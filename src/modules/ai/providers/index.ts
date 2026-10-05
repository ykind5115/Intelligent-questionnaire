/**
 * LLM Provider 统一出口。
 *
 * 决策 D13：迁内网换模型时，只需在此处替换/新增实现，
 * 业务层与 Orchestrator 不需要改动。
 */
export {
  type LLMProvider,
  type ChatMessage,
  type ChatResult,
  type ChatOptions,
  type ChatEvent,
  type ChatRole,
  type ChatUsage,
  type ProviderToolSpec,
  type ToolCallRequest,
  LLMError,
} from "./llm-provider.js";

export {
  DeepSeekProvider,
  createLLMProvider,
  type DeepSeekProviderOptions,
} from "./deepseek.provider.js";
