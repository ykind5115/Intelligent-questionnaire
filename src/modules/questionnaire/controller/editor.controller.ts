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
 * 两套目标、一套操作：
 *   /questionnaire-instances/{id}/...                        改案件结构
 *   /questionnaire-templates/{tid}/versions/{vid}/...        改模板草稿结构
 *   请求体与响应体形状**完全一致**，只有目标不同。
 *   模板草稿那条路同样只能写 draft 版本（Service 里校验）。
 *
 * 状态约束（决策 D1）：
 *   已下发的实例结构冻结，人工编辑器同样无法修改
 *   （校验在 Service 的 assertInstanceWritable 里，不在这里重复）。
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { sendSuccess } from "../../../app/api-response.js";
import { asyncHandler } from "../../../app/error-handler.js";
import { validate, validatedQuery } from "../../../app/validate.js";
import { serviceContextOf } from "../../../app/request-context.js";
import { questionnaireService } from "../service/questionnaire.service.js";
import {
  flowPreviewBody,
  flowPreviewController,
} from "./flow-preview.controller.js";

// ============================================================
// 请求 Schema（两套目标共用 body，params 各自不同）
// ============================================================

const instanceParams = z.object({ instanceId: z.uuid() });

const instanceQuestionParams = z.object({
  instanceId: z.uuid(),
  // 题目/分组的 id 是结构内自造的短 id（如 q_xxx、sec_xxx），
  // 不是 UUID，因此这里只能校验非空
  questionId: z.string().min(1),
});

const instanceSectionParams = z.object({
  instanceId: z.uuid(),
  sectionId: z.string().min(1),
});

const versionParams = z.object({
  templateId: z.uuid(),
  versionId: z.uuid(),
});

const versionQuestionParams = z.object({
  templateId: z.uuid(),
  versionId: z.uuid(),
  questionId: z.string().min(1),
});

const versionSectionParams = z.object({
  templateId: z.uuid(),
  versionId: z.uuid(),
  sectionId: z.string().min(1),
});

/** 所有写操作都允许带上「我看到的 revision」做乐观锁（05 文档第 35 节） */
const expectedRevisionSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("客户端看到的版本标识；不一致则拒绝，避免覆盖他人修改");

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

/**
 * 删除分组（连同组内问题）。
 *
 * `expectedRevision` 走 **query** 而不是 body：
 * DELETE 带 body 在部分客户端/代理上会被丢掉（fetch 支持，但不是所有工具链都行），
 * query 更稳妥也更显眼（出现在日志里）。实现里用 z.coerce 容忍字符串。
 */
const removeSectionQuery = z.object({
  expectedRevision: z.coerce.number().int().positive().optional(),
});

/** 整表重排分组：只给 id 顺序，order 由后端算（03 文档第 21 节） */
const reorderSectionsBody = z.object({
  sectionIds: z.array(z.string().min(1)).min(1),
  expectedRevision: expectedRevisionSchema,
});

/** 组内重排问题 */
const reorderQuestionsBody = z.object({
  sectionId: z.string().min(1),
  questionIds: z.array(z.string().min(1)),
  expectedRevision: expectedRevisionSchema,
});

/**
 * 设置 / 清除某题的跳转分支（决策 D16）。
 *
 * 整体替换语义：传空 `branches` 或不传 `defaultNext` 即清除对应字段。
 * `defaultNext: null` 是**有意义的值**（显式终点），因此不能用
 * `.optional()` 一概而论 —— zod 里 `null` 与 `undefined` 在此是两种意图。
 */
const branchOperator = z.enum([
  "eq",
  "ne",
  "in",
  "not_in",
  "is_answered",
  "is_empty",
]);

const setBranchBody = z.object({
  branches: z
    .array(
      z.object({
        when: z.object({
          op: branchOperator,
          questionId: z.string().min(1),
          value: z.unknown().optional(),
        }),
        goTo: z.string().min(1),
      })
    )
    .optional(),
  defaultNext: z.string().min(1).nullable().optional(),
  expectedRevision: expectedRevisionSchema,
});

