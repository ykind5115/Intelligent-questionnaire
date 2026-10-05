/**
 * HTTP 测试客户端。
 *
 * 项目里没有装 supertest，直接起一个临时服务用内置 fetch 请求。
 * 这样测的是**真实的 HTTP 链路**（包括中间件顺序、错误处理、状态码），
 * 而不是绕过 Express 直接调路由函数。
 */
import type { Server } from "node:http";
import type { Express } from "express";
import { createApp } from "../../../src/app/app.js";
import { prisma } from "../../../src/database/client.js";

export interface TestHttpClient {
  baseUrl: string;
  close(): Promise<void>;
}

/** 起一个监听随机端口的测试服务 */
export async function startTestServer(
  app: Express = createApp()
): Promise<TestHttpClient> {
  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("无法获取测试服务端口");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface ApiResult<T = unknown> {
  status: number;
  body: {
    success: boolean;
    data?: T;
    error?: { code: string; message: string; detail?: Record<string, unknown> };
    requestId?: string;
  };
}

export interface RequestOptions {
  /** 当前用户 ID；会放进 x-user-id 请求头（决策 D11） */
  userId?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** 发起一次 HTTP 请求并返回解析后的响应 */
export async function apiRequest<T = unknown>(
  client: TestHttpClient,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  options: RequestOptions = {}
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
  };

  if (options.userId) headers["x-user-id"] = options.userId;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${client.baseUrl}${path}`, {
    method,
    headers,
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });

  const text = await res.text();
  let body: ApiResult<T>["body"];
  try {
    body = JSON.parse(text) as ApiResult<T>["body"];
  } catch {
    body = {
      success: false,
      error: { code: "NON_JSON_RESPONSE", message: text.slice(0, 300) },
    };
  }

  return { status: res.status, body };
}

/**
 * 断言辅助：取出成功响应的 data。
 *
 * 签名把参数放宽成 ApiResult<unknown>，让调用方在断言处
 * 显式写出期望的响应形状（`expectData<{ id: string }>(res)`）。
 * 这样请求与断言两处的类型不必互相牵制。
 */
export function expectData<T = unknown>(result: ApiResult<unknown>): T {
  if (!result.body.success || result.body.data === undefined) {
    throw new Error(
      `期望成功响应，实际 HTTP ${result.status}：${JSON.stringify(result.body.error)}`
    );
  }
  return result.body.data as T;
}

/** 测试结束统一断开数据库连接 */
export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}

export { prisma };
