/**
 * 探针 5 的 worker：独立进程 + 独立 PrismaClient。
 * 用法（由 05-multiproc-lost-update.ts 调用）：
 *   tsx 05-worker.ts <instanceId> <startAtEpochMs>
 */
import { prisma } from "../src/database/client.js";

const instanceId = process.argv[2]!;
const startAt = Number(process.argv[3]!);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 读当前 revision（事务外，绝对提交）
  const read = await prisma.$queryRaw<{ current_revision: number }[]>`
    SELECT "current_revision" FROM questionnaire_instances WHERE id = ${instanceId}::uuid
  `;
  const seen = read[0]?.current_revision ?? -1;

  // 等到统一时刻再写，制造真实竞争窗口
  const wait = startAt - Date.now();
  if (wait > 0) await sleep(wait);

  const out: Record<string, unknown> = { seen, pid: process.pid };
  try {
    const upd = await prisma.$queryRaw<{ current_revision: number }[]>`
      UPDATE questionnaire_instances
         SET "current_revision" = "current_revision" + 1,
             "updated_at"       = NOW()
       WHERE id = ${instanceId}::uuid
         AND "current_revision" = ${seen}
      RETURNING "current_revision"
    `;
    out["affected"] = upd.length;
    out["newRev"] = upd[0]?.current_revision ?? null;
  } catch (e) {
    out["error"] = e instanceof Error ? e.message : String(e);
  }
  console.log(JSON.stringify(out));
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("WORKER_ERROR", e instanceof Error ? e.message : String(e));
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
