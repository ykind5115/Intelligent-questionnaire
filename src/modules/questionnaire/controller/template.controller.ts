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
import { questionnaireService } from "../../questionnaire/service/questionnaire.service.js";
import { invalidParameter } from "../../../shared/errors/index.js";
import { createTemplateEditorRouter, createFlowPreviewRouter } from "./editor.controller.js";
// ============================================================
// 请求 Schema
// ============================================================

const createTemplateBody = z.object({
  // trim 后校验：纯空格名称在 API 边界就报错，不靠 Service 兜
  name: z.string().trim().min(1, "模板名称不能为空").max(200),
  description: z.string().max(2000).optional(),
  /** 所属分类（可选）。给了就必须存在，否则 404（见 template.service.ts） */
  categoryId: z.uuid().optional(),
});

/**
 * 更新模板：只允许改名称、描述与分类，且至少给一个。
 *
 * description / categoryId 允许传 null 表示「清空」——
 * 若只允许 string，前端就没法把描述删掉、也没法取消分类
 * （undefined 表示"不改"）。
 */
const updateTemplateBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    categoryId: z.uuid().nullable().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.categoryId !== undefined,
    "至少要提供 name、description 或 categoryId 之一"
  );

const listQuery = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  keyword: z.string().optional(),
  status: z.enum(["draft", "published", "disabled"]).optional(),
  /** 按分类筛选 */
  categoryId: z.uuid().optional(),
});

/** 选模板用：只需要关键字与分页 */
const publishedVersionsQuery = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  keyword: z.string().optional(),
});

const idParams = z.object({ templateId: z.uuid() });
const versionParams = z.object({
  templateId: z.uuid(),
  versionId: z.uuid(),
});

/**
 * 创建版本的请求体。
 *
 * schema 用 questionnaireSchema 校验 ——
 * 这样在 API 边界就把非法问卷挡住，而不是等落库后才发现。
 */
/**
 * 保存为草稿的请求体。
 *
 * 三个字段都可选 —— 只改名称、或只写变更说明都合理。
 * 但结构是否非空由 Service 校验（空问卷不允许定稿），这里不做重复检查。
 */
const saveDraftBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  changeNote: z.string().max(2000).optional(),
});
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
  categoryId?: string | null;
  category?: { id: string; code: string; name: string } | null;
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
    // 分类：存量模板为 null；带上摘要省掉前端再查一次
    categoryId: t.categoryId ?? null,
    category: t.category ?? null,
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
      const pagination = parsePagination(req.query);

      const { items, total } = await templateService.listTemplates(
        {
          ...(query.keyword !== undefined ? { keyword: query.keyword } : {}),
          ...(query.status !== undefined ? { status: query.status } : {}),
          ...(query.categoryId !== undefined
            ? { categoryId: query.categoryId }
            : {}),
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

  /**
   * 可用的已发布版本（下发问卷时选模板用）。
   *
   * **必须注册在 `/:templateId` 之前** —— 否则 "published-versions"
   * 会被当成一个 templateId 参数匹配掉。
   */
  router.get(
    "/published-versions",
    validate({ query: publishedVersionsQuery }),
    asyncHandler(async (req: Request, res: Response) => {
      const query = validatedQuery<z.infer<typeof publishedVersionsQuery>>(req);
      const pagination = parsePagination(req.query);

      const { items, total } = await templateService.listCurrentPublishedVersions(
        { ...(query.keyword !== undefined ? { keyword: query.keyword } : {}) },
        { skip: pagination.offset, take: pagination.pageSize }
      );

      sendSuccess(req, res, {
        items,
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
  // 只能改名称、描述与分类：结构属于版本，状态由 publish/disable 控制。
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
          ...(body.categoryId !== undefined
            ? { categoryId: body.categoryId }
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

  /**
   * ---- 保存为草稿（定稿）----
   *
   * 为什么需要独立入口：`commitDraftVersion` 原先只被 AI 的
   * `POST /ai/conversations/:id/commit` 调用，于是**纯手工编辑的模板没有任何
   * 定稿动作** —— 内容其实每次操作都已落库，但用户没有「确认名称/写变更说明」
   * 的地方，也拿不到「结构非空」这道校验。
   *
   * 语义与 AI commit 完全相同（复用同一个 Service 方法），差别只是不绑定会话。
   */
  router.post(
    "/:templateId/versions/:versionId/save-draft",
    validate({ params: versionParams, body: saveDraftBody }),
    asyncHandler(async (req: Request, res: Response) => {
      const { templateId, versionId } = req.params as z.infer<
        typeof versionParams
      >;
      const body = req.body as z.infer<typeof saveDraftBody>;
      const ctx = serviceContextOf(req);

      // commitDraftVersion 只按 versionId 工作，因此这里先确认版本属于该模板，
      // 避免拿 A 模板的 id 去定稿 B 模板的版本（URL 与内容不一致）
      const version = await questionnaireService.getTemplateVersionForEditing(
        versionId,
        ctx
      );
      if (version.templateId !== templateId) {
        throw invalidParameter("版本不属于该模板", {
          path: "versionId",
          versionId,
          templateId,
        });
      }

      const saved = await templateService.commitDraftVersion(
        versionId,
        body,
        ctx
      );
      sendSuccess(req, res, saved);
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
  // 只读的流程预览（结构与候选答案 → 路径）。放在写操作之前注册，
  // 路径更长因此不会与 /:templateId 之类冲突，但顺序更明确也更安全。
  router.use("/", createFlowPreviewRouter());
  router.use("/", createTemplateEditorRouter());
  return router;
}
