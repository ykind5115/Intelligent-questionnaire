/**
 * Orchestrator 测试。
 *
 * 用假 Provider 驱动，因此**不调用真实模型**，
 * 但工具执行走的是真实的 Tool → Service → 数据库链路。
 *
 * 重点验证 08 文档里的循环纪律：
 *   - 模型不请求工具时立即结束
 *   - 工具结果必须回灌给模型（并且带上 tool_call_id）
 *   - 参数不是合法 JSON 时不执行工具，而是把原因回灌让模型纠正
 *   - 触达 MAX_TOOL_ROUNDS 时收尾而不是报错
 *   - 每次工具调用都有独立的 operation_id（决策 D9）
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "../../../src/database/client.js";
import {
  MAX_TOOL_ROUNDS,
  runTurn,
} from "../../../src/modules/ai/orchestrator/ai.orchestrator.js";
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  LLMProvider,
} from "../../../src/modules/ai/providers/index.js";
import {
  USERS,
  createTestConversation,
  createTestInstance,
  deleteTestConversation,
  deleteTestInstance,
  readInstanceState,
} from "../questionnaire/helpers.js";

/** 按脚本依次返回结果的假 Provider */
class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  /** 每次 chat 收到的完整消息列表，便于断言回灌内容 */
  readonly calls: ChatMessage[][] = [];
  readonly options: (ChatOptions | undefined)[] = [];

  constructor(private readonly script: ChatResult[]) {}

  private next(): ChatResult {
    const r = this.script.shift();
    if (!r) {
      // 脚本用尽：返回一个纯文本回复，避免测试挂死
      return { content: "（脚本已用尽）", toolCalls: [], model: "scripted" };
    }
    return r;
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatOptions
  ): Promise<ChatResult> {
    this.calls.push(structuredClone(messages));
    this.options.push(options);
    return this.next();
  }

  // eslint-disable-next-line require-yield
  async *chatStream(): AsyncIterable<never> {
    throw new Error("本测试不使用流式");
  }
}

/** 构造一个「请求调用某工具」的模型回复 */
function toolCallReply(
  calls: { id: string; name: string; args: unknown }[],
  content: string | null = null
): ChatResult {
  return {
    content,
    toolCalls: calls.map((c) => ({
      id: c.id,
      name: c.name,
      arguments:
        typeof c.args === "string" ? c.args : JSON.stringify(c.args),
    })),
    model: "scripted",
    finishReason: "tool_calls",
  };
}

let instanceId = "";

/**
 * 本文件共用的 AI 会话。
 *
 * ai_tool_executions.conversation_id 有外键约束，
 * 因此必须是一条真实存在的会话记录，不能随意编造字符串。
 */
let FIXED_CONVERSATION_ID = "";

beforeAll(async () => {
  // 会话需要绑定一个实例；这里建一个临时实例用于建会话，随后删除。
  // 断言只关心会话本身存在（外键约束要求上）。
  const seedInstance = await createTestInstance();
  FIXED_CONVERSATION_ID = await createTestConversation(seedInstance.id);
  await deleteTestInstance(seedInstance.id);
});

afterEach(async () => {
  if (instanceId) {
    await deleteTestInstance(instanceId);
    instanceId = "";
  }
});

afterAll(async () => {
  if (FIXED_CONVERSATION_ID) {
    await deleteTestConversation(FIXED_CONVERSATION_ID);
  }
  await prisma.$disconnect();
});

function baseInput(
  provider: LLMProvider,
  targetId: string,
  extra: Record<string, unknown> = {}
) {
  return {
    provider,
    // 必须是合法 UUID（ai_tool_executions.conversation_id 有 uuid 约束与外键），
    // 因此这里用固定 UUID，而不是 "conv-test" 这类字符串
    conversationId: FIXED_CONVERSATION_ID,
    targetType: "questionnaire_instance" as const,
    targetId,
    scene: "modify_questionnaire",
    userId: USERS.dispatcher,
    roles: ["dispatcher"],
    userMessage: "增加一个团伙关系调查模块，里面问一下是否存在团伙。",
    ...extra,
  };
}

