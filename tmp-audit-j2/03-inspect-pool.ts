/**
 * 探针 3：检查 prisma 内部 pg.Pool 是否真的允许并发连接。
 *
 * 手法：并发 3 个 $queryRaw（很轻），在每个查询内部 sleep，让连接保持占用；
 * 同时读取内部 pool 的 totalCount / idleCount / waitingCount。
 *
 * 用法：pnpm exec tsx tmp-audit-j2/03-inspect-pool.ts
 */
import { prisma } from "../src/database/client.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function findPools(obj: unknown, depth = 0, seen = new Set<unknown>()): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (depth > 6 || !obj || typeof obj !== "object" || seen.has(obj)) return out;
  seen.add(obj);
  const rec = obj as Record<string, unknown>;
  if (typeof rec["totalCount"] === "number" && typeof rec["idleCount"] === "number") {
    out.push(rec);
  }
  for (const k of Object.keys(rec)) {
    try {
      const v = rec[k];
      if (v && typeof v === "object") out.push(...findPools(v, depth + 1, seen));
    } catch {
      /* ignore getters */
    }
  }
  return out;
}

async function main() {
  // 先做一次查询，确保 engine / adapter 已经初始化
  await prisma.$queryRaw`SELECT 1`;

  const pools = findPools(prisma);
  console.log("找到内部 pg.Pool 数量:", pools.length);
  for (const p of pools) {
    console.log(
      "  pool options.max =",
      (p["options"] as Record<string, unknown> | undefined)?.["max"],
      " totalCount=",
      p["totalCount"],
      " idleCount=",
      p["idleCount"],
      " waitingCount=",
      p["waitingCount"]
    );
  }

  // 并发 3 个带 sleep 的查询，中途观察计数
  const N = 3;
  const marks: string[] = [];
  const snapshots = () =>
    pools
      .map((p) => `total=${p["totalCount"]} idle=${p["idleCount"]} waiting=${p["waitingCount"]}`)
      .join(" | ");

  const tasks = Array.from({ length: N }, async (_, i) => {
    const t = Date.now();
    await prisma.$transaction(async (tx) => {
      marks.push(`q${i} body-start @${Date.now() - t}ms  [${snapshots()}]`);
      await tx.$queryRaw`SELECT 1`;
      await sleep(400);
      marks.push(`q${i} body-end   @${Date.now() - t}ms  [${snapshots()}]`);
    });
  });

  const t0 = Date.now();
  await Promise.all(tasks);
  console.log(marks.join("\n"));
  console.log(`N=${N} 总耗时=${Date.now() - t0}ms`);
  console.log("结束时:", snapshots());
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
