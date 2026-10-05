/**
 * 填写模块路由。
 *
 * 依据 docs/05-api_design.md 第 15 节。
 * 调用方（src/app/routes.ts）会把这些相对路径挂到 /api/v1 下，
 * 因此这里写的是完整资源相对路径（含 questionnaire-instances /
 * questionnaire-responses 两个资源前缀）。
 */
import { Router } from "express";
import { validate } from "../../app/validate.js";
import {
  instanceResponseParams,
  responseController,
  responseParams,
  saveAnswersBody,
  saveSingleAnswerBody,
  singleAnswerParams,
} from "./controller/response.controller.js";

export function createResponseRouter(): Router {
  const router = Router();

  // ---- 获取待填写问卷（不存在则创建 response） ----
  router.get(
    "/questionnaire-instances/:instanceId/response",
    validate({ params: instanceResponseParams }),
    responseController.getOrCreate
  );

  // ---- 批量保存答案 ----
  router.put(
    "/questionnaire-responses/:id/answers",
    validate({ params: responseParams, body: saveAnswersBody }),
    responseController.saveAnswers
  );

  // ---- 保存单题答案 ----
  router.put(
    "/questionnaire-responses/:id/answers/:questionId",
    validate({ params: singleAnswerParams, body: saveSingleAnswerBody }),
    responseController.saveSingleAnswer
  );

  // ---- 提交 ----
  router.post(
    "/questionnaire-responses/:id/submit",
    validate({ params: responseParams }),
    responseController.submit
  );

  return router;
}
