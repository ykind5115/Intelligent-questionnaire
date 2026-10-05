/**
 * Express 应用装配。
 *
 * 依据 docs/06-proj_init.md 第 8 节：
 *   app.ts 只负责注册 middleware / routes / error handler，
 *   不承载业务逻辑。
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { prisma } from "../database/client.js";
import { env } from "../config/env.js";
import { devAuthMiddleware, productionAuthGuard } from "../shared/auth/auth.middleware.js";

export function createApp(): Express {
  // 生产环境若无真实鉴权则拒绝启动（决策 D11）
  productionAuthGuard();

  const app = express();

  app.use(express.json({ limit: "2mb" }));

  // 请求 ID：后续日志与审计都依赖它关联
  app.use((req, _res, next) => {
    if (!req.header("x-request-id")) {
      req.headers["x-request-id"] = crypto.randomUUID();
    }
    next();
  });

  // 开发态鉴权（决策 D11）
  app.use(devAuthMiddleware());

  // ---------------- 健康检查 ----------------
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

  // ---------------- 当前用户（用于验证鉴权链路） ----------------
  app.get("/api/v1/me", (req: Request, res: Response) => {
    res.json({
      success: true,
      data: req.currentUser ?? null,
    });
  });

  // ---------------- 未匹配路由 ----------------
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: {
        code: "NOT_FOUND",
        message: `无此接口：${req.method} ${req.path}`,
      },
    });
  });

  // ---------------- 统一错误处理 ----------------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error("[error]", message);

    res.status(500).json({
      success: false,
      error: { code: "SYSTEM_ERROR", message },
    });
  });

  return app;
}
