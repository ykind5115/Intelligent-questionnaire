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
import path from "node:path";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { prisma } from "../database/client.js";
import { env, isProduction } from "../config/env.js";
import { sendSuccess } from "./api-response.js";
import { createApiRouter } from "./routes.js";
import { errorHandler, notFoundHandler } from "./error-handler.js";
import {
  devAuthMiddleware,
  productionAuthGuard,
} from "../shared/auth/auth.middleware.js";

/** 工作台静态资源目录（仓库根下的 public/） */
const PUBLIC_DIR = path.resolve(process.cwd(), "public");

/**
 * 装配 Express 应用。
 *
 * @param existingApp 可选。传入已有的 Express 实例时复用它而不是新建。
 *   存在的意义：测试需要**先拿到 app 引用**再把它交给 http server，
 *   这样才能通过 app.locals 注入假 Provider
 *   （见 src/modules/ai/controller/ai.controller.ts 的 providerOf）。
 *   若反过来（先建 server 再反查 app）会依赖 http 内部实现，很脆。
 */
export function createApp(existingApp?: Express): Express {
  // 生产环境若无真实鉴权则拒绝启动（决策 D11）
  productionAuthGuard();

  const app = existingApp ?? express();

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

  /**
   * 可用账号列表（**仅非生产环境**）。
   *
   * 为什么需要它：
   *   开发态鉴权靠 x-user-id 头（决策 D11），而它必须是一个真实 UUID，
   *   前端不可能凭空知道 seed 用户 id。没有这个端点，
   *   工作台页面就只能让用户手工粘贴 UUID，几乎不可用。
   *
   *   x-user-id 本身就是开发态的「我是谁」声明，
   *   因此这个端点不需要额外鉴权 —— 但它绝不能出现在生产环境，
   *   否则等于把用户列表（含角色）暴露出去。
   */
  if (!isProduction) {
    app.get("/api/v1/dev/users", async (_req: Request, res: Response) => {
      const users = await prisma.user.findMany({
        where: { status: "active" },
        select: {
          id: true,
          username: true,
          displayName: true,
          roles: true,
        },
        orderBy: { username: "asc" },
      });
      res.json({ success: true, data: { items: users } });
    });
  }

  // ---------------- 工作台前端（无构建链，直接托管静态文件） ----------------
  // 挂在鉴权之前：静态文件本身不含业务数据，不需要身份；
  // 页面里的每个 API 调用都会自带 x-user-id。
  app.use("/", express.static(PUBLIC_DIR, { index: "index.html" }));

  // ---------------- 业务路由 ----------------
  app.use("/api/v1", createApiRouter());

  // ---------------- 未匹配路由 ----------------
  app.use(notFoundHandler);

  // ---------------- 统一错误处理（必须最后） ----------------
  app.use(errorHandler);

  return app;
}
