/**
 * AI 会话 API 的 HTTP 集成测试。
 *
 * 依据 docs/05-api_design.md 第 10 / 12 节。
 *
 * 为什么不用 supertest：
 *   项目没有安装 supertest，这里用 Node 内置能力起一个真实 HTTP 服务
 *   （app.listen(0) + fetch），起停方式参考 tests/integration/ai/deepseek-provider.test.ts
 *   里的 MockEndpoint。这样测的是**真实的 HTTP 链路**：
 *   路由匹配 → 校验中间件 → Controller → Service → Orchestrator → 数据库。
 *
 * 不用真实模型：
 *   通过 app.locals.aiProvider 注入假 Provider（ScriptedProvider），
 *   因此不访问外网、不消耗 Token，但工具执行走的是真实 Service 与数据库。
 *
 * 前置条件：
 *   本地数据库已启动（pnpm exec prisma dev）并执行过 pnpm db:seed。
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "../../../src/database/client.js";
import {
  errorHandler,
  notFoundHandler,
} from "../../../src/app/error-handler.js";
import { devAuthMiddleware } from "../../../src/shared/auth/auth.middleware.js";
import { createAiRouter } from "../../../src/modules/ai/routes.js";
import { aiConversationRepository } from "../../../src/modules/ai/repository/ai-conversation.repository.js";
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  LLMProvider,
} from "../../../src/modules/ai/providers/index.js";
import {
  USERS,
  createTestInstance,
  deleteTestInstance,
  readInstanceState,
} from "../questionnaire/helpers.js";

// ============================================================
// 假 Provider（与 orchestrator.test.ts 保持同一种写法）
// ============================================================

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

// ============================================================
// 被测应用（真实 HTTP 服务）
// ============================================================

const AI_BASE = "/api/v1/ai";

let app: Express;
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  // 与 src/app/routes.ts 的装配方式一致：
  // 全局错误处理必须注册在路由之后，否则 OperationError 无法映射成
  // 404 / 403 / 409 / 422，而会变成 500。
  app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(devAuthMiddleware());
  app.use(AI_BASE, createAiRouter());
  app.use(notFoundHandler);
  app.use(errorHandler);

  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
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
// HTTP 小工具
// ============================================================

interface JsonResponse {
  status: number;
  body: {
    success: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string; detail?: unknown };
  };
}

async function request(
  method: "GET" | "POST",
  path: string,
  options: { userId?: string; body?: unknown } = {}
): Promise<JsonResponse> {
  const headers: Record<string, string> = {};
  // 未显式指定时用 dispatcher1：开发态兜底账号，与 USERS.dispatcher 一致
  headers["x-user-id"] = options.userId ?? USERS.dispatcher;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });

  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as JsonResponse["body"]) : ({} as JsonResponse["body"]),
  };
}

/** 通过 API 创建一个 modify_questionnaire 会话，返回它的 id */
async function createModifyConversation(instanceId: string): Promise<string> {
  const res = await request("POST", `${AI_BASE}/conversations`, {
    body: {
      scene: "modify_questionnaire",
      targetType: "questionnaire_instance",
      targetId: instanceId,
    },
  });
  expect(res.status).toBe(201);
  const id = res.body.data?.["conversationId"];
  expect(typeof id).toBe("string");
  return id as string;
}

// ============================================================
// 测试数据清理
// ============================================================

const createdInstances: string[] = [];
const createdConversations: string[] = [];

/**
 * 删除会话。
 *
 * 为什么不用 helpers 里的 deleteTestConversation：
 *   本文件是 HTTP 层测试，需要「先删消息」才能删会话
 *   （ai_messages.conversation_id 有外键，且没有级联删除），
 *   而 helpers 的版本不会碰 ai_messages。
 */
async function deleteConversation(id: string): Promise<void> {
  await prisma.aiToolExecution.deleteMany({ where: { conversationId: id } });
  await prisma.aiMessage.deleteMany({ where: { conversationId: id } });
  await prisma.aiConversation.deleteMany({ where: { id } });
}

async function cleanup(): Promise<void> {
  while (createdConversations.length > 0) {
    const id = createdConversations.pop();
    if (id) await deleteConversation(id);
  }
  while (createdInstances.length > 0) {
    const id = createdInstances.pop();
    if (id) await deleteTestInstance(id);
  }
}

