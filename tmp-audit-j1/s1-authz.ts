/**
 * 场景 1：填写模块的授权缺失（越权填写/提交/改他人答案）。
 *
 * 依据 docs/04 第 25 节（dispatch_tasks.assigned_to = 被指派的调查人员）
 * 与 docs/05 第 15 节（填写 API），未指派给某调查人员的任务不应能被其填写。
 *
 * 运行：pnpm exec tsx tmp-audit-j1/s1-authz.ts
 */
import {
  USERS,
  call,
  cleanupInstance,
  cleanupUser,
  createTempUser,
  fail,
  getResponse,
  instanceState,
  prisma,
  responseState,
  saveRequired,
  setupDispatched,
  startServer,
  submit,
  verdict,
  type Flow,
} from "./harness.js";

async function main(): Promise<void> {
  const client = await startServer();
  const inv2 = await createTempUser("audit_j1_investigator2", ["investigator"]);
  let flow: Flow | undefined;
  let flow2: Flow | undefined;

  try {
    // 任务只指派给 investigator1
    flow = await setupDispatched(client, { assignedTo: USERS.investigator });
    console.log(
      `实例 ${flow.instanceId} 已下发，assignedTo = investigator1(${USERS.investigator})`
    );
    console.log(`临时调查人员 investigator2 = ${inv2}（没有任何 dispatch_task 指向他）`);

    // ---- 1) investigator2 直接读取「待填写问卷」 ----
    const got = await getResponse(client, flow.instanceId, inv2);
    console.log(
      `\n[1] investigator2 GET /questionnaire-instances/{id}/response → ${got.res.status} ${
        got.res.status === 200
          ? `（创建/拿到了 responseId=${got.responseId} status=${got.status}）`
          : fail(got.res)
      }`
    );
    verdict(
      got.res.status === 200,
      "未指派的 investigator 可以创建并拿到填写入口",
      `期望 403（任务未指派给他），实际 ${got.res.status}`
    );

    if (got.responseId && got.questionnaire) {
      // ---- 2) investigator2 保存答案 ----
      const saved = await saveRequired(
        client,
        got.responseId,
        got.questionnaire,
        inv2
      );
      console.log(
        `\n[2] investigator2 保存答案 → ${saved.status} ${saved.status === 200 ? "" : fail(saved)}`
      );

      // ---- 3) investigator2 提交，并观察实例状态 ----
      const before = await instanceState(flow.instanceId);
      const sub = await submit(client, got.responseId, inv2);
      const after = await instanceState(flow.instanceId);
      console.log(
        `\n[3] investigator2 提交 → ${sub.status} ${sub.status === 200 ? "" : fail(sub)}；` +
          `实例状态 ${before?.status} → ${after?.status}`
      );
      const row = await responseState(got.responseId);
      console.log(
        `    落库：response.status=${row?.status} respondentId=${row?.respondentId}` +
          `（=investigator2？${row?.respondentId === inv2}）`
      );
      verdict(
        sub.status === 200,
        "未指派的 investigator 可以提交，并把实例推进到 submitted",
        `期望 403/409，实际 ${sub.status}，实例状态被改成 ${after?.status}`
      );
    }

    // ---- 4) 用另一个实例验证「按 id 直接改他人 response」 ----
    flow2 = await setupDispatched(client, { assignedTo: USERS.investigator });
    const mine = await getResponse(client, flow2.instanceId, USERS.investigator);
    console.log(
      `\n[4] investigator1 拿到自己的 response = ${mine.responseId}（status=${mine.status}）`
    );
    if (mine.responseId) {
      const hijack = await call(
        client,
        "PUT",
        `/api/v1/questionnaire-responses/${mine.responseId}/answers`,
        {
          userId: inv2,
          body: {
            answers: [{ questionId: "q_name", answer: "investigator2 改的" }],
          },
        }
      );
      console.log(
        `    investigator2 PUT 别人的 response 答案 → ${hijack.status} ${
          hijack.status === 200 ? "" : fail(hijack)
        }`
      );
      const answer = await prisma.questionnaireAnswer.findFirst({
        where: { responseId: mine.responseId, questionId: "q_name" },
      });
      console.log(`    落库 answer = ${JSON.stringify(answer?.answer)}`);
      verdict(
        hijack.status === 200,
        "investigator2 能按 responseId 直接改 investigator1 的答案",
        `期望 403（response.respondentId ≠ 当前用户），实际 ${hijack.status}`
      );
    }

    // ---- 5) 佐证：该实例下所有 response ----
    const rows = await prisma.questionnaireResponse.findMany({
      where: { questionnaireInstanceId: flow.instanceId },
      select: { id: true, respondentId: true, status: true },
    });
    console.log(`\n[5] 实例 ${flow.instanceId} 下的 response 行：${JSON.stringify(rows)}`);
  } finally {
    await client.close();
    if (flow) await cleanupInstance(flow.instanceId).catch(() => undefined);
    if (flow2) await cleanupInstance(flow2.instanceId).catch(() => undefined);
    await cleanupUser(inv2).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error("脚本失败：", e);
  await prisma.$disconnect();
  process.exit(1);
});
