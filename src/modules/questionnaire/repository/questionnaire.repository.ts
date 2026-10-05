/**
 * Questionnaire Repository。
 *
 * 依据 docs/06-proj_init.md 第 42 节：
 *   Repository 只负责数据持久化，不知道 AI、HTTP、Prompt、用户界面。
 *
 * 本文件封装三件事：
 *   1. 读取问卷实例 / 模板版本；
 *   2. 带乐观锁的 current_schema 更新（04 文档第 37 节）；
 *   3. Revision 与审计日志的落库（04 文档第 56 节规则七）。
 */
import { prisma } from "../../../database/client.js";
import { newId } from "../../../shared/utils/id.js";
import { toJsonValue } from "../../../shared/utils/json.js";
import {
  questionnaireSchema,
  type QuestionnaireSchema,
} from "../schema/questionnaire.schema.js";
import { revisionConflict } from "../../../shared/errors/index.js";
import type { DbClient } from "../../../database/transaction.js";

/** 实例的可写状态：只有 draft 允许改结构（决策 D1） */
export const WRITABLE_INSTANCE_STATUSES = ["draft"] as const;

export interface InstanceRecord {
  id: string;
  templateVersionId: string;
  title: string;
  status: string;
  currentRevision: number;
  currentSchema: QuestionnaireSchema;
  /** 调查对象基础信息（结构随业务可变） */
  subjectInfo: Record<string, unknown> | null;
  createdBy: string;
}

export interface TemplateVersionRecord {
  id: string;
  templateId: string;
  versionNo: number;
  status: string;
  sourceType: string;
  schema: QuestionnaireSchema;
  createdBy: string;
}

