/**
 * Prisma 数据库客户端。
 *
 * 注意（Prisma 7）：
 *   1. 客户端由 generator "prisma-client" 生成到 generated/prisma，
 *      必须从生成目录导入，而不是从 @prisma/client 导入；
 *   2. 运行时需要 driver adapter（@prisma/adapter-pg），
 *      连接串来自 prisma7.config.ts 之外的显式配置。
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "../config/env.js";
import { PrismaClient } from "../../generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({
  adapter,
  log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

export type Db = typeof prisma;
