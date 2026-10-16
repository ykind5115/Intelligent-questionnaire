/**
 * 问卷实例 Controller。
 *
 * 依据 docs/05-api_design.md 第 11 / 13 / 13A / 13B 节。
 *
 * 覆盖：创建实例（模板 → 实例）、详情、修订历史、确认、撤回、扶正为模板。
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  parsePagination,
  sendCreated,
  sendSuccess,
} from "../../../app/api-response.js";
import { asyncHandler } from "../../../app/error-handler.js";
import { validate, validatedQuery } from "../../../app/validate.js";
import { serviceContextOf } from "../../../app/request-context.js";
import { questionnaireService } from "../service/questionnaire.service.js";
import { subjectInfoSchema } from "../schema/subject-info.schema.js";
import { createEditorRouter } from "./editor.controller.js";

// ============================================================
// 请求 Schema
// ============================================================

const createInstanceBody = z.object({
  templateVersionId: z.uuid(),
  title: z.string().min(1).max(200),
  /**
   * 调查对象 / 核查任务的基础信息。
   *
   * 用显式 Schema（而非 z.record）：已知字段有据可依，
   * 但保留未知字段（见 subject-info.schema.ts 的说明）。
   */
  subjectInfo: subjectInfoSchema.optional(),
});

const instanceParams = z.object({ instanceId: z.uuid() });

const revisionParams = z.object({
  instanceId: z.uuid(),
  revisionNo: z.coerce.number().int().positive(),
});

const confirmBody = z.object({
  /** 可选：带上期望的 revision，避免确认到已被改动的版本（05 文档第 35 节） */
  revision: z.number().int().positive().optional(),
});

const withdrawBody = z.object({
  reason: z.string().max(2000).optional(),
});

const promoteBody = z.object({
  changeNote: z.string().max(2000).optional(),
});

/** 实例列表查询（案件管理页） */
const listInstancesQuery = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  /** 按标题模糊搜索 */
  keyword: z.string().optional(),
  /** 按实例状态筛选 */
  status: z
    .enum([
      "draft",
      "confirmed",
      "dispatched",
      "in_progress",
      "submitted",
      "under_review",
      "returned",
      "completed",
      "withdrawn",
    ])
    .optional(),
  /** 只看下发给我的（investigator 视角） */
  assignedToMe: z.coerce.boolean().optional(),
});

// ============================================================
// 序列化
// ============================================================

function toInstanceDto(row: {
  id: string;
  templateVersionId: string;
  title: string;
  instanceNo?: string | null;
  status: string;
  currentRevision: number;
  currentSchema: unknown;
  subjectInfo?: unknown;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    id: row.id,
    templateVersionId: row.templateVersionId,
    title: row.title,
    // 可读编号：存量实例（本列上线前创建）为 null，前端需容忍
    instanceNo: row.instanceNo ?? null,
    status: row.status,
    currentRevision: row.currentRevision,
    currentSchema: row.currentSchema,
    ...(row.subjectInfo !== undefined ? { subjectInfo: row.subjectInfo } : {}),
    createdBy: row.createdBy,
    ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
    ...(row.updatedAt !== undefined ? { updatedAt: row.updatedAt } : {}),
  };
}

/**
 * 列表项序列化。
 *
 * 刻意**不含 `currentSchema`**：列表一次可能返回几十份结构（每份都可能很大），
 * 前端在这个页面也不需要看题目。要看结构走详情接口。
 *
 * 「最新下发任务」只取一条：二次下发会产生新任务，管理页关心的是
 * 「现在这份问卷在谁手上」；历史任务需要时可查 dispatch-tasks。
 */
function toInstanceListDto(row: {
  id: string;
  title: string;
  instanceNo: string | null;
  status: string;
  currentRevision: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  subjectInfo: Record<string, unknown> | null;
  templateVersionId: string;
  latestTask: {
    id: string;
    assignedTo: string;
    dispatchedBy: string;
    status: string;
    dispatchedAt: Date | null;
    dueAt: Date | null;
    withdrawnAt: Date | null;
  } | null;
  activeResponse: {
    id: string;
    respondentId: string;
    status: string;
    submittedAt: Date | null;
  } | null;
}) {
  return {
    id: row.id,
    title: row.title,
    instanceNo: row.instanceNo,
    status: row.status,
    currentRevision: row.currentRevision,
    templateVersionId: row.templateVersionId,
    subjectInfo: row.subjectInfo,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    dispatch: row.latestTask
      ? {
          taskId: row.latestTask.id,
          assignedTo: row.latestTask.assignedTo,
          dispatchedBy: row.latestTask.dispatchedBy,
          status: row.latestTask.status,
          dispatchedAt: row.latestTask.dispatchedAt,
          dueAt: row.latestTask.dueAt,
          withdrawnAt: row.latestTask.withdrawnAt,
        }
      : null,
    response: row.activeResponse
      ? {
          responseId: row.activeResponse.id,
          respondentId: row.activeResponse.respondentId,
          status: row.activeResponse.status,
          submittedAt: row.activeResponse.submittedAt,
        }
      : null,
  };
}

// ============================================================
// Router
// ============================================================

