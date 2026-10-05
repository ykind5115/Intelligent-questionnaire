/**
 * 统一响应结构。
 *
 * 依据 docs/05-api_design.md 第 6 节：
 *   成功：{ success: true, data: {...}, requestId }
 *   失败：{ success: false, error: { code, message, detail? }, requestId }
 */
import type { Response } from "express";
import type { Request } from "express";

export interface ApiSuccess<T> {
  success: true;
  data: T;
  requestId?: string;
}

export interface ApiFailure {
  success: false;
  error: {
    code: string;
    message: string;
    detail?: Record<string, unknown>;
  };
  requestId?: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** 从请求上下文取 requestId（由 app 中间件注入） */
export function requestIdOf(req: Request): string | undefined {
  const id = req.header("x-request-id");
  return id ?? undefined;
}

export function sendSuccess<T>(
  req: Request,
  res: Response,
  data: T,
  status = 200
): void {
  const body: ApiSuccess<T> = { success: true, data };
  const requestId = requestIdOf(req);
  if (requestId) body.requestId = requestId;
  res.status(status).json(body);
}

export function sendCreated<T>(
  req: Request,
  res: Response,
  data: T
): void {
  sendSuccess(req, res, data, 201);
}

export function sendFailure(
  req: Request,
  res: Response,
  code: string,
  message: string,
  status: number,
  detail?: Record<string, unknown>
): void {
  const body: ApiFailure = {
    success: false,
    error: detail ? { code, message, detail } : { code, message },
  };
  const requestId = requestIdOf(req);
  if (requestId) body.requestId = requestId;
  res.status(status).json(body);
}

/** 分页返回结构（05 文档第 9.2 节） */
export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface PaginationInput {
  page: number;
  pageSize: number;
  offset: number;
}

/** 解析分页参数，带默认值与上限（05 文档第 36 节：pageSize 最多 100） */
export function parsePagination(
  query: Record<string, unknown>
): PaginationInput {
  const page = Math.max(1, Number(query["page"] ?? 1) || 1);
  const rawSize = Number(query["pageSize"] ?? 20) || 20;
  const pageSize = Math.min(100, Math.max(1, rawSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}