afterEach(cleanup);

// ============================================================
// 1. 创建会话
// ============================================================

describe("POST /ai/conversations", () => {
  it("创建 modify_questionnaire 会话返回 201 与 conversationId", async () => {
    const inst = await createTestInstance();
    createdInstances.push(inst.id);

    const res = await request("POST", `${AI_BASE}/conversations`, {
      body: {
        scene: "modify_questionnaire",
        targetType: "questionnaire_instance",
        targetId: inst.id,
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data?.["conversationId"]).toBe("string");
    expect(res.body.data?.["scene"]).toBe("modify_questionnaire");
    expect(res.body.data?.["targetType"]).toBe("questionnaire_instance");
    expect(res.body.data?.["targetId"]).toBe(inst.id);

    const conversationId = res.body.data?.["conversationId"] as string;
    createdConversations.push(conversationId);

    // 真的落库了，且绑定到当前用户
    const row = await prisma.aiConversation.findUnique({
      where: { id: conversationId },
    });
    expect(row).not.toBeNull();
    expect(row?.userId).toBe(USERS.dispatcher);
    expect(row?.status).toBe("active");
  });

  it("targetId 不存在 → 404（问卷实例不存在）", async () => {
    const res = await request("POST", `${AI_BASE}/conversations`, {
      body: {
        scene: "modify_questionnaire",
        targetId: "00000000-0000-4000-8000-000000000000",
      },
    });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe("QUESTIONNAIRE_NOT_FOUND");
  });

  it("不支持的 scene → 422（在 API 边界就被拒）", async () => {
    const res = await request("POST", `${AI_BASE}/conversations`, {
      body: { scene: "delete_everything" },
    });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe("VALIDATION_ERROR");
  });

  it("已下发的实例创建修改会话 → 409 QUESTIONNAIRE_LOCKED（决策 D1）", async () => {
    const inst = await createTestInstance({ status: "dispatched" });
    createdInstances.push(inst.id);

    const res = await request("POST", `${AI_BASE}/conversations`, {
      body: {
        scene: "modify_questionnaire",
        targetType: "questionnaire_instance",
        targetId: inst.id,
      },
    });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("QUESTIONNAIRE_LOCKED");
    expect(res.body.error?.message).toContain("已下发");

    // 被拒绝时不应留下任何会话
    const count = await prisma.aiConversation.count({
      where: { targetId: inst.id },
    });
    expect(count).toBe(0);
  });
});

// ============================================================
// 2. 发送消息（核心链路）
// ============================================================

describe("POST /ai/conversations/:id/messages", () => {
  it("注入 ScriptedProvider 调 add_section：返回 traces、revision 递增、落库三类消息", async () => {
    const inst = await createTestInstance();
    createdInstances.push(inst.id);
    const conversationId = await createModifyConversation(inst.id);
    createdConversations.push(conversationId);

    const provider = new ScriptedProvider([
      // 第一轮：模型请求调用 add_section
      toolCallReply([
        { id: "call_1", name: "add_section", args: { title: "团伙关系调查" } },
      ]),
      // 第二轮：不再请求工具
      { content: "已增加团伙关系调查模块。", toolCalls: [], model: "scripted" },
    ]);
    app.locals.aiProvider = provider;

    try {
      const res = await request(
        "POST",
        `${AI_BASE}/conversations/${conversationId}/messages`,
        { body: { content: "增加一个团伙关系调查模块。" } }
      );

      // ---- HTTP 契约 ----
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data?.["conversationId"]).toBe(conversationId);
      expect(res.body.data?.["content"]).toBe("已增加团伙关系调查模块。");

      const traces = res.body.data?.["traces"] as { toolName: string; result: { success: boolean } }[];
      expect(Array.isArray(traces)).toBe(true);
      expect(traces.length).toBeGreaterThan(0);
      expect(traces[0]?.toolName).toBe("add_section");
      expect(traces[0]?.result.success).toBe(true);

      // ---- 数据库里的实例 revision 递增 ----
      const state = await readInstanceState(inst.id);
      expect(state?.currentRevision).toBe(inst.initialRevision + 1);
      expect(res.body.data?.["revision"]).toBe(inst.initialRevision + 1);

      const sections = (
        state?.currentSchema as { sections: { title: string }[] }
      ).sections;
      expect(sections.map((s) => s.title)).toContain("团伙关系调查");

      // ---- ai_messages 里落了 user / assistant / tool 三类消息 ----
      const messages = await prisma.aiMessage.findMany({
        where: { conversationId },
        orderBy: { sequenceNo: "asc" },
      });

      const roles = messages.map((m) => m.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");
      expect(roles).toContain("tool");

      // user 消息是本轮原话，且序号从 1 开始连续
      expect(messages[0]?.role).toBe("user");
      expect(messages[0]?.content).toBe("增加一个团伙关系调查模块。");
      expect(messages.map((m) => m.sequenceNo)).toEqual(
        messages.map((_, i) => i + 1)
      );

      // assistant(tool_calls) → tool(result) → assistant(文本) 的顺序
      expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
      const toolMessage = messages.find((m) => m.role === "tool");
      expect(toolMessage?.toolName).toBe("add_section");
      expect(toolMessage?.toolCallId).toBeTruthy();

      // ---- 消息列表接口能还原工具调用链路 ----
      const list = await request(
        "GET",
        `${AI_BASE}/conversations/${conversationId}/messages`
      );
      expect(list.status).toBe(200);
      expect(list.body.data?.["total"]).toBe(4);
      const items = list.body.data?.["items"] as Record<string, unknown>[];
      const assistantWithCall = items.find(
        (m) => m["role"] === "assistant" && m["toolArguments"] !== null
      );
      expect(assistantWithCall).toBeDefined();
      expect(
        (assistantWithCall?.["toolArguments"] as { name: string }[])[0]?.name
      ).toBe("add_section");
    } finally {
      // 必须清掉注入点，否则会污染后续用例（生产路径本不该有它）
      delete app.locals.aiProvider;
    }
  });

  it("content 为空 → 422", async () => {
    const inst = await createTestInstance();
    createdInstances.push(inst.id);
    const conversationId = await createModifyConversation(inst.id);
    createdConversations.push(conversationId);

    // 空字符串：在 API 边界被 Zod 拦下
    const empty = await request(
      "POST",
      `${AI_BASE}/conversations/${conversationId}/messages`,
      { body: { content: "" } }
    );
    expect(empty.status).toBe(422);
    expect(empty.body.error?.code).toBe("VALIDATION_ERROR");

    // 纯空白：通过 Zod，但 Service 的 trim 校验同样拒绝（仍是 422）
    const blank = await request(
      "POST",
      `${AI_BASE}/conversations/${conversationId}/messages`,
      { body: { content: "   " } }
    );
    expect(blank.status).toBe(422);
    expect(blank.body.error?.code).toBe("VALIDATION_ERROR");
  });
});

// ============================================================
// 3. 读取与权限
// ============================================================

describe("会话读取与权限", () => {
  it("访问不存在的会话 → 404", async () => {
    const res = await request(
      "GET",
      `${AI_BASE}/conversations/00000000-0000-4000-8000-000000000000`
    );

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("AI_CONVERSATION_NOT_FOUND");
  });

  it("访问他人的会话 → 403", async () => {
    const inst = await createTestInstance();
    createdInstances.push(inst.id);
    const conversationId = await createModifyConversation(inst.id);
    createdConversations.push(conversationId);

    // 详情、消息列表、关闭都必须拒绝（V1 不开放跨用户查看）
    for (const [method, path] of [
      ["GET", `${AI_BASE}/conversations/${conversationId}`],
      ["GET", `${AI_BASE}/conversations/${conversationId}/messages`],
      ["POST", `${AI_BASE}/conversations/${conversationId}/close`],
    ] as const) {
      const res = await request(method, path, { userId: USERS.investigator });
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe("PERMISSION_DENIED");
    }

    // 会话状态没有被他人改成 closed
    const row = await prisma.aiConversation.findUnique({
      where: { id: conversationId },
    });
    expect(row?.status).toBe("active");
  });
});

// ============================================================
// 4. 分页
// ============================================================

describe("分页", () => {
  it("消息列表分页正确（total 与 items 数量）", async () => {
    const inst = await createTestInstance();
    createdInstances.push(inst.id);
    const conversationId = await createModifyConversation(inst.id);
    createdConversations.push(conversationId);

    // 直接经 Repository 造 4 条消息（不驱动模型，专注分页本身）
    for (let i = 1; i <= 4; i += 1) {
      await aiConversationRepository.appendMessage({
        conversationId,
        role: i % 2 === 1 ? "user" : "assistant",
        content: `第 ${i} 条`,
      });
    }

    const first = await request(
      "GET",
      `${AI_BASE}/conversations/${conversationId}/messages?page=1&pageSize=2`
    );
    expect(first.status).toBe(200);
    expect(first.body.data?.["total"]).toBe(4);
    expect(first.body.data?.["page"]).toBe(1);
    expect(first.body.data?.["pageSize"]).toBe(2);
    expect((first.body.data?.["items"] as unknown[]).length).toBe(2);
    expect(
      (first.body.data?.["items"] as { sequenceNo: number }[]).map(
        (m) => m.sequenceNo
      )
    ).toEqual([1, 2]);

    const third = await request(
      "GET",
      `${AI_BASE}/conversations/${conversationId}/messages?page=3&pageSize=2`
    );
    expect(third.body.data?.["total"]).toBe(4);
    expect((third.body.data?.["items"] as unknown[]).length).toBe(0);

    // pageSize 超过上限时收敛到 100（05 文档第 36 节）
    const capped = await request(
      "GET",
      `${AI_BASE}/conversations/${conversationId}/messages?page=1&pageSize=1000`
    );
    expect(capped.body.data?.["pageSize"]).toBe(100);
  });

  it("会话列表只返回自己的会话（分页结构完整）", async () => {
    const inst = await createTestInstance();
    createdInstances.push(inst.id);
    const conversationId = await createModifyConversation(inst.id);
    createdConversations.push(conversationId);

    const mine = await request("GET", `${AI_BASE}/conversations`);
    expect(mine.status).toBe(200);
    expect(typeof mine.body.data?.["total"]).toBe("number");
    expect(mine.body.data?.["page"]).toBe(1);
    expect(mine.body.data?.["pageSize"]).toBe(20);
    const myIds = (mine.body.data?.["items"] as { id: string }[]).map(
      (c) => c.id
    );
    expect(myIds).toContain(conversationId);

    // 换个用户就看别人的会话列表里没有它
    const others = await request("GET", `${AI_BASE}/conversations`, {
      userId: USERS.investigator,
    });
    expect(others.status).toBe(200);
    const otherIds = (others.body.data?.["items"] as { id: string }[]).map(
      (c) => c.id
    );
    expect(otherIds).not.toContain(conversationId);
  });
});

// ============================================================
// 5. 会话详情与关闭
// ============================================================

describe("会话详情与关闭", () => {
  it("会话详情返回绑定信息，关闭后 status 变为 closed", async () => {
    const inst = await createTestInstance();
    createdInstances.push(inst.id);
    const conversationId = await createModifyConversation(inst.id);
    createdConversations.push(conversationId);

    const detail = await request(
      "GET",
      `${AI_BASE}/conversations/${conversationId}`
    );
    expect(detail.status).toBe(200);
    expect(detail.body.data?.["id"]).toBe(conversationId);
    expect(detail.body.data?.["scene"]).toBe("modify_questionnaire");
    expect(detail.body.data?.["targetId"]).toBe(inst.id);
    expect(detail.body.data?.["status"]).toBe("active");

    const closed = await request(
      "POST",
      `${AI_BASE}/conversations/${conversationId}/close`
    );
    expect(closed.status).toBe(200);
    expect(closed.body.data?.["status"]).toBe("closed");

    const row = await prisma.aiConversation.findUnique({
      where: { id: conversationId },
    });
    expect(row?.status).toBe("closed");
  });
});

// ============================================================
// 6. 未认证
// ============================================================

describe("鉴权", () => {
  it("未知的 x-user-id → 401（不会退化成匿名）", async () => {
    const res = await request("GET", `${AI_BASE}/conversations`, {
      userId: "00000000-0000-4000-8000-0000000000ff",
    });
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe("UNAUTHORIZED");
  });
});
