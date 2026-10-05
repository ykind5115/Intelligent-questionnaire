/**
 * 从请求中取出当前用户与权限上下文。
 *
 * 鉴权中间件已保证 req.currentUser 存在；
 * 这里只在缺失时抛错（属于服务装配问题，不应静默继续）。
 */
import type { Request } from "express";
import { ErrorCode, OperationError } from "../shared/errors/index.js";
import type { ServiceContext } from "../modules/questionnaire/service/questionnaire.service.js";
import type { AiServiceContext } from "../modules/ai/service/ai-conversation.service.js";

export function requireUser(req: Request) {
  const user = req.currentUser;
  if (!user) {
    throw new OperationError(
      ErrorCode.UNAUTHORIZED,
      "未认证：缺少当前用户上下文"
    );
  }
  return user;
}

/** 供 Questionnaire / Template Service 使用 */
export function serviceContextOf(
  req: Request,
  extra: Partial<ServiceContext> = {}
): ServiceContext {
  const user = requireUser(req);
  return {
    userId: user.id,
    roles: user.roles,
    source: "rest",
    ...extra,
  };
}

/** 供 AI 会话 Service 使用 */
export function aiContextOf(req: Request): AiServiceContext {
  const user = requireUser(req);
  return { userId: user.id, roles: user.roles };
}
