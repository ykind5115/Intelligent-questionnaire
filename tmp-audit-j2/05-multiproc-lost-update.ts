/**
 * 探针 5：多进程真实并发下，乐观锁是否真的阻止「丢失更新」。
 *
 * 设计：
 *   parent：建实例 → spawn N 个 worker（各自独立 Node 进程、独立 PrismaClient）
 *   worker：读 current_revision → sleep 到统一时刻 → 执行
 *           UPDATE ... WHERE current_revision = <读到的值> RETURNING ...
 *           把结果（读到的版本 / affected / 新版本 / 错误）以一行 JSON 打到 stdout
 *   parent：汇总，判定是否「恰好 1 个成功」
 *
 * 用法：pnpm exec tsx tmp-audit-j2/05-multiproc-lost-update.ts [N]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prisma } from "../src/database/client.js";
import {
  createTestInstance,
  deleteTestInstance,
} from "../tests/integration/questionnaire/helpers.js";

const N = Number(process.argv[2] ?? 5);
const here = path.dirname(fileURLToPath(import.meta.url));

function runWorker(instanceId: string, startAt: number): Promise<string> {
  return new Promise((resolve) => {
    const tsxCli = path.join(
      here,
      "..",
      "node_modules",
      "tsx",
      "dist",
      "cli.mjs"
    );
    const child = spawn(
      process.execPath,
      [tsxCli, path.join(here, "05-worker.ts"), instanceId, String(startAt)],
      { stdio: ["ignore", "pipe", "pipe"], shell: false }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("close", () => resolve(out.trim() || `WORKER_FAILED: ${err.trim().split("\n").slice(-3).join(" | ")}`));
  });
}

async function main() {
  const inst = await createTestInstance();
  console.log("instance:", inst.id, "初始 revision:", inst.initialRevision);

  const startAt = Date.now() + 6000; // 给所有 worker 足够时间启动
  const results = await Promise.all(
    Array.from({ length: N }, () => runWorker(inst.id, startAt))
  );

  const parsed = results.map((r) => {
    try {
      return JSON.parse(r);
    } catch {
      return { raw: r };
    }
  });

  console.log("worker 结果:");
  for (const p of parsed) console.log("  ", JSON.stringify(p));

  const ok = parsed.filter((p) => p.affected === 1).length;
  const conflict = parsed.filter((p) => p.affected === 0).length;
  const failed = parsed.filter((p) => p.raw || p.error);

  const final = await prisma.questionnaireInstance.findUnique({
    where: { id: inst.id },
    select: { currentRevision: true },
  });

  console.log(
    JSON.stringify(
      {
        并发进程数: N,
        affected1: ok,
        冲突数: conflict,
        失败: failed.length,
        最终revision: final?.currentRevision,
        读到的revision集合: [...new Set(parsed.map((p) => p.seen))],
        判定:
          ok === 1
            ? "乐观锁有效：恰好 1 个进程更新成功，其余 0 行受影响"
            : `丢失更新：${ok} 个进程同时更新成功`,
      },
      null,
      2
    )
  );

  await deleteTestInstance(inst.id);
  // 清审计
  await prisma.aiToolExecution.deleteMany({
    where: { questionnaireInstanceId: inst.id },
  });
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
