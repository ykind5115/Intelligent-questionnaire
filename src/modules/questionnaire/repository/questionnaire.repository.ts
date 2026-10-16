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
  /** 可读编号，形如 INS-20261015-0001；存量实例为 null */
  instanceNo: string | null;
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

/**
 * 实例列表行（案件管理页用）。
 *
 * 只取列表需要的字段：**不带 `current_schema`**。
 * 结构是 JSONB 且可能很大，列表里带上会让响应体成倍增长；
 * 需要看结构时按 id 走详情接口。
 */
export interface InstanceListRow {
  id: string;
  title: string;
  /** 可读编号，形如 INS-20261015-0001；存量实例为 null */
  instanceNo: string | null;
  status: string;
  currentRevision: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  subjectInfo: Record<string, unknown> | null;
  templateVersionId: string;
  /** 最新一条下发任务（撤回后二次下发会是新的那条；历史任务保留在库里） */
  latestTask: {
    id: string;
    assignedTo: string;
    dispatchedBy: string;
    status: string;
    dispatchedAt: Date | null;
    dueAt: Date | null;
    withdrawnAt: Date | null;
  } | null;
  /** 当前待处理的答卷（优先取未提交的，否则取最新一份） */
  activeResponse: {
    id: string;
    respondentId: string;
    status: string;
    submittedAt: Date | null;
  } | null;
}

/**
 * 构造「这个用户能看哪些实例」的过滤条件（横向授权）。
 *
 * 与 `resolveInstanceAccess`（Service 层逐个实例的判定）保持一致：
 * 两处规则必须同步，否则会出现「列表看得到、点进去 403」。
 * 因此这里刻意写成同一套规则，并在注释里互相指向。
 *
 * - template_admin：模板治理需要，可见全部
 * - dispatcher：只能看到自己创建的实例
 * - investigator：被指派给自己，或自己已填过答卷的实例
 * - reviewer：有已提交/已审核答卷的实例（审核工作台）
 */
