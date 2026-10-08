/**
 * 人工编辑器 Controller（决策 D3 的兜底能力）。
 *
 * 设计原则（很重要）：
 *   **不新增任何业务逻辑**。这里只是给已经存在的 Operation 层
 *   加一层 REST 门面，所有校验、权限、状态冻结、事务、Revision、审计
 *   都走与 AI Tool 完全相同的 QuestionnaireService。
 *
 *   这也是为什么能在很短时间里做出可用的人工编辑器 ——
 *   Operation 层从第一天就被约束成纯函数（入参 (schema, input) → 新 schema），
 *   因此「AI 改问卷」与「人改问卷」天然共用同一套实现。
 *
 * 状态约束（决策 D1）：
 *   已下发的实例结构冻结，人工编辑器同样无法修改
 *   （校验在 Service 的 assertInstanceWritable 里，不在这里重复）。
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { sendSuccess } from "../../../app/api-response.js";
import { asyncHandler } from "../../../app/error-handler.js";
import { validate } from "../../../app/validate.js";
import { serviceContextOf } from "../../../app/request-context.js";
import { questionnaireService } from "../service/questionnaire.service.js";

// ============================================================
// 请求 Schema
// ============================================================

const instanceParams = z.object({ instanceId: z.string().min(1) });

const questionParams = z.object({
  instanceId: z.string().min(1),
  questionId: z.string().min(1),
});

const sectionParams = z.object({
  instanceId: z.string().min(1),
  sectionId: z.string().min(1),
});

/** 所有写操作都允许带上「我看到的 revision」做乐观锁（05 文档第 35 节） */
const expectedRevisionSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("客户端看到的 currentRevision；不一致则拒绝，避免覆盖他人修改");

const optionInput = z.object({
  label: z.string().min(1),
  value: z.string().optional(),
});

const questionType = z.enum([
  "text",
  "textarea",
  "number",
  "single_choice",
  "multiple_choice",
  "date",
  "datetime",
  "boolean",
]);

const addSectionBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  expectedRevision: expectedRevisionSchema,
});

const updateSectionBody = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    expectedRevision: expectedRevisionSchema,
  })
  .refine(
    (v) => v.title !== undefined || v.description !== undefined,
    "至少要提供 title 或 description 之一"
  );

const addQuestionBody = z.object({
  sectionId: z.string().min(1),
  type: questionType,
  title: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  required: z.boolean().optional(),
  options: z.array(optionInput).optional(),
  expectedRevision: expectedRevisionSchema,
});

