/**
 * 探针 11：填写模块并发/串行数据完整性问题（每个场景单独进程运行）。
 *
 * 用法：pnpm exec tsx tmp-audit-j2/11-response-flows.ts <A|B|C|D>
 *   A getOrCreateResponse 并发 → 同一 (instance, investigator) 产生几条 response
 *   B submitResponse 并发两次 → 几次成功
 *   C saveAnswer 并发 upsert 同一题 → 唯一约束报错？行数？
 *   D reviewResponse 在实例已 completed 后再次审核另一份答卷 → 终态被改写？
 */
import { prisma } from "../src/database/client.js";
import { responseService } from "../src/modules/response/service/response.service.js";
import { reviewService } from "../src/modules/review/service/review.service.js";
import { isOperationError } from "../src/shared/errors/index.js";
import { newId } from "../src/shared/utils/id.js";
import {
  CTX,
  USERS,
  createTestInstance,
  deleteTestInstance,
} from "../tests/integration/questionnaire/helpers.js";

function errInfo(e: unknown) {
  if (isOperationError(e)) return { kind: "OperationError", code: e.code, message: e.message };
  const anyE = e as { code?: string; name?: string; message?: string };
  return { kind: "RAW", code: anyE?.code ?? anyE?.name ?? "UNKNOWN", message: (anyE?.message ?? String(e)).slice(0, 160) };
}

async function fullCleanup(instanceId: string) {
  const responses = await prisma.questionnaireResponse.findMany({
    where: { questionnaireInstanceId: instanceId },
    select: { id: true },
  });
  const ids = responses.map((r) => r.id);
  await prisma.reviewRecord.deleteMany({ where: { questionnaireResponseId: { in: ids } } });
  await prisma.questionnaireAnswer.deleteMany({ where: { responseId: { in: ids } } });
  await prisma.questionnaireResponse.deleteMany({ where: { id: { in: ids } } });
  await prisma.dispatchTask.deleteMany({ where: { questionnaireInstanceId: instanceId } });
  await prisma.aiToolExecution.deleteMany({ where: { questionnaireInstanceId: instanceId } });
  await deleteTestInstance(instanceId);
}

const CASE = (process.argv[2] ?? "A").toUpperCase();
const N = Number(process.argv[3] ?? 3);

async function main() {
  const out: Record<string, unknown> = { case: CASE };

  if (CASE === "A") {
    const inst = await createTestInstance({ status: "dispatched" });
    const settled = await Promise.allSettled(
      Array.from({ length: N }, () => responseService.getOrCreateResponse(inst.id, CTX.investigator()))
    );
    const ids = settled
      .filter((s) => s.status === "fulfilled")
      .map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof responseService.getOrCreateResponse>>>).value.response.id);
    const rows = await prisma.questionnaireResponse.findMany({
      where: { questionnaireInstanceId: inst.id },
      select: { id: true, status: true },
    });
    out["getOrCreateResponse"] = {
      并发度: N,
      成功次数: settled.filter((s) => s.status === "fulfilled").length,
      返回的不同responseId: [...new Set(ids)],
      DB中response行数: rows.length,
      期望行数: 1,
      产生重复: rows.length > 1,
      错误: settled.filter((s) => s.status === "rejected").map((s) => errInfo((s as PromiseRejectedResult).reason)),
    };
    await fullCleanup(inst.id);
  }

  if (CASE === "B") {
    const inst = await createTestInstance({ status: "dispatched" });
    const created = await responseService.getOrCreateResponse(inst.id, CTX.investigator());
    const settled = await Promise.allSettled(
      Array.from({ length: N }, () => responseService.submitResponse(created.response.id, CTX.investigator()))
    );
    const resp = await prisma.questionnaireResponse.findUnique({
      where: { id: created.response.id },
      select: { status: true, submittedAt: true },
    });
    const instRow = await prisma.questionnaireInstance.findUnique({
      where: { id: inst.id },
      select: { status: true },
    });
    out["submitResponse"] = {
      并发度: N,
      成功次数: settled.filter((s) => s.status === "fulfilled").length,
      response状态: resp?.status,
      实例状态: instRow?.status,
      错误: settled.filter((s) => s.status === "rejected").map((s) => errInfo((s as PromiseRejectedResult).reason)),
    };
    await fullCleanup(inst.id);
  }

  if (CASE === "C") {
    const inst = await createTestInstance({ status: "dispatched" });
    const created = await responseService.getOrCreateResponse(inst.id, CTX.investigator());
    const schema = (await prisma.questionnaireInstance.findUnique({
      where: { id: inst.id },
      select: { currentSchema: true },
    }))!.currentSchema as { sections: { questions: { id: string }[] }[] };
    const qid = schema.sections[0]!.questions[0]!.id;
    const settled = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        responseService.saveAnswer(created.response.id, qid, `答案-${i}`, CTX.investigator())
      )
    );
    const answers = await prisma.questionnaireAnswer.findMany({
      where: { responseId: created.response.id, questionId: qid },
      select: { id: true, answer: true },
    });
    out["saveAnswerUpsert"] = {
      并发度: N,
      成功次数: settled.filter((s) => s.status === "fulfilled").length,
      DB中答案行数: answers.length,
      期望行数: 1,
      答案值: answers.map((a) => a.answer),
      错误: settled.filter((s) => s.status === "rejected").map((s) => errInfo((s as PromiseRejectedResult).reason)),
    };
    await fullCleanup(inst.id);
  }

  if (CASE === "D") {
    const inst = await createTestInstance({ status: "dispatched" });
    const r1 = await responseService.getOrCreateResponse(inst.id, CTX.investigator());
    const r2Id = newId();
    await prisma.questionnaireResponse.create({
      data: {
        id: r2Id,
        questionnaireInstanceId: inst.id,
        respondentId: USERS.reviewer,
        status: "submitted",
        submittedAt: new Date(),
      },
    });
    await prisma.questionnaireResponse.update({
      where: { id: r1.response.id },
      data: { status: "submitted", submittedAt: new Date() },
    });

    await reviewService.reviewResponse(r1.response.id, { result: "approved" }, CTX.admin({ roles: ["reviewer"] }));
    const afterFirst = await prisma.questionnaireInstance.findUnique({
      where: { id: inst.id },
      select: { status: true },
    });

    let second: unknown;
    try {
      const r = await reviewService.reviewResponse(r2Id, { result: "rejected", comment: "另一份答卷退回" }, CTX.admin({ roles: ["reviewer"] }));
      second = { ok: true, instanceStatus: r.instanceStatus, responseStatus: r.response.status };
    } catch (e) {
      second = errInfo(e);
    }
    const afterSecond = await prisma.questionnaireInstance.findUnique({
      where: { id: inst.id },
      select: { status: true },
    });
    out["completed实例被再次审核改写"] = {
      第一份审核后实例状态: afterFirst?.status,
      第二份审核结果: second,
      第二份审核后实例状态: afterSecond?.status,
      终态被改写: afterFirst?.status === "completed" && afterSecond?.status !== "completed",
    };
    await fullCleanup(inst.id);
  }

  console.log(JSON.stringify(out, null, 2));
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("FAILED", JSON.stringify(errInfo(e)));
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
