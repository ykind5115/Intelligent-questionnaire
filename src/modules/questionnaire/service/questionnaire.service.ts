/**
 * Questionnaire Service。
 *
 * 这是 V1 的核心业务层（06 文档第 65 节）：
 *   REST Controller 与 AI Tool 都汇聚到这里，
 *   因此不存在两套业务逻辑。
 *
 * 职责（06 文档第 41 节 + 03 文档第 27 节）：
 *   权限校验（D8）→ 目标校验 → 状态校验（D1）→ 应用 Operation
 *   → 乐观锁更新 → Revision 递增（D9）→ 审计日志
 *
 * 明确不做：
 *   - 不拼 Prompt、不调 LLM（那是 AI 模块的事）
 *   - 不直接写 SQL（那是 Repository 的事）
 */
import { transaction, type Tx } from "../../../database/transaction.js";
import { newId, uuidValidate } from "../../../shared/utils/id.js";
import {
  ErrorCode,
  OperationError,
  permissionDenied,
  questionnaireLocked,
  sectionNotFound,
  questionNotFound,
  revisionConflict,
  validationError,
} from "../../../shared/errors/index.js";
import {
  addQuestion,
  addSection,
  moveQuestion,
  removeQuestion,
  updateQuestion,
  updateSection,
  uuidIdFactory,
  type AddQuestionInput,
  type AddSectionInput,
  type IdFactory,
  type MoveQuestionInput,
  type RemoveQuestionInput,
  type UpdateQuestionInput,
  type UpdateSectionInput,
} from "../operations/index.js";
import type { QuestionnaireSchema } from "../schema/questionnaire.schema.js";
import {
  questionnaireRepository,
  type InstanceRecord,
  type TemplateVersionRecord,
} from "../repository/questionnaire.repository.js";

// ============================================================
// 上下文与类型
// ============================================================

/** 能修改问卷结构的角色（决策 D8） */
export const STRUCTURE_WRITE_ROLES = ["dispatcher", "template_admin"] as const;
/** 只读角色 */
export const STRUCTURE_READ_ROLES = [
  "investigator",
  "reviewer",
  "dispatcher",
  "template_admin",
] as const;

export type ChangeSource = "ai_tool" | "rest" | "manual_editor";

export interface ServiceContext {
  /** 发起人（由鉴权中间件注入，AI 继承当前用户权限） */
  userId: string;
  roles: string[];
  /** 决策 D9：一次业务动作一个 operation_id */
  operationId?: string;
  source?: ChangeSource;
  /** AI 工具调用时用于审计关联 */
  conversationId?: string;
  messageId?: string;
  model?: string;
  /**
   * 审计日志里记录的操作名。
   *
   * 为什么需要它：REST 路由与 AI Tool 调用的方法名相同（例如都是 addQuestion），
   * 但在审计里应该能区分是「哪个入口进来的」，
   * 因此由调用方显式给出工具名（如 add_question）。
   * 不传时回退为内部操作名。
   */
  auditToolName?: string;
  /** 可注入的 ID 生成器（测试用） */
  idFactory?: IdFactory;
}

/** 所有可执行的问卷结构操作 */
export type QuestionnaireOperationName =
  | "add_section"
  | "add_question"
  | "update_section"
  | "update_question"
  | "remove_question"
  | "move_question";

export type OperationPayload =
  | { name: "add_section"; input: AddSectionInput }
  | { name: "add_question"; input: AddQuestionInput }
  | { name: "update_section"; input: UpdateSectionInput }
  | { name: "update_question"; input: UpdateQuestionInput }
  | { name: "remove_question"; input: RemoveQuestionInput }
  | { name: "move_question"; input: MoveQuestionInput };

export interface ApplyResult {
  schema: QuestionnaireSchema;
  revision: number;
  /** Operation 产生的附加信息（新建的 id 等），供 Tool Result 返回给模型 */
  details: Record<string, unknown>;
}

// ============================================================
// 内部：Operation 分发
// ============================================================

interface DispatchOutcome {
  schema: QuestionnaireSchema;
  details: Record<string, unknown>;
}

/**
 * 把一次操作应用到 schema 上。
 *
 * 纯计算，不碰数据库 —— 因此可以被单元测试直接覆盖，
 * 也保证「AI Tool 与人工编辑走同一条路径」。
 */