function instanceAccessFilter(ctx: {
  userId: string;
  roles: string[];
}): Record<string, unknown> {
  const roles = ctx.roles;

  if (roles.includes("template_admin")) return {};

  const or: Record<string, unknown>[] = [];

  if (roles.includes("dispatcher")) {
    or.push({ createdBy: ctx.userId });
  }

  if (roles.includes("investigator")) {
    or.push({ dispatchTasks: { some: { assignedTo: ctx.userId } } });
    or.push({ responses: { some: { respondentId: ctx.userId } } });
  }

  if (roles.includes("reviewer")) {
    or.push({
      responses: { some: { status: { in: ["submitted", "reviewed"] } } },
    });
  }

  // 有读权限但没有匹配到任何分支（例如角色组合异常）→ 什么都不给
  if (or.length === 0) return { id: { equals: "__no_access__" } };

  return { OR: or };
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

/** 实例编号的号段名（instance_no_counters.scope），预留将来按业务线分号段 */
const INSTANCE_NO_SCOPE = "instance";

/**
 * 取「本地」日期的 YYYYMMDD，作为实例编号里的日期段与发号表的 day。
 *
 * 与 ai-conversation.service.ts 的 formatLocalTimestamp 同理：
 * 不能用 toISOString()，否则东八区用户在夜里会发现编号的日期是「昨天」。
 */
function formatDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export const questionnaireRepository = {
  // ==========================================================
  // 读取
  // ==========================================================

  /**
   * 领取一个新的实例编号，形如 `INS-20261015-0001`。
   *
   * 为什么不用 `count(*) + 1`：并发下两个事务会读到同一个计数，必然撞号。
   * 这里用 `INSERT ... ON CONFLICT (day, scope) DO UPDATE SET current = current + 1`
   * 把「读 + 写」放进同一条语句：同一天的行会被行锁串行化
   * （并发建案会排队，不会撞号），不同天互不阻塞。
   *
   * 已知取舍：**编号允许有空洞**。被回滚的事务已经消耗掉一个号，
   * 这是「宁可跳号也不重号」的有意选择 —— 重号会被唯一索引拦下并让建案失败。
   *
   * 必须在建案事务内调用：事务回滚时计数器自增一并回滚。
   */
  async allocateInstanceNo(
    client: DbClient = prisma,
    now: Date = new Date()
  ): Promise<string> {
    const day = formatDay(now);

    const counter = await client.instanceNoCounter.upsert({
      where: { day_scope: { day, scope: INSTANCE_NO_SCOPE } },
      create: { day, scope: INSTANCE_NO_SCOPE, current: 1 },
      update: { current: { increment: 1 } },
      select: { current: true },
    });

    return `INS-${day}-${String(counter.current).padStart(4, "0")}`;
  },

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
      instanceNo: row.instanceNo,
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

  /**
   * 查询某用户是否被指派了该实例的调查任务。
   *
   * 用途：横向授权校验（决策 D8 的落地）。
   * 调查人员只应看到/填写「指派给自己」的问卷，
   * 而不是任意 uuid 都能进入。
   */
  async hasDispatchAssignment(
    instanceId: string,
    userId: string,
    client: DbClient = prisma
  ): Promise<boolean> {
    const found = await client.dispatchTask.findFirst({
      where: {
        questionnaireInstanceId: instanceId,
        assignedTo: userId,
      },
      select: { id: true },
    });
    return found !== null;
  },

  /** 查询某用户是否是该实例的调查对象答卷填写人 */
  async hasRespondedTo(
    instanceId: string,
    userId: string,
    client: DbClient = prisma
  ): Promise<boolean> {
    const found = await client.questionnaireResponse.findFirst({
      where: {
        questionnaireInstanceId: instanceId,
        respondentId: userId,
      },
      select: { id: true },
    });
    return found !== null;
  },

  /** 按 id 读取答卷（含所属实例，便于做归属校验） */
  async findResponseById(
    responseId: string,
    client: DbClient = prisma
  ): Promise<{
    id: string;
    questionnaireInstanceId: string;
    respondentId: string;
    status: string;
  } | null> {
    const row = await client.questionnaireResponse.findUnique({
      where: { id: responseId },
      select: {
        id: true,
        questionnaireInstanceId: true,
        respondentId: true,
        status: true,
      },
    });
    return row;
  },

  /**
   * 列出「可用的已发布模板版本」——用于下发问卷时选模板。
   *
   * 为什么是「每个模板只取 current_version_id 指向的那一个」：
   *   一个模板可能有多条历史已发布版本，但业务语义是「选一个模板」，
   *   把历史版本全列出来只会让人困惑该选哪个。
   *   需要看历史版本时走模板详情页。
   *
   * 只返回 status = published 的模板，且 current_version_id 非空 ——
   * 后者是「当前生效版本」的唯一权威来源（publish 时写入、disable 时清空）。
   */
  async listCurrentPublishedVersions(
    query: { keyword?: string },
    options: { skip: number; take: number }
  ): Promise<{
    items: {
      versionId: string;
      templateId: string;
      templateName: string;
      templateDescription: string | null;
      versionNo: number;
      publishedAt: Date;
      schema: unknown;
      createdBy: string;
    }[];
    total: number;
  }> {
    const where = {
      status: "published" as const,
      // current_version_id 非空 = 这个模板有正在生效的版本
      NOT: { currentVersionId: null },
      ...(query.keyword
        ? {
            name: {
              contains: query.keyword,
              mode: "insensitive" as const,
            },
          }
        : {}),
    };

    const [templates, total] = await Promise.all([
      prisma.questionnaireTemplate.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: options.skip,
        take: options.take,
        select: {
          id: true,
          name: true,
          description: true,
          currentVersionId: true,
          createdBy: true,
        },
      }),
      prisma.questionnaireTemplate.count({ where }),
    ]);

    const versionIds = templates
      .map((t) => t.currentVersionId)
      .filter((id): id is string => id !== null);

    if (versionIds.length === 0) return { items: [], total };

    const versions = await prisma.questionnaireTemplateVersion.findMany({
      where: { id: { in: versionIds } },
      select: {
        id: true,
        templateId: true,
        versionNo: true,
        // 版本表没有 published_at 字段；用 createdAt 近似。
        // 语义上「已发布版本的生成时间」足够用，且不引入新的冗余字段。
        createdAt: true,
        schema: true,
      },
    });

    const byId = new Map(versions.map((v) => [v.id, v]));

    const items = templates.flatMap((t) => {
      const v = t.currentVersionId ? byId.get(t.currentVersionId) : undefined;
      // 版本被删/状态不一致时跳过，而不是返回半条记录
      if (!v) return [];
      return [
        {
          versionId: v.id,
          templateId: t.id,
          templateName: t.name,
          templateDescription: t.description,
          versionNo: v.versionNo,
          publishedAt: v.createdAt,
          schema: v.schema,
          createdBy: t.createdBy,
        },
      ];
    });

    return { items, total };
  },

  /**
   * 列出问卷实例（案件管理页）。
   *
   * 与 `findInstanceById` 的区别：这里**不带 `current_schema`**，并附带
   * 「最新下发任务」与「当前待处理答卷」，让列表一屏就能回答
   * 「这份问卷现在在谁手上、到哪一步了」。
   */
  async listInstances(
    query: {
      /** 标题模糊匹配（不区分大小写） */
      keyword?: string;
      /** 实例状态 */
      status?: string;
      /** 只要下发给我的（investigator 视角） */
      assignedToMe?: boolean;
    },
    access: { userId: string; roles: string[] },
    options: { skip: number; take: number }
  ): Promise<{ items: InstanceListRow[]; total: number }> {
    const accessFilter = instanceAccessFilter(access);

    const where: Record<string, unknown> = {
      ...accessFilter,
      ...(query.status ? { status: query.status } : {}),
      ...(query.keyword
        ? { title: { contains: query.keyword, mode: "insensitive" } }
        : {}),
      ...(query.assignedToMe
        ? { dispatchTasks: { some: { assignedTo: access.userId } } }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.questionnaireInstance.findMany({
        where,
        // 最近更新的排前面：管理场景更关心"刚动过的"
        orderBy: { updatedAt: "desc" },
        skip: options.skip,
        take: options.take,
        select: {
          id: true,
          title: true,
          instanceNo: true,
          status: true,
          currentRevision: true,
          createdBy: true,
          createdAt: true,
          updatedAt: true,
          subjectInfo: true,
          templateVersionId: true,
          // 只要最新一条：二次下发会产生新任务，管理页关心的是「现在这条」
          dispatchTasks: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              id: true,
              assignedTo: true,
              dispatchedBy: true,
              status: true,
              dispatchedAt: true,
              dueAt: true,
              withdrawnAt: true,
            },
          },
          // 待处理优先（draft 在上），否则取最新一份
          responses: {
            orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
            take: 1,
            select: {
              id: true,
              respondentId: true,
              status: true,
              submittedAt: true,
            },
          },
        },
      }),
      prisma.questionnaireInstance.count({ where }),
    ]);

    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        instanceNo: r.instanceNo,
        status: r.status,
        currentRevision: r.currentRevision,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        subjectInfo: (r.subjectInfo ?? null) as Record<string, unknown> | null,
        templateVersionId: r.templateVersionId,
        latestTask: r.dispatchTasks[0] ?? null,
        activeResponse: r.responses[0] ?? null,
      })),
    };
  },

  /** 列出实例的修订历史（不含快照内容，避免列表接口过大） */  async listRevisions(
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
