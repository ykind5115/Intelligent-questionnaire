/**
 * DeepSeek Provider（OpenAI 兼容协议）。
 *
 * 依据决策 D12：V1 使用 DeepSeek 的 OpenAI 兼容接口。
 *   （决策记录里写的是 `deepseek-v41-flash`；该模型已退役，
 *    官方现在接受 `deepseek-flash`（默认）与 `deepseek-v4-pro`，
 *    旧的 `deepseek-v4-flash` 名字仍被接受但会由新模型承接。
 *    本 Provider 不关心具体模型名 —— 它只把 env.AI_MODEL 原样传下去，
 *    因此换模型不需要改代码。）
 *
 * 依据决策 D13：所有连接参数来自环境变量，
 *   迁内网时只改 AI_BASE_URL / AI_API_KEY / AI_MODEL，本文件不动。
 *
 * 注意 base URL 必须是 **OpenAI 兼容**的根地址；
 *   填成 Anthropic 兼容端点（/anthropic）会 404，见 buildChatCompletionsUrl 的说明。
 */
import { env, isProduction } from "../../../config/env.js";
import {
  LLMError,
  type ChatEvent,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type LLMProvider,
  type ProviderToolSpec,
  type ToolCallRequest,
} from "./llm-provider.js";

/**
 * DeepSeek 默认端点。
 *
 * 决策 D13 要求「不得硬编码 base URL」（迁内网时容易漏配而静默打公网），
 * 但完全不给默认值会让本地开发必须先手填 AI_BASE_URL 才能跑。
 *
 * 折中做法：
 *   1. 默认值只作为「非生产环境」的便利，且必须显式声明；
 *   2. 生产环境（NODE_ENV=production）若未配置 AI_BASE_URL，直接拒绝构造，
 *      避免静默访问公网服务。
 */
const DEV_DEFAULT_BASE_URL = "https://api.deepseek.com";

/**
 * 组装 chat completions 的完整 URL。
 *
 * 兼容三种写法，避免「少写或多写 /v1」这类常见配置错误：
 *   https://api.deepseek.com      → https://api.deepseek.com/chat/completions
 *   https://api.deepseek.com/v1   → https://api.deepseek.com/chat/completions
 *   http://localhost:8000/v1      → http://localhost:8000/chat/completions
 *   http://localhost:8000         → http://localhost:8000/chat/completions
 *
 * 迁内网时自研服务多半是 OpenAI 兼容的 `/v1/...`，因此不能简单粗暴地
 * 一律追加 `/chat/completions`（会变成 `/v1/chat/completions` 缺失或重复）。
 */
function buildChatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${base}/chat/completions`;
}

/**
 * 识别「填成了 Anthropic 兼容端点」这一常见配置错误。
 *
 * DeepSeek 同时提供两套兼容协议：
 *   OpenAI  兼容：https://api.deepseek.com            （本项目使用）
 *   Anthropic 兼容：https://api.deepseek.com/anthropic （路径为 /v1/messages）
 *
 * 若把 Anthropic 端点填进 AI_BASE_URL，请求会打到
 * /anthropic/chat/completions —— 该路径不存在，返回 **404 且响应体为空**，
 * 非常难排查（本次就是这样踩到的）。因此这里提前给出明确提示。
 */
function looksLikeAnthropicEndpoint(baseUrl: string): boolean {
  return /\/anthropic\/?$/.test(baseUrl.trim());
}

/** 与 OpenAI 兼容协议的线格式（仅限本文件内部使用） */
interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
  name?: string;
}

interface WireResponse {
  model?: string;
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: {
        id: string;
        function: { name: string; arguments: string };
      }[];
    };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: string };
}

/** 把中立消息转成线格式 */
function toWireMessage(m: ChatMessage): WireMessage {
  const wire: WireMessage = { role: m.role, content: m.content };

  if (m.toolCalls && m.toolCalls.length > 0) {
    wire.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.name, arguments: c.arguments },
    }));
  }
  if (m.toolCallId !== undefined) wire.tool_call_id = m.toolCallId;
  if (m.name !== undefined) wire.name = m.name;

  return wire;
}

function parseToolCalls(
  raw: { id: string; function: { name: string; arguments: string } }[] | undefined
): ToolCallRequest[] {
  if (!raw) return [];
  return raw.map((c) => ({
    id: c.id,
    name: c.function.name,
    arguments: c.function.arguments,
  }));
}

export interface DeepSeekProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** 单次请求超时（毫秒） */
  timeoutMs?: number;
}

export class DeepSeekProvider implements LLMProvider {
  readonly name = "deepseek";

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: DeepSeekProviderOptions = {}) {
    const configured = (options.baseUrl ?? env.AI_BASE_URL ?? "").trim();

    if (!configured && isProduction) {
      // 迁内网时如果漏配 AI_BASE_URL，默认值会静默把敏感的案件数据
      // 发到公网的 DeepSeek —— 这违反决策 D13，因此生产环境直接拒绝启动。
      throw new Error(
        [
          "生产环境必须显式配置 AI_BASE_URL（决策 D13）。",
          "若迁移到内网自研模型，请把 AI_BASE_URL 指向内网服务地址；",
          "依赖默认的公网 DeepSeek 端点会把业务数据发往公网。",
        ].join(" ")
      );
    }

    this.baseUrl = (configured || DEV_DEFAULT_BASE_URL).replace(/\/+$/, "");

    // 配置写错时给出**可定位**的提示，而不是等到一个空 body 的 404。
    if (looksLikeAnthropicEndpoint(this.baseUrl)) {
      // 不直接抛错：也许是内网某个恰好以 /anthropic 结尾的 OpenAI 兼容网关。
      // 但必须让人看到，否则排查成本极高。
      console.warn(
        [
          "[DeepSeekProvider] AI_BASE_URL 看起来是 Anthropic 兼容端点：",
          this.baseUrl,
          "本项目走 OpenAI 兼容协议，会请求",
          buildChatCompletionsUrl(this.baseUrl),
          "——该路径通常不存在（404 且响应体为空）。",
          "若使用 DeepSeek 官方服务，请改为 https://api.deepseek.com",
        ].join(" ")
      );
    }
    this.apiKey = options.apiKey ?? env.AI_API_KEY;
    this.model = options.model ?? env.AI_MODEL;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  private buildBody(
    messages: ChatMessage[],
    options: ChatOptions,
    stream: boolean
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: options.model ?? this.model,
      messages: messages.map(toWireMessage),
      stream,
    };

    if (options.temperature !== undefined) {
      body["temperature"] = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      body["max_tokens"] = options.maxTokens;
    }
    if (options.tools && options.tools.length > 0) {
      body["tools"] = options.tools as ProviderToolSpec[];
      body["tool_choice"] = "auto";
    }
    if (options.parallelToolCalls !== undefined) {
      body["parallel_tool_calls"] = options.parallelToolCalls;
    }

    return body;
  }

  private async post(
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Response> {
    if (!this.apiKey) {
      throw new LLMError(
        "AI_API_KEY_MISSING",
        "未配置 AI_API_KEY，无法调用模型接口。请在 .env 中填写（见 .env.example）"
      );
    }

    // 超时与外部取消信号合并
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combined = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    let res: Response;
    try {
      res = await fetch(buildChatCompletionsUrl(this.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LLMError("LLM_REQUEST_FAILED", `模型请求失败：${message}`, {
        retryable: true,
      });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LLMError(
        "LLM_HTTP_ERROR",
        `模型接口返回 ${res.status}：${text.slice(0, 500)}`,
        { status: res.status, retryable: res.status >= 500 || res.status === 429 }
      );
    }

    return res;
  }

  async chat(
    messages: ChatMessage[],
    options: ChatOptions = {}
  ): Promise<ChatResult> {
    const res = await this.post(
      this.buildBody(messages, options, false),
      options.signal
    );

    const data = (await res.json()) as WireResponse;

    if (data.error) {
      throw new LLMError(
        "LLM_API_ERROR",
        `模型返回错误：${data.error.message ?? JSON.stringify(data.error)}`
      );
    }

    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? null;
    const toolCalls = parseToolCalls(choice?.message?.tool_calls);

    return {
      content,
      toolCalls,
      model: data.model ?? options.model ?? this.model,
      ...(data.usage
        ? {
            usage: {
              ...(data.usage.prompt_tokens !== undefined
                ? { promptTokens: data.usage.prompt_tokens }
                : {}),
              ...(data.usage.completion_tokens !== undefined
                ? { completionTokens: data.usage.completion_tokens }
                : {}),
              ...(data.usage.total_tokens !== undefined
                ? { totalTokens: data.usage.total_tokens }
                : {}),
            },
          }
        : {}),
      ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
    };
  }

  async *chatStream(
    messages: ChatMessage[],
    options: ChatOptions = {}
  ): AsyncIterable<ChatEvent> {
    const res = await this.post(
      this.buildBody(messages, options, true),
      options.signal
    );

    if (!res.body) {
      throw new LLMError("LLM_EMPTY_STREAM", "模型返回了空的流式响应");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // 汇总最终的完整结果（流式过程中逐步拼装）
    let fullContent = "";
    const toolCallsByIndex = new Map<
      number,
      { id: string; name: string; args: string }
    >();
    let model = options.model ?? this.model;
    let finishReason: string | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE：事件之间以空行分隔
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          for (const line of part.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;

            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") continue;

            let chunk: {
              model?: string;
              choices?: {
                delta?: {
                  content?: string | null;
                  tool_calls?: {
                    index: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }[];
                };
                finish_reason?: string;
              }[];
            };

            try {
              chunk = JSON.parse(payload);
            } catch {
              continue; // 忽略无法解析的分片，不中断整个流
            }

            if (chunk.model) model = chunk.model;

            const choice = chunk.choices?.[0];
            if (!choice) continue;

            if (choice.finish_reason) finishReason = choice.finish_reason;

            const delta = choice.delta;

            if (delta?.content) {
              fullContent += delta.content;
              yield { type: "text_delta", text: delta.content };
            }

            for (const tc of delta?.tool_calls ?? []) {
              const existing = toolCallsByIndex.get(tc.index) ?? {
                id: "",
                name: "",
                args: "",
              };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) {
                existing.args += tc.function.arguments;
              }
              toolCallsByIndex.set(tc.index, existing);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls: ToolCallRequest[] = [...toolCallsByIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ id: v.id, name: v.name, arguments: v.args }));

    for (const call of toolCalls) {
      yield { type: "tool_call", call };
    }

    yield {
      type: "done",
      result: {
        content: fullContent.length > 0 ? fullContent : null,
        toolCalls,
        model,
        ...(finishReason ? { finishReason } : {}),
      },
    };
  }
}

/** 工厂：按配置创建 Provider，便于将来替换 */
export function createLLMProvider(): LLMProvider {
  return new DeepSeekProvider();
}
