/**
 * 审核模块路由。
 *
 * 依据 docs/05-api_design.md 第 16 节。
 * 调用方（src/app/routes.ts）会把这些相对路径挂到 /api/v1 下。
 *
 * 注意路由顺序：/questionnaire-responses/review/pending 必须放在
 * /questionnaire-responses/:id/review 之前注册 ——
 * 否则 ":id" 会先吃掉字面量 "review"，
 * 让「待审核列表」被当成一次「审核详情」请求（:id = "review"）。
 */
import { Router } from "express";
import { validate } from "../../app/validate.js";
import {
  pendingReviewsQuery,
  reviewBody,
  reviewController,
  reviewParams,
} from "./controller/review.controller.js";

export function createReviewRouter(): Router {
  const router = Router();

  // ---- 待审核列表（必须在 :id/review 之前） ----
  router.get(
    "/questionnaire-responses/review/pending",
    validate({ query: pendingReviewsQuery }),
    reviewController.listPending
  );

  // ---- 审核详情 ----
  router.get(
    "/questionnaire-responses/:id/review",
    validate({ params: reviewParams }),
    reviewController.detail
  );

  // ---- 审核（通过 / 退回） ----
  router.post(
    "/questionnaire-responses/:id/review",
    validate({ params: reviewParams, body: reviewBody }),
    reviewController.review
  );

  return router;
}
