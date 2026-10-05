/**
 * 填写 Controller。
 *
 * 依据 docs/06-proj_init.md 第 40 节：
 *   Controller 只做参数校验、调用 Service、转换 Response。
 *
 * 覆盖 docs/05-api_design.md 第 15 节：
 *   GET  /questionnaire-instances/:instanceId/response
 *   PUT  /questionnaire-responses/:id/answers
 *   PUT  /questionnaire-responses/:id/answers/:questionId
 *   POST /questionnaire-responses/:id/submit
 */
import type { Request, Response } from "express";
import { z } from "zod";
import { sendSuccess } from "../../../app/api-response.js";
import { asyncHandler } from "../../../app/error-handler.js";
import { serviceContextOf } from "../../../app/request-context.js";
import { responseService } from "../service/response.service.js";

// ============================================================
// 请求 Schema
// ============================================================

/**
 * 答案值。
 *
 * questionnaire_answers.answer 是 JSONB（04 文档第 28 节），
 * 不同题型结构不同：text → string、multiple_choice → string[]，
 * 因此这里只约束「是合法 JSON 标量/数组/对象」，
 * 具体题型语义留给问卷结构（current_schema）解释。
 */
export const answerValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

const questionIdSchema = z.string().min(1).max(100);

export const instanceResponseParams = z.object({
  instanceId: z.uuid(),
});

export const responseParams = z.object({ id: z.uuid() });

export const singleAnswerParams = z.object({
  id: z.uuid(),
  questionId: questionIdSchema,
});

/** 批量保存（05 文档第 15.3 节） */
export const saveAnswersBody = z.object({
  answers: z
    .array(
      z.object({
        questionId: questionIdSchema,
        answer: answerValueSchema,
      })
    )
    .min(1)
    .max(500),
});

/** 单题保存（05 文档第 15.2 节） */
export const saveSingleAnswerBody = z.object({
  answer: answerValueSchema,
});

// ============================================================
// Handlers（路径在 routes.ts 中定义）
// ============================================================

export const responseController = {
  /** GET /questionnaire-instances/:instanceId/response */
  getOrCreate: asyncHandler(async (req: Request, res: Response) => {
    const { instanceId } = req.params as z.infer<
      typeof instanceResponseParams
    >;

    const result = await responseService.getOrCreateResponse(
      instanceId,
      serviceContextOf(req)
    );

    sendSuccess(req, res, {
      responseId: result.response.id,
      questionnaireInstanceId: result.response.questionnaireInstanceId,
      status: result.response.status,
      submittedAt: result.response.submittedAt,
      instanceStatus: result.instance.status,
      revisionNo: result.instance.currentRevision,
      questionnaire: result.schema,
      answers: result.answers.map((a) => ({
        questionId: a.questionId,
        answer: a.answer,
        revisionNo: a.revisionNo,
      })),
    });
  }),

  /** PUT /questionnaire-responses/:id/answers */
  saveAnswers: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as z.infer<typeof responseParams>;
    const body = req.body as z.infer<typeof saveAnswersBody>;

    const result = await responseService.saveAnswers(
      id,
      body.answers,
      serviceContextOf(req)
    );

    sendSuccess(req, res, {
      responseId: result.response.id,
      status: result.response.status,
      revisionNo: result.revisionNo,
      savedCount: result.saved.length,
      saved: result.saved,
    });
  }),

  /** PUT /questionnaire-responses/:id/answers/:questionId */
  saveSingleAnswer: asyncHandler(async (req: Request, res: Response) => {
    const { id, questionId } = req.params as z.infer<
      typeof singleAnswerParams
    >;
    const body = req.body as z.infer<typeof saveSingleAnswerBody>;

    const result = await responseService.saveAnswer(
      id,
      questionId,
      body.answer,
      serviceContextOf(req)
    );

    sendSuccess(req, res, {
      responseId: result.response.id,
      status: result.response.status,
      revisionNo: result.revisionNo,
      savedCount: result.saved.length,
      saved: result.saved,
    });
  }),

  /** POST /questionnaire-responses/:id/submit */
  submit: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as z.infer<typeof responseParams>;

    const result = await responseService.submitResponse(
      id,
      serviceContextOf(req)
    );

    sendSuccess(req, res, {
      responseId: result.response.id,
      status: result.response.status,
      submittedAt: result.response.submittedAt,
      instanceId: result.instanceId,
      instanceStatus: result.instanceStatus,
    });
  }),
};
