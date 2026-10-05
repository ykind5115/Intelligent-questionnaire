/**
 * 探针 7（决策 D9 核心）：同一个 operation_id 被并发提交。
 *
 * 期望：
 *   - 只有 1 次真实写入；
 *   - 其余请求走幂等重放（details.idempotentReplay === true），不新增 revision / 节点；
 *   - 不出现唯一约束错误。
 *
 * 检查项：
 *   fullTitleCount（current_schema 里含指定标记的分组数）、
 *   revisions 增量、audit 行数、唯一约束错误数。
 *
 * 用法：pnpm exec tsx tmp-audit-j2/07-same-operation-id.ts [并发度] [轮数]
 */
import { prisma } from "../src/database/client.js";
import { questionnaireService } from "../src/modules/questionnaire/service/questionnaire.service.js";
import { isOperationError } from "../src/shared/errors/index.js";
import { newId } from "../src/shared/utils/id.js";
import {
  CTX,
  createTestInstance,
  deleteTestInstance,
} from "../tests/integration/questionnaire/helpers.js";

const N = Number(process.argv[2] ?? 5);
const ROUNDS = Number(process.argv[3] ?? 5);

async function oneRound(round: number) {
  const inst = await createTestInstance();
  const operationId = newId();
  const marker = `D9-并发-${round}`;

  const settled = await Promise.allSettled(
    Array.from({ length: N }, () =>
      questionnaireService.applyToInstance(
        inst.id,
        { name: "add_section", input: { title: marker } },
        CTX.dispatcher({ operationId })
      )
    )
  );

  const fulfilled = settled
    .filter((s) => s.status === "fulfilled")
    .map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof questionnaireService.applyToInstance>>>).value);
  const rejected = settled
    .filter((s) => s.status === "rejected")
    .map((s) => (s as PromiseRejectedResult).reason);

  const replays = fulfilled.filter(
    (v) => (v.details as Record<string, unknown>)["idempotentReplay"] === true
  ).length;
  const realWrites = fulfilled.length - replays;

  const state = await prisma.questionnaireInstance.findUnique({
    where: { id: inst.id },
    select: { currentRevision: true, currentSchema: true },
  });
  const markerCount = (
    (state?.currentSchema as { sections: { title: string }[] }).sections ?? []
  ).filter((s) => s.title === marker).length;

  const revisions = await prisma.questionnaireRevision.findMany({
    where: { questionnaireInstanceId: inst.id },
    orderBy: { revisionNo: "asc" },
    select: { revisionNo: true, operationId: true },
  });
  const audits = await prisma.aiToolExecution.findMany({
    where: { operationId },
    select: { operationId: true, success: true },
  });

  const errorCodes = rejected.map((e) =>
    isOperationError(e) ? e.code : `RAW:${e instanceof Error ? e.message : String(e)}`
  );
  const uniqueViolations = errorCodes.filter(
    (c) => c.includes("Unique") || c.includes("P2002") || c.startsWith("RAW:")
  );

  const ok =
    realWrites === 1 &&
    replays === N - 1 &&
    markerCount === 1 &&
    state?.currentRevision === 2 &&
    revisions.length === 2 &&
    revisions.filter((r) => r.operationId === operationId).length === 1 &&
    audits.length === 1 &&
    rejected.length === 0;

  console.log(
    JSON.stringify({
      round,
      ok,
      concurrency: N,
      realWrites,
      replays,
      rejectedCount: rejected.length,
      errorCodes,
      uniqueViolations,
      dbCurrentRevision: state?.currentRevision,
      revisionNos: revisions.map((r) => r.revisionNo),
      revisionsWithThisOperationId: revisions.filter((r) => r.operationId === operationId).length,
      auditRows: audits.length,
      markerCountInSchema: markerCount,
      fulfilledRevisions: fulfilled.map((v) => v.revision),
    })
  );

  await deleteTestInstance(inst.id);
  await prisma.aiToolExecution.deleteMany({ where: { operationId } });
  return ok;
}

async function main() {
  let allOk = true;
  for (let r = 1; r <= ROUNDS; r++) {
    if (!(await oneRound(r))) allOk = false;
  }
  console.log(`\n=== 探针7 结论：${allOk ? "同一 operation_id 并发提交被正确幂等化" : "存在幂等/唯一约束问题"} ===`);
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
