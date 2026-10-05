/**
 * Express 应用装配。
 *
 * 依据 docs/06-proj_init.md 第 8 节：
 *   app.ts 只负责注册 middleware / routes / error handler，
 *   不承载业务逻辑。
 *
 * 中间件顺序有讲究：
 *   json 解析 → requestId → 鉴权 → 业务路由 → 404 → 错误处理
 *   错误处理必须最后注册，否则无法捕获前面抛出的异常。
 */
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { prisma } from "../database/client.js";
import { env } from "../config/env.js";
import { sendSuccess } from "./api-response.js";
import { createApiRouter } from "./routes.js";
import { errorHandler, notFoundHandler } from "./error-handler.js";
import {
  devAuthMiddleware,
  productionAuthGuard,
} from "../shared/auth/auth.middleware.js";

export function createApp(): Express {
  // 生产环境若无真实鉴权则拒绝启动（决策 D11）
  productionAuthGuard();

  const app = express();

  app.use(express.json({ limit: "2mb" }));

  // 请求 ID：后续日志与审计都依赖它关联
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (!req.header("x-request-id")) {
      req.headers["x-request-id"] = crypto.randomUUID();
    }
    next();
  });

  // 开发态鉴权（决策 D11）
  app.use(devAuthMiddleware());

  // ---------------- 健康检查（无需业务权限） ----------------
  app.get("/healthz", async (_req: Request, res: Response) => {
    let db = "down";
    try {
      await prisma.$queryRawUnsafe("select 1");
      db = "up";
    } catch {
      db = "down";
    }

    res.status(db === "up" ? 200 : 503).json({
      success: db === "up",
      data: {
        service: "intelligent-questionnaire",
        env: env.NODE_ENV,
        db,
        model: env.AI_MODEL,
        time: new Date().toISOString(),
      },
    });
  });

  // 当前用户（用于验证鉴权链路）
  app.get("/api/v1/me", (req: Request, res: Response) => {
    sendSuccess(req, res, req.currentUser ?? null);
  });

  // ---------------- 业务路由 ----------------
  app.use("/api/v1", createApiRouter());

  // ---------------- 未匹配路由 ----------------
  app.use(notFoundHandler);

  // ---------------- 统一错误处理（必须最后） ----------------
  app.use(errorHandler);

  return app;
}
