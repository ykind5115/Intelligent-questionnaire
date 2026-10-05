/**
 * Tool 参数的共用片段。
 *
 * 依据 docs/03-questionnaire_schema_ai_tool_calling .md 第 22 节：
 *   所有修改类 Tool 必须带 target_id。
 *
 * 命名约定（03 文档第 22.2 节）：
 *   Tool 参数（发给模型的 JSON Schema）用 snake_case；
 *   进入 Service 前统一转成 camelCase。
 */
import { z } from "zod";
import {
  ErrorCode,
  OperationError,
  invalidParameter,
} from "../../../shared/errors/index.js";
import type { ToolContext, ToolResult } from "./types.js";

/**
 * target_id 参数。
 *
 * 设计说明：**可选，默认取上下文**。
 *
 * 为什么不做成必填：
 *   03 文档第 23 节的原则是「业务上下文优先于模型自行判断」。
 *   目标问卷由 Conversation 绑定，模型即使不传也不会改错对象；
 *   做成必填只会增加模型出错面（多一个可能填错/编造的字段）。
 *
 * 但一旦模型传了，就必须与上下文一致，否则拒绝 —— 这是防止
 * 「模型因上下文混淆而修改错误问卷」的核心校验。
 */
export const targetIdSchema = z
  .string()
  .optional()
  .describe(
    "要操作的问卷 ID。可以省略，省略时自动使用当前会话绑定的问卷。" +
      "如果填写，必须与当前会话绑定的问卷一致，否则会被拒绝。"
  );

/**
 * 校验 target_id 与上下文一致性，并返回实际使用的目标 ID。
 *
 * 对应 05 文档第 27 节：不一致时返回 INVALID_TOOL_CONTEXT。
 */
export function resolveTargetId(
  inputTargetId: string | undefined,
  context: ToolContext
): string {
  if (inputTargetId !== undefined && inputTargetId !== context.targetId) {
    throw new OperationError(
      ErrorCode.INVALID_TOOL_CONTEXT,
      "工具操作目标与当前 AI 会话不一致",
      {
        path: "target_id",
        provided: inputTargetId,
        expected: context.targetId,
      }
    );
  }
  return context.targetId;
}

/**
 * 场景校验：写入类 Tool 只能用于「可写目标」。
 *
 * 依据 docs/03-questionnaire_schema_ai_tool_calling .md 第 36.0 节：
 *
 *   | Scene                 | target_type              | 是否允许 |
 *   | create_template       | template（草稿版本）      | ✅ 允许  |
 *   | create_template       | template_version（已发布）| ❌ 拒绝  |
 *   | modify_questionnaire  | questionnaire_instance   | ✅ 允许  |
 *   | modify_questionnaire  | template_version（正式模板）| ❌ 拒绝 |
 *
 * 也就是说：**AI 可以写「模板草稿版本」**（这正是 AI 从零创建问卷的路径），
 * 但不允许写「已发布的正式模板」。
 *
 * 注意：本文档早期实现曾用一句 `assertInstanceScene` 把 template 目标
 * 一并拒绝，导致「AI 创建问卷」整条链路不可用 —— 那是把
 * 「模板草稿」与「已发布版本」混为一谈了。
 */
export function assertWritableScene(context: ToolContext): void {
  const allowed =
    (context.scene === "create_template" &&
      context.targetType === "template") ||
    (context.scene === "modify_questionnaire" &&
      context.targetType === "questionnaire_instance");

  if (!allowed) {
    throw invalidParameter(
      `场景与目标类型不匹配：scene=${context.scene}, targetType=${context.targetType}。` +
        `create_template 需要 targetType=template（模板草稿）；` +
        `modify_questionnaire 需要 targetType=questionnaire_instance。` +
        `已发布的正式模板不允许被 AI 修改。`
    );
  }
}

/**
 * 把任意异常统一转成 ToolResult。
 *
 * 依据 03 文档第 30 节：模型拿到失败结果后可以
 * 重新读取、重新调用，或向用户解释，而不是假装成功。
 */
export function toToolResult(
  error: unknown,
  operationId?: string
): ToolResult<never> {
  if (error instanceof OperationError) {
    return {
      success: false,
      error: error.detail
        ? {
            code: error.code,
            message: error.message,
            detail: error.detail,
          }
        : { code: error.code, message: error.message },
      ...(operationId ? { metadata: { operation_id: operationId } } : {}),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    error: { code: "SYSTEM_ERROR", message },
    ...(operationId ? { metadata: { operation_id: operationId } } : {}),
  };
}

/** 选项输入：AI 只需要给 label，value 可省略 */
export const optionInputSchema = z.object({
  label: z.string().min(1).describe("选项显示文本"),
  value: z
    .string()
    .optional()
    .describe("选项取值，省略时等于 label。一般不需要填。"),
});

/** 题型枚举，与 03 文档第 7 节一致 */
export const questionTypeSchema = z
  .enum([
    "text",
    "textarea",
    "number",
    "single_choice",
    "multiple_choice",
    "date",
    "datetime",
    "boolean",
  ])
  .describe(
    "题型。single_choice / multiple_choice 必须提供 options（至少 2 个）；" +
      "其他题型不要提供 options。"
  );
