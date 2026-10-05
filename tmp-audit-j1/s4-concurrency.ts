/**
 * 场景 4：并发（缺少条件更新/行锁导致的 TOCTOU）。
 *
 * A) 同一条 response 并发审核（approved + rejected）：
 *    期望只有一个成功，另一个 409；否则会出现「response 与 instance 状态互相矛盾」。
 * B) 同一条 response 并发提交：期望只有一个成功。
 * C) 同一个 pending 下发任务并发下发：期望只有一个成功。
 *
 * 运行：pnpm exec tsx tmp-audit-j1/s4-concurrency.ts
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
  const flows: Flow[] = [];

  try {
    // ============ A) 并发审核 ============
    console.log("=== A) 同一条 response 并发审核（approved + rejected）===");
    const a = await setupDispatched(client, { assignedTo: USERS.investigator });
    flows.push(a);
    const ra = await getResponse(client, a.instanceId, USERS.investigator);
    await saveRequired(client, ra.responseId!, ra.questionnaire!, USERS.investigator);
    await submit(client, ra.responseId!, USERS.investigator);

    const [ap, rj] = await Promise.all([
      review(client, ra.responseId!, USERS.reviewer, "approved", "并发-通过"),
      review(client, ra.responseId!, USERS.reviewer, "rejected", "并发-退回"),
    ]);
    const stateA = await instanceState(a.instanceId);
    const respA = await responseState(ra.responseId!);
    const recordsA = await prisma.reviewRecord.findMany({
      where: { questionnaireResponseId: ra.responseId! },
      select: { result: true },
    });
    console.log(
      `approved → ${ap.status} ${ap.status === 200 ? "" : fail(ap)}；` +
        `rejected → ${rj.status} ${rj.status === 200 ? "" : fail(rj)}`
    );
    console.log(
      `最终：instance.status=${stateA?.status}，response.status=${respA?.status}，` +
        `review_records=${JSON.stringify(recordsA)}`
    );
    const consistent =
      (stateA?.status === "completed" && respA?.status === "submitted") ||
      (stateA?.status === "returned" && respA?.status === "draft");
    verdict(
      (ap.status === 200 && rj.status === 200) || !consistent,
      "并发审核产生互相矛盾的状态 / 重复审核记录",
      `两个请求都返回 200=${ap.status === 200 && rj.status === 200}；` +
        `instance=${stateA?.status} + response=${respA?.status} 是否为合法组合=${consistent}`
    );

    // ============ B) 并发提交 ============
    console.log("\n=== B) 同一条 response 并发提交 ===");
    const b = await setupDispatched(client, { assignedTo: USERS.investigator });
    flows.push(b);
    const rb = await getResponse(client, b.instanceId, USERS.investigator);
    await saveRequired(client, rb.responseId!, rb.questionnaire!, USERS.investigator);

    const [s1, s2] = await Promise.all([
      submit(client, rb.responseId!, USERS.investigator),
      submit(client, rb.responseId!, USERS.investigator),
    ]);
    const auditsB = await prisma.aiToolExecution.count({
      where: {
        questionnaireInstanceId: b.instanceId,
        toolName: "submit_response",
      },
    });
    console.log(
      `两次并发提交 → ${s1.status} / ${s2.status}；submit_response 审计条数=${auditsB}`
    );
    verdict(
      s1.status === 200 && s2.status === 200,
      "同一个 draft 可以被并发提交两次（业务动作被执行两遍）",
      `期望只有一个 200，实际 ${s1.status} / ${s2.status}，审计写了 ${auditsB} 条`
    );

    // ============ C) 并发下发 ============
    console.log("\n=== C) 同一个 pending 下发任务并发下发 ===");
    const instance = await (await import("../tests/integration/questionnaire/helpers.js")).createTestInstance(
      { status: "confirmed" }
    );
    const c: Flow = { instanceId: instance.id, taskId: "" };
    flows.push(c);
    const created = await call(client, "POST", "/api/v1/dispatch-tasks", {
      userId: USERS.dispatcher,
      body: {
        questionnaireInstanceId: instance.id,
        assignedTo: USERS.investigator,
      },
    });
    c.taskId = (created.body.data as { id: string }).id;

    const [d1, d2] = await Promise.all([
      call(client, "POST", `/api/v1/dispatch-tasks/${c.taskId}/dispatch`, {
        userId: USERS.dispatcher,
      }),
      call(client, "POST", `/api/v1/dispatch-tasks/${c.taskId}/dispatch`, {
        userId: USERS.dispatcher,
      }),
    ]);
    const auditsC = await prisma.aiToolExecution.count({
      where: { questionnaireInstanceId: instance.id, toolName: "dispatch_task" },
    });
    console.log(
      `两次并发下发 → ${d1.status} / ${d2.status}；dispatch_task 审计条数=${auditsC}`
    );
    verdict(
      d1.status === 200 && d2.status === 200,
      "同一个 pending 任务可以被并发下发两次（审计重复）",
      `期望只有一个 200，实际 ${d1.status} / ${d2.status}，审计写了 ${auditsC} 条`
    );
  } finally {
    await client.close();
    for (const f of flows) {
      await cleanupInstance(f.instanceId).catch(() => undefined);
    }
    const { prisma: p } = await import("../src/database/client.js");
    await p.$disconnect();
  }
}

main().catch(async (e) => {
  console.error("脚本失败：", e);
  const { prisma: p } = await import("../src/database/client.js");
  await p.$disconnect();
  process.exit(1);
});
