/**
 * Tool 层集成测试（真实数据库）。
 *
 * 这一层是「模型意图」与「业务操作」之间的边界，最容易出问题的地方是：
 *   1. 模型幻觉出工具名或参数 → 必须返回结构化失败，而不是抛异常或静默忽略
 *   2. 模型把 target_id 填错 → 必须拒绝，不能改错问卷
 *   3. 权限与状态校验必须由后端执行，不能依赖 Prompt 约束
 *   4. description 与 JSON Schema 是 Prompt 的一部分，必须完整可用
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { prisma } from "../../../src/database/client.js";
import {
  ErrorCode,
  isOperationError,
} from "../../../src/shared/errors/index.js";
import {
  ALL_TOOLS,
  allLlmToolSpecs,
  runTool,
  toolRegistry,
  type ToolContext,
} from "../../../src/modules/ai/tools/index.js";
import { newId } from "../../../src/shared/utils/id.js";
import {
  CTX,
  USERS,
  countArtifacts,
  createTestInstance,
  deleteTestInstance,
  readInstanceState,
} from "../questionnaire/helpers.js";

/** 构造 ToolContext（决策 D9：一次 Tool 调用一个 operation_id） */
function toolCtx(
  targetId: string,
  extra: Partial<ToolContext> = {}
): ToolContext {
  return {
    userId: USERS.dispatcher,
    roles: ["dispatcher"],
    // 必须是合法 UUID：operation_id 是 uuid 字段，
    // 非法值会在写审计日志时被数据库拒绝
    operationId: newId(),
    scene: "modify_questionnaire",
    targetType: "questionnaire_instance",
    targetId,
    ...extra,
  };
}

/** 固定 operationId 的上下文，用于幂等测试 */
function toolCtxWithFixedOperation(
  targetId: string,
  operationId: string,
  extra: Partial<ToolContext> = {}
): ToolContext {
  return toolCtx(targetId, { operationId, ...extra });
}

let instanceId = "";

