/**
 * 探针 1f：pg.Pool 在不同 max 下的真实并发度。
 * 目的：确认「串行化」是 pg.Pool 上限导致，还是服务端（prisma dev）只允许 1 条并发连接。
 *
 * 用法：pnpm exec tsx tmp-audit-j2/01f-pool-concurrency.ts [max] [N]
 */
import "dotenv/config";
import pg from "pg";

const MAX = Number(process.argv[2] ?? 5);
const N = Number(process.argv[3] ?? 5);
const SLEEP_MS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pool = new pg.Pool({
    connectionString: process.env["DATABASE_URL"],
    max: MAX,
  });
  pool.on("error", (e) => console.error("[pool error]", e.message));

  const t0 = Date.now();
  const events: string[] = [];
  await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        events.push(`c${i} begin @${Date.now() - t0}ms`);
        await sleep(SLEEP_MS);
        await c.query("COMMIT");
        events.push(`c${i} commit @${Date.now() - t0}ms`);
      } finally {
        c.release();
      }
    })
  );
  const total = Date.now() - t0;
  console.log(events.join("\n"));
  console.log(
    `max=${MAX} N=${N} 总耗时=${total}ms  pool.totalCount=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`
  );
  // 并发度估算
  console.log(`实际并发度 ≈ ${(N * SLEEP_MS) / total}`.slice(0, 60));
  await pool.end();
}

main().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
