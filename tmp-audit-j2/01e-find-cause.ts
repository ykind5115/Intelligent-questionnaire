/**
 * 探针 1e：找出「交互式事务被串行化」的真正原因。
 *
 * 实验：
 *   A. 完全不走 prisma：直接用 pg.Pool(max=5) 跑 5 个并发事务，看是否并行；
 *   B. 走 prisma.$transaction，但只 sleep（见 01d）→ 已确认串行；
 *   C. 打印 prisma 内部 pg Pool 的 totalCount/idleCount/waitingCount。
 *
 * 用法：pnpm exec tsx tmp-audit-j2/01e-find-cause.ts
 */
import "dotenv/config";
import pg from "pg";
import { prisma } from "../src/database/client.js";

const N = 5;
const SLEEP_MS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function expA() {
  console.log("=== A. 纯 pg.Pool(max=5) 并发事务 ===");
  const pool = new pg.Pool({
    connectionString: process.env["DATABASE_URL"],
    max: 2, // 保持低上限：prisma 自身已占用若干连接，避免打爆 prisma dev
  });
  const t0 = Date.now();
  const events: string[] = [];
  await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        events.push(`a${i} begin @${Date.now() - t0}ms`);
        await c.query("SELECT 1");
        await sleep(SLEEP_MS);
        await c.query("COMMIT");
        events.push(`a${i} commit @${Date.now() - t0}ms`);
      } finally {
        c.release();
      }
    })
  );
  const total = Date.now() - t0;
  console.log(events.join("\n"));
  console.log(`A) 总耗时=${total}ms → ${total < SLEEP_MS * 2 ? "并行" : "串行"}`);
  console.log(`A) pool.totalCount=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`);
  await pool.end();
}

async function expC() {
  console.log("\n=== C. 观察 prisma 内部 pg Pool 计数 ===");
  const p = prisma as unknown as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (/adapter|engine|_client|pool/i.test(key)) {
      console.log("  key:", key, "->", typeof p[key]);
    }
  }
  // 打印自身非函数属性
  const proto = Object.getOwnPropertyNames(prisma).slice(0, 60);
  console.log("  own props:", proto.join(", "));
}

async function main() {
  await expA();
  await expC();
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
