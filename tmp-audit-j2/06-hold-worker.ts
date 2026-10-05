/**
 * 探针 6：两个独立进程，各自持有 1 条数据库事务，凭文件栅栏判定是否真能「同时打开」。
 *
 * 用法：
 *   pnpm exec tsx tmp-audit-j2/06-hold-worker.ts <tag> <dir> <holdMs>
 * 由 06-two-proc-hold.ts 调度。
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const tag = process.argv[2]!;
const dir = process.argv[3]!;
const holdMs = Number(process.argv[4] ?? 3000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pool = new pg.Pool({
    connectionString: process.env["DATABASE_URL"],
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  const client = await pool.connect();
  const out: Record<string, unknown> = { tag };
  try {
    await client.query("BEGIN");
    await client.query("SELECT 1");
    out["txOpened"] = true;
    fs.writeFileSync(path.join(dir, `${tag}.ready`), String(Date.now()));
    // 等待对方也 ready，最多 5 秒
    const deadline = Date.now() + 5000;
    const other = tag === "A" ? "B" : "A";
    while (!fs.existsSync(path.join(dir, `${other}.ready`)) && Date.now() < deadline) {
      await sleep(50);
    }
    out["otherReady"] = fs.existsSync(path.join(dir, `${other}.ready`));
    out["heldAt"] = Date.now();
    await sleep(holdMs);
    await client.query("COMMIT");
    out["committed"] = true;
  } catch (e) {
    out["error"] = e instanceof Error ? e.message : String(e);
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
  console.log(JSON.stringify(out));
}

main().catch((e) => {
  console.error("WORKER_ERROR", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
