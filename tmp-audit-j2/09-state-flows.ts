/**
 * 探针 9：填写 / 下发 / 审核 三个模块的并发与状态流转自洽性。
 *
 * 覆盖：
 *   9A getOrCreateResponse 并发 → 会不会产生同一 (instance, investigator) 的多条 response；
 *   9B submitResponse 并发两次 → 是否只有一次成功；
 *   9C reviewService.reviewResponse 并发两次 → 会不会写两条 review 记录 / 状态错乱；
 *   9D dispatchService.createTask 重复调用 → 是否产生重复 pending 任务；
 *   9E questionnaireService 并发 confirm + withdraw；
 *   9F saveAnswers 并发 upsert 同一 (response, question) → 会不会抛唯一约束错误。
 *
 * 用法：pnpm exec tsx tmp-audit-j2/09-state-flows.ts
 */
import { prisma } from "../src/database/client.js";
import { questionnaireService } from "../src/modules/questionnaire/service/questionnaire.service.js";
import { responseService } from "../src/modules/response/service/response.service.js";
import { reviewService } from "../src/modules/review/service/review.service.js";
import { dispatchService } from "../src/modules/dispatch/service/dispatch.service.js";
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
  return {
    kind: "RAW",
    code: anyE?.code ?? anyE?.name ?? "UNKNOWN",
    message: (anyE?.message ?? String(e)).slice(0, 140),
  };
}

/** 清理一个实例相关的所有写入 */
async function fullCleanup(instanceId: string) {
  const responses = await prisma.questionnaireResponse.findMany({
    where: { questionnaireInstanceId: instanceId },
    select: { id: true },
  });
  const responseIds = responses.map((r) => r.id);
  await prisma.reviewRecord.deleteMany({
    where: { questionnaireResponseId: { in: responseIds } },
  });
  await prisma.questionnaireAnswer.deleteMany({
    where: { responseId: { in: responseIds } },
  });
  await prisma.dispatchTask.deleteMany({
    where: { questionnaireInstanceId: instanceId },
  });
  await deleteTestInstance(instanceId);
}

const results: Record<string, unknown> = {};

// ---------------------------------------------------------------- 9A
async function testA() {
  const inst = await createTestInstance({ status: "dispatched" });
  const settled = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      responseService.getOrCreateResponse(inst.id, CTX.investigator())
    )
  );
  const rows = await prisma.questionnaireResponse.findMany({
    where: { questionnaireInstanceId: inst.id, respondentId: USERS.investigator },
    select: { id: true },
  });
  const distinctIds = new Set(
    settled
      .filter((s) => s.status === "fulfilled")
      .map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof responseService.getOrCreateResponse>>>).value.response.id)
  );
  results["9A_getOrCreateResponse"] = {
    concurrency: 3,
    返回的不同responseId: [...distinctIds],
    DB中的response行数: rows.length,
    期望行数: 1,
    ok: rows.length === 1,
    错误: settled.filter((s) => s.status === "rejected").map((s) => errInfo((s as PromiseRejectedResult).reason)),
  };
  await fullCleanup(inst.id);
}

// ---------------------------------------------------------------- 9B
async function testB() {
  const inst = await createTestInstance({ status: "dispatched" });
  const created = await responseService.getOrCreateResponse(inst.id, CTX.investigator());
  // 填一个必填项？这里只验证 draft→submitted 的并发
  const settled = await Promise.allSettled(
    Array.from({ length: 3 }, () => responseService.submitResponse(created.response.id, CTX.investigator()))
  );
  const okCount = settled.filter((s) => s.status === "fulfilled").length;
  const reviews = await prisma.reviewRecord.count({
    where: { questionnaireResponseId: created.response.id },
  });
  const resp = await prisma.questionnaireResponse.findUnique({
    where: { id: created.response.id },
    select: { status: true, submittedAt: true },
  });
  const instRow = await prisma.questionnaireInstance.findUnique({
    where: { id: inst.id },
    select: { status: true },
  });
  results["9B_submitResponse"] = {
    concurrency: 3,
    成功次数: okCount,
    期望成功次数: 1,
    response状态: resp?.status,
    submittedAt非空: resp?.submittedAt !== null,
    实例状态: instRow?.status,
    reviewRecords: reviews,
    ok: okCount === 1 && resp?.status === "submitted" && instRow?.status === "submitted",
    错误: settled.filter((s) => s.status === "rejected").map((s) => errInfo((s as PromiseRejectedResult).reason)),
  };
  // 注意：必填校验可能拦下提交，这里若被拦也算 ok=false，需人工看 message
  await fullCleanup(inst.id);
}

