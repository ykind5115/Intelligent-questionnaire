/**
 * 探针 1h：最小 raw pg 连通性测试。
 * 用法：pnpm exec tsx tmp-audit-j2/01h-pg-basic.ts [max] [N]
 */
import "dotenv/config";
import pg from "pg";

const MAX = Number(process.argv[2] ?? 1);
const N = Number(process.argv[3] ?? 1);

async function main() {
  console.log("DATABASE_URL =", (process.env["DATABASE_URL"] ?? "").replace(/:[^:@]*@/, ":***@"));
  const pool = new pg.Pool({
    connectionString: process.env["DATABASE_URL"],
    max: MAX,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", (e) => console.error("[pool idle error]", e.message));

  try {
    const one = await pool.query("SELECT 1 AS ok");
    console.log("单条查询成功:", JSON.stringify(one.rows));
  } catch (e) {
    console.error("单条查询失败:", e instanceof Error ? e.message : String(e));
  }

  const results = await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      try {
        const r = await pool.query("SELECT $1::int AS i, pg_sleep(0.3)", [i]);
        return { i, ok: true, rows: r.rows.length };
      } catch (e) {
        return { i, ok: false, err: e instanceof Error ? e.message : String(e) };
      }
    })
  );
  console.log("并发查询:", JSON.stringify(results));
  console.log("totalCount", pool.totalCount, "idle", pool.idleCount, "waiting", pool.waitingCount);
  await pool.end();
}

main().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
