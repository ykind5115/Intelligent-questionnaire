/**
 * 探针 4：判断「串行化」是客户端造成的还是服务端（prisma dev）造成的。
 *
 * 手法：创建**两个独立的 PrismaClient**，各自 pool max=1。若服务端允许 2 条并发连接，
 *       两个 client 的事务应当互相重叠；若仍然串行，则瓶颈在服务端。
 *
 * 用法：pnpm exec tsx tmp-audit-j2/04-two-clients.ts
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SLEEP_MS = 400;

function makeClient(tag: string) {
  const adapter = new PrismaPg({
    connectionString: process.env["DATABASE_URL"],
    max: 1,
    idleTimeoutMillis: 10_000,
  });
  return new PrismaClient({
    adapter,
    log: [{ emit: "event", level: "error" } as never],
  }).$extends({
    name: `tag-${tag}`,
    result: {},
  }) as unknown as PrismaClient;
}

async function runOn(client: PrismaClient, tag: string, t0: number, log: string[]) {
  try {
    await client.$transaction(async (tx) => {
      log.push(`${tag} begin @${Date.now() - t0}ms`);
      await tx.$queryRaw`SELECT 1`;
      await sleep(SLEEP_MS);
      log.push(`${tag} end   @${Date.now() - t0}ms`);
    });
  } catch (e) {
    log.push(`${tag} ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  const c1 = makeClient("c1");
  const c2 = makeClient("c2");

  // 预热
  await c1.$queryRaw`SELECT 1`;
  await c2.$queryRaw`SELECT 1`;

  const log: string[] = [];
  const t0 = Date.now();
  await Promise.all([
    runOn(c1, "C1", t0, log),
    runOn(c2, "C2", t0, log),
  ]);
  const total = Date.now() - t0;
  console.log(log.join("\n"));
  console.log(`两个独立 client，各 pool max=1 → 总耗时=${total}ms，判定：${total < SLEEP_MS * 1.7 ? "服务端支持并发" : "服务端串行"}`);

  await c1.$disconnect();
  await c2.$disconnect();
}

main().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
