/**
 * 场景 6：按文档 13A.4 把撤回做对之后，填写模块仍然无法恢复填写。
 *
 * 这不是修改 src/，而是按 docs/05 第 13A.4 节、docs/04 第 25.3 节
 * 手工把数据置为「文档要求的撤回后状态」：
 *   questionnaire_responses.status = 'withdrawn'
 *   dispatch_tasks.status          = 'withdrawn'（withdrawn_at / withdrawn_by）
 * 然后走既有的二次下发路径，考察 response 模块的表现。
 *
 * 运行：pnpm exec tsx tmp-audit-j1/s6-withdrawn.ts
 */
import {
  USERS,
  call,
  cleanupInstance,
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
  let flow: Flow | undefined;

  try {
    flow = await setupDispatched(client, { assignedTo: USERS.investigator });
    const instanceId = flow.instanceId;

    const r1 = await getResponse(client, instanceId, USERS.investigator);
    await saveRequired(client, r1.responseId!, r1.questionnaire!, USERS.investigator);
    await submit(client, r1.responseId!, USERS.investigator);
    console.log(`[1] 撤回前：响应=${r1.responseId}，实例=${(await instanceState(instanceId))?.status}`);

    // 按文档要求处理撤回
    await call(client, "POST", `/api/v1/questionnaire-instances/${instanceId}/withdraw`, {
      userId: USERS.dispatcher,
      body: { reason: "审计" },
    });
    await prisma.questionnaireResponse.update({
      where: { id: r1.responseId! },
      data: { status: "withdrawn" },
    });
    await prisma.dispatchTask.update({
      where: { id: flow.taskId },
      data: { status: "withdrawn", withdrawnAt: new Date(), withdrawnBy: USERS.dispatcher },
    });
    console.log(
      `[2] 按 docs/05 13A.4 手工置为撤回后状态：response=${(await responseState(r1.responseId!))?.status}，` +
        `instance=${(await instanceState(instanceId))?.status}`
    );

    // 二次下发
    await call(client, "POST", `/api/v1/questionnaire-instances/${instanceId}/confirm`, {
      userId: USERS.dispatcher,
    });
    const t2 = await call(client, "POST", "/api/v1/dispatch-tasks", {
      userId: USERS.dispatcher,
      body: { questionnaireInstanceId: instanceId, assignedTo: USERS.investigator },
    });
    const t2Id = (t2.body.data as { id: string }).id;
    await call(client, "POST", `/api/v1/dispatch-tasks/${t2Id}/dispatch`, {
      userId: USERS.dispatcher,
    });
    console.log(`[3] 二次下发后实例=${(await instanceState(instanceId))?.status}`);

    // 调查人员重新进入
    const again = await getResponse(client, instanceId, USERS.investigator);
    console.log(
      `[4] investigator1 GET .../response → ${again.res.status}；` +
        `返回的仍是撤回前那条 response（${again.responseId === r1.responseId}），status=${again.status}`
    );

    const saveAgain = await saveRequired(
      client,
      again.responseId!,
      again.questionnaire!,
      USERS.investigator
    );
    const submitAgain = await submit(client, again.responseId!, USERS.investigator);
    const reviewAgain = await review(client, again.responseId!, USERS.reviewer, "rejected", "试试退回");
    console.log(
      `    保存=${saveAgain.status} ${saveAgain.status === 200 ? "" : fail(saveAgain)}`
    );
    console.log(
      `    提交=${submitAgain.status} ${submitAgain.status === 200 ? "" : fail(submitAgain)}`
    );
    console.log(
      `    审核退回=${reviewAgain.status} ${reviewAgain.status === 200 ? "" : fail(reviewAgain)}`
    );
    verdict(
      again.responseId === r1.responseId &&
        saveAgain.status !== 200 &&
        submitAgain.status !== 200 &&
        reviewAgain.status !== 200,
      "撤回后二次下发，填写入口彻底死锁（没有任何角色能救回）",
      `getOrCreateResponse 复用了 status=withdrawn 的旧 response；` +
        `保存 ${saveAgain.status}、提交 ${submitAgain.status}、审核退回 ${reviewAgain.status} 全部被拒；` +
        `它既不会新建一条 draft，也没有任何接口把 withdrawn 复位`
    );
  } finally {
    await client.close();
    if (flow) await cleanupInstance(flow.instanceId).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error("脚本失败：", e);
  await prisma.$disconnect();
  process.exit(1);
});
