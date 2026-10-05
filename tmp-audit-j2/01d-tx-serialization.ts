/**
 * 探针 1d：Prisma 的**交互式事务是否被串行化**。
 *
 * 手法：让 N 个并发事务各自 sleep(SLEEP_MS) 后返回。
 *   真正并行 → 总耗时 ≈ SLEEP_MS
 *   被串行化 → 总耗时 ≈ N * SLEEP_MS
 *
 * 同时打印每次 start/end 的时间戳，直接看出是否重叠。
 *
 * 用法：pnpm exec tsx tmp-audit-j2/01d-tx-serialization.ts [N] [sleepMs]
 */
import { prisma } from "../src/database/client.js";

const N = Number(process.argv[2] ?? 5);
const SLEEP_MS = Number(process.argv[3] ?? 200);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const t0 = Date.now();
  const events: string[] = [];

  const tasks = Array.from({ length: N }, async (_, i) => {
    const start = Date.now() - t0;
    events.push(`task${i} BEGIN @${start}ms`);
    await prisma.$transaction(async (tx) => {
      const inner = Date.now() - t0;
      events.push(`task${i}   body-start @${inner}ms`);
      await tx.$queryRaw`SELECT 1`;
      await sleep(SLEEP_MS);
      events.push(`task${i}   body-end @${Date.now() - t0}ms`);
    });
    events.push(`task${i} COMMIT @${Date.now() - t0}ms`);
  });

  await Promise.all(tasks);
  const total = Date.now() - t0;

  console.log(events.join("\n"));
  console.log(
    `\nN=${N} sleep=${SLEEP_MS}ms 总耗时=${total}ms  ` +
      `判定：${total < SLEEP_MS * 2 ? "并行" : total >= SLEEP_MS * N * 0.8 ? "被串行化" : "部分并行"}`
  );
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
