/**
 * 场景 3：撤回（withdraw）→ 二次下发后，原调查人员永久无法填写。
 *
 * 依据 docs/05 第 13A.4 节 + docs/04 第 25.3 节：
 *   撤回时 questionnaire_responses.status 必须置为 'withdrawn'，
 *   dispatch_tasks.status 置为 'withdrawn'（记 withdrawn_at / withdrawn_by）。
 *   撤回后实例回到 draft，可再次 confirm + dispatch（第 13.3 节）。
 *
 * 观察点：
 *   a) 撤回时 response / dispatch_task 到底被改成了什么；
 *   b) 二次下发后 GET .../response 返回的是哪一条（旧 response 还是新建）；
 *   c) 原调查人员还能不能继续填 / 提交；
 *   d) 那条「撤回前的旧提交」还能不能被审核。
 *
 * 运行：pnpm exec tsx tmp-audit-j1/s3-withdraw.ts
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
  review,
  saveRequired,
  setupDispatched,
  startServer,
  submit,
  verdict,
  type Flow,
} from "./harness.js";

async function main(): Promise<void> {
  const client = await startServer();
  const inv2 = await createTempUser("audit_j1_investigator4", ["investigator"]);
  let flow: Flow | undefined;

  try {
    flow = await setupDispatched(client, { assignedTo: USERS.investigator });
    const instanceId = flow.instanceId;

    // 1) 正常填写并提交
    const r1 = await getResponse(client, instanceId, USERS.investigator);
    await saveRequired(client, r1.responseId!, r1.questionnaire!, USERS.investigator);
    const sub = await submit(client, r1.responseId!, USERS.investigator);
    console.log(`[1] 提交 → ${sub.status}；实例=${(await instanceState(instanceId))?.status}`);
    const taskAfterSubmit = await prisma.dispatchTask.findUnique({
      where: { id: flow.taskId },
      select: { status: true },
    });
    console.log(`    下发任务状态 = ${taskAfterSubmit?.status}`);

    // 2) 撤回
    const wd = await call(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${instanceId}/withdraw`,
      { userId: USERS.dispatcher, body: { reason: "审计：需要调整结构" } }
    );
    const taskAfterWithdraw = await prisma.dispatchTask.findUnique({
      where: { id: flow.taskId },
      select: { status: true, withdrawnAt: true, withdrawnBy: true },
    });
    const respAfterWithdraw = await responseState(r1.responseId!);
    console.log(
      `\n[2] withdraw → ${wd.status}；实例=${(await instanceState(instanceId))?.status}`
    );
    console.log(
      `    期望（05 文档 13A.4 / 04 文档 25.3）：response.status='withdrawn'，` +
        `dispatch_task.status='withdrawn' 且 withdrawn_at/withdrawn_by 非空`
    );
    console.log(
      `    实际：response.status=${respAfterWithdraw?.status}，` +
        `task.status=${taskAfterWithdraw?.status}，withdrawnAt=${String(taskAfterWithdraw?.withdrawnAt)}，` +
        `withdrawnBy=${String(taskAfterWithdraw?.withdrawnBy)}`
    );
    verdict(
      taskAfterWithdraw?.status !== "withdrawn" || respAfterWithdraw?.status !== "withdrawn",
      "撤回没有按文档处理既有 response / dispatch_task",
      `response.status=${respAfterWithdraw?.status}（期望 withdrawn），` +
        `task.status=${taskAfterWithdraw?.status}（期望 withdrawn）`
    );

    // 3) 二次下发（第 13.3 节的正确路径）
    const confirm = await call(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${instanceId}/confirm`,
      { userId: USERS.dispatcher }
    );
    const task2 = await call(client, "POST", "/api/v1/dispatch-tasks", {
      userId: USERS.dispatcher,
      body: {
        questionnaireInstanceId: instanceId,
        assignedTo: USERS.investigator,
      },
    });
    const task2Id = (task2.body.data as { id?: string } | undefined)?.id;
    const dispatch2 = task2Id
      ? await call(client, "POST", `/api/v1/dispatch-tasks/${task2Id}/dispatch`, {
          userId: USERS.dispatcher,
        })
      : undefined;
    console.log(
      `\n[3] confirm=${confirm.status} 新建任务=${task2.status} 二次下发=${dispatch2?.status}；` +
        `实例=${(await instanceState(instanceId))?.status}`
    );

    // 4) 原调查人员重新获取待填写问卷
    const again = await getResponse(client, instanceId, USERS.investigator);
    console.log(
      `\n[4] investigator1 再次 GET .../response → ${again.res.status}；` +
        `responseId=${again.responseId}（与撤回前同一条？${again.responseId === r1.responseId}）` +
        ` status=${again.status}`
    );

    const saveAgain = await saveRequired(
      client,
      again.responseId!,
      again.questionnaire!,
      USERS.investigator
    );
    const submitAgain = await submit(client, again.responseId!, USERS.investigator);
    console.log(
      `    重新保存答案 → ${saveAgain.status} ${saveAgain.status === 200 ? "" : fail(saveAgain)}`
    );
    console.log(
      `    重新提交 → ${submitAgain.status} ${submitAgain.status === 200 ? "" : fail(submitAgain)}`
    );
    verdict(
      again.responseId === r1.responseId && saveAgain.status !== 200,
      "二次下发后原调查人员被永久卡死（拿到的仍是撤回前的旧 response）",
      `GET 返回同一条 response（status=${again.status}），保存 ${saveAgain.status}、提交 ${submitAgain.status}；` +
        `既拿不到可填的 draft，也没有任何接口能把这条 response 复位`
    );

    // 5) 换一个「没填过」的调查人员试试（越权问题在此又成为唯一出路）
    const fresh = await getResponse(client, instanceId, inv2);
    console.log(
      `\n[5] 换 investigator2（无指派）→ ${fresh.res.status}，responseId=${fresh.responseId} status=${fresh.status}`
    );

    // 6) 撤回前的那条旧提交还能不能审核
    const stale = await review(client, r1.responseId!, USERS.reviewer, "approved", "审核旧提交");
    console.log(
      `\n[6] reviewer 审核「撤回前产生的旧提交」→ ${stale.status} ${
        stale.status === 200 ? "" : fail(stale)
      }；实例=${(await instanceState(instanceId))?.status}`
    );
  } finally {
    await client.close();
    if (flow) await cleanupInstance(flow.instanceId).catch(() => undefined);
    await cleanupUser(inv2).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error("脚本失败：", e);
  await prisma.$disconnect();
  process.exit(1);
});
