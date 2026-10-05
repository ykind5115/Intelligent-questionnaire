/**
 * 审核 Controller。
 *
 * 依据 docs/06-proj_init.md 第 40 节：
 *   Controller 只做参数校验、调用 Service、转换 Response。
 *
 * 覆盖 docs/05-api_design.md 第 16 节：
 *   GET  /questionnaire-responses/review/pending
 *   GET  /questionnaire-responses/:id/review
 *   POST /questionnaire-responses/:id/review
 */
import type { Request, Response } from "express";
import { z } from "zod";
import { parsePagination, sendSuccess } from "../../../app/api-response.js";
import { asyncHandler } from "../../../app/error-handler.js";
import { serviceContextOf } from "../../../app/request-context.js";
import { validatedQuery } from "../../../app/validate.js";
import { RESPONSE_STATUSES } from "../../response/service/response.service.js";
import { REVIEW_RESULTS, reviewService } from "../service/review.service.js";

// ============================================================
// 请求 Schema
// ============================================================

/** 待审核列表（05 文档第 16.1 节） */
export const pendingReviewsQuery = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  /** 不传默认只看 submitted */
  status: z.enum(RESPONSE_STATUSES).optional(),
  questionnaireInstanceId: z.uuid().optional(),
});

export const reviewParams = z.object({ id: z.uuid() });

/** 审核通过 / 退回（05 文档第 16.3 / 16.4 节，同一个接口） */
export const reviewBody = z.object({
  result: z.enum(REVIEW_RESULTS),
  comment: z.string().max(2000).optional(),
});

// ============================================================
// Handlers（路径在 routes.ts 中定义）
// ============================================================

export const reviewController = {
  /** GET /questionnaire-responses/review/pending */
  listPending: asyncHandler(async (req: Request, res: Response) => {
    const query = validatedQuery<z.infer<typeof pendingReviewsQuery>>(req);
    const pagination = parsePagination(req.query as Record<string, unknown>);

    const { items, total } = await reviewService.listPending(
      {
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.questionnaireInstanceId !== undefined
          ? { questionnaireInstanceId: query.questionnaireInstanceId }
          : {}),
      },
      { skip: pagination.offset, take: pagination.pageSize },
      serviceContextOf(req)
    );

    sendSuccess(req, res, {
      items,
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
    });
  }),

  /** GET /questionnaire-responses/:id/review */
  detail: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as z.infer<typeof reviewParams>;

    const detail = await reviewService.getDetail(id, serviceContextOf(req));

    sendSuccess(req, res, {
      responseId: detail.response.id,
      questionnaireInstanceId: detail.response.questionnaireInstanceId,
      respondentId: detail.response.respondentId,
      status: detail.response.status,
      submittedAt: detail.response.submittedAt,
      instance: {
        id: detail.instance.id,
        title: detail.instance.title,
        status: detail.instance.status,
        currentRevision: detail.instance.currentRevision,
      },
      questionnaire: detail.schema,
      answers: detail.answers,
      reviews: detail.reviews,
    });
  }),

  /** POST /questionnaire-responses/:id/review */
  review: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as z.infer<typeof reviewParams>;
    const body = req.body as z.infer<typeof reviewBody>;

    const result = await reviewService.reviewResponse(
      id,
      {
        result: body.result,
        ...(body.comment !== undefined ? { comment: body.comment } : {}),
      },
      serviceContextOf(req)
    );

    sendSuccess(req, res, {
      reviewId: result.review.id,
      responseId: result.response.id,
      result: result.review.result,
      comment: result.review.comment,
      reviewerId: result.review.reviewerId,
      reviewedAt: result.review.createdAt,
      responseStatus: result.response.status,
      instanceId: result.instanceId,
      instanceStatus: result.instanceStatus,
    });
  }),
};
