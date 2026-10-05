/**
 * 鉴权与当前用户上下文。
 *
 * 依据决策 D11：
 *   V1 不做注册/登录接口，使用 seed.ts 固定的测试账号；
 *   开发态通过请求头 x-user-id 指定当前用户。
 *
 * 设计约束（必须在 V1 守住）：
 *   1. 业务代码只依赖 CurrentUser，不感知当前是测试账号还是真实鉴权；
 *   2. 因此接入真实鉴权时，只需替换本文件里的中间件实现，业务层零改动；
 *   3. 生产环境若没有真实鉴权实现，必须拒绝启动，
 *      绝不能静默降级为「人人可指定身份」。
 */
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../database/client.js";
import { isProduction } from "../../config/env.js";
import { uuidValidate } from "../utils/id.js";

/** 与 05 文档第 5 节一致 */
export interface CurrentUser {
  id: string;
  username: string;
  roles: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      currentUser?: CurrentUser;
    }
  }
}

export const USER_ID_HEADER = "x-user-id";

/** 开发态兜底用户：未带请求头时使用，便于直接用浏览器/curl 调试 */
const DEV_FALLBACK_USERNAME = "dispatcher1";

async function loadUserById(id: string): Promise<CurrentUser | null> {
  // 先校验格式：id 字段是 uuid 类型，
  // 传入非 UUID 字符串时数据库会直接抛错（而不是返回空），
  // 那会变成 500。这里提前拦掉，让它表现为 401。
  if (!uuidValidate(id)) return null;

  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, username: true, roles: true, status: true },
  });

  if (!user || user.status !== "active") return null;

  return { id: user.id, username: user.username, roles: user.roles };
}

async function loadUserByUsername(
  username: string
): Promise<CurrentUser | null> {
  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true, roles: true, status: true },
  });

  if (!user || user.status !== "active") return null;

  return { id: user.id, username: user.username, roles: user.roles };
}

/**
 * 开发态鉴权中间件（决策 D11）。
 *
 * 行为：
 *   1. 读请求头 x-user-id
 *   2. 查 users 表
 *   3. 注入 req.currentUser
 *
 * 若未带请求头，回退到 dispatcher1，方便调试。
 */
export function devAuthMiddleware() {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const raw = req.header(USER_ID_HEADER);

      let user: CurrentUser | null = null;

      if (raw) {
        user = await loadUserById(raw);
        if (!user) {
          res.status(401).json({
            success: false,
            error: {
              code: "UNAUTHORIZED",
              message: `未知或已停用的用户 id：${raw}`,
            },
          });
          return;
        }
      } else {
        user = await loadUserByUsername(DEV_FALLBACK_USERNAME);
        if (!user) {
          res.status(500).json({
            success: false,
            error: {
              code: "SYSTEM_ERROR",
              message:
                "未找到兜底测试账号，请先执行 pnpm db:seed",
            },
          });
          return;
        }
      }

      req.currentUser = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * 生产环境的鉴权占位。
 *
 * 因为没有实现真实鉴权，生产环境下必须直接失败，
 * 而不是放行 —— 见本文件顶部的设计约束第 3 条。
 */
export function productionAuthGuard(): void {
  if (isProduction) {
    throw new Error(
      [
        "生产环境尚未实现真实鉴权（决策 D11 只覆盖开发态）。",
        "请实现 JWT / 内网 SSO 等鉴权中间件后再以 production 启动。",
        "拒绝以测试账号模式运行生产服务。",
      ].join(" ")
    );
  }
}
