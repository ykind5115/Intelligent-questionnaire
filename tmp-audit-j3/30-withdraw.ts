/**
 * 审计脚本 C：D1 撤回的「既有数据处理」是否真的实现（09 §3.3 / 05 §13A.4）。
 *
 * 要求：
 *   questionnaire_responses → status = withdrawn
 *   dispatch_tasks         → status = withdrawn + withdrawn_at / withdrawn_by
 *   instance               → draft，revision 不清空
 *
 * 同时验证「撤回 → 二次下发」这条 D1 核心闭环在真实数据上是否走得通。
 */
import { createApp } from "../src/app/app.js";
import {
  startTestServer,
  apiRequest,
  expectData,
} from "../tests/integration/api/helpers.js";
import { USERS } from "../tests/integration/questionnaire/helpers.js";
import { prisma } from "../src/database/client.js";

const results: Record<string, unknown> = {};
const created = { instances: [] as string[] };

async function cleanup(): Promise<void> {
  for (const id of created.instances) {
    await prisma.questionnaireAnswer.deleteMany({
      where: { response: { questionnaireInstanceId: id } },
    });
    await prisma.reviewRecord.deleteMany({
      where: { response: { questionnaireInstanceId: id } },
    });
    await prisma.questionnaireResponse.deleteMany({
      where: { questionnaireInstanceId: id },
    });
    await prisma.dispatchTask.deleteMany({ where: { questionnaireInstanceId: id } });
    await prisma.aiToolExecution.deleteMany({
      where: { questionnaireInstanceId: id },
    });
    await prisma.questionnaireRevision.deleteMany({
      where: { questionnaireInstanceId: id },
    });
    await prisma.questionnaireInstance.deleteMany({ where: { id } });
  }
}