export function dispatchOperation(
  schema: QuestionnaireSchema,
  payload: OperationPayload,
  ids: IdFactory = uuidIdFactory
): DispatchOutcome {
  switch (payload.name) {
    case "add_section": {
      const r = addSection(schema, payload.input, ids);
      return { schema: r.schema, details: { section: r.section } };
    }
    case "add_question": {
      const r = addQuestion(schema, payload.input, ids);
      return { schema: r.schema, details: { question: r.question } };
    }
    case "update_section": {
      const r = updateSection(schema, payload.input);
      return { schema: r.schema, details: { section: r.section } };
    }
    case "update_question": {
      const r = updateQuestion(schema, payload.input, ids);
      return { schema: r.schema, details: { question: r.question } };
    }
    case "remove_question": {
      const r = removeQuestion(schema, payload.input);
      return { schema: r.schema, details: { removed: r.removed } };
    }
    case "move_question": {
      const r = moveQuestion(schema, payload.input);
      return { schema: r.schema, details: { question: r.question } };
    }
    default: {
      // 穷尽性检查：新增操作名时这里会编译报错
      const never: never = payload;
      throw new OperationError(
        ErrorCode.INVALID_OPERATION,
        `未知操作：${JSON.stringify(never)}`
      );
    }
  }
}

// ============================================================
// 内部：校验
// ============================================================

function assertCanWriteStructure(ctx: ServiceContext): void {
  const allowed = ctx.roles.some((r) =>
    (STRUCTURE_WRITE_ROLES as readonly string[]).includes(r)
  );
  if (!allowed) {
    throw permissionDenied(
      `当前用户角色 [${ctx.roles.join(", ")}] 无权修改问卷结构，` +
        `需要 ${STRUCTURE_WRITE_ROLES.join(" 或 ")}`
    );
  }
}

/**
 * 决策 D1：只有 draft / confirmed 允许改结构。
 * 已下发及之后必须走撤回（withdraw）。
 */
const STRUCTURE_WRITABLE_STATUSES = ["draft", "confirmed"];

function assertInstanceWritable(instance: InstanceRecord): void {
  if (!STRUCTURE_WRITABLE_STATUSES.includes(instance.status)) {
    throw questionnaireLocked(instance.status);
  }
}

/**
 * 校验 operationId 格式。
 *
 * 为什么要显式校验而不是交给数据库报错：
 *   operation_id 是 uuid 列。如果传入非法字符串，
 *   会先走完整个业务逻辑，最后在「写审计日志」时才由数据库抛出
 *   invalid input syntax for type uuid —— 此时错误码已丢失（变成 SYSTEM_ERROR），
 *   调用方无法判断究竟是幂等冲突、校验失败还是系统故障。
 *
 * 更严重的是：审计写入在同一个事务内，
 * 因此这个「日志格式错误」会把已经成功的业务改动一起回滚，
 * 表现为「结构明明改对了，却报系统错误且没保存」。
 */
function assertUuid(
  value: string | undefined,
  fieldName: string
): void {
  if (value !== undefined && !uuidValidate(value)) {
    throw validationError(
      `${fieldName} 必须是合法 UUID，收到：${value}`,
      { path: fieldName, value }
    );
  }
}

/** 校验上下文中所有「要落库的 ID 字段」格式 */
function assertServiceContext(ctx: ServiceContext): void {
  assertUuid(ctx.operationId, "operationId");
  assertUuid(ctx.conversationId, "conversationId");
  assertUuid(ctx.messageId, "messageId");
  assertUuid(ctx.userId, "userId");
}

// ============================================================
// Service
// ============================================================