/** JSONB 里的 schema 读出来后必须校验，不能盲目信任数据库内容（04 文档第 44 节） */
function parseSchema(raw: unknown, subject: string): QuestionnaireSchema {
  const parsed = questionnaireSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${subject} 中的问卷结构不合法（数据库内容与 Schema 定义不一致）：` +
        parsed.error.issues.map((i) => i.message).join("; ")
    );
  }
  return parsed.data;
}

export const questionnaireRepository = {
  // ==========================================================
  // 读取
  // ==========================================================

  async findInstanceById(
    id: string,
    client: DbClient = prisma
  ): Promise<InstanceRecord | null> {
    const row = await client.questionnaireInstance.findUnique({
      where: { id },
    });
    if (!row) return null;

    return {
      id: row.id,
      templateVersionId: row.templateVersionId,
      title: row.title,
      status: row.status,
      currentRevision: row.currentRevision,
      currentSchema: parseSchema(row.currentSchema, `实例 ${row.id}`),
      subjectInfo: (row.subjectInfo ?? null) as Record<string, unknown> | null,
      createdBy: row.createdBy,
    };
  },

  async findTemplateVersionById(
    id: string,
    client: DbClient = prisma
  ): Promise<TemplateVersionRecord | null> {
    const row = await client.questionnaireTemplateVersion.findUnique({
      where: { id },
    });
    if (!row) return null;

    return {
      id: row.id,
      templateId: row.templateId,
      versionNo: row.versionNo,
      status: row.status,
      sourceType: row.sourceType,
      schema: parseSchema(row.schema, `模板版本 ${row.id}`),
      createdBy: row.createdBy,
    };
  },

  /** 读取指定 revision 的快照（回滚 / 审计用） */
  async findRevisionSnapshot(
    instanceId: string,
    revisionNo: number,
    client: DbClient = prisma
  ): Promise<QuestionnaireSchema | null> {
    const row = await client.questionnaireRevision.findUnique({
      where: {
        questionnaireInstanceId_revisionNo: {
          questionnaireInstanceId: instanceId,
          revisionNo,
        },
      },
    });
    if (!row) return null;
    return parseSchema(row.schemaSnapshot, `修订 ${instanceId}#${revisionNo}`);
  },

  /** 列出实例的修订历史（不含快照内容，避免列表接口过大） */
  async listRevisions(
    instanceId: string,
    client: DbClient = prisma
  ): Promise<
    {
      revisionNo: number;
      operationType: string | null;
      operationId: string | null;
      createdBy: string | null;
      createdAt: Date;
    }[]
  > {
    return client.questionnaireRevision.findMany({
      where: { questionnaireInstanceId: instanceId },
      orderBy: { revisionNo: "asc" },
      select: {
        revisionNo: true,
        operationType: true,
        operationId: true,
        createdBy: true,
        createdAt: true,
      },
    });
  },

  // ==========================================================
  // 写入（实例）
  // ==========================================================

  /**
   * 带乐观锁地更新实例结构，并把 current_revision 加 1。
   *
   * 依据 04 文档第 37 节：
   *   UPDATE ... WHERE id = $1 AND current_revision = $2
   *   受影响行数为 0 说明版本已被别人改动，返回 409 REVISION_CONFLICT。
   *
   * 返回更新后的 revision（即新的 current_revision）。
   */
  async updateInstanceSchema(
    params: {
      instanceId: string;
      expectedRevision: number;
      schema: QuestionnaireSchema;
    },
    client: DbClient = prisma
  ): Promise<number> {
    const rows = await client.$queryRaw<
      { current_revision: number }[]
    >`
      UPDATE questionnaire_instances
         SET "current_schema"    = ${JSON.stringify(params.schema)}::jsonb,
             "current_revision"  = "current_revision" + 1,
             "updated_at"        = NOW()
       WHERE id = ${params.instanceId}::uuid
         AND "current_revision" = ${params.expectedRevision}
      RETURNING "current_revision"
    `;

    const updated = rows[0];
    if (!updated) {
      // 区分「实例不存在」与「版本冲突」：再读一次当前 revision
      const current = await client.questionnaireInstance.findUnique({
        where: { id: params.instanceId },
        select: { currentRevision: true },
      });
      throw revisionConflict(
        params.expectedRevision,
        current?.currentRevision ?? -1
      );
    }

    return updated.current_revision;
  },

  // ==========================================================
  // 写入（修订记录与审计）
  // ==========================================================

  /**
   * 创建一次 Revision 快照。
   *
   * 依据 03 文档第 44 节与 04 文档第 56 节规则七：
   *   一次 Tool 调用 = 一个 operation_id = 一个事务 = 一次 revision 递增
   * 因此 revisionNo 必须与 updateInstanceSchema 后的 current_revision 一致。
   */
  async createRevision(
    params: {
      instanceId: string;
      revisionNo: number;
      schema: QuestionnaireSchema;
      operationType: string;
      operationId?: string;
      createdBy?: string;
    },
    client: DbClient = prisma
  ) {
    return client.questionnaireRevision.create({
      data: {
        id: newId(),
        questionnaireInstanceId: params.instanceId,
        revisionNo: params.revisionNo,
        schemaSnapshot: toJsonValue(params.schema),
        operationType: params.operationType,
        ...(params.operationId !== undefined
          ? { operationId: params.operationId }
          : {}),
        ...(params.createdBy !== undefined
          ? { createdBy: params.createdBy }
          : {}),
      },
    });
  },

  /**
   * 写审计日志。
   *
   * 依据 03 文档第 33 节 / 02 文档第 15 节：
   *   谁、什么时间、因为什么、通过哪个操作、改了哪份问卷、改成了什么。
   */
  async createAuditLog(
    params: {
      operationId: string;
      source: "ai_tool" | "rest" | "manual_editor";
      toolName: string;
      instanceId?: string;
      conversationId?: string;
      messageId?: string;
      arguments: unknown;
      result?: unknown;
      success: boolean;
      errorCode?: string;
      model?: string;
    },
    client: DbClient = prisma
  ) {
    return client.aiToolExecution.create({
      data: {
        id: newId(),
        operationId: params.operationId,
        source: params.source,
        toolName: params.toolName,
        arguments: toJsonValue(params.arguments),
        ...(params.result !== undefined
          ? { result: toJsonValue(params.result) }
          : {}),
        success: params.success,
        ...(params.errorCode !== undefined
          ? { errorCode: params.errorCode }
          : {}),
        ...(params.instanceId !== undefined
          ? { questionnaireInstanceId: params.instanceId }
          : {}),
        ...(params.conversationId !== undefined
          ? { conversationId: params.conversationId }
          : {}),
        ...(params.messageId !== undefined
          ? { messageId: params.messageId }
          : {}),
        ...(params.model !== undefined ? { model: params.model } : {}),
      },
    });
  },

  /**
   * 幂等查询（决策 D9）。
   *
   * 依据 03 文档第 32.2 节与 04 文档第 24.2 节：
   *   **先查后插，不依赖 UNIQUE 冲突报错。**
   */
  async findExecutedOperation(
    operationId: string,
    client: DbClient = prisma
  ) {
    return client.aiToolExecution.findUnique({
      where: { operationId },
    });
  },

  /**
   * 更新模板草稿版本的 schema。
   *
   * 模板版本没有 revision 机制（04 文档第 45 节：模板版本与实例修订是两套东西），
   * 因此这里只更新 schema，并且只允许改 draft 状态的版本
   * （04 文档第 11.1 节：发布后的版本不可直接修改）。
   */
  async updateTemplateVersionSchema(
    params: { versionId: string; schema: QuestionnaireSchema },
    client: DbClient = prisma
  ): Promise<number> {
    const result = await client.questionnaireTemplateVersion.updateMany({
      where: { id: params.versionId, status: "draft" },
      data: { schema: toJsonValue(params.schema) },
    });
    return result.count;
  },

  /** 同时更新实例状态（确认 / 撤回等流转用） */
  async updateInstanceStatus(
    params: { instanceId: string; status: string },
    client: DbClient = prisma
  ) {
    return client.questionnaireInstance.update({
      where: { id: params.instanceId },
      data: { status: params.status },
    });
  },
};
