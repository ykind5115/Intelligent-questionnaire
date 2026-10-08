/**
 * 路由总装配。
 *
 * 依据 docs/06-proj_init.md 第 8.2 节：集中注册模块路由。
 *
 * 注意各模块路由的挂载前缀：
 *   /api/v1/questionnaire-templates   → 模板
 *   /api/v1/questionnaire-instances   → 实例（含 revisions / confirm / withdraw / promote）
 *   /api/v1/ai                        → AI 会话
 *   /api/v1                          → 下发 / 填写 / 审核
 *     （这三者的路径里同时出现 questionnaire-instances/:id/response
 *       与 questionnaire-responses/...，无法放在同一个子前缀下）
 */
import { Router } from "express";
import { createTemplateRouter } from "../modules/questionnaire/controller/template.controller.js";
import { createInstanceRouterWithEditor } from "../modules/questionnaire/controller/instance.controller.js";
import { createAiRouter } from "../modules/ai/routes.js";
import { createDispatchRouter } from "../modules/dispatch/routes.js";
import { createResponseRouter } from "../modules/response/routes.js";
import { createReviewRouter } from "../modules/review/routes.js";

export function createApiRouter(): Router {
  const router = Router();

  router.use("/questionnaire-templates", createTemplateRouter());
  router.use("/questionnaire-instances", createInstanceRouterWithEditor());
  router.use("/ai", createAiRouter());

  // 下发 / 填写 / 审核：路径直接位于 /api/v1 之下
  router.use("/", createDispatchRouter());
  router.use("/", createResponseRouter());
  router.use("/", createReviewRouter());

  return router;
}
