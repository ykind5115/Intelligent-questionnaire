/**
 * Tool 契约。
 *
 * 依据 docs/06-proj_init.md 第 27 节与 docs/05-api_design.md 第 18 节。
 *
 * 设计要点：
 *   1. Tool 不是 REST API，它是 AI Orchestrator 与业务 Service 之间的内部契约；
 *   2. Tool 的参数 JSON Schema 会直接发给模型，
 *      因此 description 与参数描述**属于 Prompt 的一部分**（15.3 节）；
 *   3. Tool 不直接操作 Repository，一律经 QuestionnaireService（第 28 节）。
 */
import type { z } from "zod";
import type { ServiceContext } from "../../questionnaire/service/questionnaire.service.js";

/** 变更来源（决策 D3 的人工编辑器同样要留痕） */
export type ChangeSource = "ai_tool" | "rest" | "manual_editor";

/**
 * Tool 执行上下文。
 *
 * 依据 docs/08-ai_agent_prompt_tool_calling.md 第 46 节（决策 D8 / D9）。
 */
export interface ToolContext {
  userId: string;
  roles: string[];

  /** 决策 D9：一次 Tool 调用一个 operation_id */
  operationId: string;

  /** create_template | modify_questionnaire */
  scene: string;

  /** template | questionnaire_instance */
  targetType: "template" | "questionnaire_instance";

  /**
   * 当前操作目标。
   *
   * 依据 03 文档第 23 节：
   *   Tool 参数 target_id 必须等于 ToolContext.targetId，不一致直接拒绝。
   *   这样可以防止模型因上下文混淆而改错问卷。
   */
  targetId: string;

  conversationId?: string;
  messageId?: string;
  model?: string;
}

/**
 * Tool 返回值。
 *
 * 依据 03 文档第 28 节统一格式；
 * metadata.operation_id 供前端把 tool_call_start / tool_call_result 配对。
 */
export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    detail?: Record<string, unknown>;
  };
  metadata?: {
    operation_id?: string;
    /** 结构发生变化时返回新 revision，前端据此刷新 */
    revision?: number;
  };
}

/** Tool 的可注入依赖（便于测试替换） */
export interface ToolDeps {
  service: typeof import("../../questionnaire/service/questionnaire.service.js").questionnaireService;
}

export interface ToolDefinition<
  TInputSchema extends z.ZodTypeAny = z.ZodTypeAny,
  TResult = unknown,
> {
  /** 工具名，snake_case，与 03 文档第 48 节的 7 个工具一致 */
  name: string;

  /**
   * 给模型看的说明。
   *
   * 必须写明：
   *   - 什么时候该用、什么时候不该用
   *   - 参数里的 ID 从哪里来（只能取自上一次 Tool Result，不得编造）
   *   - 危险操作（删除）的额外约束
   */
  description: string;

  /** 参数校验（同时用于生成发给模型的 JSON Schema） */
  inputSchema: TInputSchema;

  /** 是否修改问卷结构（用于区分读取类与写入类） */
  mutates: boolean;

  execute(
    input: z.infer<TInputSchema>,
    context: ToolContext,
    deps: ToolDeps
  ): Promise<ToolResult<TResult>>;
}

/** 由 ToolContext 构造 ServiceContext */
export function toServiceContext(context: ToolContext): ServiceContext {
  return {
    userId: context.userId,
    roles: context.roles,
    operationId: context.operationId,
    source: "ai_tool",
    ...(context.conversationId !== undefined
      ? { conversationId: context.conversationId }
      : {}),
    ...(context.messageId !== undefined
      ? { messageId: context.messageId }
      : {}),
    ...(context.model !== undefined ? { model: context.model } : {}),
  };
}

/** 统一的失败结果 */
export function toolFailure(
  code: string,
  message: string,
  operationId?: string,
  detail?: Record<string, unknown>
): ToolResult<never> {
  return {
    success: false,
    error: detail ? { code, message, detail } : { code, message },
    ...(operationId ? { metadata: { operation_id: operationId } } : {}),
  };
}

/** 统一的成功结果 */
export function toolSuccess<T>(
  data: T,
  operationId: string,
  revision?: number
): ToolResult<T> {
  return {
    success: true,
    data,
    metadata: {
      operation_id: operationId,
      ...(revision !== undefined ? { revision } : {}),
    },
  };
}
