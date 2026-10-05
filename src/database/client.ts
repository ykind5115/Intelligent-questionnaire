/**
 * Prisma 数据库客户端。
 *
 * 注意（Prisma 7）：
 *   1. 客户端由 generator "prisma-client" 生成到 generated/prisma，
 *      必须从生成目录导入，而不是从 @prisma/client 导入；
 *   2. 运行时需要 driver adapter（@prisma/adapter-pg），
 *      连接串来自 prisma7.config.ts 之外的显式配置。
 *
 * 关于连接池上限（实测结论，不要随意去掉）：
 *   本机数据库由 `prisma dev` 提供，它给出的连接串带有 `connection_limit=10`，
 *   而后端 pg.Pool 的默认 max 也是 10 —— 两边顶在一起时，
 *   并发请求（或并行跑集成测试）会出现：
 *     - `Server has closed the connection`
 *     - `Connection terminated unexpectedly`
 *     - `bind message supplies N parameters, but prepared statement "" requires 0`
 *       （前一次连接异常中断后，pg 复用了失效的 prepared statement 状态）
 *
 *   因此这里显式把 pool 上限压到明显低于服务端限制，
 *   并开启空闲连接回收。迁移到内网真实 PostgreSQL 后，
 *   该上限仍应保持「小于数据库 max_connections 除以实例数」。
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "../config/env.js";
import { PrismaClient } from "../../generated/prisma/client.js";

/** 连接池上限：必须小于数据库端的连接限制 */
const POOL_MAX = Number(process.env["DB_POOL_MAX"] ?? 5);

const adapter = new PrismaPg(
  {
    connectionString: env.DATABASE_URL,
    max: POOL_MAX,
    // 空闲连接及时释放，避免长期占用服务端连接额度
    idleTimeoutMillis: 10_000,
    // 获取连接的最长等待时间；超过则快速失败而不是无限堆积
    connectionTimeoutMillis: 15_000,
  },
  {
    // 连接层异常打日志，便于定位池耗尽问题（而不是静默失败）
    onPoolError: (err: Error) => {
      // eslint-disable-next-line no-console
      console.error("[db pool error]", err.message);
    },
    onConnectionError: (err: Error) => {
      // eslint-disable-next-line no-console
      console.error("[db connection error]", err.message);
    },
  }
);

export const prisma = new PrismaClient({
  adapter,
  log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

export type Db = typeof prisma;
