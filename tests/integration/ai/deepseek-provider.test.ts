/**
 * DeepSeekProvider 线格式测试。
 *
 * 为什么需要这一层测试：
 *   Orchestrator 用的是假 Provider，只验证了「循环逻辑」；
 *   Tool/Service 验证的是业务。而 Provider 与真实模型之间的
 *   HTTP 线格式（请求体形状、SSE 分片解析）此前完全没被覆盖，
 *   只有接上真实端点才会暴露问题。
 *
 * 这里用本机 mock HTTP 服务充当模型端点，
 * 因此**不需要真实 API Key，也不访问外网**。
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { DeepSeekProvider } from "../../../src/modules/ai/providers/index.js";
import { LLMError } from "../../../src/modules/ai/providers/llm-provider.js";

// ============================================================
// Mock 模型端点
// ============================================================

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

interface MockEndpointOptions {
  /** 非流式响应体 */
  json?: unknown;
  /** 流式响应分片（原样写入，用于测试 SSE 解析） */
  sse?: string[];
  /** 返回的 HTTP 状态码，默认 200 */
  status?: number;
  /** 返回的原始文本（用于模拟非 JSON 错误体） */
  rawText?: string;
  /** 响应前延迟毫秒数（用于测试超时） */
  delayMs?: number;
}

class MockEndpoint {
  private server: Server | undefined;
  readonly requests: CapturedRequest[] = [];
  private port = 0;

  constructor(private readonly options: MockEndpointOptions) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          body = {};
        }
        this.requests.push({
          url: req.url ?? "",
          method: req.method ?? "",
          headers: req.headers,
          body,
        });

        const send = () => {
          const status = this.options.status ?? 200;

          if (this.options.rawText !== undefined) {
            res.writeHead(status, { "Content-Type": "text/plain" });
            res.end(this.options.rawText);
            return;
          }

          if (this.options.sse) {
            res.writeHead(status, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            for (const chunk of this.options.sse) {
              res.write(chunk);
            }
            res.end();
            return;
          }

          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.options.json ?? {}));
        };

        if (this.options.delayMs) {
          setTimeout(send, this.options.delayMs);
        } else {
          send();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, "127.0.0.1", () => resolve());
    });

    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("无法获取 mock 服务端口");
    }
    this.port = address.port;
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = undefined;
  }
}

/** 每个测试都建自己的 mock 端点，避免相互干扰 */
let active: MockEndpoint | undefined;

async function startEndpoint(
  options: MockEndpointOptions
): Promise<{ baseUrl: string; endpoint: MockEndpoint }> {
  const endpoint = new MockEndpoint(options);
  active = endpoint;
  const baseUrl = await endpoint.start();
  return { baseUrl, endpoint };
}

afterEach(async () => {
  if (active) {
    await active.stop();
    active = undefined;
  }
});

function makeProvider(baseUrl: string, apiKey = "test-key"): DeepSeekProvider {
  return new DeepSeekProvider({
    baseUrl,
    apiKey,
    model: "deepseek-v41-flash",
  });
}

// ============================================================
// base URL 归一化（来自一次真实的 404 故障）
//
// 现象：AI_BASE_URL 填成了 Anthropic 兼容端点
//   https://api.deepseek.com/anthropic
// 而本 provider 走 OpenAI 协议，会拼成
//   /anthropic/chat/completions  → 404 且响应体为空，极难排查。
//
// 这里把几种常见写法固定下来，避免再退化。
// ============================================================

