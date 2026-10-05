/**
 * 探针 10：不依赖并发的状态流转缺陷（串行两次调用即可复现）。
 *
 * 10A dispatchService.createTask 连续调用两次 → 同一实例+同一调查员是否产生两条 pending 任务；
 * 10B reviewService.reviewResponse 连续调用两次（先 approved 再 rejected）→
 *     第二次是否被拦（response 已不是 submitted），review_records 会不会出现矛盾记录；
 * 10C reviewResponse 在「实例已 completed」时再审核另一份 submitted response → 状态是否被覆盖。
 *
 * 用法：pnpm exec tsx tmp-audit-j2/10-serial-flow-defects.ts
 */
import { prisma } from "../src/database/client.js";
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
  return { kind: "RAW", code: anyE?.code ?? anyE?.name ?? "UNKNOWN", message: (anyE?.message ?? String(e)).slice(0, 160) };
}

async function fullCleanup(instanceId: string) {
  const responses = await prisma.questionnaireResponse.findMany({
    where: { questionnaireInstanceId: instanceId },
    select: { id: true },
  });
  const responseIds = responses.map((r) => r.id);
  await prisma.reviewRecord.deleteMany({ where: { questionnaireResponseId: { in: responseIds } } });
  await prisma.questionnaireAnswer.deleteMany({ where: { responseId: { in: responseIds } } });
  await prisma.questionnaireResponse.deleteMany({ where: { id: { in: responseIds } } });
  await prisma.dispatchTask.deleteMany({ where: { questionnaireInstanceId: instanceId } });
  await deleteTestInstance(instanceId);
}

const results: Record<string, unknown> = {};

async function testA() {
  const inst = await createTestInstance({ status: "confirmed" });
  const first = await dispatchService.createTask(
    { questionnaireInstanceId: inst.id, assignedTo: USERS.investigator },
    CTX.dispatcher()
  );
  const second = await dispatchService.createTask(
    { questionnaireInstanceId: inst.id, assignedTo: USERS.investigator },
    CTX.dispatcher()
  );
  const tasks = await prisma.dispatchTask.findMany({
    where: { questionnaireInstanceId: inst.id },
    select: { id: true, status: true, assignedTo: true },
  });
  results["10A_重复创建下发任务"] = {
    两次调用返回的任务id: [first.id, second.id],
    两次id是否相同: first.id === second.id,
    DB中的pending任务数: tasks.filter((t) => t.status === "pending").length,
    期望: 1,
    重复: tasks.length > 1,
    错误: [],
  };
  await fullCleanup(inst.id);
}

async function testB() {
  const inst = await createTestInstance({ status: "dispatched" });
  const created = await responseService.getOrCreateResponse(inst.id, CTX.investigator());
  await prisma.questionnaireResponse.update({
    where: { id: created.response.id },
    data: { status: "submitted", submittedAt: new Date() },
  });

  const first = await reviewService.reviewResponse(
    created.response.id,
    { result: "approved", comment: "第一次审核" },
    CTX.admin({ roles: ["reviewer"] })
  );

  let secondResult: unknown;
  try {
    const r = await reviewService.reviewResponse(
      created.response.id,
      { result: "rejected", comment: "第二次审核" },
      CTX.admin({ roles: ["reviewer"] })
    );
    secondResult = { ok: true, instanceStatus: r.instanceStatus, responseStatus: r.response.status };
  } catch (e) {
    secondResult = errInfo(e);
  }

  const instRow = await prisma.questionnaireInstance.findUnique({
    where: { id: inst.id },
    select: { status: true },
  });
  const respRow = await prisma.questionnaireResponse.findUnique({
    where: { id: created.response.id },
    select: { status: true },
  });
  const reviews = await prisma.reviewRecord.findMany({
    where: { questionnaireResponseId: created.response.id },
    select: { result: true },
  });

  results["10B_重复审核同一份答卷"] = {
    第一次审核: { instanceStatus: first.instanceStatus, responseStatus: first.response.status },
    第二次审核: secondResult,
    review_records: reviews.map((r) => r.result),
    实例最终状态: instRow?.status,
    response最终状态: respRow?.status,
    第二次被拒绝: typeof secondResult === "object" && secondResult !== null && "code" in secondResult,
  };
  await fullCleanup(inst.id);
}

async function testC() {
  // 同一实例下两份 response（两名调查员），第一份 approved 把实例置 completed，
  // 第二份仍是 submitted —— 此时再审第二份会怎样？
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

  await reviewService.reviewResponse(
    r1.response.id,
    { result: "approved" },
    CTX.admin({ roles: ["reviewer"] })
  );
  const afterFirst = await prisma.questionnaireInstance.findUnique({
    where: { id: inst.id },
    select: { status: true },
  });

  let second: unknown;
  try {
    const r = await reviewService.reviewResponse(
      r2Id,
      { result: "rejected", comment: "另一份答卷退回" },
      CTX.admin({ roles: ["reviewer"] })
    );
    second = { ok: true, instanceStatus: r.instanceStatus, responseStatus: r.response.status };
  } catch (e) {
    second = errInfo(e);
  }
  const afterSecond = await prisma.questionnaireInstance.findUnique({
    where: { id: inst.id },
    select: { status: true },
  });

  results["10C_completed实例被再次审核改写"] = {
    第一份审核后实例状态: afterFirst?.status,
    第二份审核结果: second,
    第二份审核后实例状态: afterSecond?.status,
    终态被改写: afterFirst?.status === "completed" && afterSecond?.status !== "completed",
  };
  await fullCleanup(inst.id);
}

async function main() {
  // 本机 prisma dev 在一个进程里只能稳定支撑第一条连接，
  // 因此支持只跑单个用例：tsx 10-serial-flow-defects.ts A
  const only = process.argv[2]?.toUpperCase();
  const cases: [string, () => Promise<void>][] = [
    ["A", testA],
    ["B", testB],
    ["C", testC],
  ];
  for (const [name, fn] of cases) {
    if (only && only !== name) continue;
    try {
      await fn();
    } catch (e) {
      results[fn.name] = { harnessError: errInfo(e) };
    }
    console.log(`[done] ${fn.name}`);
  }
  console.log(JSON.stringify(results, null, 2));
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
