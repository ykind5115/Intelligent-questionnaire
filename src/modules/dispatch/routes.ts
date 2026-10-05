/**
 * 下发模块路由。
 *
 * 依据 docs/05-api_design.md 第 14 节。
 * 调用方（src/app/routes.ts）会把这些相对路径挂到 /api/v1 下，
 * 因此这里只写资源相对路径，不带 /api/v1 前缀。
 */
import { Router } from "express";
import { validate } from "../../app/validate.js";
import {
  createDispatchTaskBody,
  dispatchController,
  dispatchTaskParams,
  listDispatchTasksQuery,
} from "./controller/dispatch.controller.js";

export function createDispatchRouter(): Router {
  const router = Router();

  // ---- 创建下发任务 ----
  router.post(
    "/dispatch-tasks",
    validate({ body: createDispatchTaskBody }),
    dispatchController.createTask
  );

  // ---- 执行下发 ----
  router.post(
    "/dispatch-tasks/:id/dispatch",
    validate({ params: dispatchTaskParams }),
    dispatchController.dispatch
  );

  // ---- 查询下发任务（分页） ----
  router.get(
    "/dispatch-tasks",
    validate({ query: listDispatchTasksQuery }),
    dispatchController.list
  );

  return router;
}
