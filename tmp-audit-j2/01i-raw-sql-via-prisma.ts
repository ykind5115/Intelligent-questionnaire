/**
 * 探针 1i：用 prisma.$queryRaw（不经交互式事务）验证乐观锁 SQL 本身的语义。
 *
 * 关键：$queryRaw 每次调用是独立自动提交语句，可以真正并发。
 * 步骤：
 *   1. 建实例；
 *   2. 并发 8 个任务：各自先读 current_revision，然后在**同一个 Promise.all 批次**里
 *      执行 `UPDATE ... WHERE current_revision = <各自读到的值>`；
 *   3. 统计 affected rows。
 *
 * 期望：只有 1 个 affected=1，其余 affected=0（乐观锁有效）。
 *
 * 用法：pnpm exec tsx tmp-audit-j2/01i-raw-sql-via-prisma.ts [并发度] [轮数]
 */
import { prisma } from "../src/database/client.js";
import { createTestInstance, deleteTestInstance } from "../tests/integration/questionnaire/helpers.js";

const N = Number(process.argv[2] ?? 8);
const ROUNDS = Number(process.argv[3] ?? 5);

function makeBarrier(n: number) {
  let arrived = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return async () => {
    arrived += 1;
    if (arrived >= n) release?.();
    await gate;
  };
}

async function oneRound(round: number) {
  const inst = await createTestInstance();
  const arrive = makeBarrier(N);

  const results = await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      // 1) 读：这是独立的自动提交语句
      const read = await prisma.$queryRaw<{ current_revision: number }[]>`
        SELECT "current_revision" FROM questionnaire_instances WHERE id = ${inst.id}::uuid
      `;
      const seen = read[0]?.current_revision ?? -1;

      // 2) 栅栏：让所有读都完成后再一起写
      await arrive();

      // 3) 写：带乐观锁条件
      try {
        const upd = await prisma.$queryRaw<{ current_revision: number }[]>`
          UPDATE questionnaire_instances
             SET "current_revision" = "current_revision" + 1,
                 "updated_at"       = NOW()
           WHERE id = ${inst.id}::uuid
             AND "current_revision" = ${seen}
          RETURNING "current_revision"
        `;
        return { i, seen, affected: upd.length, newRev: upd[0]?.current_revision ?? null };
      } catch (e) {
        return {
          i,
          seen,
          affected: -1,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    })
  );

  const winner = results.filter((r) => r.affected === 1);
  const losers = results.filter((r) => r.affected === 0);
  const final = await prisma.questionnaireInstance.findUnique({
    where: { id: inst.id },
    select: { currentRevision: true },
  });

  const ok = winner.length === 1 && losers.length === N - 1 && final?.currentRevision === 2;
  console.log(
    JSON.stringify({
      round,
      ok,
      concurrency: N,
      distinctSeenValues: [...new Set(results.map((r) => r.seen))],
      winners: winner.map((w) => ({ i: w.i, seen: w.seen, newRev: w.newRev })),
      loserCount: losers.length,
      errors: results.filter((r) => r.affected === -1),
      finalRevision: final?.currentRevision,
      allAffected: results.map((r) => r.affected),
    })
  );

  await deleteTestInstance(inst.id);
  return ok;
}

async function main() {
  let allOk = true;
  for (let r = 1; r <= ROUNDS; r++) {
    if (!(await oneRound(r))) allOk = false;
  }
  console.log(`\n=== 探针1i 结论：${allOk ? "乐观锁 SQL 语义正确（恰好 1 个成功）" : "乐观锁 SQL 语义不正确"} ===`);
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