async function main(): Promise<void> {
  const app = createApp();
  const server = await startTestServer(app);
  const base = "/api/v1";

  try {
    const version = await prisma.questionnaireTemplateVersion.findFirst({
      where: { status: "published" },
      orderBy: { createdAt: "asc" },
    });
    if (!version) throw new Error("缺少已发布模板版本");

    // 建实例 → 确认 → 下发
    const instRes = await apiRequest<{ id: string }>(
      server,
      "POST",
      `${base}/questionnaire-instances`,
      {
        userId: USERS.dispatcher,
        body: { templateVersionId: version.id, title: "审计C-撤回既有数据" },
      }
    );
    const instanceId = expectData<{ id: string }>(instRes).id;
    created.instances.push(instanceId);

    await apiRequest(server, "POST", `${base}/questionnaire-instances/${instanceId}/confirm`, {
      userId: USERS.dispatcher,
      body: {},
    });
    const task1 = await apiRequest<{ id: string }>(server, "POST", `${base}/dispatch-tasks`, {
      userId: USERS.dispatcher,
      body: { questionnaireInstanceId: instanceId, assignedTo: USERS.investigator },
    });
    const taskId = expectData<{ id: string }>(task1).id;
    await apiRequest(server, "POST", `${base}/dispatch-tasks/${taskId}/dispatch`, {
      userId: USERS.dispatcher,
    });

    // 调查员填写 + 提交
    const respRes = await apiRequest<{
      responseId: string;
      questionnaire: { sections: { questions: { id: string; required: boolean }[] }[] };
    }>(server, "GET", `${base}/questionnaire-instances/${instanceId}/response`, {
      userId: USERS.investigator,
    });
    const filling = expectData<{
      responseId: string;
      questionnaire: { sections: { questions: { id: string; required: boolean }[] }[] };
    }>(respRes);
    const requiredIds = filling.questionnaire.sections
      .flatMap((s) => s.questions)
      .filter((q) => q.required)
      .map((q) => q.id);
    await apiRequest(server, "PUT", `${base}/questionnaire-responses/${filling.responseId}/answers`, {
      userId: USERS.investigator,
      body: { answers: requiredIds.map((id) => ({ questionId: id, answer: "已核查" })) },
    });
    const submitRes = await apiRequest(server, "POST", `${base}/questionnaire-responses/${filling.responseId}/submit`, {
      userId: USERS.investigator,
    });
    results["1_beforeWithdraw"] = {
      submitHttp: submitRes.status,
      instanceStatus: (submitRes.body.data as { instanceStatus: string }).instanceStatus,
    };

    // ---- 撤回 ----
    const withdrawRes = await apiRequest(server, "POST", `${base}/questionnaire-instances/${instanceId}/withdraw`, {
      userId: USERS.dispatcher,
      body: { reason: "结构需要调整" },
    });
    results["2_withdraw"] = { http: withdrawRes.status, body: withdrawRes.body.data };

    const [instRow, respRow, taskRow] = await Promise.all([
      prisma.questionnaireInstance.findUnique({
        where: { id: instanceId },
        select: { status: true, currentRevision: true },
      }),
      prisma.questionnaireResponse.findUnique({
        where: { id: filling.responseId },
        select: { status: true, submittedAt: true },
      }),
      prisma.dispatchTask.findUnique({
        where: { id: taskId },
        select: { status: true, withdrawnAt: true, withdrawnBy: true },
      }),
    ]);
    results["3_afterWithdrawDb"] = {
      instance: instRow,
      response: respRow,
      dispatchTask: taskRow,
      expectationFromDoc: {
        "response.status": "withdrawn",
        "dispatchTask.status": "withdrawn",
        "dispatchTask.withdrawnAt": "非 null",
        "dispatchTask.withdrawnBy": "非 null（撤回人）",
      },
    };

    // 撤回后仍出现在「待审核」列表？（说明旧 response 没有被失效）
    const pendingAfterWithdraw = await apiRequest<{ total: number; items: { responseId: string }[] }>(
      server,
      "GET",
      `${base}/questionnaire-responses/review/pending?questionnaireInstanceId=${instanceId}`,
      { userId: USERS.reviewer }
    );
    results["4_pendingReviewAfterWithdraw"] = {
      http: pendingAfterWithdraw.status,
      total: expectData<{ total: number; items: { responseId: string }[] }>(
        pendingAfterWithdraw
      ).total,
    };

    // ---- 二次下发：撤回 → 确认 → 再下发 → 调查员重新填写 ----
    await apiRequest(server, "POST", `${base}/questionnaire-instances/${instanceId}/confirm`, {
      userId: USERS.dispatcher,
      body: {},
    });
    const task2 = await apiRequest<{ id: string }>(server, "POST", `${base}/dispatch-tasks`, {
      userId: USERS.dispatcher,
      body: { questionnaireInstanceId: instanceId, assignedTo: USERS.investigator },
    });
    const task2Id = expectData<{ id: string }>(task2).id;
    await apiRequest(server, "POST", `${base}/dispatch-tasks/${task2Id}/dispatch`, {
      userId: USERS.dispatcher,
    });

    const refill = await apiRequest<{ responseId: string; status: string }>(
      server,
      "GET",
      `${base}/questionnaire-instances/${instanceId}/response`,
      { userId: USERS.investigator }
    );
    const refillData = expectData<{ responseId: string; status: string }>(refill);
    const refillSave = await apiRequest(server, "PUT", `${base}/questionnaire-responses/${refillData.responseId}/answers`, {
      userId: USERS.investigator,
      body: { answers: [{ questionId: requiredIds[0], answer: "二次核查-已修改" }] },
    });
    results["5_secondDispatchRefill"] = {
      getResponseHttp: refill.status,
      responseStatusAfterSecondDispatch: refillData.status,
      sameResponseIdAsBefore: refillData.responseId === filling.responseId,
      saveAnswersHttp: refillSave.status,
      saveAnswersError: refillSave.body.error ?? null,
    };

    const task2Row = await prisma.dispatchTask.findUnique({
      where: { id: task2Id },
      select: { status: true },
    });
    results["6_task2"] = task2Row;
  } finally {
    console.log(JSON.stringify(results, null, 2));
    await cleanup();
    await server.close();
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error("脚本失败：", e);
  try {
    await cleanup();
  } catch {
    /* ignore */
  }
  await prisma.$disconnect();
  process.exit(1);
});