describe("DeepSeekProvider - base URL 归一化", () => {
  const cases: { name: string; suffix: string; expectPath: string }[] = [
    { name: "裸域名", suffix: "", expectPath: "/chat/completions" },
    { name: "带 /v1", suffix: "/v1", expectPath: "/chat/completions" },
    { name: "带尾斜杠", suffix: "/", expectPath: "/chat/completions" },
    { name: "带 /v1/", suffix: "/v1/", expectPath: "/chat/completions" },
  ];

  for (const c of cases) {
    it(`${c.name} → 请求 ${c.expectPath}`, async () => {
      const { baseUrl, endpoint } = await startEndpoint({
        json: {
          model: "deepseek-flash",
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        },
      });

      // mock 端点返回的是 http://127.0.0.1:port
      await makeProvider(baseUrl + c.suffix).chat([
        { role: "user", content: "hi" },
      ]);

      expect(endpoint.requests[0]?.url).toBe(c.expectPath);
    });
  }

  it("填成 Anthropic 端点时给出明确警告（而不是等一个空 body 的 404）", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      // 只构造，不发请求
      new DeepSeekProvider({
        baseUrl: "https://api.deepseek.com/anthropic",
        apiKey: "test-key",
        model: "deepseek-flash",
      });
    } finally {
      console.warn = original;
    }

    const joined = warnings.join("\n");
    expect(joined).toContain("Anthropic");
    // 提示里要给出可执行的修法
    expect(joined).toContain("https://api.deepseek.com");
  });

  it("正常的 OpenAI 端点不会触发警告", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const { baseUrl } = await startEndpoint({
        json: {
          model: "deepseek-flash",
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        },
      });
      new DeepSeekProvider({
        baseUrl,
        apiKey: "test-key",
        model: "deepseek-flash",
      });
    } finally {
      console.warn = original;
    }

    expect(warnings.join("\n")).not.toContain("Anthropic");
  });
});

// ============================================================
// 非流式
// ============================================================

describe("DeepSeekProvider.chat - 请求线格式", () => {
  it("POST 到 /chat/completions，带 Bearer 认证与 JSON 头", async () => {
    const { baseUrl, endpoint } = await startEndpoint({
      json: {
        model: "deepseek-v41-flash",
        choices: [{ message: { content: "好的" }, finish_reason: "stop" }],
      },
    });

    await makeProvider(baseUrl).chat([{ role: "user", content: "你好" }]);

    const req = endpoint.requests[0];
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe("/chat/completions");
    expect(req?.headers["authorization"]).toBe("Bearer test-key");
    expect(String(req?.headers["content-type"])).toContain("application/json");
  });

  it("请求体包含 model / messages / stream=false", async () => {
    const { baseUrl, endpoint } = await startEndpoint({
      json: { choices: [{ message: { content: "ok" } }] },
    });

    await makeProvider(baseUrl).chat([{ role: "user", content: "你好" }]);

    const body = endpoint.requests[0]?.body;
    expect(body?.["model"]).toBe("deepseek-v41-flash");
    expect(body?.["stream"]).toBe(false);
    expect(body?.["messages"]).toEqual([
      { role: "user", content: "你好" },
    ]);
  });

  it("传入 tools 时同时带上 tool_choice=auto", async () => {
    const { baseUrl, endpoint } = await startEndpoint({
      json: { choices: [{ message: { content: "ok" } }] },
    });

    await makeProvider(baseUrl).chat([{ role: "user", content: "x" }], {
      tools: [
        {
          type: "function",
          function: {
            name: "add_section",
            description: "新增分组",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });

    const body = endpoint.requests[0]?.body;
    expect(body?.["tool_choice"]).toBe("auto");
    expect(Array.isArray(body?.["tools"])).toBe(true);
  });

  it("temperature 与 maxTokens 映射为 temperature / max_tokens", async () => {
    const { baseUrl, endpoint } = await startEndpoint({
      json: { choices: [{ message: { content: "ok" } }] },
    });

    await makeProvider(baseUrl).chat([{ role: "user", content: "x" }], {
      temperature: 0.2,
      maxTokens: 4096,
    });

    const body = endpoint.requests[0]?.body;
    expect(body?.["temperature"]).toBe(0.2);
    expect(body?.["max_tokens"]).toBe(4096);
  });

  it("tool 角色的消息带上 tool_call_id（回灌工具结果时的正确线格式）", async () => {
    const { baseUrl, endpoint } = await startEndpoint({
      json: { choices: [{ message: { content: "ok" } }] },
    });

    await makeProvider(baseUrl).chat([
      { role: "user", content: "增加一个问题" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "call_1", name: "add_section", arguments: '{"title":"A"}' },
        ],
      },
      {
        role: "tool",
        content: '{"success":true}',
        toolCallId: "call_1",
        name: "add_section",
      },
    ]);

    const messages = endpoint.requests[0]?.body["messages"] as Record<
      string,
      unknown
    >[];

    // assistant 消息必须把 toolCalls 转成线格式的 tool_calls
    expect(messages[1]?.["tool_calls"]).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "add_section", arguments: '{"title":"A"}' },
      },
    ]);

    // tool 消息必须带 tool_call_id
    expect(messages[2]?.["tool_call_id"]).toBe("call_1");
    expect(messages[2]?.["name"]).toBe("add_section");
  });
});

