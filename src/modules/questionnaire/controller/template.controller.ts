/**
 * 问卷模板 Controller。
 *
 * 依据 docs/06-proj_init.md 第 40 节：
 *   Controller 只做参数校验、调用 Service、转换 Response。
 *   不写业务逻辑、不碰数据库、不拼 Prompt。
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  sendCreated,
  sendSuccess,
  parsePagination,
} from "../../../app/api-response.js";
import { asyncHandler } from "../../../app/error-handler.js";
import { validate, validatedQuery } from "../../../app/validate.js";
import { serviceContextOf } from "../../../app/request-context.js";
import { questionnaireSchema } from "../../questionnaire/schema/questionnaire.schema.js";
import { templateService } from "../../questionnaire/service/template.service.js";

// ============================================================
// 请求 Schema
// ============================================================

const createTemplateBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const listQuery = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  keyword: z.string().optional(),
  status: z.enum(["draft", "published", "disabled"]).optional(),
});

const idParams = z.object({ templateId: z.string().min(1) });
const versionParams = z.object({
  templateId: z.string().min(1),
  versionId: z.string().min(1),
});

/**
 * 创建版本的请求体。
 *
 * schema 用 questionnaireSchema 校验 ——
 * 这样在 API 边界就把非法问卷挡住，而不是等落库后才发现。
 */
const createVersionBody = z.object({
  schema: questionnaireSchema.optional(),
  changeNote: z.string().max(2000).optional(),
});

// ============================================================
// 序列化
// ============================================================

function toTemplateDto(t: {
  id: string;
  name: string;
  description: string | null;
  status: string;
  currentVersionId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    status: t.status,
    currentVersionId: t.currentVersionId,
    createdBy: t.createdBy,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function toVersionSummaryDto(v: {
  id: string;
  templateId: string;
  versionNo: number;
  status: string;
  changeNote: string | null;
  sourceType: string;
  sourceInstanceId: string | null;
  createdBy: string;
  createdAt: Date;
}) {
  return {
    id: v.id,
    templateId: v.templateId,
    versionNo: v.versionNo,
    status: v.status,
    changeNote: v.changeNote,
    sourceType: v.sourceType,
    sourceInstanceId: v.sourceInstanceId,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
  };
}

// ============================================================
// Router
// ============================================================

export function createTemplateRouter(): Router {
  const router = Router();

  // ---- 创建模板 ----
  router.post(
    "/",
    validate({ body: createTemplateBody }),
    asyncHandler(async (req: Request, res: Response) => {
      const template = await templateService.createTemplate(
        req.body as z.infer<typeof createTemplateBody>,
        serviceContextOf(req)
      );
      sendCreated(req, res, toTemplateDto(template));
    })
  );

  // ---- 模板列表 ----
  router.get(
    "/",
    validate({ query: listQuery }),
    asyncHandler(async (req: Request, res: Response) => {
      const query = validatedQuery<z.infer<typeof listQuery>>(req);
      const pagination = parsePagination(req.query as Record<string, unknown>);

      const { items, total } = await templateService.listTemplates(
        {
          ...(query.keyword !== undefined ? { keyword: query.keyword } : {}),
          ...(query.status !== undefined ? { status: query.status } : {}),
        },
        { skip: pagination.offset, take: pagination.pageSize }
      );

      sendSuccess(req, res, {
        items: items.map(toTemplateDto),
        page: pagination.page,
        pageSize: pagination.pageSize,
        total,
      });
    })
  );

  // ---- 模板详情 ----
  router.get(
    "/:templateId",
    validate({ params: idParams }),
    asyncHandler(async (req: Request, res: Response) => {
      const { templateId } = req.params as z.infer<typeof idParams>;
      const template = await templateService.getTemplate(templateId);
      sendSuccess(req, res, toTemplateDto(template));
    })
  );

  // ---- 版本列表 ----
  router.get(
    "/:templateId/versions",
    validate({ params: idParams }),
    asyncHandler(async (req: Request, res: Response) => {
      const { templateId } = req.params as z.infer<typeof idParams>;
      const versions = await templateService.listVersions(templateId);
      sendSuccess(req, res, { items: versions.map(toVersionSummaryDto) });
    })
  );

  // ---- 创建版本 ----
  router.post(
    "/:templateId/versions",
    validate({ params: idParams, body: createVersionBody }),
    asyncHandler(async (req: Request, res: Response) => {
      const { templateId } = req.params as z.infer<typeof idParams>;
      const body = req.body as z.infer<typeof createVersionBody>;

      const version = await templateService.createVersion(
        templateId,
        {
          ...(body.schema !== undefined ? { schema: body.schema } : {}),
          ...(body.changeNote !== undefined
            ? { changeNote: body.changeNote }
            : {}),
        },
        serviceContextOf(req)
      );

      sendCreated(req, res, toVersionSummaryDto(version));
    })
  );

  // ---- 版本详情（含完整 schema） ----
  router.get(
    "/:templateId/versions/:versionId",
    validate({ params: versionParams }),
    asyncHandler(async (req: Request, res: Response) => {
      const { templateId, versionId } = req.params as z.infer<
        typeof versionParams
      >;
      const version = await templateService.getVersion(templateId, versionId);
      sendSuccess(req, res, {
        ...toVersionSummaryDto(version),
        schema: version.schema,
      });
    })
  );

  // ---- 发布版本 ----
  router.post(
    "/:templateId/versions/:versionId/publish",
    validate({ params: versionParams }),
    asyncHandler(async (req: Request, res: Response) => {
      const { templateId, versionId } = req.params as z.infer<
        typeof versionParams
      >;
      const version = await templateService.publishVersion(
        templateId,
        versionId,
        serviceContextOf(req)
      );
      sendSuccess(req, res, toVersionSummaryDto(version));
    })
  );

  // ---- 停用版本 ----
  router.post(
    "/:templateId/versions/:versionId/disable",
    validate({ params: versionParams }),
    asyncHandler(async (req: Request, res: Response) => {
      const { templateId, versionId } = req.params as z.infer<
        typeof versionParams
      >;
      const version = await templateService.disableVersion(
        templateId,
        versionId,
        serviceContextOf(req)
      );
      sendSuccess(req, res, toVersionSummaryDto(version));
    })
  );

  return router;
}
