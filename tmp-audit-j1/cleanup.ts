/**
 * 兜底清理：读取 tmp-audit-j1/state.json，按外键顺序删除本次审计产生的全部数据。
 *
 * 为什么需要重试：本机 prisma dev 的连接池在并发/异常中断后会偶发
 *   `bind message supplies N parameters, but prepared statement "" requires 0`
 * （见 src/database/client.ts 顶部注释），属于瞬时错误。
 *
 * 运行：pnpm exec tsx tmp-audit-j1/cleanup.ts
 */
import { prisma } from "../src/database/client.js";

const STATE_FILE = "tmp-audit-j1/state.json";

interface AuditState {
  instances: string[];
  users: string[];
}

async function retry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < 5; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  console.error(`[cleanup] ${label} 失败：`, lastErr);
  throw lastErr;
}

async function cleanupInstance(instanceId: string): Promise<void> {
  const responses = await retry(
    () =>
      prisma.questionnaireResponse.findMany({
        where: { questionnaireInstanceId: instanceId },
        select: { id: true },
      }),
    "find responses"
  );
  const ids = responses.map((r) => r.id);

  if (ids.length > 0) {
    await retry(
      () =>
        prisma.reviewRecord.deleteMany({
          where: { questionnaireResponseId: { in: ids } },
        }),
      "delete reviews"
    );
    await retry(
      () => prisma.questionnaireAnswer.deleteMany({ where: { responseId: { in: ids } } }),
      "delete answers"
    );
    await retry(
      () => prisma.questionnaireResponse.deleteMany({ where: { id: { in: ids } } }),
      "delete responses"
    );
  }

  await retry(
    () => prisma.dispatchTask.deleteMany({ where: { questionnaireInstanceId: instanceId } }),
    "delete dispatch tasks"
  );
  await retry(
    () => prisma.aiToolExecution.deleteMany({ where: { questionnaireInstanceId: instanceId } }),
    "delete audits"
  );
  await retry(
    () => prisma.questionnaireRevision.deleteMany({ where: { questionnaireInstanceId: instanceId } }),
    "delete revisions"
  );
  await retry(
    () => prisma.questionnaireInstance.deleteMany({ where: { id: instanceId } }),
    "delete instance"
  );
  console.log(`[cleanup] 实例 ${instanceId} 已清理`);
}

async function cleanupUser(userId: string): Promise<void> {
  await retry(() => prisma.reviewRecord.deleteMany({ where: { reviewerId: userId } }), "del reviews by user");
  const responses = await retry(
    () => prisma.questionnaireResponse.findMany({ where: { respondentId: userId }, select: { id: true } }),
    "find responses by user"
  );
  const ids = responses.map((r) => r.id);
  if (ids.length > 0) {
    await retry(
      () => prisma.reviewRecord.deleteMany({ where: { questionnaireResponseId: { in: ids } } }),
      "del reviews of responses"
    );
    await retry(
      () => prisma.questionnaireAnswer.deleteMany({ where: { responseId: { in: ids } } }),
      "del answers"
    );
    await retry(
      () => prisma.questionnaireResponse.deleteMany({ where: { id: { in: ids } } }),
      "del responses"
    );
  }
  await retry(() => prisma.dispatchTask.deleteMany({ where: { assignedTo: userId } }), "del tasks as assignee");
  await retry(() => prisma.dispatchTask.deleteMany({ where: { dispatchedBy: userId } }), "del tasks as dispatcher");
  await retry(() => prisma.dispatchTask.deleteMany({ where: { withdrawnBy: userId } }), "del tasks as withdrawer");
  await retry(() => prisma.user.deleteMany({ where: { id: userId } }), "del user");
  console.log(`[cleanup] 用户 ${userId} 已清理`);
}

async function main(): Promise<void> {
  const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
  if (!existsSync(STATE_FILE)) {
    console.log("没有 state.json，无需清理");
    return;
  }
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as AuditState;

  for (const id of state.instances) {
    await cleanupInstance(id).catch(() => undefined);
  }
  for (const id of state.users) {
    await cleanupUser(id).catch(() => undefined);
  }

  writeFileSync(STATE_FILE, JSON.stringify({ instances: [], users: [] }, null, 2), "utf8");

  // 输出基线核对信息（串行查询，避免本机连接池被打满）
  const users = await retry(() => prisma.user.count(), "count users");
  const templates = await retry(() => prisma.questionnaireTemplate.count(), "count templates");
  const versions = await retry(() => prisma.questionnaireTemplateVersion.count(), "count versions");
  const instances = await retry(() => prisma.questionnaireInstance.count(), "count instances");
  const tasks = await retry(() => prisma.dispatchTask.count(), "count tasks");
  const responses = await retry(() => prisma.questionnaireResponse.count(), "count responses");
  const answers = await retry(() => prisma.questionnaireAnswer.count(), "count answers");
  const reviews = await retry(() => prisma.reviewRecord.count(), "count reviews");
  const audits = await retry(() => prisma.aiToolExecution.count(), "count audits");
  console.log(
    `\n[基线] users=${users} templates=${templates} templateVersions=${versions} instances=${instances} ` +
      `dispatchTasks=${tasks} responses=${responses} answers=${answers} reviews=${reviews} audits=${audits}`
  );

  // 审计临时用户（如因脚本中断残留）
  const strays = await prisma.user.findMany({
    where: { username: { startsWith: "audit_j1_" } },
    select: { id: true, username: true },
  });
  for (const s of strays) {
    await cleanupUser(s.id).catch(() => undefined);
  }
  if (strays.length > 0) {
    console.log(`[cleanup] 额外清理残留审计用户：${strays.map((s) => s.username).join(", ")}`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error("清理失败：", e);
    await prisma.$disconnect();
    process.exit(1);
  });