type OperationPayload = Parameters<
  typeof questionnaireService.applyToInstance
>[1];

/** 把 expectedRevision 转成 Service 的 options（undefined 时不传） */
function revisionOptions(expectedRevision?: number): {
  expectedRevision?: number;
} {
  return expectedRevision !== undefined ? { expectedRevision } : {};
}

/** 人工编辑的审计来源：与 AI 区分开（决策 D3） */
function editorContext(req: Request, toolName: string) {
  return {
    ...serviceContextOf(req),
    source: "manual_editor" as const,
    auditToolName: toolName,
  };
}

// ============================================================
// payload 构造（两套目标共用）
// ============================================================

function buildAddSection(body: z.infer<typeof addSectionBody>): OperationPayload {
  return {
    name: "add_section",
    input: {
      title: body.title,
      ...(body.description !== undefined
        ? { description: body.description }
        : {}),
    },
  };
}

function buildUpdateSection(
  sectionId: string,
  body: z.infer<typeof updateSectionBody>
): OperationPayload {
  return {
    name: "update_section",
    input: {
      sectionId,
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined
        ? { description: body.description }
        : {}),
    },
  };
}

function buildAddQuestion(
  body: z.infer<typeof addQuestionBody>
): OperationPayload {
  return {
    name: "add_question",
    input: {
      sectionId: body.sectionId,
      type: body.type,
      title: body.title,
      ...(body.description !== undefined
        ? { description: body.description }
        : {}),
      ...(body.required !== undefined ? { required: body.required } : {}),
      ...(body.options !== undefined ? { options: body.options } : {}),
    },
  };
}

function buildUpdateQuestion(
  questionId: string,
  body: z.infer<typeof updateQuestionBody>
): OperationPayload {
  return {
    name: "update_question",
    input: {
      questionId,
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined
        ? { description: body.description }
        : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.required !== undefined ? { required: body.required } : {}),
      ...(body.options !== undefined ? { options: body.options } : {}),
    },
  };
}

function buildMoveQuestion(
  questionId: string,
  body: z.infer<typeof moveQuestionBody>
): OperationPayload {
  return {
    name: "move_question",
    input: {
      questionId,
      targetSectionId: body.targetSectionId,
      ...(body.targetOrder !== undefined
        ? { targetOrder: body.targetOrder }
        : {}),
    },
  };
}

function buildRemoveQuestion(questionId: string): OperationPayload {
  return { name: "remove_question", input: { questionId } };
}

function buildRemoveSection(sectionId: string): OperationPayload {
  return { name: "remove_section", input: { sectionId } };
}

function buildReorderSections(
  body: z.infer<typeof reorderSectionsBody>
): OperationPayload {
  return { name: "reorder_sections", input: { sectionIds: body.sectionIds } };
}

function buildReorderQuestions(
  body: z.infer<typeof reorderQuestionsBody>
): OperationPayload {
  return {
    name: "reorder_questions",
    input: { sectionId: body.sectionId, questionIds: body.questionIds },
  };
}

function buildSetQuestionBranch(
  questionId: string,
  body: z.infer<typeof setBranchBody>
): OperationPayload {
  return {
    name: "set_question_branch",
    input: {
      questionId,
      ...(body.branches !== undefined ? { branches: body.branches } : {}),
      // 注意：undefined 表示「清除」，null 表示「显式终点」，必须原样透传
      ...(body.defaultNext !== undefined
        ? { defaultNext: body.defaultNext }
        : {}),
    },
  };
}

// ============================================================
// 通用注册：把六个操作挂到一套目标的四个路径上
// ============================================================

interface TargetSchemas {
  /** 新增分组 / 新增问题用的 params（只含目标标识） */
  base: z.ZodTypeAny;
  /** 带 sectionId 的 params */
  section: z.ZodTypeAny;
  /** 带 questionId 的 params */
  question: z.ZodTypeAny;
}

/**
 * 在给定前缀下注册六个编辑操作。
 *
 * 之所以抽成一个函数：两套目标（实例 / 模板版本）的操作集合、
 * 请求体、响应体完全相同，只有「目标怎么取」不同。
 * 手写两遍容易出现两边行为漂移。
 */