// ---------------------------------------------------------------- 9C
async function testC() {
  const inst = await createTestInstance({ status: "dispatched" });
  const created = await responseService.getOrCreateResponse(inst.id, CTX.investigator());
  await prisma.questionnaireResponse.update({
    where: { id: created.response.id },
    data: { status: "submitted", submittedAt: new Date() },
  });

  const settled = await Promise.allSettled([
    reviewService.reviewResponse(created.response.id, { result: "approved" }, CTX.admin({ roles: ["reviewer"] })),
    reviewService.reviewResponse(created.response.id, { result: "approved" }, CTX.admin({ roles: ["reviewer"] })),
    reviewService.reviewResponse(created.response.id, { result: "rejected", comment: "并发退回" }, CTX.admin({ roles: ["reviewer"] })),
  ]);
  const okCount = settled.filter((s) => s.status === "fulfilled").length;
  const records = await prisma.reviewRecord.findMany({
    where: { questionnaireResponseId: created.response.id },
    select: { result: true },
  });
  const instRow = await prisma.questionnaireInstance.findUnique({
    where: { id: inst.id },
    select: { status: true },
  });
  const resp = await prisma.questionnaireResponse.findUnique({
    where: { id: created.response.id },
    select: { status: true, submittedAt: true },
  });
  results["9C_reviewResponse"] = {
    concurrency: 3,
    成功次数: okCount,
    期望成功次数: 1,
    reviewRecords: records.map((r) => r.result),
    实例状态: instRow?.status,
    response状态: resp?.status,
    自洽: instRow?.status === "completed" ? resp?.status === "submitted" : instRow?.status === "returned" ? resp?.status === "draft" : false,
    错误: settled.filter((s) => s.status === "rejected").map((s) => errInfo((s as PromiseRejectedResult).reason)),
  };
  await fullCleanup(inst.id);
}

// ---------------------------------------------------------------- 9D
async function testD() {
  const inst = await createTestInstance({ status: "confirmed" });
  const settled = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      dispatchService.createTask(
        { questionnaireInstanceId: inst.id, assignedTo: USERS.investigator },
        CTX.dispatcher()
      )
    )
  );
  const tasks = await prisma.dispatchTask.findMany({
    where: { questionnaireInstanceId: inst.id },
    select: { id: true, status: true },
  });
  results["9D_createDispatchTask"] = {
    concurrency: 3,
    成功次数: settled.filter((s) => s.status === "fulfilled").length,
    DB中的pending任务数: tasks.filter((t) => t.status === "pending").length,
    是否有唯一约束: false,
    结论: tasks.length > 1 ? "同一实例+同一调查员产生重复下发任务（无唯一约束）" : "未产生重复",
    错误: settled.filter((s) => s.status === "rejected").map((s) => errInfo((s as PromiseRejectedResult).reason)),
  };
  await fullCleanup(inst.id);
}

// ---------------------------------------------------------------- 9E
async function testE() {
  const inst = await createTestInstance({ status: "draft" });
  // 先把实例推到 dispatched，再并发 confirm + withdraw + withdraw
  await prisma.questionnaireInstance.update({
    where: { id: inst.id },
    data: { status: "dispatched" },
  });
  const settled = await Promise.allSettled([
    questionnaireService.withdrawInstance(inst.id, CTX.dispatcher()),
    questionnaireService.withdrawInstance(inst.id, CTX.dispatcher()),
    questionnaireService.confirmInstance(inst.id, CTX.dispatcher()),
  ]);
  const instRow = await prisma.questionnaireInstance.findUnique({
    where: { id: inst.id },
    select: { status: true },
  });
  const audits = await prisma.aiToolExecution.findMany({
    where: { questionnaireInstanceId: inst.id, toolName: "withdraw_instance" },
    select: { id: true },
  });
  results["9E_withdrawAndConfirm"] = {
    concurrency: 3,
    成功次数: settled.filter((s) => s.status === "fulfilled").length,
    实例最终状态: instRow?.status,
    withdraw审计条数: audits.length,
    状态自洽: ["draft", "dispatched"].includes(instRow?.status ?? ""),
    错误: settled.filter((s) => s.status === "rejected").map((s) => errInfo((s as PromiseRejectedResult).reason)),
  };
  await fullCleanup(inst.id);
}

// ---------------------------------------------------------------- 9F
async function testF() {
  const inst = await createTestInstance({ status: "dispatched" });
  const created = await responseService.getOrCreateResponse(inst.id, CTX.investigator());
  const schema = (await prisma.questionnaireInstance.findUnique({
    where: { id: inst.id },
    select: { currentSchema: true },
  }))!.currentSchema as { sections: { questions: { id: string }[] }[] };
  const qid = schema.sections[0]!.questions[0]!.id;

  const settled = await Promise.allSettled(
    Array.from({ length: 4 }, (_, i) =>
      responseService.saveAnswer(created.response.id, qid, `答案-${i}`, CTX.investigator())
    )
  );
  const answers = await prisma.questionnaireAnswer.findMany({
    where: { responseId: created.response.id, questionId: qid },
    select: { id: true, answer: true },
  });
  results["9F_saveAnswersUpsert"] = {
    concurrency: 4,
    成功次数: settled.filter((s) => s.status === "fulfilled").length,
    DB中的答案行数: answers.length,
    期望行数: 1,
    是否有唯一约束: true,
    ok: answers.length === 1 && settled.every((s) => s.status === "fulfilled"),
    错误: settled.filter((s) => s.status === "rejected").map((s) => errInfo((s as PromiseRejectedResult).reason)),
  };
  await fullCleanup(inst.id);
}

async function main() {
  for (const fn of [testA, testB, testC, testD, testE, testF]) {
    try {
      await fn();
    } catch (e) {
      results[fn.name] = { harnessError: errInfo(e) };
    }
    // 让本机 prisma dev 缓一缓，避免连接风暴把数据库打挂
    console.log(`[done] ${fn.name}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(JSON.stringify(results, null, 2));
  void newId;
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
