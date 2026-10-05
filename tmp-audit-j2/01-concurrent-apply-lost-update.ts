/**
 * 探针 1：并发 applyToInstance（相同实例，**不同** operation_id）。
 *
 * 期望（若乐观锁有效）：恰好 1 个成功，其余 REVISION_CONFLICT，
 *   current_revision = 2，revisions 表恰好 2 行（r1 与 r2），审计恰好 1 行。
 * 若乐观锁失效（丢失更新）：多个成功，current_revision 与 revision 行数不一致。
 *
 * 用法：pnpm exec tsx tmp-audit-j2/01-concurrent-apply-lost-update.ts [并发度] [轮数]
 */
import { prisma } from "../src/database/client.js";
import { questionnaireService } from "../src/modules/questionnaire/service/questionnaire.service.js";
import { isOperationError } from "../src/shared/errors/index.js";
import { newId } from "../src/shared/utils/id.js";
import {
  CTX,
  createTestInstance,
  deleteTestInstance,
  readInstanceState,
} from "../tests/integration/questionnaire/helpers.js";

const CONCURRENCY = Number(process.argv[2] ?? 5);
const ROUNDS = Number(process.argv[3] ?? 8);

async function oneRound(round: number) {
  const inst = await createTestInstance();

  const ops = Array.from({ length: CONCURRENCY }, (_, i) => ({
    opId: newId(),
    title: `并发分组-${round}-${i}`,
  }));

  const settled = await Promise.allSettled(
    ops.map((o) =>
      questionnaireService.applyToInstance(
        inst.id,
        { name: "add_section", input: { title: o.title } },
        CTX.dispatcher({ operationId: o.opId })
      )
    )
  );

  const successes: { idx: number; revision: number }[] = [];
  const conflicts: number[] = [];
  const otherErrors: { idx: number; code: string; message: string }[] = [];

  settled.forEach((s, idx) => {
    if (s.status === "fulfilled") {
      successes.push({ idx, revision: s.value.revision });
    } else {
      const e = s.reason;
      if (isOperationError(e) && e.code === "REVISION_CONFLICT") {
        conflicts.push(idx);
      } else {
        otherErrors.push({
          idx,
          code: isOperationError(e) ? e.code : "NON_OPERATION_ERROR",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  });

  const state = await readInstanceState(inst.id);
  const revisions = await prisma.questionnaireRevision.findMany({
    where: { questionnaireInstanceId: inst.id },
    orderBy: { revisionNo: "asc" },
    select: { revisionNo: true, operationType: true, operationId: true },
  });
  const audits = await prisma.aiToolExecution.findMany({
    where: { questionnaireInstanceId: inst.id },
    select: { operationId: true, success: true },
  });

  // 检查 current_schema 里到底有几个「并发分组-」标题（丢失更新的直接证据）
  const titles = (
    (state?.currentSchema as { sections: { title: string }[] } | undefined)
      ?.sections ?? []
  )
    .map((s) => s.title)
    .filter((t) => t.startsWith(`并发分组-${round}-`));

  const ok =
    successes.length === 1 &&
    conflicts.length === CONCURRENCY - 1 &&
    otherErrors.length === 0 &&
    state?.currentRevision === 2 &&
    revisions.length === 2 &&
    revisions.map((r) => r.revisionNo).join(",") === "1,2" &&
    audits.length === 1 &&
    titles.length === 1;

  console.log(
    JSON.stringify({
      round,
      concurrency: CONCURRENCY,
      ok,
      successes,
      conflictCount: conflicts.length,
      otherErrors,
      dbCurrentRevision: state?.currentRevision,
      revisionNos: revisions.map((r) => r.revisionNo),
      operationIdsInRevisions: revisions.map((r) => r.operationId),
      auditCount: audits.length,
      appliedTitlesInSchema: titles,
    })
  );

  await deleteTestInstance(inst.id);
  await prisma.aiToolExecution.deleteMany({
    where: { operationId: { in: ops.map((o) => o.opId) } },
  });

  return ok;
}

async function main() {
  let allOk = true;
  for (let r = 1; r <= ROUNDS; r++) {
    const ok = await oneRound(r);
    if (!ok) allOk = false;
  }
  console.log(`\n=== 探针1 结论：${allOk ? "全部轮次符合乐观锁预期" : "存在不符合预期的轮次"} (并发度=${CONCURRENCY}, 轮数=${ROUNDS}) ===`);
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