function registerOperations(
  router: Router,
  prefix: string,
  schemas: TargetSchemas,
  resolve: (req: Request) => {
    apply: (
      payload: OperationPayload,
      expectedRevision?: number
    ) => Promise<{ details: Record<string, unknown>; revision: number }>;
  }
): void {
  const run = async (
    req: Request,
    res: Response,
    payload: OperationPayload,
    expectedRevision?: number
  ): Promise<void> => {
    const { apply } = resolve(req);
    const result = await apply(payload, expectedRevision);
    // 响应体形状：{ ...本次变更详情, revision }
    sendSuccess(req, res, { ...result.details, revision: result.revision });
  };

  // ---- 新增分组 ----
  router.post(
    `${prefix}/sections`,
    validate({ params: schemas.base, body: addSectionBody }),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof addSectionBody>;
      await run(req, res, buildAddSection(body), body.expectedRevision);
    })
  );

  // ---- 修改分组 ----
  // 注意顺序：`/sections/reorder` 必须注册在 `/sections/:sectionId` **之前**，
  // 否则 "reorder" 会被当成一个 sectionId 匹配掉（Express 按注册顺序匹配）。
  router.patch(
    `${prefix}/sections/reorder`,
    validate({ params: schemas.base, body: reorderSectionsBody }),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof reorderSectionsBody>;
      await run(req, res, buildReorderSections(body), body.expectedRevision);
    })
  );

  router.patch(
    `${prefix}/sections/:sectionId`,
    validate({ params: schemas.section, body: updateSectionBody }),
    asyncHandler(async (req, res) => {
      const { sectionId } = req.params as { sectionId: string };
      const body = req.body as z.infer<typeof updateSectionBody>;
      await run(
        req,
        res,
        buildUpdateSection(sectionId, body),
        body.expectedRevision
      );
    })
  );

  // ---- 删除分组（连同组内问题） ----
  router.delete(
    `${prefix}/sections/:sectionId`,
    validate({ params: schemas.section, query: removeSectionQuery }),
    asyncHandler(async (req, res) => {
      const { sectionId } = req.params as { sectionId: string };
      const query = validatedQuery<z.infer<typeof removeSectionQuery>>(req);
      await run(req, res, buildRemoveSection(sectionId), query.expectedRevision);
    })
  );

  // ---- 新增问题 ----
  router.post(
    `${prefix}/questions`,
    validate({ params: schemas.base, body: addQuestionBody }),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof addQuestionBody>;
      await run(req, res, buildAddQuestion(body), body.expectedRevision);
    })
  );

  // ---- 移动问题 ----
  // 注册在「修改问题」之前：路径段数不同不会冲突，
  // 但先注册更长的路径可读性更好（也避免将来改成前缀匹配时出错）。
  router.patch(
    `${prefix}/questions/:questionId/move`,
    validate({ params: schemas.question, body: moveQuestionBody }),
    asyncHandler(async (req, res) => {
      const { questionId } = req.params as { questionId: string };
      const body = req.body as z.infer<typeof moveQuestionBody>;
      await run(
        req,
        res,
        buildMoveQuestion(questionId, body),
        body.expectedRevision
      );
    })
  );

  // ---- 组内重排问题 ----
  // 同样必须在 `/questions/:questionId` 之前注册
  router.patch(
    `${prefix}/questions/reorder`,
    validate({ params: schemas.base, body: reorderQuestionsBody }),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof reorderQuestionsBody>;
      await run(req, res, buildReorderQuestions(body), body.expectedRevision);
    })
  );

  // ---- 设置 / 清除跳转分支（决策 D16）----
  // 必须注册在 `/questions/:questionId` 之前，否则 "branch" 会被当成 id
  router.patch(
    `${prefix}/questions/:questionId/branch`,
    validate({ params: schemas.question, body: setBranchBody }),
    asyncHandler(async (req, res) => {
      const { questionId } = req.params as { questionId: string };
      const body = req.body as z.infer<typeof setBranchBody>;
      await run(
        req,
        res,
        buildSetQuestionBranch(questionId, body),
        body.expectedRevision
      );
    })
  );

  // ---- 修改问题 ----
  router.patch(
    `${prefix}/questions/:questionId`,
    validate({ params: schemas.question, body: updateQuestionBody }),
    asyncHandler(async (req, res) => {
      const { questionId } = req.params as { questionId: string };
      const body = req.body as z.infer<typeof updateQuestionBody>;
      await run(
        req,
        res,
        buildUpdateQuestion(questionId, body),
        body.expectedRevision
      );
    })
  );

  // ---- 删除问题 ----
  router.delete(
    `${prefix}/questions/:questionId`,
    validate({ params: schemas.question, body: deleteQuestionBody.optional() }),
    asyncHandler(async (req, res) => {
      const { questionId } = req.params as { questionId: string };
      const body = (req.body ?? {}) as z.infer<typeof deleteQuestionBody>;
      await run(
        req,
        res,
        buildRemoveQuestion(questionId),
        body.expectedRevision
      );
    })
  );
}

