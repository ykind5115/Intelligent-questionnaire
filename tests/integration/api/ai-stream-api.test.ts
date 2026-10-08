/**
 * SSE 流式端点集成测试。
 *
 * 依据 docs/05-api_design.md 第 10.4 节与 08 文档第 52 节。
 *
 * 这一层的价值在于：用户能在 AI 改问卷的过程中实时看到进度，
 * 而不是盯着转圈等十几秒。因此测试的重点是**事件顺序与内容**，
 * 而不只是「能连上」。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp } from "../../../src/app/app.js";
import { prisma } from "../../../src/database/client.js";
import { newId } from "../../../src/shared/utils/id.js";
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  LLMProvider,
  ChatEvent,
} from "../../../src/modules/ai/providers/index.js";
import {
  USERS,
  createTestInstance,
  deleteTestInstance,
} from "../questionnaire/helpers.js";

// ============================================================
// 流式假 Provider
// ============================================================

/**
 * 按脚本流式返回的假 Provider。
 *
 * 每个脚本项可以带 `deltas`，用于模拟「模型逐字输出」。
 */
class StreamingProvider implements LLMProvider {
  readonly name = "scripted-stream";
  readonly calls: ChatMessage[][] = [];

  constructor(
    private readonly script: (ChatResult & { deltas?: string[] })[]
  ) {}

  private next(): ChatResult & { deltas?: string[] } {
    return (
      this.script.shift() ?? {
        content: "（脚本已用尽）",
        toolCalls: [],
        model: "scripted-stream",
      }
    );
  }

  async chat(messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResult> {
    this.calls.push(messages);
    const { deltas: _d, ...result } = this.next();
    return result;
  }

  async *chatStream(
    messages: ChatMessage[],
    _options?: ChatOptions
  ): AsyncIterable<ChatEvent> {
    this.calls.push(messages);
    const { deltas = [], ...result } = this.next();

    for (const text of deltas) {
      yield { type: "text_delta", text };
    }
    // 工具调用的增量事件也发一下，验证端点不会把它们当正文
    for (const tc of result.toolCalls) {
      yield {
        type: "tool_call",
        call: { id: tc.id, name: tc.name, arguments: tc.arguments },
      };
    }
    yield { type: "done", result };
  }
}

// ============================================================
// 被测服务
// ============================================================

let app: ReturnType<typeof createApp>;
let server: Server;
let baseUrl = "";
let instanceId = "";
const createdTemplates: string[] = [];
/** 本文件创建的会话，测试后清理（否则开发库里会堆残留） */
const createdConversations: string[] = [];

beforeAll(async () => {
  // 先建 app 并留下引用，才能注入假 Provider
  app = createApp();
  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  // 会话必须显式清理：这些用例会真的建会话（外键约束要求如此），
  // 不清就会在开发库里累积。
  for (const cid of createdConversations.splice(0)) {
    await prisma.aiToolExecution.deleteMany({ where: { conversationId: cid } });
    await prisma.aiMessage.deleteMany({ where: { conversationId: cid } });
    await prisma.aiConversation.deleteMany({ where: { id: cid } });
  }

  if (instanceId) {
    await deleteTestInstance(instanceId);
    instanceId = "";
  }
  for (const id of createdTemplates.splice(0)) {
    await prisma.questionnaireTemplate.updateMany({
      where: { id },
      data: { currentVersionId: null },
    });
    await prisma.questionnaireTemplateVersion.deleteMany({
      where: { templateId: id },
    });
    await prisma.questionnaireTemplate.deleteMany({ where: { id } });
  }
  await prisma.aiToolExecution.deleteMany({
    where: { questionnaireInstanceId: null, source: "ai_tool" },
  });
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
  await prisma.$disconnect();
});

// ============================================================
// SSE 解析
// ============================================================

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * 发一个 POST 并解析返回的 SSE 流。
 *
 * 注意：测试必须**真实地按流读取**，不能 await res.text()，
 * 否则就测不出「事件是边跑边发」这一关键性质。
 */
async function postSse(
  path: string,
  options: { userId?: string; body?: unknown }
): Promise<{ status: number; contentType: string; events: SseEvent[] }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": options.userId ?? USERS.dispatcher,
    },
    body: JSON.stringify(options.body ?? {}),
  });

  const contentType = res.headers.get("content-type") ?? "";
  const events: SseEvent[] = [];

  if (!res.body) return { status: res.status, contentType, events };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 以空行分隔事件
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      events.push(parseSseBlock(raw));
    }
  }

  if (buffer.trim()) events.push(parseSseBlock(buffer));

  return { status: res.status, contentType, events };
}

function parseSseBlock(raw: string): SseEvent {
  let event = "message";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  return {
    event,
    data: data ? (JSON.parse(data) as Record<string, unknown>) : {},
  };
}

