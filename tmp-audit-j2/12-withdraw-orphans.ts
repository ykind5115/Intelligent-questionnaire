/**
 * 探针 12：撤回（withdraw）后遗留的填写结果是否仍然「待审核 / 可审核」。
 *
 * 场景：
 *   1. 实例 dispatched，调查员提交答卷（response=submitted，instance=submitted）
 *   2. 下发人员撤回（withdraw）→ instance=draft（结构重新可改）
 *   3. 观察：response 状态是否被置为 withdrawn？（文档 04 第 27.3 节承诺撤回后标记失效）
 *   4. 观察：reviewService.listPending 是否仍然把这份答卷列为「待审核」
 *   5. 观察：reviewService.reviewResponse 是否仍然能审核它，并把实例状态改成 completed
 *
 * 用法：pnpm exec tsx tmp-audit-j2/12-withdraw-orphans.ts
 */
import { prisma } from "../src/database/client.js";
import { questionnaireService } from "../src/modules/questionnaire/service/questionnaire.service.js";
import { responseService } from "../src/modules/response/service/response.service.js";
import { reviewService } from "../src/modules/review/service/review.service.js";
import { isOperationError } from "../src/shared/errors/index.js";
import {
  CTX,
  createTestInstance,
  deleteTestInstance,
} from "../tests/integration/questionnaire/helpers.js";

function errInfo(e: unknown) {
  if (isOperationError(e)) return { kind: "OperationError", code: e.code, message: e.message };
  const anyE = e as { code?: string; name?: string; message?: string };
  return { kind: "RAW", code: anyE?.code ?? "UNKNOWN", message: (anyE?.message ?? String(e)).slice(0, 140) };
}

async function cleanup(instanceId: string) {
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

async function main() {
  const inst = await createTestInstance({ status: "dispatched" });
  const created = await responseService.getOrCreateResponse(inst.id, CTX.investigator());

  // 直接把 response 置为 submitted（跳过必填校验，聚焦状态流转）
  await prisma.questionnaireResponse.update({
    where: { id: created.response.id },
    data: { status: "submitted", submittedAt: new Date() },
  });
  await prisma.questionnaireInstance.update({
    where: { id: inst.id },
    data: { status: "submitted" },
  });

  // ---- withdraw ----
  const withdrawn = await questionnaireService.withdrawInstance(
    inst.id,
    CTX.dispatcher(),
    "审计：撤回后检查遗留答卷"
  );

  const respAfter = await prisma.questionnaireResponse.findUnique({
    where: { id: created.response.id },
    select: { status: true, submittedAt: true },
  });
  const instAfter = await prisma.questionnaireInstance.findUnique({
    where: { id: inst.id },
    select: { status: true },
  });

  // ---- 撤回后这份答卷还在「待审核」列表里吗 ----
  const pending = await reviewService.listPending(
    { questionnaireInstanceId: inst.id },
    { skip: 0, take: 50 },
    CTX.admin({ roles: ["reviewer"] })
  );

  // ---- 撤回后还能审核吗 ----
  let reviewAfterWithdraw: unknown;
  try {
    const r = await reviewService.reviewResponse(
      created.response.id,
      { result: "approved", comment: "撤回后仍然审核通过" },
      CTX.admin({ roles: ["reviewer"] })
    );
    reviewAfterWithdraw = { ok: true, instanceStatus: r.instanceStatus, responseStatus: r.response.status };
  } catch (e) {
    reviewAfterWithdraw = errInfo(e);
  }

  const finalInst = await prisma.questionnaireInstance.findUnique({
    where: { id: inst.id },
    select: { status: true },
  });
  const reviews = await prisma.reviewRecord.count({
    where: { questionnaireResponseId: created.response.id },
  });

  console.log(
    JSON.stringify(
      {
        撤回返回: withdrawn,
        撤回后实例状态: instAfter?.status,
        撤回后答卷状态: respAfter?.status,
        期望答卷状态_文档承诺: "withdrawn",
        答卷是否被标记失效: respAfter?.status === "withdrawn",
        撤回后仍出现在待审核列表: pending.total > 0,
        待审核条数: pending.total,
        撤回后仍可审核: reviewAfterWithdraw,
        审核后实例最终状态: finalInst?.status,
        review_records条数: reviews,
        结论:
          respAfter?.status !== "withdrawn"
            ? "撤回未使答卷失效：遗留 submitted 答卷仍可被审核，可把已撤回实例改成 completed"
            : "撤回正确标记了答卷失效",
      },
      null,
      2
    )
  );

  await cleanup(inst.id);
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
