/**
 * DeepSeek Provider（OpenAI 兼容协议）。
 *
 * 依据决策 D12：V1 使用 DeepSeek `deepseek-v41-flash`。
 * 依据决策 D13：所有连接参数来自环境变量，
 *   迁内网时只改 AI_BASE_URL / AI_API_KEY / AI_MODEL，本文件不动。
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
      res = await fetch(`${this.baseUrl}/chat/completions`, {
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
