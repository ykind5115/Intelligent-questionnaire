/**
 * 业务错误类型与错误码。
 *
 * 错误码取自 docs/03-questionnaire_schema_ai_tool_calling .md 第 31 节
 * 与 docs/05-api_design.md 第 8 节（含决策 D1 补充的码）。
 *
 * 设计约束：
 *   Operation 层是纯函数，不依赖 Express、不依赖 Prisma。
 *   它只抛出 OperationError；由上层（Service / Tool / Controller）
 *   决定如何映射成 HTTP 状态码或 Tool Result。
 */

export const ErrorCode = {
  // ---- 通用 ----
  INVALID_PARAMETER: "INVALID_PARAMETER",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  SYSTEM_ERROR: "SYSTEM_ERROR",

  // ---- 资源不存在 ----
  QUESTIONNAIRE_NOT_FOUND: "QUESTIONNAIRE_NOT_FOUND",
  TEMPLATE_NOT_FOUND: "TEMPLATE_NOT_FOUND",
  TEMPLATE_VERSION_NOT_FOUND: "TEMPLATE_VERSION_NOT_FOUND",
  SECTION_NOT_FOUND: "SECTION_NOT_FOUND",
  QUESTION_NOT_FOUND: "QUESTION_NOT_FOUND",
  AI_CONVERSATION_NOT_FOUND: "AI_CONVERSATION_NOT_FOUND",
  DISPATCH_NOT_FOUND: "DISPATCH_NOT_FOUND",
  RESPONSE_NOT_FOUND: "RESPONSE_NOT_FOUND",
  REVIEW_NOT_FOUND: "REVIEW_NOT_FOUND",

  // ---- 结构不合法 ----
  INVALID_QUESTION_TYPE: "INVALID_QUESTION_TYPE",
  INVALID_OPTIONS: "INVALID_OPTIONS",
  INVALID_OPERATION: "INVALID_OPERATION",
  NESTED_SECTION_UNSUPPORTED: "NESTED_SECTION_UNSUPPORTED",

  // ---- 权限 / 状态（决策 D1、D8）----
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  PERMISSION_DENIED: "PERMISSION_DENIED",

  /** 实例已下发，结构冻结（决策 D1） */
  QUESTIONNAIRE_LOCKED: "QUESTIONNAIRE_LOCKED",
  INVALID_STATUS_TRANSITION: "INVALID_STATUS_TRANSITION",
  WITHDRAW_NOT_ALLOWED: "WITHDRAW_NOT_ALLOWED",
  PROMOTE_NOT_ALLOWED: "PROMOTE_NOT_ALLOWED",

  /** 乐观锁冲突（04 文档第 37 节） */
  REVISION_CONFLICT: "REVISION_CONFLICT",

  /** Tool 参数 target_id 与会话不一致（03 文档第 23 节） */
  INVALID_TOOL_CONTEXT: "INVALID_TOOL_CONTEXT",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 错误码 → HTTP 状态码映射（05 文档第 8 节） */
const HTTP_STATUS: Partial<Record<ErrorCodeValue, number>> = {
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.PERMISSION_DENIED]: 403,
  [ErrorCode.VALIDATION_ERROR]: 422,
  [ErrorCode.INVALID_QUESTION_TYPE]: 422,
  [ErrorCode.INVALID_OPTIONS]: 422,
  [ErrorCode.NESTED_SECTION_UNSUPPORTED]: 422,
  [ErrorCode.INVALID_PARAMETER]: 400,
  [ErrorCode.INVALID_OPERATION]: 400,
  [ErrorCode.INVALID_TOOL_CONTEXT]: 400,
  [ErrorCode.QUESTIONNAIRE_NOT_FOUND]: 404,
  [ErrorCode.TEMPLATE_NOT_FOUND]: 404,
  [ErrorCode.TEMPLATE_VERSION_NOT_FOUND]: 404,
  [ErrorCode.SECTION_NOT_FOUND]: 404,
  [ErrorCode.QUESTION_NOT_FOUND]: 404,
  [ErrorCode.AI_CONVERSATION_NOT_FOUND]: 404,
  [ErrorCode.DISPATCH_NOT_FOUND]: 404,
  [ErrorCode.RESPONSE_NOT_FOUND]: 404,
  [ErrorCode.REVIEW_NOT_FOUND]: 404,
  // 状态冲突类统一 409
  [ErrorCode.QUESTIONNAIRE_LOCKED]: 409,
  [ErrorCode.INVALID_STATUS_TRANSITION]: 409,
  [ErrorCode.WITHDRAW_NOT_ALLOWED]: 409,
  [ErrorCode.PROMOTE_NOT_ALLOWED]: 409,
  [ErrorCode.REVISION_CONFLICT]: 409,
  [ErrorCode.SYSTEM_ERROR]: 500,
};

export interface ErrorDetail {
  /** 出错的具体字段路径，便于定位 */
  path?: string;
  [key: string]: unknown;
}

/**
 * 业务异常基类。
 *
 * 所有业务失败都必须抛这个类型，便于上层统一映射，
 * 也便于 Tool 层转成 { success:false, error:{code,message} }。
 */
export class OperationError extends Error {
  readonly code: ErrorCodeValue;
  readonly detail?: ErrorDetail;

  constructor(code: ErrorCodeValue, message: string, detail?: ErrorDetail) {
    super(message);
    this.name = "OperationError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code] ?? 500;
  }

  /** 转成 Tool Result / API 响应的 error 结构 */
  toErrorResponse(): { code: string; message: string; detail?: ErrorDetail } {
    return this.detail
      ? { code: this.code, message: this.message, detail: this.detail }
      : { code: this.code, message: this.message };
  }
}

// ---------------- 常用构造快捷方式 ----------------

export const invalidParameter = (message: string, detail?: ErrorDetail) =>
  new OperationError(ErrorCode.INVALID_PARAMETER, message, detail);

export const validationError = (message: string, detail?: ErrorDetail) =>
  new OperationError(ErrorCode.VALIDATION_ERROR, message, detail);

export const sectionNotFound = (sectionId: string) =>
  new OperationError(
    ErrorCode.SECTION_NOT_FOUND,
    `分组不存在：${sectionId}`,
    { path: "sectionId", sectionId }
  );

export const questionNotFound = (questionId: string) =>
  new OperationError(
    ErrorCode.QUESTION_NOT_FOUND,
    `问题不存在：${questionId}`,
    { path: "questionId", questionId }
  );

export const invalidQuestionType = (type: string) =>
  new OperationError(
    ErrorCode.INVALID_QUESTION_TYPE,
    `不支持的题型：${type}`,
    { path: "type", type }
  );

export const invalidOptions = (message: string) =>
  new OperationError(ErrorCode.INVALID_OPTIONS, message, { path: "options" });

/** 决策 D1：实例已下发，结构冻结 */
export const questionnaireLocked = (status: string) =>
  new OperationError(
    ErrorCode.QUESTIONNAIRE_LOCKED,
    "问卷已下发，请先撤回后再修改",
    { path: "status", status }
  );

export const permissionDenied = (message: string) =>
  new OperationError(ErrorCode.PERMISSION_DENIED, message);

export const revisionConflict = (expected: number, actual: number) =>
  new OperationError(
    ErrorCode.REVISION_CONFLICT,
    `版本冲突：期望 revision=${expected}，实际 revision=${actual}`,
    { path: "revision", expected, actual }
  );

export function isOperationError(e: unknown): e is OperationError {
  return e instanceof OperationError;
}
