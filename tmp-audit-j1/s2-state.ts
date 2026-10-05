/**
 * 场景 2：状态机漏洞（审核/提交不校验实例状态，终态可被回退）。
 *
 * A) 提交接口不校验实例状态：实例已 completed，另一个 draft response 仍可提交，
 *    并把实例从 completed 拉回 submitted。
 * B) 审核接口不校验「这份 response 是否已经审过」：approved 之后 response 仍是
 *    submitted，于是同一条 response 可以被再次 rejected → 实例从 completed 回到 returned。
 *
 * 运行：pnpm exec tsx tmp-audit-j1/s2-state.ts
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
  const inv2 = await createTempUser("audit_j1_investigator3", ["investigator"]);
  const flows: Flow[] = [];

  try {
    // ================= A) completed → submitted =================
    console.log("=== A) 提交接口不校验实例状态 ===");
    const a = await setupDispatched(client, { assignedTo: USERS.investigator });
    flows.push(a);

    const r1 = await getResponse(client, a.instanceId, USERS.investigator);
    const r2 = await getResponse(client, a.instanceId, inv2);
    console.log(
      `同一实例下两条 draft response：inv1=${r1.responseId}，inv2=${r2.responseId}`
    );

    const s1 = await saveRequired(client, r1.responseId!, r1.questionnaire!, USERS.investigator);
    const sub1 = await submit(client, r1.responseId!, USERS.investigator);
    console.log(
      `inv1 保存=${s1.status} 提交=${sub1.status}；实例=${(await instanceState(a.instanceId))?.status}`
    );

    const appr = await review(client, r1.responseId!, USERS.reviewer, "approved", "通过");
    console.log(
      `reviewer approved → ${appr.status}；实例=${(await instanceState(a.instanceId))?.status}；` +
        `resp1.status=${(await responseState(r1.responseId!))?.status}`
    );

    // 实例已是 completed，inv2 的 draft response 还能继续保存与提交吗？
    const s2 = await saveRequired(client, r2.responseId!, r2.questionnaire!, inv2);
    console.log(`\n实例已 completed 时，inv2 保存答案 → ${s2.status} ${s2.status === 200 ? "" : fail(s2)}`);

    const beforeSub2 = await instanceState(a.instanceId);
    const sub2 = await submit(client, r2.responseId!, inv2);
    const afterSub2 = await instanceState(a.instanceId);
    console.log(
      `inv2 提交 → ${sub2.status} ${sub2.status === 200 ? "" : fail(sub2)}；` +
        `实例状态 ${beforeSub2?.status} → ${afterSub2?.status}`
    );
    verdict(
      sub2.status === 200 && afterSub2?.status === "submitted",
      "completed（终态）被提交接口回退为 submitted",
      `期望 409（实例 completed，不能再提交），实际 ${sub2.status}，实例状态 ${afterSub2?.status}`
    );

    // ================= B) 已审核通过的 response 可以再次被退回 =================
    console.log("\n=== B) 同一条 response 可以被重复审核 ===");
    const b = await setupDispatched(client, { assignedTo: USERS.investigator });
    flows.push(b);

    const rb = await getResponse(client, b.instanceId, USERS.investigator);
    await saveRequired(client, rb.responseId!, rb.questionnaire!, USERS.investigator);
    const subB = await submit(client, rb.responseId!, USERS.investigator);
    console.log(`inv1 提交=${subB.status}`);

    const apprB = await review(client, rb.responseId!, USERS.reviewer, "approved", "第一次通过");
    const stateAfterApprove = await instanceState(b.instanceId);
    console.log(
      `第 1 次审核 approved → ${apprB.status}；实例=${stateAfterApprove?.status}；` +
        `response.status=${(await responseState(rb.responseId!))?.status}`
    );

    // 待审核列表里还会不会出现「已经通过」的这条？
    const pending = await call(
      client,
      "GET",
      "/api/v1/questionnaire-responses/review/pending?page=1&pageSize=100",
      { userId: USERS.reviewer }
    );
    const items = (pending.body.data as { items: { responseId: string; status: string; instanceStatus: string }[] })
      .items;
    const stillPending = items.find((i) => i.responseId === rb.responseId);
    console.log(
      `\nGET /review/pending 中该 response → ${stillPending ? JSON.stringify(stillPending) : "未出现"}`
    );
    verdict(
      Boolean(stillPending),
      "已审核通过的 response 仍然出现在「待审核列表」",
      `期望不出现（已 approved），实际出现：${JSON.stringify(stillPending)}`
    );

    // 第 2 次审核：rejected
    const rejB = await review(client, rb.responseId!, USERS.reviewer, "rejected", "第二次退回");
    const stateAfterReject = await instanceState(b.instanceId);
    const respAfterReject = await responseState(rb.responseId!);
    console.log(
      `\n第 2 次审核 rejected → ${rejB.status} ${rejB.status === 200 ? "" : fail(rejB)}；` +
        `实例 ${stateAfterApprove?.status} → ${stateAfterReject?.status}；` +
        `response.status=${respAfterReject?.status}`
    );
    verdict(
      rejB.status === 200 && stateAfterReject?.status === "returned",
      "已 completed 的实例被再次审核退回（completed → returned）",
      `期望 409（一条提交只能审一次 / completed 是终态），实际 ${rejB.status}，实例状态 ${stateAfterReject?.status}`
    );

    const records = await prisma.reviewRecord.findMany({
      where: { questionnaireResponseId: rb.responseId! },
      select: { result: true, comment: true, createdAt: true },
    });
    console.log(`同一条 response 的 review_records：${JSON.stringify(records)}`);
  } finally {
    await client.close();
    for (const f of flows) await cleanupInstance(f.instanceId).catch(() => undefined);
    await cleanupUser(inv2).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error("脚本失败：", e);
  await prisma.$disconnect();
  process.exit(1);
});
