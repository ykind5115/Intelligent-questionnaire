/**
 * 全局错误处理中间件。
 *
 * 依据 docs/06-proj_init.md 第 8 节：
 *   app 层负责注册 middleware / routes / error handler，不承载业务逻辑。
 *
 * 核心职责：把 OperationError 映射成正确的 HTTP 状态码。
 * OperationError 自带 httpStatus（见 shared/errors），
 * 因此这里不需要维护第二张映射表 —— 避免两处不一致。
 */
import type { NextFunction, Request, Response } from "express";
import { isOperationError } from "../shared/errors/index.js";
import { sendFailure } from "./api-response.js";

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // 响应已开始发送时交还给 Express 默认处理，避免 "headers already sent"
  if (res.headersSent) {
    next(err);
    return;
  }

  if (isOperationError(err)) {
    sendFailure(
      req,
      res,
      err.code,
      err.message,
      err.httpStatus,
      err.detail
    );
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error("[unhandled error]", err);

  sendFailure(req, res, "SYSTEM_ERROR", message, 500);
}

/** 未匹配路由的 404 处理 */
export function notFoundHandler(req: Request, res: Response): void {
  sendFailure(
    req,
    res,
    "NOT_FOUND",
    `无此接口：${req.method} ${req.path}`,
    404
  );
}

/**
 * 把 async 路由处理器的异常转交给 errorHandler。
 *
 * Express 5 已经能自动捕获 async 抛出的异常，
 * 但显式包装能让行为在版本升级时保持稳定，也让路由定义读起来更清楚。
 */
export function asyncHandler<
  T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
>(fn: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void fn(req, res, next).catch(next);
  };
}
