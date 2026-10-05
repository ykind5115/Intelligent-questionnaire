/**
 * AI Tool 层统一出口。
 */
export {
  toolRegistry,
  runTool,
  toLlmToolSpec,
  allLlmToolSpecs,
  ALL_TOOLS,
  type LlmToolSpec,
} from "./tool-registry.js";

export {
  toolSuccess,
  toolFailure,
  toServiceContext,
  type ToolContext,
  type ToolDefinition,
  type ToolDeps,
  type ToolResult,
} from "./types.js";