describe("runTurn - 基本循环", () => {
  it("模型不请求工具时直接返回文本，不执行任何工具", async () => {
    const provider = new ScriptedProvider([
      { content: "你好，请告诉我调查对象。", toolCalls: [], model: "scripted" },
    ]);

    const out = await runTurn(
      baseInput(provider, "00000000-0000-0000-0000-000000000000")
    );

    expect(out.content).toBe("你好，请告诉我调查对象。");
    expect(out.traces).toHaveLength(0);
    expect(out.truncated).toBe(false);
    expect(provider.calls).toHaveLength(1);
  });

  it("system prompt 里包含场景说明与工具纪律", async () => {
    const provider = new ScriptedProvider([
      { content: "ok", toolCalls: [], model: "scripted" },
    ]);

    await runTurn(
      baseInput(provider, "00000000-0000-0000-0000-000000000000")
    );

    const system = provider.calls[0]?.[0];
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("增量修改");
    // 工具纪律必须告知模型：ID 不能编造、删除需明确要求
    expect(system?.content).toContain("不要自己编造");
    expect(system?.content).toContain("删除");
  });

  it("把工具定义发给模型", async () => {
    const provider = new ScriptedProvider([
      { content: "ok", toolCalls: [], model: "scripted" },
    ]);

    await runTurn(
      baseInput(provider, "00000000-0000-0000-0000-000000000000")
    );

    const tools = provider.options[0]?.tools;
    expect(tools).toHaveLength(7);
    expect(tools?.map((t) => t.function.name)).toContain("add_section");
  });
});

describe("runTurn - 工具执行与结果回灌", () => {
  it("执行工具、落库，并把结果回灌给模型", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const provider = new ScriptedProvider([
      // 第一轮：请求调用 add_section
      toolCallReply([
        { id: "call_1", name: "add_section", args: { title: "团伙关系调查" } },
      ]),
      // 第二轮：不再请求工具
      { content: "已增加团伙关系调查模块。", toolCalls: [], model: "scripted" },
    ]);

    const out = await runTurn(baseInput(provider, instanceId));

    expect(out.traces).toHaveLength(1);
    expect(out.traces[0]?.toolName).toBe("add_section");
    expect(out.traces[0]?.result.success).toBe(true);
    expect(out.content).toBe("已增加团伙关系调查模块。");
    expect(out.truncated).toBe(false);

    // 真的落库了
    const state = await readInstanceState(instanceId);
    const sections = (
      state?.currentSchema as { sections: { title: string }[] }
    ).sections;
    expect(sections.map((s) => s.title)).toContain("团伙关系调查");

    // 第二轮请求里必须带回 tool 消息，且 tool_call_id 对应
    expect(provider.calls).toHaveLength(2);
    const secondCall = provider.calls[1] ?? [];
    const toolMsg = secondCall.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.toolCallId).toBe("call_1");
    expect(toolMsg?.name).toBe("add_section");
    expect(toolMsg?.content).toContain('"success":true');
  });

  it("多轮多次调用：add_section → add_question 依赖链", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    // 先问出 section_id 才能加题，这里用脚本模拟模型两轮拿 ID
    const provider = new ScriptedProvider([
      toolCallReply([
        { id: "c1", name: "add_section", args: { title: "团伙关系调查" } },
      ]),
      { content: "分组已建好。", toolCalls: [], model: "scripted" },
    ]);

    const out = await runTurn(baseInput(provider, instanceId));
    const sectionId = (
      out.traces[0]?.result.data as { section: { id: string } }
    ).section.id;
    expect(sectionId).toMatch(/^sec_/);

    // 第二次回合：模型带着已知 ID 加题
    const provider2 = new ScriptedProvider([
      toolCallReply([
        {
          id: "c2",
          name: "add_question",
          args: {
            section_id: sectionId,
            type: "boolean",
            title: "是否存在团伙？",
            required: true,
          },
        },
      ]),
      { content: "已增加问题。", toolCalls: [], model: "scripted" },
    ]);

    const out2 = await runTurn(baseInput(provider2, instanceId));
    expect(out2.traces[0]?.result.success).toBe(true);

    const state = await readInstanceState(instanceId);
    const sec = (
      state?.currentSchema as {
        sections: { id: string; questions: { title: string }[] }[];
      }
    ).sections.find((s) => s.id === sectionId);
    expect(sec?.questions.map((q) => q.title)).toEqual(["是否存在团伙？"]);
  });

  it("模型给的参数不是合法 JSON 时不执行工具，把原因回灌", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const provider = new ScriptedProvider([
      // 故意返回坏 JSON
      {
        content: null,
        toolCalls: [
          { id: "bad_1", name: "add_section", arguments: "{不是合法JSON" },
        ],
        model: "scripted",
      },
      { content: "抱歉，我重新整理。", toolCalls: [], model: "scripted" },
    ]);

    const out = await runTurn(baseInput(provider, instanceId));

    expect(out.traces).toHaveLength(1);
    expect(out.traces[0]?.result.success).toBe(false);
    expect(out.traces[0]?.result.error?.code).toBe("INVALID_PARAMETER");

    // 未落库
    const state = await readInstanceState(instanceId);
    expect(state?.currentRevision).toBe(inst.initialRevision);

    // 模型收到了失败原因
    const toolMsg = (provider.calls[1] ?? []).find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("INVALID_PARAMETER");
  });

  it("工具返回失败（找不到分组）时不假装成功，失败原因回灌", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const provider = new ScriptedProvider([
      toolCallReply([
        {
          id: "c1",
          name: "add_question",
          args: {
            section_id: "sec_不存在",
            type: "text",
            title: "x",
          },
        },
      ]),
      { content: "我没找到那个分组，先读一下当前问卷。", toolCalls: [], model: "scripted" },
    ]);

    const out = await runTurn(baseInput(provider, instanceId));

    expect(out.traces[0]?.result.success).toBe(false);
    expect(out.traces[0]?.result.error?.code).toBe("SECTION_NOT_FOUND");
    const toolMsg = (provider.calls[1] ?? []).find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("SECTION_NOT_FOUND");
  });

  it("并行多个工具调用都会执行", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const provider = new ScriptedProvider([
      toolCallReply([
        { id: "p1", name: "add_section", args: { title: "并行组一" } },
        { id: "p2", name: "add_section", args: { title: "并行组二" } },
      ]),
      { content: "已增加两个分组。", toolCalls: [], model: "scripted" },
    ]);

    const out = await runTurn(baseInput(provider, instanceId));

    expect(out.traces).toHaveLength(2);
    expect(out.traces.every((t) => t.result.success)).toBe(true);

    const state = await readInstanceState(instanceId);
    const sections = (
      state?.currentSchema as { sections: { title: string }[] }
    ).sections;
    expect(sections.map((s) => s.title)).toContain("并行组一");
    expect(sections.map((s) => s.title)).toContain("并行组二");
  });
});

