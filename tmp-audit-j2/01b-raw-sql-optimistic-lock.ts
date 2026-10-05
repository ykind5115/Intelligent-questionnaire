/**
 * 探针 1b：用**纯 pg 原始 SQL**复现「乐观锁 UPDATE 未生效」。
 *
 * 目的：排除 Prisma / 测试脚本的干扰。
 * 步骤：
 *   1. 用 pg 直连（绕过 Prisma），起一个实例；
 *   2. 用 5 个独立连接，各自 BEGIN → SELECT current_revision → 同步栅栏
 *      → UPDATE ... WHERE current_revision = <读到的值> RETURNING current_revision
 *      → COMMIT；
 *   3. 打印每个连接的 affected rows。
 *
 * 期望：只有 1 个连接 affected=1，其余 affected=0。
 * 若全部 affected=1 → 数据库层面也不满足「乐观锁」语义，问题在 SQL/隔离级别而不是 Prisma。
 *
 * 用法：pnpm exec tsx tmp-audit-j2/01b-raw-sql-optimistic-lock.ts
 */
import "dotenv/config";
import pg from "pg";
import { prisma } from "../src/database/client.js";
import { newId } from "../src/shared/utils/id.js";
import {
  USERS,
  createTestInstance,
  deleteTestInstance,
} from "../tests/integration/questionnaire/helpers.js";

const CONCURRENCY = Number(process.argv[2] ?? 5);

/** 简易栅栏：等所有参与者都到达后再放行 */
function makeBarrier(n: number) {
  let arrived = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return async () => {
    arrived += 1;
    if (arrived === n) release?.();
    await gate;
  };
}

async function main() {
  const inst = await createTestInstance();
  console.log("instance:", inst.id, "revision:", inst.initialRevision);

  const pool = new pg.Pool({
    connectionString: process.env["DATABASE_URL"],
    max: CONCURRENCY + 2,
  });

  const arrive = makeBarrier(CONCURRENCY);

  const tasks = Array.from({ length: CONCURRENCY }, async (_, i) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const read = await client.query<{ current_revision: number }>(
        `SELECT "current_revision" FROM questionnaire_instances WHERE id = $1::uuid`,
        [inst.id]
      );
      const seen = read.rows[0]?.current_revision;

      // 让所有连接都读到同一 revision 后再一起写
      await arrive();

      const upd = await client.query<{ current_revision: number }>(
        `UPDATE questionnaire_instances
            SET "current_revision" = "current_revision" + 1,
                "updated_at"       = NOW()
          WHERE id = $1::uuid
            AND "current_revision" = $2
        RETURNING "current_revision"`,
        [inst.id, seen]
      );

      await client.query("COMMIT");
      return { i, seen, affected: upd.rowCount, returned: upd.rows[0] ?? null };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      return {
        i,
        seen: -1,
        affected: -1,
        returned: null,
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      client.release();
    }
  });

  const results = await Promise.all(tasks);
  await pool.end();

  const final = await prisma.questionnaireInstance.findUnique({
    where: { id: inst.id },
    select: { currentRevision: true },
  });

  console.log("results:", JSON.stringify(results, null, 2));
  console.log("最终 currentRevision =", final?.currentRevision);
  console.log(
    "affected=1 的连接数 =",
    results.filter((r) => r.affected === 1).length,
    "（期望 1）"
  );

  await deleteTestInstance(inst.id);
  // 清掉本轮审计（applyToInstance 未参与，故只可能是 createTestInstance 无审计）
  void USERS;
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("FAILED", e);
    await prisma.$disconnect();
    process.exit(1);
  });