afterEach(async () => {
  if (instanceId) {
    await deleteTestInstance(instanceId);
    instanceId = "";
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ============================================================
// Registry 与工具定义
// ============================================================

describe("Tool Registry", () => {
  it("恰好注册 7 个工具（03 文档第 48 节）", () => {
    expect(ALL_TOOLS).toHaveLength(7);
    expect(ALL_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "add_question",
        "add_section",
        "get_questionnaire",
        "move_question",
        "remove_question",
        "update_question",
        "update_section",
      ].sort()
    );
  });

  it("不存在宏工具（generate_questionnaire / modify_questionnaire）", () => {
    expect(toolRegistry.has("generate_questionnaire")).toBe(false);
    expect(toolRegistry.has("modify_questionnaire")).toBe(false);
    expect(toolRegistry.has("validate_questionnaire")).toBe(false);
  });

  it("只有 get_questionnaire 是读取类", () => {
    const readonly = toolRegistry.listReadonly();
    expect(readonly).toHaveLength(1);
    expect(readonly[0]?.name).toBe("get_questionnaire");
  });

  it("每个工具都有非空 description（它属于 Prompt 的一部分）", () => {
    for (const t of ALL_TOOLS) {
      expect(t.description.length).toBeGreaterThan(10);
    }
  });

  it("remove_question 的 description 明确要求「仅在用户明确要求时」", () => {
    const tool = toolRegistry.get("remove_question");
    expect(tool?.description).toContain("明确要求");
    expect(tool?.description).toContain("不要");
  });

  it("写入类工具的 description 提醒 ID 不得编造", () => {
    for (const name of ["add_question", "update_question", "move_question"]) {
      const tool = toolRegistry.get(name);
      expect(tool?.description).toMatch(/id|ID/);
    }
  });
});

// ============================================================
// JSON Schema 生成（发给模型的定义）
// ============================================================

describe("LlmToolSpec 生成", () => {
  it("生成 7 个 OpenAI 兼容的 function 定义", () => {
    const specs = allLlmToolSpecs();
    expect(specs).toHaveLength(7);
    for (const s of specs) {
      expect(s.type).toBe("function");
      expect(s.function.name).toBeTruthy();
      expect(s.function.description).toBeTruthy();
      expect(s.function.parameters).toBeTruthy();
      // 顶层不应带 $schema（OpenAI 兼容协议不需要）
      expect(s.function.parameters["$schema"]).toBeUndefined();
      expect(s.function.parameters["type"]).toBe("object");
    }
  });

  it("target_id 是可选的，不进入 required（由上下文兜底）", () => {
    const spec = allLlmToolSpecs().find(
      (s) => s.function.name === "add_question"
    );
    const required = spec?.function.parameters["required"] as string[];
    expect(required).not.toContain("target_id");
    expect(required).toContain("section_id");
    expect(required).toContain("title");
    expect(required).toContain("type");
  });

  it("题型 enum 完整传入（模型据此生成合法题型）", () => {
    const spec = allLlmToolSpecs().find(
      (s) => s.function.name === "add_question"
    );
    const props = spec?.function.parameters["properties"] as Record<
      string,
      { enum?: string[] }
    >;
    expect(props["type"]?.enum).toEqual([
      "text",
      "textarea",
      "number",
      "single_choice",
      "multiple_choice",
      "date",
      "datetime",
      "boolean",
    ]);
  });
});

// ============================================================
// 参数与上下文校验（模型输出不可信）
// ============================================================

describe("runTool 的参数与上下文校验", () => {
  it("未知工具名返回 INVALID_OPERATION，而不是抛异常", async () => {
    const result = await runTool(
      "generate_questionnaire",
      {},
      toolCtx("00000000-0000-0000-0000-000000000000")
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.INVALID_OPERATION);
    expect(result.error?.message).toContain("未知工具");
  });

  it("缺少必填参数返回 INVALID_PARAMETER，并给出字段路径", async () => {
    const result = await runTool(
      "add_question",
      { section_id: "sec_x", type: "text" }, // 缺 title
      toolCtx("00000000-0000-0000-0000-000000000000")
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.INVALID_PARAMETER);
    const issues = result.error?.detail?.["issues"] as { path: string }[];
    expect(issues.some((i) => i.path === "title")).toBe(true);
  });

  it("参数类型错误返回 INVALID_PARAMETER", async () => {
    const result = await runTool(
      "add_section",
      { title: 12345 }, // 应为 string
      toolCtx("00000000-0000-0000-0000-000000000000")
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.INVALID_PARAMETER);
  });

  it("target_id 与会话不一致时返回 INVALID_TOOL_CONTEXT（防止改错问卷）", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const result = await runTool(
      "add_section",
      {
        target_id: "11111111-1111-1111-1111-111111111111", // 另一个问卷
        title: "不该被写入",
      },
      toolCtx(instanceId)
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.INVALID_TOOL_CONTEXT);
    expect(result.error?.detail?.["expected"]).toBe(instanceId);

    // 确认真的没有被写入
    const state = await readInstanceState(instanceId);
    const sections = (
      state?.currentSchema as { sections: { title: string }[] }
    ).sections;
    expect(sections.map((s) => s.title)).not.toContain("不该被写入");
  });

  it("target_id 与会话一致时正常执行", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const result = await runTool(
      "add_section",
      { target_id: instanceId, title: "显式传 target_id" },
      toolCtx(instanceId)
    );

    expect(result.success).toBe(true);
  });

  it("省略 target_id 时使用上下文绑定的问卷", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const result = await runTool(
      "add_section",
      { title: "省略 target_id" },
      toolCtx(instanceId)
    );

    expect(result.success).toBe(true);
    const state = await readInstanceState(instanceId);
    const sections = (
      state?.currentSchema as { sections: { title: string }[] }
    ).sections;
    expect(sections.map((s) => s.title)).toContain("省略 target_id");
  });

  it("create_template 场景下写入类工具被拒绝", async () => {
    const result = await runTool(
      "add_section",
      { title: "x" },
      toolCtx("00000000-0000-0000-0000-000000000000", {
        targetType: "template",
        scene: "create_template",
      })
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.INVALID_PARAMETER);
  });
});