describe("runTurn - 每次工具调用一个 operation_id（决策 D9）", () => {
  it("同轮内多次调用获得不同的 operation_id", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const provider = new ScriptedProvider([
      toolCallReply([
        { id: "a", name: "add_section", args: { title: "A 组" } },
        { id: "b", name: "add_section", args: { title: "B 组" } },
      ]),
      { content: "done", toolCalls: [], model: "scripted" },
    ]);

    const out = await runTurn(baseInput(provider, instanceId));

    const ids = out.traces.map((t) => t.operationId);
    expect(new Set(ids).size).toBe(2);
    // operation_id 必须是合法 UUID（写库要求）
    for (const id of ids) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    }

    // 两次调用产生两条审计记录
    const audits = await prisma.aiToolExecution.count({
      where: { questionnaireInstanceId: instanceId },
    });
    expect(audits).toBe(2);
  });
});

describe("runTurn - 轮数上限", () => {
  it("一直请求工具时会收尾而不是无限循环，也不抛异常", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    // 脚本里放足够多轮，每轮都请求 add_section
    const script: ChatResult[] = Array.from(
      { length: MAX_TOOL_ROUNDS + 3 },
      (_, i) =>
        toolCallReply([
          {
            id: `c${i}`,
            name: "add_section",
            args: { title: `自动组 ${i}` },
          },
        ])
    );
    const provider = new ScriptedProvider(script);

    const out = await runTurn(baseInput(provider, instanceId));

    expect(out.truncated).toBe(true);
    expect(out.traces).toHaveLength(MAX_TOOL_ROUNDS);
    expect(out.content).toContain("完成");
    // 已完成的修改是有效的（不应整体回滚）
    const state = await readInstanceState(instanceId);
    expect(state?.currentRevision).toBe(
      inst.initialRevision + MAX_TOOL_ROUNDS
    );
  });

  it("提供 summarize 时用自定义收尾文案", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const script: ChatResult[] = Array.from(
      { length: MAX_TOOL_ROUNDS + 2 },
      (_, i) =>
        toolCallReply([
          { id: `c${i}`, name: "add_section", args: { title: `组 ${i}` } },
        ])
    );

    const out = await runTurn(
      baseInput(new ScriptedProvider(script), instanceId, {
        summarize: async () => "自定义收尾：先做到这里，继续说「继续」即可。",
      })
    );

    expect(out.truncated).toBe(true);
    expect(out.content).toBe("自定义收尾：先做到这里，继续说「继续」即可。");
  });
});