const updateQuestionBody = z
  .object({
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(2000).optional(),
    type: questionType.optional(),
    required: z.boolean().optional(),
    options: z.array(optionInput).optional(),
    expectedRevision: expectedRevisionSchema,
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.description !== undefined ||
      v.type !== undefined ||
      v.required !== undefined ||
      v.options !== undefined,
    "至少要提供一个要修改的字段"
  );

const moveQuestionBody = z.object({
  targetSectionId: z.string().min(1),
  targetOrder: z.number().int().positive().optional(),
  expectedRevision: expectedRevisionSchema,
});

const deleteQuestionBody = z.object({
  expectedRevision: expectedRevisionSchema,
});

// ============================================================
// 公共：把 expectedRevision 组装成 applyToInstance 的 options
// ============================================================

function revisionOptions(expectedRevision?: number): {
  expectedRevision?: number;
} {
  return expectedRevision !== undefined ? { expectedRevision } : {};
}

/** 写操作的统一返回：新 revision 与本次变更详情（前端据此刷新结构树） */
// 返回体形状：{ ...本次变更详情, revision }
// 例如新增分组返回 { section: {...}, revision: 3 }

// ============================================================
// Router
// ============================================================

/**
 * 人工编辑器路由。
 *
 * 挂在 /questionnaire-instances 之下（与实例详情同一前缀），
 * 因此调用方看到的路径是 /api/v1/questionnaire-instances/{id}/...
 */
export function createEditorRouter(): Router {
  const router = Router();

  const apply = async (
    req: Request,
    res: Response,
    payload: Parameters<
      typeof questionnaireService.applyToInstance
    >[1],
    expectedRevision?: number
  ): Promise<void> => {
    const { instanceId } = req.params as z.infer<typeof instanceParams>;

    const result = await questionnaireService.applyToInstance(
      instanceId,
      payload,
      {
        ...serviceContextOf(req),
        // 人工编辑也要留痕，来源区分于 AI（决策 D3）
        source: "manual_editor",
        auditToolName: payload.name,
      },
      revisionOptions(expectedRevision)
    );

    sendSuccess(req, res, {
      ...result.details,
      revision: result.revision,
    });
  };

  // ---- 新增分组 ----
  router.post(
    "/:instanceId/sections",
    validate({ params: instanceParams, body: addSectionBody }),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof addSectionBody>;
      await apply(
        req,
        res,
        {
          name: "add_section",
          input: {
            title: body.title,
            ...(body.description !== undefined
              ? { description: body.description }
              : {}),
          },
        },
        body.expectedRevision
      );
    })
  );

  // ---- 修改分组 ----
  router.patch(
    "/:instanceId/sections/:sectionId",
    validate({ params: sectionParams, body: updateSectionBody }),
    asyncHandler(async (req, res) => {
      const { sectionId } = req.params as z.infer<typeof sectionParams>;
      const body = req.body as z.infer<typeof updateSectionBody>;

      await apply(
        req,
        res,
        {
          name: "update_section",
          input: {
            sectionId,
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.description !== undefined
              ? { description: body.description }
              : {}),
          },
        },
        body.expectedRevision
      );
    })
  );

  // ---- 新增问题 ----
  router.post(
    "/:instanceId/questions",
    validate({ params: instanceParams, body: addQuestionBody }),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof addQuestionBody>;

      await apply(
        req,
        res,
        {
          name: "add_question",
          input: {
            sectionId: body.sectionId,
            type: body.type,
            title: body.title,
            ...(body.description !== undefined
              ? { description: body.description }
              : {}),
            ...(body.required !== undefined
              ? { required: body.required }
              : {}),
            ...(body.options !== undefined ? { options: body.options } : {}),
          },
        },
        body.expectedRevision
      );
    })
  );

  // ---- 修改问题 ----
  router.patch(
    "/:instanceId/questions/:questionId",
    validate({ params: questionParams, body: updateQuestionBody }),
    asyncHandler(async (req, res) => {
      const { questionId } = req.params as z.infer<typeof questionParams>;
      const body = req.body as z.infer<typeof updateQuestionBody>;

      await apply(
        req,
        res,
        {
          name: "update_question",
          input: {
            questionId,
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.description !== undefined
              ? { description: body.description }
              : {}),
            ...(body.type !== undefined ? { type: body.type } : {}),
            ...(body.required !== undefined
              ? { required: body.required }
              : {}),
            ...(body.options !== undefined ? { options: body.options } : {}),
          },
        },
        body.expectedRevision
      );
    })
  );

  // ---- 移动问题 ----
  router.patch(
    "/:instanceId/questions/:questionId/move",
    validate({ params: questionParams, body: moveQuestionBody }),
    asyncHandler(async (req, res) => {
      const { questionId } = req.params as z.infer<typeof questionParams>;
      const body = req.body as z.infer<typeof moveQuestionBody>;

      await apply(
        req,
        res,
        {
          name: "move_question",
          input: {
            questionId,
            targetSectionId: body.targetSectionId,
            ...(body.targetOrder !== undefined
              ? { targetOrder: body.targetOrder }
              : {}),
          },
        },
        body.expectedRevision
      );
    })
  );

  // ---- 删除问题 ----
  router.delete(
    "/:instanceId/questions/:questionId",
    validate({ params: questionParams, body: deleteQuestionBody.optional() }),
    asyncHandler(async (req, res) => {
      const { questionId } = req.params as z.infer<typeof questionParams>;
      const body = (req.body ?? {}) as z.infer<typeof deleteQuestionBody>;

      await apply(
        req,
        res,
        { name: "remove_question", input: { questionId } },
        body.expectedRevision
      );
    })
  );

  return router;
}