export function createInstanceRouter(): Router {
  const router = Router();

  // ---- 创建实例（模板版本 → 实例） ----
  router.post(
    "/",
    validate({ body: createInstanceBody }),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as z.infer<typeof createInstanceBody>;

      const instance = await questionnaireService.createInstance(
        {
          templateVersionId: body.templateVersionId,
          title: body.title,
          ...(body.subjectInfo !== undefined
            ? { subjectInfo: body.subjectInfo }
            : {}),
        },
        serviceContextOf(req)
      );

      sendCreated(req, res, toInstanceDto(instance));
    })
  );

  /**
   * 列出实例（案件管理页）。
   *
   * 横向授权在 Service + Repository 里按行过滤，因此同一个接口
   * 对 dispatcher / investigator / reviewer 会返回不同的集合，
   * 前端不需要（也不应该）自己判断能看哪些。
   */
  router.get(
    "/",
    validate({ query: listInstancesQuery }),
    asyncHandler(async (req: Request, res: Response) => {
      const query = validatedQuery<z.infer<typeof listInstancesQuery>>(req);
      const pagination = parsePagination(req.query);

      const { items, total, users } = await questionnaireService.listInstances(
        {
          ...(query.keyword !== undefined ? { keyword: query.keyword } : {}),
          ...(query.status !== undefined ? { status: query.status } : {}),
          ...(query.assignedToMe !== undefined
            ? { assignedToMe: query.assignedToMe }
            : {}),
        },
        serviceContextOf(req),
        { skip: pagination.offset, take: pagination.pageSize }
      );

      sendSuccess(req, res, {
        items: items.map(toInstanceListDto),
        // 用户名映射：让前端能显示「下发给谁」而不是一串 uuid
        users,
        page: pagination.page,
        pageSize: pagination.pageSize,
        total,
      });
    })
  );

  // ---- 实例详情 ----
  router.get(
    "/:instanceId",
    validate({ params: instanceParams }),
    asyncHandler(async (req: Request, res: Response) => {
      const { instanceId } = req.params as z.infer<typeof instanceParams>;
      const instance = await questionnaireService.getInstance(
        instanceId,
        serviceContextOf(req)
      );

      sendSuccess(req, res, toInstanceDto(instance));
    })
  );

  // ---- 修订历史 ----
  router.get(
    "/:instanceId/revisions",
    validate({ params: instanceParams }),
    asyncHandler(async (req: Request, res: Response) => {
      const { instanceId } = req.params as z.infer<typeof instanceParams>;
      const revisions = await questionnaireService.listRevisions(
        instanceId,
        serviceContextOf(req)
      );
      sendSuccess(req, res, { items: revisions });
    })
  );

  // ---- 指定修订的完整快照 ----
  router.get(
    "/:instanceId/revisions/:revisionNo",
    validate({ params: revisionParams }),
    asyncHandler(async (req: Request, res: Response) => {
      const { instanceId, revisionNo } = req.params as unknown as z.infer<
        typeof revisionParams
      >;
      const schema = await questionnaireService.getRevisionSchema(
        instanceId,
        revisionNo,
        serviceContextOf(req)
      );
      sendSuccess(req, res, { instanceId, revisionNo, schema });
    })
  );

  // ---- 确认 ----
  router.post(
    "/:instanceId/confirm",
    validate({ params: instanceParams, body: confirmBody.optional() }),
    asyncHandler(async (req: Request, res: Response) => {
      const { instanceId } = req.params as z.infer<typeof instanceParams>;
      const body = (req.body ?? {}) as z.infer<typeof confirmBody>;

      const result = await questionnaireService.confirmInstance(
        instanceId,
        serviceContextOf(req),
        // 05 文档第 35 节：客户端可带上它看到的 revision 做乐观锁校验
        body.revision !== undefined ? { expectedRevision: body.revision } : {}
      );
      sendSuccess(req, res, result);
    })
  );

  // ---- 撤回（决策 D1） ----
  router.post(
    "/:instanceId/withdraw",
    validate({ params: instanceParams, body: withdrawBody.optional() }),
    asyncHandler(async (req: Request, res: Response) => {
      const { instanceId } = req.params as z.infer<typeof instanceParams>;
      const body = (req.body ?? {}) as z.infer<typeof withdrawBody>;

      const result = await questionnaireService.withdrawInstance(
        instanceId,
        serviceContextOf(req),
        body.reason
      );
      sendSuccess(req, res, result);
    })
  );

  // ---- 扶正为模板新版本（决策 D2） ----
  router.post(
    "/:instanceId/promote",
    validate({ params: instanceParams, body: promoteBody.optional() }),
    asyncHandler(async (req: Request, res: Response) => {
      const { instanceId } = req.params as z.infer<typeof instanceParams>;
      const body = (req.body ?? {}) as z.infer<typeof promoteBody>;

      const result = await questionnaireService.promoteToTemplate(
        instanceId,
        {
          ...(body.changeNote !== undefined
            ? { changeNote: body.changeNote }
            : {}),
        },
        serviceContextOf(req)
      );
      sendCreated(req, res, result);
    })
  );

  return router;
}

/**
 * 实例路由（含人工编辑器子路由）。
 *
 * 人工编辑器（决策 D3）挂在同一前缀下，路径形如：
 *   POST   /questionnaire-instances/{id}/sections
 *   PATCH  /questionnaire-instances/{id}/sections/{sectionId}
 *   POST   /questionnaire-instances/{id}/questions
 *   PATCH  /questionnaire-instances/{id}/questions/{questionId}
 *   PATCH  /questionnaire-instances/{id}/questions/{questionId}/move
 *   DELETE /questionnaire-instances/{id}/questions/{questionId}
 *
 * 拆成两个文件是为了让「实例生命周期」与「结构编辑」各自清晰；
 * 它们共用同一套 Service，因此行为与 AI Tool 完全一致。
 */
export function createInstanceRouterWithEditor(): Router {
  const router = createInstanceRouter();
  router.use("/", createEditorRouter());
  return router;
}
