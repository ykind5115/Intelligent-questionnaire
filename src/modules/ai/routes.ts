/**
 * AI 模块路由装配。
 *
 * 依据 docs/05-api_design.md 第 10 / 12 节：
 *   POST   /api/v1/ai/conversations                  创建会话
 *   POST   /api/v1/ai/conversations/{id}/messages    发送消息
 *   GET    /api/v1/ai/conversations                  我的会话列表
 *   GET    /api/v1/ai/conversations/{id}             会话详情
 *   GET    /api/v1/ai/conversations/{id}/messages    消息列表
 *   POST   /api/v1/ai/conversations/{id}/close       关闭会话
 *
 * 本文件只做「把 Controller 里的 router 暴露出来」这一件事：
 * 挂载点（/api/v1/ai）由 src/app/routes.ts 决定，
 * 这样路由前缀变化时不需要改模块内部的代码。
 */
import type { Router } from "express";
import { createAiRouter } from "./controller/ai.controller.js";

/** AI 模块的挂载点（单独导出，便于测试与文档保持一致） */
export const AI_ROUTE_PREFIX = "/api/v1/ai";

/** 创建 AI 模块路由（相对路径，已在 ai.controller.ts 中定义） */
export function createAiRoutes(): Router {
  return createAiRouter();
}

export { createAiRouter };
export default createAiRoutes;
