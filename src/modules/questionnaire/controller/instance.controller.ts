/**
 * 问卷实例 Controller。
 *
 * 依据 docs/05-api_design.md 第 11 / 13 / 13A / 13B 节。
 *
 * 覆盖：创建实例（模板 → 实例）、详情、修订历史、确认、撤回、扶正为模板。
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { sendCreated, sendSuccess } from "../../../app/api-response.js";
import { asyncHandler } from "../../../app/error-handler.js";
import { validate } from "../../../app/validate.js";
import { serviceContextOf } from "../../../app/request-context.js";
import { questionnaireService } from "../service/questionnaire.service.js";
import { createEditorRouter } from "./editor.controller.js";

// ============================================================
// 请求 Schema
// ============================================================

const createInstanceBody = z.object({
  templateVersionId: z.string().min(1),
  title: z.string().min(1).max(200),
  /** 调查对象基础信息，结构随业务可变 */
  subjectInfo: z.record(z.string(), z.unknown()).optional(),
});

const instanceParams = z.object({ instanceId: z.string().min(1) });

const revisionParams = z.object({
  instanceId: z.string().min(1),
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

// ============================================================
// 序列化
// ============================================================

function toInstanceDto(row: {
  id: string;
  templateVersionId: string;
  title: string;
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
    status: row.status,
    currentRevision: row.currentRevision,
    currentSchema: row.currentSchema,
    ...(row.subjectInfo !== undefined ? { subjectInfo: row.subjectInfo } : {}),
    createdBy: row.createdBy,
    ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
    ...(row.updatedAt !== undefined ? { updatedAt: row.updatedAt } : {}),
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