describe("DeepSeekProvider.chat - 响应解析", () => {
  it("解析文本内容、model、finish_reason 与 usage", async () => {
    const { baseUrl } = await startEndpoint({
      json: {
        model: "deepseek-v41-flash",
        choices: [
          { message: { content: "需要帮你做什么？" }, finish_reason: "stop" },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      },
    });

    const result = await makeProvider(baseUrl).chat([
      { role: "user", content: "hi" },
    ]);

    expect(result.content).toBe("需要帮你做什么？");
    expect(result.model).toBe("deepseek-v41-flash");
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toEqual([]);
    expect(result.usage?.totalTokens).toBe(15);
  });

  it("解析 tool_calls（含 arguments 字符串原样保留）", async () => {
    const { baseUrl } = await startEndpoint({
      json: {
        model: "deepseek-v41-flash",
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_abc",
                  function: {
                    name: "add_question",
                    arguments: '{"title":"是否拥有无人机？","type":"boolean"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    });

    const result = await makeProvider(baseUrl).chat([
      { role: "user", content: "加一题" },
    ]);

    expect(result.content).toBeNull();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.id).toBe("call_abc");
    expect(result.toolCalls[0]?.name).toBe("add_question");
    expect(JSON.parse(result.toolCalls[0]?.arguments ?? "{}")).toEqual({
      title: "是否拥有无人机？",
      type: "boolean",
    });
  });
});

describe("DeepSeekProvider - 错误处理", () => {
  it("缺少 API Key 时抛出 LLMError(AI_API_KEY_MISSING)，且不发请求", async () => {
    const { baseUrl, endpoint } = await startEndpoint({
      json: { choices: [{ message: { content: "x" } }] },
    });

    const provider = new DeepSeekProvider({
      baseUrl,
      apiKey: "",
      model: "m",
    });

    await expect(
      provider.chat([{ role: "user", content: "x" }])
    ).rejects.toThrow(LLMError);

    await provider
      .chat([{ role: "user", content: "x" }])
      .catch((e: LLMError) => {
        expect(e.code).toBe("AI_API_KEY_MISSING");
      });

    expect(endpoint.requests).toHaveLength(0);
  });

  it("5xx 抛出可重试的 LLM_HTTP_ERROR，且保留状态码", async () => {
    const { baseUrl } = await startEndpoint({
      status: 503,
      rawText: "service unavailable",
    });

    const provider = makeProvider(baseUrl);

    await provider.chat([{ role: "user", content: "x" }]).catch((e: LLMError) => {
      expect(e).toBeInstanceOf(LLMError);
      expect(e.code).toBe("LLM_HTTP_ERROR");
      expect(e.status).toBe(503);
      expect(e.retryable).toBe(true);
    });

    await expect(
      provider.chat([{ role: "user", content: "x" }])
    ).rejects.toThrow(/503/);
  });

  it("4xx 抛出不可重试的错误", async () => {
    const { baseUrl } = await startEndpoint({
      status: 400,
      rawText: "bad request",
    });

    await makeProvider(baseUrl)
      .chat([{ role: "user", content: "x" }])
      .catch((e: LLMError) => {
        expect(e.status).toBe(400);
        expect(e.retryable).toBe(false);
      });
  });

  it("响应体里带 error 字段时抛出 LLM_API_ERROR", async () => {
    const { baseUrl } = await startEndpoint({
      json: { error: { message: "模型配额不足" } },
    });

    await makeProvider(baseUrl)
      .chat([{ role: "user", content: "x" }])
      .catch((e: LLMError) => {
        expect(e.code).toBe("LLM_API_ERROR");
        expect(e.message).toContain("模型配额不足");
      });
  });

  it("连接失败时抛出可重试的 LLM_REQUEST_FAILED", async () => {
    // 指向一个没有服务的端口
    const provider = new DeepSeekProvider({
      baseUrl: "http://127.0.0.1:1",
      apiKey: "k",
      model: "m",
      timeoutMs: 3000,
    });

    await provider
      .chat([{ role: "user", content: "x" }])
      .catch((e: LLMError) => {
        expect(e.code).toBe("LLM_REQUEST_FAILED");
        expect(e.retryable).toBe(true);
      });
  });
});

// ============================================================
// 流式
// ============================================================

describe("DeepSeekProvider.chatStream - SSE 解析", () => {
  it("请求体带 stream=true", async () => {
    const { baseUrl, endpoint } = await startEndpoint({
      sse: ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"],
    });

    const events = [];
    for await (const e of makeProvider(baseUrl).chatStream([
      { role: "user", content: "x" },
    ])) {
      events.push(e);
    }

    expect(endpoint.requests[0]?.body["stream"]).toBe(true);
  });

  it("逐片产出 text_delta，最后产出 done", async () => {
    const { baseUrl } = await startEndpoint({
      sse: [
        'data: {"model":"deepseek-v41-flash","choices":[{"delta":{"content":"好的"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"，我先"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"建立问卷。"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ],
    });

    const texts: string[] = [];
    let done: { content: string | null; model: string } | undefined;

    for await (const e of makeProvider(baseUrl).chatStream([
      { role: "user", content: "x" },
    ])) {
      if (e.type === "text_delta") texts.push(e.text);
      if (e.type === "done") done = e.result;
    }

    expect(texts).toEqual(["好的", "，我先", "建立问卷。"]);
    expect(done?.content).toBe("好的，我先建立问卷。");
    expect(done?.model).toBe("deepseek-v41-flash");
  });

  it("按 index 聚合跨分片的 tool_calls 参数", async () => {
    const { baseUrl } = await startEndpoint({
      sse: [
        // 第一片：给出工具名与 id
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"add_question","arguments":"{\\"title\\":"}}]}}]}\n\n',
        // 第二片：arguments 续传
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"是否拥有无人机？\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ],
    });

    const calls: { id: string; name: string; arguments: string }[] = [];
    let done: { toolCalls: typeof calls } | undefined;

    for await (const e of makeProvider(baseUrl).chatStream([
      { role: "user", content: "x" },
    ])) {
      if (e.type === "tool_call") calls.push(e.call);
      if (e.type === "done") done = e.result;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe("call_1");
    expect(calls[0]?.name).toBe("add_question");
    // 参数被完整拼回来，并且是合法 JSON
    expect(JSON.parse(calls[0]?.arguments ?? "{}")).toEqual({
      title: "是否拥有无人机？",
    });
    expect(done?.toolCalls[0]?.arguments).toBe('{"title":"是否拥有无人机？"}');
  });

  it("同时返回文本与工具调用时两者都保留", async () => {
    const { baseUrl } = await startEndpoint({
      sse: [
        'data: {"choices":[{"delta":{"content":"我来增加这一题。"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"add_section","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ],
    });

    let text = "";
    const names: string[] = [];
    for await (const e of makeProvider(baseUrl).chatStream([
      { role: "user", content: "x" },
    ])) {
      if (e.type === "text_delta") text += e.text;
      if (e.type === "tool_call") names.push(e.call.name);
    }

    expect(text).toBe("我来增加这一题。");
    expect(names).toEqual(["add_section"]);
  });

  it("忽略无法解析的分片，不中断整个流", async () => {
    const { baseUrl } = await startEndpoint({
      sse: [
        'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
        "data: {这不是合法JSON\n\n",
        'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
        "data: [DONE]\n\n",
      ],
    });

    let text = "";
    for await (const e of makeProvider(baseUrl).chatStream([
      { role: "user", content: "x" },
    ])) {
      if (e.type === "text_delta") text += e.text;
    }

    expect(text).toBe("AB");
  });

  it("忽略非 data: 行（注释、空行）", async () => {
    const { baseUrl } = await startEndpoint({
      sse: [
        ": keep-alive comment\n\n",
        'data: {"choices":[{"delta":{"content":"X"}}]}\n\n',
        "\n",
        "data: [DONE]\n\n",
      ],
    });

    let text = "";
    for await (const e of makeProvider(baseUrl).chatStream([
      { role: "user", content: "x" },
    ])) {
      if (e.type === "text_delta") text += e.text;
    }

    expect(text).toBe("X");
  });
});

// ============================================================
// 配置
// ============================================================

describe("DeepSeekProvider - baseUrl 处理", () => {
  it("去掉结尾斜杠，避免拼出 //chat/completions", async () => {
    const { baseUrl, endpoint } = await startEndpoint({
      json: { choices: [{ message: { content: "ok" } }] },
    });

    await makeProvider(`${baseUrl}///`).chat([
      { role: "user", content: "x" },
    ]);

    expect(endpoint.requests[0]?.url).toBe("/chat/completions");
  });
});
