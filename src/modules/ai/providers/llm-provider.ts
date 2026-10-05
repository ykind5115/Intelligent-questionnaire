/**
 * LLM Provider 抽象。
 *
 * 依据 docs/06-proj_init.md 第 24 至 25 节与决策 D13：
 *   Orchestrator 不允许直接 fetch 某个模型 API。
 *   迁内网换模型时，只替换 Provider 实现，业务层零改动。
 *
 * 因此本文件中的类型必须是**中立的**：
 *   不得出现任何厂商专有概念（字段名、错误码、特殊参数）。
 *   OpenAI 兼容只是其中一种实现的内部细节。
 */

// ============================================================
// 消息
// ============================================================

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCallRequest {
  /** 模型给出的调用 ID，回传结果时必须带上 */
  id: string;
  name: string;
  /** 模型给的原始参数（字符串形式 JSON），需自行解析与校验 */
  arguments: string;
}

export interface ChatMessage {
  role: ChatRole;
  /** 文本内容；tool 消息可为空 */
  content: string | null;
  /** 仅 assistant 消息可能有：模型请求调用的工具 */
  toolCalls?: ToolCallRequest[];
  /** 仅 tool 消息需要：对应哪一次调用 */
  toolCallId?: string;
  /** 仅 tool 消息需要：工具名（部分厂商要求） */
  name?: string;
}

// ============================================================
// 工具定义（发给模型的格式）
// ============================================================

export interface ProviderToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ============================================================
// 调用选项与结果
// ============================================================

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ProviderToolSpec[];
  /** 是否允许模型并行发起多个工具调用 */
  parallelToolCalls?: boolean;
  signal?: AbortSignal;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatResult {
  /** 模型的文本回复，可能为空（纯工具调用回合） */
  content: string | null;
  /** 模型请求调用的工具，可能为空 */
  toolCalls: ToolCallRequest[];
  /** 用于审计：本次实际使用的模型标识 */
  model: string;
  usage?: ChatUsage;
  /** 结束原因，例如 stop / tool_calls / length */
  finishReason?: string;
}

/** 流式事件（SSE 用） */
export type ChatEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ToolCallRequest }
  | { type: "done"; result: ChatResult };

/**
 * Provider 接口。
 *
 * 只暴露两个方法：一次性对话与流式对话。
 * 这样上层（Orchestrator）只依赖这个契约，
 * 至于底层是 HTTP、SDK 还是本地模型，与本层无关。
 */
export interface LLMProvider {
  /** 供日志/审计使用的可读名称 */
  readonly name: string;

  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>;

  chatStream(
    messages: ChatMessage[],
    options?: ChatOptions
  ): AsyncIterable<ChatEvent>;
}

// ============================================================
// 异常
// ============================================================

export class LLMError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; status?: number } = {}
  ) {
    super(message);
    this.name = "LLMError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.status !== undefined) this.status = options.status;
  }
}
