/**
 * 事务辅助。
 *
 * 依据 docs/06-proj_init.md 第 10.2 节与 docs/04-database_design.md 第 56 节规则七：
 *   一次 Tool 调用 = 一个 operation_id = 一个事务 = 一次 revision 递增
 * 因此事务边界必须显式、可控。
 */
import { prisma } from "./client.js";

/** Prisma 事务客户端类型（tx 参数） */
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export type DbClient = typeof prisma | Tx;

/**
 * 在一个数据库事务中执行 fn。
 *
 * 用法：
 *   await transaction(async (tx) => {
 *     // 全部成功才提交，抛错则回滚
 *   });
 */
export async function transaction<T>(
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  return prisma.$transaction(fn);
}
