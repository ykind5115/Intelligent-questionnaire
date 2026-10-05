/**
 * Tool Registry。
 *
 * 依据 docs/06-proj_init.md 第 26 节与 docs/08-ai_agent_prompt_tool_calling.md 第 15 节：
 *   Orchestrator 不写 if (toolName === "add_question") 这种分支，
 *   而是由 Registry 统一查找与执行。
 *
 * 执行顺序（06 文档第 26 节 / 03 文档第 27.3 节）：
 *   Registry 查找 → Zod 参数校验 → Tool.execute
 *   （权限、target_id 一致性、状态校验、Domain 校验都在 Tool 与 Service 内完成）
 */
import { z } from "zod";
import { ErrorCode, OperationError } from "../../../shared/errors/index.js";
import {
  addQuestionTool,
  addSectionTool,
  getQuestionnaireTool,
  moveQuestionTool,
  removeQuestionTool,
  updateQuestionTool,
  updateSectionTool,
} from "./questionnaire.tools.js";
import type { ToolContext, ToolDefinition, ToolDeps, ToolResult } from "./types.js";
import { toolFailure } from "./types.js";
import { questionnaireService } from "../../questionnaire/service/questionnaire.service.js";

/**
 * V1 的 7 个工具。
 *
 * 与 docs/03-questionnaire_schema_ai_tool_calling .md 第 48 节严格一致：
 * 数量与名称都不可随意增减 —— 新增工具意味着新增一类对问卷的写权限。
 */
export const ALL_TOOLS: readonly ToolDefinition[] = [
  // 读取
  getQuestionnaireTool,
  // 分组
  addSectionTool,
  updateSectionTool,
  // 问题
  addQuestionTool,
  updateQuestionTool,
  removeQuestionTool,
  moveQuestionTool,
];

/** 工具名 → 定义 */
const registry: Map<string, ToolDefinition> = new Map(
  ALL_TOOLS.map((t) => [t.name, t])
);

export const toolRegistry = {
  /** 全部工具定义（发给模型时用） */
  list(): readonly ToolDefinition[] {
    return ALL_TOOLS;
  },

  /** 按名查找 */
  get(name: string): ToolDefinition | undefined {
    return registry.get(name);
  },

  has(name: string): boolean {
    return registry.has(name);
  },

  /** 只取读取类工具（某些场景只允许读） */
  listReadonly(): readonly ToolDefinition[] {
    return ALL_TOOLS.filter((t) => !t.mutates);
  },
};

/**
 * 执行一次 Tool 调用。
 *
 * 这是 Orchestrator 唯一需要调用的入口：
 *   1. 查表：未知工具名直接失败（模型幻觉出工具名时不会静默忽略）
 *   2. Zod 校验：模型给的参数绝对不能直接信任（08 文档第 27 节）
 *   3. 交给 Tool.execute：内部再走 Service 完成权限/状态/事务/审计
 *
 * 注意：**任何情况下都不抛异常**，一律返回 ToolResult。
 * 因为调用方是模型，它需要拿到结构化的失败原因才能自我纠正
 * （03 文档第 30 节：不得假装执行成功）。
 */
export async function runTool(
  name: string,
  rawInput: unknown,
  context: ToolContext,
  deps: ToolDeps = { service: questionnaireService }
): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool) {
    return toolFailure(
      ErrorCode.INVALID_OPERATION,
      `未知工具：${name}。可用工具：${[...registry.keys()].join(", ")}`,
      context.operationId
    );
  }

  const parsed = tool.inputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return toolFailure(
      ErrorCode.INVALID_PARAMETER,
      `参数不合法：${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
      context.operationId,
      {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      }
    );
  }

  try {
    return await tool.execute(parsed.data, context, deps);
  } catch (error) {
    // 兜底：Tool 内部的 try/catch 之外仍可能抛出（例如依赖注入错误）
    if (error instanceof OperationError) {
      return toolFailure(
        error.code,
        error.message,
        context.operationId,
        error.detail
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return toolFailure(
      ErrorCode.SYSTEM_ERROR,
      message,
      context.operationId
    );
  }
}

// ============================================================
// 生成发给模型的工具定义
// ============================================================

export interface LlmToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * 把 Tool 的 Zod schema 转成 OpenAI 兼容的 function calling 格式。
 *
 * 为什么用 z.toJSONSchema（Zod 4 内置）而不是第三方库：
 *   少一个依赖，且与运行时校验用的是同一份 schema 定义，
 *   避免「校验用一套、发给模型的是另一套」造成的不一致。
 */
export function toLlmToolSpec(tool: ToolDefinition): LlmToolSpec {
  const jsonSchema = z.toJSONSchema(tool.inputSchema, {
    target: "draft-7",
    io: "input",
  }) as Record<string, unknown>;

  // OpenAI 兼容协议要求顶层是 object 且不携带 $schema
  delete jsonSchema["$schema"];

  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: jsonSchema,
    },
  };
}

export function allLlmToolSpecs(): LlmToolSpec[] {
  return ALL_TOOLS.map(toLlmToolSpec);
}