export const questionnaireService = {
  // ----------------------------------------------------------
  // 读取
  // ----------------------------------------------------------

  async getInstance(
    instanceId: string,
    ctx: ServiceContext
  ): Promise<InstanceRecord> {
    const allowed = ctx.roles.some((r) =>
      (STRUCTURE_READ_ROLES as readonly string[]).includes(r)
    );
    if (!allowed) {
      throw permissionDenied(
        `当前用户角色 [${ctx.roles.join(", ")}] 无权读取问卷`
      );
    }

    const instance = await questionnaireRepository.findInstanceById(instanceId);
    if (!instance) {
      throw new OperationError(
        ErrorCode.QUESTIONNAIRE_NOT_FOUND,
        `问卷实例不存在：${instanceId}`
      );
    }
    return instance;
  },

  // ----------------------------------------------------------
  // 读取审计
  // ----------------------------------------------------------

  /**
   * 记录一次「读取问卷结构」的操作。
   *
   * 依据 08 文档第 47 节：AI 的每一次 Tool Calling 都应记录，
   * 读取类工具（get_questionnaire）同样属于 Tool Calling，
   * 因此需要留痕，否则无法复盘「模型当时看到的是哪一版结构」。
   *
   * 与写入类不同的是：这不改变任何数据，也不在事务中，
   * 因此失败不应影响调用方（调用方按需忽略异常）。
   */
  async recordReadAudit(
    instanceId: string,
    ctx: ServiceContext,
    result: { revision: number }
  ): Promise<void> {
    await questionnaireRepository.createAuditLog({
      operationId: ctx.operationId ?? newId(),
      source: ctx.source ?? "rest",
      toolName: ctx.auditToolName ?? "get_questionnaire",
      instanceId,
      arguments: { instanceId },
      result,
      success: true,
      ...(ctx.conversationId !== undefined
        ? { conversationId: ctx.conversationId }
        : {}),
      ...(ctx.messageId !== undefined ? { messageId: ctx.messageId } : {}),
      ...(ctx.model !== undefined ? { model: ctx.model } : {}),
    });
  },

  // ----------------------------------------------------------
  // 对「问卷实例」应用一次操作（AI 修改实例 / 人工编辑实例）
  // ----------------------------------------------------------

  /**
   * 完整链路：
   *   事务开始
   *     → 读实例
   *     → 幂等检查（D9，可选）
   *     → 权限 + 状态校验
   *     → 应用 Operation（纯函数）
   *     → 乐观锁更新 current_schema + revision+1
   *     → 写 Revision 快照
   *     → 写审计日志
   *   提交
   */
  async applyToInstance(
    instanceId: string,
    payload: OperationPayload,
    ctx: ServiceContext,
    options: { expectedRevision?: number } = {}
  ): Promise<ApplyResult> {
    assertCanWriteStructure(ctx);
    assertServiceContext(ctx);

    const operationId = ctx.operationId ?? newId();
    const ids = ctx.idFactory ?? uuidIdFactory;

    return transaction(async (tx: Tx) => {
      // ---- 幂等（决策 D9：先查后插，不依赖 UNIQUE 冲突）----
      if (ctx.operationId) {
        const existing = await questionnaireRepository.findExecutedOperation(
          ctx.operationId,
          tx
        );
        if (existing?.success) {
          const current = await questionnaireRepository.findInstanceById(
            instanceId,
            tx
          );
          if (!current) {
            throw new OperationError(
              ErrorCode.QUESTIONNAIRE_NOT_FOUND,
              `问卷实例不存在：${instanceId}`
            );
          }
          return {
            schema: current.currentSchema,
            revision: current.currentRevision,
            details: {
              idempotentReplay: true,
              previousResult: existing.result,
            },
          };
        }
      }

      // ---- 读实例 ----
      const instance = await questionnaireRepository.findInstanceById(
        instanceId,
        tx
      );
      if (!instance) {
        throw new OperationError(
          ErrorCode.QUESTIONNAIRE_NOT_FOUND,
          `问卷实例不存在：${instanceId}`
        );
      }

      // ---- 状态校验（决策 D1）----
      assertInstanceWritable(instance);

      // ---- 版本校验 ----
      const expectedRevision =
        options.expectedRevision ?? instance.currentRevision;
      if (expectedRevision !== instance.currentRevision) {
        throw revisionConflict(expectedRevision, instance.currentRevision);
      }

      // ---- 应用 Operation ----
      const outcome = dispatchOperation(instance.currentSchema, payload, ids);

      // ---- 持久化（乐观锁）----
      const newRevision = await questionnaireRepository.updateInstanceSchema(
        {
          instanceId,
          expectedRevision,
          schema: outcome.schema,
        },
        tx
      );

      // ---- Revision 快照（与 current_revision 严格对应）----
      await questionnaireRepository.createRevision(
        {
          instanceId,
          revisionNo: newRevision,
          schema: outcome.schema,
          operationType: payload.name,
          operationId,
          createdBy: ctx.userId,
        },
        tx
      );

      // ---- 审计日志 ----
      await questionnaireRepository.createAuditLog(
        {
          operationId,
          source: ctx.source ?? "rest",
          toolName: ctx.auditToolName ?? payload.name,
          instanceId,
          arguments: payload.input,
          result: {
            revision: newRevision,
            ...outcome.details,
          },
          success: true,
          ...(ctx.conversationId !== undefined
            ? { conversationId: ctx.conversationId }
            : {}),
          ...(ctx.messageId !== undefined ? { messageId: ctx.messageId } : {}),
          ...(ctx.model !== undefined ? { model: ctx.model } : {}),
        },
        tx
      );

      return {
        schema: outcome.schema,
        revision: newRevision,
        details: outcome.details,
      };
    });
  },

  // ----------------------------------------------------------
  // 对「模板草稿版本」应用一次操作（AI 创建模板）
  // ----------------------------------------------------------

  /**
   * 与 applyToInstance 的区别：
   *   1. 模板版本没有 revision 机制，只更新 schema；
   *   2. 只允许修改 status = draft 的版本
   *      （04 文档第 11.1 节：发布后的版本不可直接修改）。
   */
  async applyToTemplateVersion(
    versionId: string,
    payload: OperationPayload,
    ctx: ServiceContext
  ): Promise<ApplyResult> {
    assertCanWriteStructure(ctx);
    assertServiceContext(ctx);

    const operationId = ctx.operationId ?? newId();
    const ids = ctx.idFactory ?? uuidIdFactory;

    return transaction(async (tx: Tx) => {
      const version = await questionnaireRepository.findTemplateVersionById(
        versionId,
        tx
      );
      if (!version) {
        throw new OperationError(
          ErrorCode.TEMPLATE_VERSION_NOT_FOUND,
          `模板版本不存在：${versionId}`
        );
      }

      if (version.status !== "draft") {
        throw new OperationError(
          ErrorCode.PERMISSION_DENIED,
          `模板版本状态为 ${version.status}，只有 draft 版本允许修改`
        );
      }

      const outcome = dispatchOperation(version.schema, payload, ids);

      const affected =
        await questionnaireRepository.updateTemplateVersionSchema(
          { versionId, schema: outcome.schema },
          tx
        );

      if (affected === 0) {
        // 并发下状态可能刚被发布
        throw new OperationError(
          ErrorCode.PERMISSION_DENIED,
          "模板版本状态已变化（可能刚被发布），本次修改未生效"
        );
      }

      await questionnaireRepository.createAuditLog(
        {
          operationId,
          source: ctx.source ?? "rest",
          toolName: ctx.auditToolName ?? payload.name,
          arguments: payload.input,
          result: outcome.details,
          success: true,
          ...(ctx.conversationId !== undefined
            ? { conversationId: ctx.conversationId }
            : {}),
          ...(ctx.messageId !== undefined ? { messageId: ctx.messageId } : {}),
          ...(ctx.model !== undefined ? { model: ctx.model } : {}),
        },
        tx
      );

      return {
        schema: outcome.schema,
        revision: version.versionNo,
        details: outcome.details,
      };
    });
  },

  // ----------------------------------------------------------
  // 状态流转：确认 / 撤回（决策 D1）
  // ----------------------------------------------------------

  async confirmInstance(
    instanceId: string,
    ctx: ServiceContext
  ): Promise<{ id: string; status: string }> {
    assertCanWriteStructure(ctx);

    return transaction(async (tx: Tx) => {
      const instance = await questionnaireRepository.findInstanceById(
        instanceId,
        tx
      );
      if (!instance) {
        throw new OperationError(
          ErrorCode.QUESTIONNAIRE_NOT_FOUND,
          `问卷实例不存在：${instanceId}`
        );
      }
      if (instance.status !== "draft") {
        throw new OperationError(
          ErrorCode.INVALID_STATUS_TRANSITION,
          `只有 draft 状态可以确认，当前为 ${instance.status}`
        );
      }

      const updated = await questionnaireRepository.updateInstanceStatus(
        { instanceId, status: "confirmed" },
        tx
      );
      return { id: updated.id, status: updated.status };
    });
  },

  /**
   * 撤回（撤销下发）。
   *
   * 依据 05 文档第 13A 节与 02 文档第 21.3 节：
   *   dispatched / in_progress / submitted / under_review
   *     → draft（结构重新可改）
   *   returned → 需先回到 in_progress 再撤回，因此这里不接受
   *   completed → 终态，只能新建实例
   *
   * 撤回不修改 current_schema，也不产生新的 Revision。
   */
  async withdrawInstance(
    instanceId: string,
    ctx: ServiceContext,
    reason?: string
  ): Promise<{ id: string; status: string }> {
    assertCanWriteStructure(ctx);
    assertServiceContext(ctx);

    const WITHDRAWABLE = [
      "dispatched",
      "in_progress",
      "submitted",
      "under_review",
    ];

    return transaction(async (tx: Tx) => {
      const instance = await questionnaireRepository.findInstanceById(
        instanceId,
        tx
      );
      if (!instance) {
        throw new OperationError(
          ErrorCode.QUESTIONNAIRE_NOT_FOUND,
          `问卷实例不存在：${instanceId}`
        );
      }

      if (!WITHDRAWABLE.includes(instance.status)) {
        throw new OperationError(
          ErrorCode.WITHDRAW_NOT_ALLOWED,
          `状态 ${instance.status} 不允许撤回。` +
            `可撤回状态：${WITHDRAWABLE.join(", ")}；` +
            `returned 需先回到 in_progress，completed 为终态`,
          { path: "status", status: instance.status }
        );
      }

      const updated = await questionnaireRepository.updateInstanceStatus(
        { instanceId, status: "draft" },
        tx
      );

      await questionnaireRepository.createAuditLog(
        {
          operationId: ctx.operationId ?? newId(),
          source: ctx.source ?? "rest",
          toolName: "withdraw_instance",          instanceId,
          arguments: { reason: reason ?? null },
          result: { from: instance.status, to: "draft" },
          success: true,
        },
        tx
      );

      return { id: updated.id, status: updated.status };
    });
  },
};

export type QuestionnaireService = typeof questionnaireService;