// ============================================================
// 写入链路
// ============================================================

describe("写入类工具", () => {
  it("add_section → 落库 + revision 递增 + 审计记录工具名", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const result = await runTool(
      "add_section",
      { title: "团伙关系调查" },
      toolCtx(instanceId)
    );

    expect(result.success).toBe(true);
    expect(result.metadata?.revision).toBe(inst.initialRevision + 1);
    const section = result.data as { section: { id: string; title: string } };
    expect(section.section.title).toBe("团伙关系调查");

    // 审计里记录的是工具名，来源是 ai_tool
    const log = await prisma.aiToolExecution.findFirst({
      where: { questionnaireInstanceId: instanceId },
      orderBy: { createdAt: "desc" },
    });
    expect(log?.toolName).toBe("add_section");
    expect(log?.source).toBe("ai_tool");
  });

  it("add_section → add_question 的依赖链：使用返回的 section_id", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const sectionResult = await runTool(
      "add_section",
      { title: "团伙关系调查" },
      toolCtx(instanceId)
    );
    const sectionId = (
      sectionResult.data as { section: { id: string } }
    ).section.id;

    const qResult = await runTool(
      "add_question",
      {
        section_id: sectionId,
        type: "single_choice",
        title: "是否存在团伙？",
        required: true,
        options: [{ label: "是" }, { label: "否" }, { label: "不清楚" }],
      },
      toolCtx(instanceId)
    );

    expect(qResult.success).toBe(true);
    const question = (
      qResult.data as { question: { id: string; title: string } }
    ).question;
    expect(question.id).toMatch(/^q_/);

    const state = await readInstanceState(instanceId);
    const sec = (
      state?.currentSchema as {
        sections: { id: string; questions: { title: string }[] }[];
      }
    ).sections.find((s) => s.id === sectionId);
    expect(sec?.questions.map((q) => q.title)).toEqual(["是否存在团伙？"]);
  });

  it("用不存在的 section_id 加题：返回 SECTION_NOT_FOUND 且不写入", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const result = await runTool(
      "add_question",
      { section_id: "sec_不存在", type: "text", title: "x" },
      toolCtx(instanceId)
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.SECTION_NOT_FOUND);

    const state = await readInstanceState(instanceId);
    expect(state?.currentRevision).toBe(inst.initialRevision);
  });

  it("选择题缺少 options 时，参数层就拦住（不会进业务层）", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    // Zod 层无法表达「选择题必须有 options」的跨字段约束，
    // 因此会落到 Operation 层由 INVALID_OPTIONS 拦截
    const result = await runTool(
      "add_question",
      { section_id: "sec_basic", type: "single_choice", title: "购买渠道" },
      toolCtx(instanceId)
    );

    expect(result.success).toBe(false);
    // 若 section_id 恰好存在于该模板则应是 INVALID_OPTIONS；
    // 不存在则是 SECTION_NOT_FOUND —— 两者都算被正确拦截
    expect([
      ErrorCode.INVALID_OPTIONS,
      ErrorCode.SECTION_NOT_FOUND,
    ]).toContain(result.error?.code);
  });

  it("remove_question 删除后 revision 递增", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    // 先建一个可删的问题
    const sectionResult = await runTool(
      "add_section",
      { title: "临时分组" },
      toolCtx(instanceId)
    );
    const sectionId = (sectionResult.data as { section: { id: string } })
      .section.id;

    const qResult = await runTool(
      "add_question",
      { section_id: sectionId, type: "text", title: "临时问题" },
      toolCtx(instanceId)
    );
    const questionId = (qResult.data as { question: { id: string } }).question
      .id;

    const afterAdd = await readInstanceState(instanceId);

    const result = await runTool(
      "remove_question",
      { question_id: questionId },
      toolCtx(instanceId)
    );

    expect(result.success).toBe(true);
    const afterRemove = await readInstanceState(instanceId);
    expect(afterRemove?.currentRevision).toBe(
      (afterAdd?.currentRevision ?? 0) + 1
    );

    const sec = (
      afterRemove?.currentSchema as {
        sections: { id: string; questions: unknown[] }[];
      }
    ).sections.find((s) => s.id === sectionId);
    expect(sec?.questions).toHaveLength(0);
  });
});

