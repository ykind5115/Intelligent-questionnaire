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
import { createTemplateEditorRouter } from "./editor.controller.js";

// ============================================================
// 请求 Schema
// ============================================================

const createTemplateBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

/**
 * 更新模板：只允许改名称与描述，且至少给一个。
 *
 * description 允许传 null 表示「清空描述」——
 * 若只允许 string，前端就没法把描述删掉（undefined 表示"不改"）。
 */
const updateTemplateBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.description !== undefined,
    "至少要提供 name 或 description 之一"
  );

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

  // ---- 更新模板（模板管理页的「保存」） ----
  //
  // 只能改名称与描述：结构属于版本，状态由 publish/disable 控制。
  router.patch(
    "/:templateId",
    validate({ params: idParams, body: updateTemplateBody }),
    asyncHandler(async (req: Request, res: Response) => {
      const { templateId } = req.params as z.infer<typeof idParams>;
      const body = req.body as z.infer<typeof updateTemplateBody>;

      const updated = await templateService.updateTemplate(
        templateId,
        {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
        },
        serviceContextOf(req)
      );
      sendSuccess(req, res, toTemplateDto(updated));
    })
  );

  // ---- 删除模板（连带其版本；有实例引用时拒绝） ----
  router.delete(
    "/:templateId",
    validate({ params: idParams }),
    asyncHandler(async (req: Request, res: Response) => {
      const { templateId } = req.params as z.infer<typeof idParams>;
      const result = await templateService.deleteTemplate(
        templateId,
        serviceContextOf(req)
      );
      sendSuccess(req, res, result);
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

/**
 * 模板路由（含模板草稿的人工编辑器子路由）。
 *
 * 人工编辑器（决策 D3）挂在同一前缀下，路径形如：
 *   POST   /questionnaire-templates/{tid}/versions/{vid}/sections
 *   PATCH  /questionnaire-templates/{tid}/versions/{vid}/sections/{sectionId}
 *   POST   /questionnaire-templates/{tid}/versions/{vid}/questions
 *   PATCH  /questionnaire-templates/{tid}/versions/{vid}/questions/{questionId}
 *   PATCH  /questionnaire-templates/{tid}/versions/{vid}/questions/{questionId}/move
 *   DELETE /questionnaire-templates/{tid}/versions/{vid}/questions/{questionId}
 *
 * 与实例编辑器共用同一套 Service 与 Operation 层，
 * 因此规则（权限、只能改 draft、乐观锁、审计）完全一致。
 */
export function createTemplateRouterWithEditor(): Router {
  const router = createTemplateRouter();
  router.use("/", createTemplateEditorRouter());
  return router;
}
