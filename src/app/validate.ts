/**
 * 请求校验中间件。
 *
 * 依据 docs/06-proj_init.md 第 40 节：
 *   Controller 只做「接收 Request → 参数校验 → 调用 Service → 转换 Response」。
 *
 * 用 Zod 在进入 Controller 之前完成校验，
 * 这样 Controller 里拿到的一定是合法且已转型的数据，
 * 校验失败也统一变成 VALIDATION_ERROR（而不是各写一套 if）。
 */
import type { NextFunction, Request, Response } from "express";
import type { z } from "zod";
import { validationError } from "../shared/errors/index.js";

export interface ValidationSchemas {
  body?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  params?: z.ZodTypeAny;
}

/** 把 Zod 的错误转成带字段路径的 detail */
function toDetail(error: z.ZodError): Record<string, unknown> {
  return {
    issues: error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
}

/**
 * 创建校验中间件。
 *
 * 校验通过后把结果写回 req.body / req.query / req.params，
 * 因此下游拿到的是**已转型**的数据（例如字符串 "3" 变成数字 3）。
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.params) {
        const parsed = schemas.params.safeParse(req.params);
        if (!parsed.success) {
          throw validationError("路径参数不合法", toDetail(parsed.error));
        }
        req.params = parsed.data as Request["params"];
      }

      if (schemas.query) {
        const parsed = schemas.query.safeParse(req.query);
        if (!parsed.success) {
          throw validationError("查询参数不合法", toDetail(parsed.error));
        }
        // query 在 Express 5 中是 getter，只能挂到自定义字段上
        (req as Request & { validatedQuery?: unknown }).validatedQuery =
          parsed.data;
      }

      if (schemas.body) {
        const parsed = schemas.body.safeParse(req.body);
        if (!parsed.success) {
          throw validationError("请求体不合法", toDetail(parsed.error));
        }
        req.body = parsed.data;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/** 取回已校验的 query（类型由调用方断言） */
export function validatedQuery<T>(req: Request): T {
  return (req as Request & { validatedQuery?: unknown }).validatedQuery as T;
}