// ============================================================
// 实例编辑器
// ============================================================

/**
 * 实例编辑器路由，挂在 /questionnaire-instances 之下：
 *   /api/v1/questionnaire-instances/{id}/sections ...
 */
export function createEditorRouter(): Router {
  const router = Router();

  registerOperations(
    router,
    "/:instanceId",
    {
      base: instanceParams,
      section: instanceSectionParams,
      question: instanceQuestionParams,
    },
    (req) => {
      const { instanceId } = req.params as z.infer<typeof instanceParams>;
      return {
        apply: async (payload, expectedRevision) => {
          const r = await questionnaireService.applyToInstance(
            instanceId,
            payload,
            editorContext(req, payload.name),
            revisionOptions(expectedRevision)
          );
          return { details: r.details, revision: r.revision };
        },
      };
    }
  );

  return router;
}

// ============================================================
// 模板草稿编辑器
// ============================================================

/**
 * 模板草稿编辑器路由，挂在 /questionnaire-templates 之下：
 *   /api/v1/questionnaire-templates/{tid}/versions/{vid}/sections ...
 *
 * 有了它，「从零创建问卷」之后可以像改案件一样手工微调结构 ——
 * 这正是决策 D3 要的兜底能力（AI 改得不合适时人还能直接改）。
 * 只有 draft 版本可写，发布后的版本会被 Service 拒绝。
 */
/**
 * 流程预览子路由（只读）。
 *
 * 路径：
 *   GET  /:templateId/versions/:versionId/flow/structure  结构与不可达诊断
 *   POST /:templateId/versions/:versionId/flow/cases      按候选答案求路径
 *
 * 单独一个 router 而不是塞进 registerOperations：
 *   那两个入口是「应用一次写操作」，而这里是只读查询，
 *   请求/响应形状与它们完全不同，混在一起会让 registerOperations 变复杂。
 */
export function createFlowPreviewRouter(): Router {
  const router = Router();

  router.get(
    "/:templateId/versions/:versionId/flow/structure",
    validate({ params: versionParams }),
    flowPreviewController.structure
  );

  router.post(
    "/:templateId/versions/:versionId/flow/cases",
    validate({ params: versionParams, body: flowPreviewBody }),
    flowPreviewController.cases
  );

  return router;
}

export function createTemplateEditorRouter(): Router {
  const router = Router();

  registerOperations(
    router,
    "/:templateId/versions/:versionId",
    {
      base: versionParams,
      section: versionSectionParams,
      question: versionQuestionParams,
    },
    (req) => {
      const { versionId } = req.params as z.infer<typeof versionParams>;
      return {
        apply: async (payload, expectedRevision) => {
          const r = await questionnaireService.applyToTemplateVersion(
            versionId,
            payload,
            editorContext(req, payload.name),
            revisionOptions(expectedRevision)
          );
          return { details: r.details, revision: r.revision };
        },
      };
    }
  );

  return router;
}
