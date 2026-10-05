/**
 * 探针 2：低并发下确认「prisma.$transaction 交互式事务是否被串行化」。
 * 用法：pnpm exec tsx tmp-audit-j2/02-tx-serial-lowconc.ts [N] [sleepMs] [rounds]
 */
import { prisma } from "../src/database/client.js";

const N = Number(process.argv[2] ?? 2);
const SLEEP_MS = Number(process.argv[3] ?? 400);
const ROUNDS = Number(process.argv[4] ?? 3);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function once(n: number) {
  const t0 = Date.now();
  const windows: { i: number; start: number; end: number }[] = [];
  await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      await prisma.$transaction(async (tx) => {
        const start = Date.now() - t0;
        await tx.$queryRaw`SELECT 1`;
        await sleep(SLEEP_MS);
        windows.push({ i, start, end: Date.now() - t0 });
      });
    })
  );
  const total = Date.now() - t0;
  // 交叉重叠检测
  let overlaps = 0;
  for (let a = 0; a < windows.length; a++) {
    for (let b = a + 1; b < windows.length; b++) {
      const A = windows[a]!;
      const B = windows[b]!;
      if (A.start < B.end && B.start < A.end) overlaps++;
    }
  }
  return { n, total, windows: windows.sort((x, y) => x.start - y.start), overlaps };
}

async function main() {
  for (let r = 1; r <= ROUNDS; r++) {
    const res = await once(N);
    const parallel = res.total < SLEEP_MS * 1.6;
    console.log(
      JSON.stringify({
        round: r,
        n: N,
        sleepMs: SLEEP_MS,
        totalMs: res.total,
        overlappingPairs: res.overlaps,
        verdict: res.overlaps > 0 ? "并行（有重叠窗口）" : "完全串行（无重叠窗口）",
        windows: res.windows,
      })
    );
    void parallel;
  }
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