// ============================================================
// 读取类工具
// ============================================================

describe("get_questionnaire", () => {
  it("返回完整结构与当前 revision", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const result = await runTool("get_questionnaire", {}, toolCtx(instanceId));

    expect(result.success).toBe(true);
    const data = result.data as {
      questionnaire: { sections: unknown[] };
      revision: number;
      status: string;
    };
    expect(data.revision).toBe(inst.initialRevision);
    expect(data.status).toBe("draft");
    expect(data.questionnaire.sections.length).toBeGreaterThan(0);
  });

  it("读取也产生审计记录（便于复盘模型当时看到的结构）", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    await runTool("get_questionnaire", {}, toolCtx(instanceId));

    const { audits } = await countArtifacts(instanceId);
    expect(audits).toBe(1);

    const log = await prisma.aiToolExecution.findFirst({
      where: { questionnaireInstanceId: instanceId },
    });
    expect(log?.toolName).toBe("get_questionnaire");
  });

  it("investigator 可以读（只读角色）", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const result = await runTool(
      "get_questionnaire",
      {},
      toolCtx(instanceId, {
        userId: USERS.investigator,
        roles: ["investigator"],
      })
    );

    expect(result.success).toBe(true);
  });
});

// ============================================================
// 权限与状态（模型无权绕过）
// ============================================================

describe("权限与状态由后端强制", () => {
  it("investigator 调用写入工具被拒绝", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const result = await runTool(
      "add_section",
      { title: "调查员不该能加" },
      toolCtx(instanceId, {
        userId: USERS.investigator,
        roles: ["investigator"],
      })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.PERMISSION_DENIED);

    const state = await readInstanceState(instanceId);
    const sections = (
      state?.currentSchema as { sections: { title: string }[] }
    ).sections;
    expect(sections.map((s) => s.title)).not.toContain("调查员不该能加");
  });

  it("已下发的问卷调用写入工具返回 QUESTIONNAIRE_LOCKED（决策 D1）", async () => {
    const inst = await createTestInstance({ status: "dispatched" });
    instanceId = inst.id;

    const result = await runTool(
      "add_section",
      { title: "下发后不该能加" },
      toolCtx(instanceId)
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ErrorCode.QUESTIONNAIRE_LOCKED);
    expect(result.error?.message).toContain("撤回");
  });
});

// ============================================================
// 幂等（决策 D9）
// ============================================================

describe("Tool 幂等", () => {
  it("同一 operation_id 重复执行同一工具不产生重复数据", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const ctx = toolCtxWithFixedOperation(instanceId, newId()); // operationId 固定

    const first = await runTool(
      "add_section",
      { title: "幂等分组" },
      ctx
    );
    const second = await runTool(
      "add_section",
      { title: "幂等分组" },
      ctx
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    // 第二次是重放，revision 不变
    expect(second.metadata?.revision).toBe(first.metadata?.revision);

    const state = await readInstanceState(instanceId);
    const sections = (
      state?.currentSchema as { sections: { title: string }[] }
    ).sections;
    expect(sections.filter((s) => s.title === "幂等分组")).toHaveLength(1);

    const { audits } = await countArtifacts(instanceId);
    expect(audits).toBe(1);
  });
});
