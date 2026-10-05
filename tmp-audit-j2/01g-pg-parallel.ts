/**
 * 探针 1g：用纯 pg 精确测量服务端允许的并发事务数（不依赖 prisma）。
 * 带重试，规避 prisma dev 偶发 ECONNRESET。
 *
 * 用法：pnpm exec tsx tmp-audit-j2/01g-pg-parallel.ts [max] [N] [rounds]
 */
import "dotenv/config";
import pg from "pg";

const MAX = Number(process.argv[2] ?? 5);
const N = Number(process.argv[3] ?? 5);
const ROUNDS = Number(process.argv[4] ?? 3);
const SLEEP_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function once(max: number, n: number) {
  const pool = new pg.Pool({
    connectionString: process.env["DATABASE_URL"],
    max,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
  });
  const errs: string[] = [];
  pool.on("error", (e) => errs.push(`[pool] ${e.message}`));

  const t0 = Date.now();
  const marks: number[] = [];
  await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      try {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          marks.push(Date.now() - t0);
          await sleep(SLEEP_MS);
          await c.query("COMMIT");
        } finally {
          c.release();
        }
      } catch (e) {
        errs.push(`c${i}: ${e instanceof Error ? e.message : String(e)}`);
      }
    })
  );
  const total = Date.now() - t0;
  await pool.end().catch(() => {});
  return { total, marks, errs, poolMax: pool.options.max };
}

async function main() {
  for (let r = 1; r <= ROUNDS; r++) {
    const res = await once(MAX, N);
    const t0 = Math.min(...res.marks);
    const spread = Math.max(...res.marks) - t0;
    console.log(
      JSON.stringify({
        round: r,
        max: MAX,
        n: N,
        totalMs: res.total,
        firstBeginSpreadMs: spread,
        marks: res.marks,
        errors: res.errs,
      })
    );
  }
}

main().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