describe("runTurn - 权限与状态由后端强制（不靠 Prompt）", () => {
  it("调查员角色通过 Orchestrator 也无法改结构", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const provider = new ScriptedProvider([
      toolCallReply([
        { id: "c1", name: "add_section", args: { title: "不该被写入" } },
      ]),
      { content: "我无权修改。", toolCalls: [], model: "scripted" },
    ]);

    const out = await runTurn(
      baseInput(provider, instanceId, {
        userId: USERS.investigator,
        roles: ["investigator"],
      })
    );

    expect(out.traces[0]?.result.success).toBe(false);
    expect(out.traces[0]?.result.error?.code).toBe("PERMISSION_DENIED");

    const state = await readInstanceState(instanceId);
    const sections = (
      state?.currentSchema as { sections: { title: string }[] }
    ).sections;
    expect(sections.map((s) => s.title)).not.toContain("不该被写入");
  });

  it("已下发问卷通过 Orchestrator 也无法改（决策 D1）", async () => {
    const inst = await createTestInstance({ status: "dispatched" });
    instanceId = inst.id;

    const provider = new ScriptedProvider([
      toolCallReply([
        { id: "c1", name: "add_section", args: { title: "不该被写入" } },
      ]),
      { content: "问卷已下发，需要先撤回。", toolCalls: [], model: "scripted" },
    ]);

    const out = await runTurn(baseInput(provider, instanceId));

    expect(out.traces[0]?.result.success).toBe(false);
    expect(out.traces[0]?.result.error?.code).toBe("QUESTIONNAIRE_LOCKED");
  });
});

describe("runTurn - 非法上下文字段必须提前失败", () => {
  /**
   * 回归测试：conversationId 是 uuid 列且有外键。
   *
   * 早期实现里非法值会一路走完业务逻辑，最后在「写审计日志」时
   * 才由数据库抛出 invalid input syntax for type uuid，
   * 错误码丢失成 SYSTEM_ERROR；更糟的是审计写入在同一事务内，
   * 会把已经成功的结构修改一起回滚。
   *
   * 现在由 Service 入口校验，返回明确的 VALIDATION_ERROR。
   */
  it("conversationId 不是合法 UUID 时返回 VALIDATION_ERROR 而不是 SYSTEM_ERROR", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const provider = new ScriptedProvider([
      toolCallReply([
        { id: "c1", name: "add_section", args: { title: "不该被写入" } },
      ]),
      { content: "done", toolCalls: [], model: "scripted" },
    ]);

    const out = await runTurn(
      baseInput(provider, instanceId, { conversationId: "conv-not-a-uuid" })
    );

    expect(out.traces[0]?.result.success).toBe(false);
    expect(out.traces[0]?.result.error?.code).toBe("VALIDATION_ERROR");
    expect(out.traces[0]?.result.error?.message).toContain("conversationId");
  });

  it("非法上下文导致的失败不会改动问卷", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const provider = new ScriptedProvider([
      toolCallReply([
        { id: "c1", name: "add_section", args: { title: "不该被写入" } },
      ]),
      { content: "done", toolCalls: [], model: "scripted" },
    ]);

    await runTurn(
      baseInput(provider, instanceId, { conversationId: "bad" })
    );

    const state = await readInstanceState(instanceId);
    expect(state?.currentRevision).toBe(inst.initialRevision);
    const sections = (
      state?.currentSchema as { sections: { title: string }[] }
    ).sections;
    expect(sections.map((s) => s.title)).not.toContain("不该被写入");
  });
});
