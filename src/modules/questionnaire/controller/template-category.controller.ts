/**
 * 模板分类 Controller。
 *
 * 依据 docs/11-future-capability-plan.md 第 5.1 节。
 *
 * 挂载前缀：`/api/v1/questionnaire-template-categories`
 *   GET    /        列出分类（任何已鉴权用户，选模板与筛选都要读）
 *   POST   /        新建分类（template_admin）
 *   PATCH  /:categoryId  改名称/描述（template_admin，不接受改 code）
 *   DELETE /:categoryId  删除（template_admin，仍被模板引用时拒绝）
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { sendCreated, sendSuccess } from "../../../app/api-response.js";
import { asyncHandler } from "../../../app/error-handler.js";
import { validate } from "../../../app/validate.js";
import { serviceContextOf } from "../../../app/request-context.js";
import { templateCategoryService } from "../../questionnaire/service/template-category.service.js";

const createCategoryBody = z.object({
  // 字符集由 Service 统一校验（错误信息更具体），这里只挡长度与空值
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).optional(),
});

/**
 * 更新分类：只允许改名称与描述，且至少给一个。
 *
 * description 允许 null 表示「清空描述」（与模板的 updateTemplate 同理）。
 * 刻意**没有 code**：编码是程序侧引用的依据，要换就新建分类。
 */
const updateCategoryBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.description !== undefined,
    "至少要提供 name 或 description 之一"
  );

const categoryParams = z.object({ categoryId: z.uuid() });

export function createTemplateCategoryRouter(): Router {
  const router = Router();

  router.get(
    "/",
    asyncHandler(async (req: Request, res: Response) => {
      const items = await templateCategoryService.listCategories();
      sendSuccess(req, res, { items });
    })
  );

  router.post(
    "/",
    validate({ body: createCategoryBody }),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as z.infer<typeof createCategoryBody>;
      const created = await templateCategoryService.createCategory(
        {
          code: body.code,
          name: body.name,
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
        },
        serviceContextOf(req)
      );
      sendCreated(req, res, created);
    })
  );

  router.patch(
    "/:categoryId",
    validate({ params: categoryParams, body: updateCategoryBody }),
    asyncHandler(async (req: Request, res: Response) => {
      const { categoryId } = req.params as z.infer<typeof categoryParams>;
      const body = req.body as z.infer<typeof updateCategoryBody>;

      const updated = await templateCategoryService.updateCategory(
        categoryId,
        {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
        },
        serviceContextOf(req)
      );
      sendSuccess(req, res, updated);
    })
  );

  router.delete(
    "/:categoryId",
    validate({ params: categoryParams }),
    asyncHandler(async (req: Request, res: Response) => {
      const { categoryId } = req.params as z.infer<typeof categoryParams>;
      const result = await templateCategoryService.deleteCategory(
        categoryId,
        serviceContextOf(req)
      );
      sendSuccess(req, res, result);
    })
  );

  return router;
}
