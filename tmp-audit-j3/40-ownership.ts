/**
 * 审计脚本 D：D8 角色权限在「填写」链路上是否存在越权（归属校验缺失）。
 *
 * 关注：
 *  1. 下发任务 assignedTo = investigator1 时，另一个 investigator 能否照样拿到并填写？
 *  2. 一个 investigator 能否改写/提交别人的 response（按 responseId 直接访问）？
 *  3. 角色本身的拦截是否有效（dispatcher 不能填写、investigator 不能审核）？
 */
import { createApp } from "../src/app/app.js";
import {
  startTestServer,
  apiRequest,
  expectData,
} from "../tests/integration/api/helpers.js";
import { USERS } from "../tests/integration/questionnaire/helpers.js";
import { newId } from "../src/shared/utils/id.js";
import { prisma } from "../src/database/client.js";

const results: Record<string, unknown> = {};
const created = { instances: [] as string[], users: [] as string[] };
const INVESTIGATOR2 = newId();

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
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
}

async function main(): Promise<void> {
  const app = createApp();
  const server = await startTestServer(app);
  const base = "/api/v1";

  try {
    // 临时第二个调查员（用完删除，保持 4 用户基线）
    await prisma.user.create({
      data: {
        id: INVESTIGATOR2,
        username: `audit_investigator2_${INVESTIGATOR2.slice(0, 8)}`,
        displayName: "审计用调查员二号",
        status: "active",
        roles: ["investigator"],
      },
    });
    created.users.push(INVESTIGATOR2);
    results["prep"] = { investigator2Id: INVESTIGATOR2 };

    const version = await prisma.questionnaireTemplateVersion.findFirst({
      where: { status: "published" },
      orderBy: { createdAt: "asc" },
    });
    if (!version) throw new Error("缺少已发布模板版本");

    const instRes = await apiRequest<{ id: string }>(
      server,
      "POST",
      `${base}/questionnaire-instances`,
      {
        userId: USERS.dispatcher,
        body: { templateVersionId: version.id, title: "审计D-归属校验" },
      }
    );
    const instanceId = expectData<{ id: string }>(instRes).id;
    created.instances.push(instanceId);

    await apiRequest(server, "POST", `${base}/questionnaire-instances/${instanceId}/confirm`, {
      userId: USERS.dispatcher,
      body: {},
    });
    const task = await apiRequest<{ id: string }>(server, "POST", `${base}/dispatch-tasks`, {
      userId: USERS.dispatcher,
      body: {
        questionnaireInstanceId: instanceId,
        assignedTo: USERS.investigator, // 只指派给 investigator1
      },
    });
    const taskId = expectData<{ id: string }>(task).id;
    await apiRequest(server, "POST", `${base}/dispatch-tasks/${taskId}/dispatch`, {
      userId: USERS.dispatcher,
    });

    const readQ = async (userId: string) => {
      const r = await apiRequest<{
        responseId: string;
        status: string;
        questionnaire: { sections: { questions: { id: string; required: boolean }[] }[] };
      }>(server, "GET", `${base}/questionnaire-instances/${instanceId}/response`, { userId });
      return r;
    };

    // investigator1 拿到自己的 response
    const r1 = await readQ(USERS.investigator);
    const resp1 = expectData<{
      responseId: string;
      questionnaire: { sections: { questions: { id: string; required: boolean }[] }[] };
    }>(r1);
    const requiredIds = resp1.questionnaire.sections
      .flatMap((s) => s.questions)
      .filter((q) => q.required)
      .map((q) => q.id);

    // 1) 未被指派的 investigator2 能否拿到待填写问卷？
    const r2 = await readQ(INVESTIGATOR2);
    results["1_unassignedInvestigator_getResponse"] = {
      http: r2.status,
      ok: r2.body.success,
      createdOwnResponse: r2.body.success
        ? (r2.body.data as { responseId: string }).responseId !== resp1.responseId
        : null,
      assignedToInDb: (await prisma.dispatchTask.findUnique({
        where: { id: taskId },
        select: { assignedTo: true },
      }))?.assignedTo,
    };

    // 2) investigator2 能否改写 investigator1 的 response？
    const crossSave = await apiRequest(
      server,
      "PUT",
      `${base}/questionnaire-responses/${resp1.responseId}/answers`,
      {
        userId: INVESTIGATOR2,
        body: { answers: [{ questionId: requiredIds[0], answer: "越权写入" }] },
      }
    );
    results["2_writeOthersResponse"] = {
      http: crossSave.status,
      ok: crossSave.body.success,
    };

    // 3) investigator2 能否提交 investigator1 的 response？
    //    先把必填项补全，排除「必填校验」这一干扰因素，单独验证归属校验是否存在。
    await apiRequest(
      server,
      "PUT",
      `${base}/questionnaire-responses/${resp1.responseId}/answers`,
      {
        userId: INVESTIGATOR2,
        body: {
          answers: requiredIds.map((id) => ({ questionId: id, answer: "越权代填" })),
        },
      }
    );
    const crossSubmit = await apiRequest(
      server,
      "POST",
      `${base}/questionnaire-responses/${resp1.responseId}/submit`,
      { userId: INVESTIGATOR2 }
    );
    results["3_submitOthersResponse"] = {
      http: crossSubmit.status,
      ok: crossSubmit.body.success,
      error: crossSubmit.body.error ?? null,
      answerWrittenByOtherUser: await prisma.questionnaireAnswer.findFirst({
        where: { responseId: resp1.responseId, questionId: requiredIds[0] },
        select: { answer: true },
      }),
    };

    // 4) 角色本身拦截是否有效
    const dispatcherFill = await apiRequest(
      server,
      "PUT",
      `${base}/questionnaire-responses/${resp1.responseId}/answers`,
      { userId: USERS.dispatcher, body: { answers: [{ questionId: requiredIds[0], answer: "x" }] } }
    );
    const investigatorReview = await apiRequest(
      server,
      "POST",
      `${base}/questionnaire-responses/${resp1.responseId}/review`,
      { userId: USERS.investigator, body: { result: "approved" } }
    );
    const investigatorPending = await apiRequest(
      server,
      "GET",
      `${base}/questionnaire-responses/review/pending`,
      { userId: USERS.investigator }
    );
    results["4_roleGuards"] = {
      dispatcherSaveAnswers: { http: dispatcherFill.status, error: dispatcherFill.body.error?.code },
      investigatorReview: { http: investigatorReview.status, error: investigatorReview.body.error?.code },
      investigatorPendingList: {
        http: investigatorPending.status,
        error: investigatorPending.body.error?.code,
      },
    };
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