// ============================================================
// 前置：建实例 + 会话，并注入假 Provider
// ============================================================

interface Prepared {
  conversationId: string;
  instanceId: string;
}

async function prepare(provider: LLMProvider): Promise<Prepared> {
  const inst = await createTestInstance();
  instanceId = inst.id;

  // 通过 HTTP 建会话，确保走真实链路
  const convRes = await fetch(`${baseUrl}/api/v1/ai/conversations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": USERS.dispatcher,
    },
    body: JSON.stringify({
      scene: "modify_questionnaire",
      targetType: "questionnaire_instance",
      targetId: inst.id,
    }),
  });
  const convBody = (await convRes.json()) as {
    data?: { conversationId: string };
  };
  const conversationId = convBody.data?.conversationId;
  expect(typeof conversationId).toBe("string");

  // 注入假 Provider（与既有 AI API 测试同样的注入点）
  injectProvider(provider);

  createdConversations.push(conversationId!);
  return { conversationId: conversationId!, instanceId: inst.id };
}

/** 注入假 Provider（app.locals.aiProvider 是 Controller 的注入点） */
function injectProvider(provider: LLMProvider): void {
  app.locals["aiProvider"] = provider;
}

// ============================================================
// 用例
// ============================================================

describe("SSE：响应头与事件协议", () => {
  it("Content-Type 是 text/event-stream，且关闭了反代缓冲", async () => {
    const provider = new StreamingProvider([
      { content: "好的。", toolCalls: [], model: "s", deltas: ["好的", "。"] },
    ]);
    const p = await prepare(provider);

    const res = await fetch(
      `${baseUrl}/api/v1/ai/conversations/${p.conversationId}/messages/stream`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-id": USERS.dispatcher,
        },
        body: JSON.stringify({ content: "你好" }),
      }
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    // Nginx 等反代默认会缓冲，必须显式关闭
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    await res.text();
  });

  it("文本增量逐条推送，最后以 done 结束", async () => {
    const provider = new StreamingProvider([
      {
        content: "我来帮你增加一个分组。",
        toolCalls: [],
        model: "s",
        deltas: ["我来", "帮你", "增加一个分组。"],
      },
    ]);
    const p = await prepare(provider);

    const { events } = await postSse(
      `/api/v1/ai/conversations/${p.conversationId}/messages/stream`,
      { body: { content: "帮我加个分组" } }
    );

    const deltas = events.filter((e) => e.event === "text_delta");
    expect(deltas.map((d) => d.data["text"])).toEqual([
      "我来",
      "帮你",
      "增加一个分组。",
    ]);

    const done = events.find((e) => e.event === "done");
    expect(done).toBeDefined();
    expect(done?.data["content"]).toBe("我来帮你增加一个分组。");
    expect(done?.data["truncated"]).toBe(false);

    // done 必须是最后一个事件
    expect(events[events.length - 1]?.event).toBe("done");
  });
});

describe("SSE：工具调用事件", () => {
  it("推送 tool_call_start / tool_call_result，并在结构变更时推送 questionnaire_updated", async () => {
    const provider = new StreamingProvider([
      {
        content: null,
        toolCalls: [
          {
            id: "c1",
            name: "add_section",
            arguments: JSON.stringify({ title: "活动轨迹" }),
          },
        ],
        model: "s",
      },
      {
        content: "已增加「活动轨迹」分组。",
        toolCalls: [],
        model: "s",
        deltas: ["已增加", "「活动轨迹」分组。"],
      },
    ]);
    const p = await prepare(provider);

    const { events } = await postSse(
      `/api/v1/ai/conversations/${p.conversationId}/messages/stream`,
      { body: { content: "增加一个活动轨迹分组" } }
    );

    const start = events.find((e) => e.event === "tool_call_start");
    expect(start).toBeDefined();
    expect(start?.data["toolName"]).toBe("add_section");
    expect(start?.data["operationId"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(start?.data["arguments"]).toEqual({ title: "活动轨迹" });

    const result = events.find((e) => e.event === "tool_call_result");
    expect(result).toBeDefined();
    expect(result?.data["success"]).toBe(true);
    // 新 revision 让前端知道结构变了
    expect(typeof result?.data["revision"]).toBe("number");

    const updated = events.find((e) => e.event === "questionnaire_updated");
    expect(updated).toBeDefined();
    expect(updated?.data["questionnaireId"]).toBe(p.instanceId);

    // 顺序：start → result → updated
    const order = events
      .filter((e) =>
        ["tool_call_start", "tool_call_result", "questionnaire_updated"].includes(
          e.event
        )
      )
      .map((e) => e.event);
    expect(order).toEqual([
      "tool_call_start",
      "tool_call_result",
      "questionnaire_updated",
    ]);

    // 结构真的变了
    const after = await prisma.questionnaireInstance.findUnique({
      where: { id: p.instanceId },
      select: { currentSchema: true },
    });
    const titles = (
      after?.currentSchema as { sections: { title: string }[] }
    ).sections.map((s) => s.title);
    expect(titles).toContain("活动轨迹");
  });

  it("工具失败时推送 success=false 与 errorCode，且不推 questionnaire_updated", async () => {
    const provider = new StreamingProvider([
      {
        content: null,
        toolCalls: [
          {
            id: "c1",
            name: "add_question",
            // section_id 不存在 → 业务校验失败
            arguments: JSON.stringify({
              section_id: "sec_nope",
              type: "text",
              title: "题",
            }),
          },
        ],
        model: "s",
      },
      { content: "没能加上。", toolCalls: [], model: "s" },
    ]);
    const p = await prepare(provider);

    const { events } = await postSse(
      `/api/v1/ai/conversations/${p.conversationId}/messages/stream`,
      { body: { content: "加一道题" } }
    );

    const result = events.find((e) => e.event === "tool_call_result");
    expect(result?.data["success"]).toBe(false);
    expect(typeof result?.data["errorCode"]).toBe("string");
    expect(
      events.some((e) => e.event === "questionnaire_updated")
    ).toBe(false);

    // 失败不应中断整个流
    expect(events[events.length - 1]?.event).toBe("done");
  });
});

describe("SSE：错误与权限", () => {
  it("会话不存在 → 404（校验在写流之前，因此是正常状态码）", async () => {
    const provider = new StreamingProvider([]);
    injectProvider(provider);

    const { status } = await postSse(
      `/api/v1/ai/conversations/00000000-0000-4000-8000-000000000000/messages/stream`,
      { body: { content: "你好" } }
    );

    // SSE 一旦写下响应头，状态码就固定成 200，调用方无法处理；
    // 因此「调用前就能判定」的错误必须走正常 HTTP 状态码。
    expect(status).toBe(404);
  });

  it("内容为空 → 422（校验发生在写流之前）", async () => {
    const provider = new StreamingProvider([]);
    const p = await prepare(provider);

    const res = await fetch(
      `${baseUrl}/api/v1/ai/conversations/${p.conversationId}/messages/stream`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-id": USERS.dispatcher,
        },
        body: JSON.stringify({ content: "   " }),
      }
    );

    // 校验中间件在 Controller 之前拦截，因此仍是普通 JSON 错误
    expect(res.status).toBe(422);
    await res.text();
  });

  it("访问他人会话 → 403（校验在写流之前）", async () => {
    const provider = new StreamingProvider([]);
    const p = await prepare(provider);

    const { status } = await postSse(
      `/api/v1/ai/conversations/${p.conversationId}/messages/stream`,
      {
        userId: USERS.investigator,
        body: { content: "偷看" },
      }
    );

    expect(status).toBe(403);

    // 单独再确认错误体内容是 PERMISSION_DENIED
    const res = await fetch(
      `${baseUrl}/api/v1/ai/conversations/${p.conversationId}/messages/stream`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-id": USERS.investigator,
        },
        body: JSON.stringify({ content: "偷看" }),
      }
    );
    const body = (await res.json()) as { error?: { code: string } };
    expect(body.error?.code).toBe("PERMISSION_DENIED");
  });
});

describe("SSE：落库", () => {
  it("流结束后消息成对落库（user / assistant+tool / assistant）", async () => {
    const provider = new StreamingProvider([
      {
        content: null,
        toolCalls: [
          {
            id: "c1",
            name: "add_section",
            arguments: JSON.stringify({ title: "落库校验组" }),
          },
        ],
        model: "s",
      },
      {
        content: "完成。",
        toolCalls: [],
        model: "s",
        deltas: ["完成。"],
      },
    ]);
    const p = await prepare(provider);

    await postSse(
      `/api/v1/ai/conversations/${p.conversationId}/messages/stream`,
      { body: { content: "加个分组" } }
    );

    const rows = await prisma.aiMessage.findMany({
      where: { conversationId: p.conversationId },
      orderBy: { createdAt: "asc" },
      select: {
        role: true,
        content: true,
        toolName: true,
        toolArguments: true,
      },
    });

    // user + (assistant with toolCalls) + (tool) + assistant(final)
    expect(rows.map((r) => r.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(rows[0]?.content).toBe("加个分组");
    // 工具请求记在 toolName / toolArguments 上（没有独立的 tool_calls 列）\n    expect(rows[1]?.toolName).toBe("add_section");\n    expect(rows[1]?.toolArguments).toEqual({ title: "落库校验组" });
    expect(rows[2]?.toolName).toBe("add_section");
    expect(rows[3]?.content).toBe("完成。");

    // 会话由 afterEach 统一清理
  });
});
