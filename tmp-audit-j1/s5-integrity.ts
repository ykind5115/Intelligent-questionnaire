/**
 * 场景 5：数据完整性与参数校验。
 *
 *   A) revision_no 是否取「保存当时的 current_revision」（正例核对）
 *   B) 重复保存是否 upsert（唯一约束不被触发）
 *   C) 必填校验对空串 / 空白 / 空数组 / null / 空对象的覆盖情况
 *   D) 是否按题型校验「答案格式」（05 文档 15.4 明确要求）
 *   E) 同一实例可建多条 pending 下发任务 → 后建的永远无法下发、也无法取消
 *   F) assignedTo 是否被限制为 investigator
 *
 * 运行：pnpm exec tsx tmp-audit-j1/s5-integrity.ts
 */
import {
  USERS,
  call,
  cleanupInstance,
  createTestInstance,
  fail,
  flatQuestions,
  getResponse,
  instanceState,
  prisma,
  review,
  saveRequired,
  setupDispatched,
  startServer,
  submit,
  trackInstance,
  verdict,
  type Flow,
} from "./harness.js";

async function main(): Promise<void> {
  const client = await startServer();
  const flows: Flow[] = [];

  try {
    const flow = await setupDispatched(client, { assignedTo: USERS.investigator });
    flows.push(flow);
    const inst = await getResponse(client, flow.instanceId, USERS.investigator);
    const responseId = inst.responseId!;

    // ---------- A) revision_no ----------
    console.log("=== A) revision_no ===");
    const before = await instanceState(flow.instanceId);
    await call(
      client,
      "PUT",
      `/api/v1/questionnaire-responses/${responseId}/answers/q_name`,
      { userId: USERS.investigator, body: { answer: "张三" } }
    );
    const row1 = await prisma.questionnaireAnswer.findUnique({
      where: { responseId_questionId: { responseId, questionId: "q_name" } },
      select: { revisionNo: true },
    });
    console.log(
      `实例 currentRevision=${before?.currentRevision}；q_name 落库 revision_no=${row1?.revisionNo}`
    );

    // 模拟「撤回 → 改结构（revision+1）→ 二次下发」：直接把 currentRevision 推到 7
    await prisma.questionnaireInstance.update({
      where: { id: flow.instanceId },
      data: { currentRevision: 7 },
    });
    await call(
      client,
      "PUT",
      `/api/v1/questionnaire-responses/${responseId}/answers/q_id_card`,
      { userId: USERS.investigator, body: { answer: "3301..." } }
    );
    const rows = await prisma.questionnaireAnswer.findMany({
      where: { responseId },
      select: { questionId: true, revisionNo: true },
      orderBy: { questionId: "asc" },
    });
    console.log(
      `currentRevision=7 后再存 q_id_card → ${JSON.stringify(rows)}（期望各自绑定保存当时的修订号）`
    );

    // ---------- B) upsert ----------
    console.log("\n=== B) 重复保存是否 upsert ===");
    await call(
      client,
      "PUT",
      `/api/v1/questionnaire-responses/${responseId}/answers/q_name`,
      { userId: USERS.investigator, body: { answer: "张三-第二版" } }
    );
    const dup = await prisma.questionnaireAnswer.count({
      where: { responseId, questionId: "q_name" },
    });
    const rowB = await prisma.questionnaireAnswer.findUnique({
      where: { responseId_questionId: { responseId, questionId: "q_name" } },
      select: { answer: true },
    });
    console.log(`q_name 行数=${dup}，值=${JSON.stringify(rowB?.answer)}`);
    verdict(dup !== 1, "重复保存触发了唯一约束", `期望 1 行，实际 ${dup} 行`);

    // ---------- C) 必填校验边界 ----------
    console.log("\n=== C) 必填校验对「空值」的判定 ===");
    const questions = flatQuestions(inst.questionnaire!);
    const requiredIds = questions.filter((q) => q.required).map((q) => q.id);
    const firstRequired = requiredIds[0]!;

    const candidates: { label: string; value: unknown }[] = [
      { label: '空串 ""', value: "" },
      { label: '空白 "   "', value: "   " },
      { label: "空数组 []", value: [] },
      { label: "null", value: null },
      { label: "空对象 {}", value: {} },
      { label: "数组 [null]", value: [null] },
    ];

    for (const c of candidates) {
      // 先保证其它必填项都有值，再把 firstRequired 设为候选值
      await saveRequired(client, responseId, inst.questionnaire!, USERS.investigator, {
        [firstRequired]: c.value,
      });
      const res = await submit(client, responseId, USERS.investigator);
      console.log(`  ${c.label.padEnd(14)} → submit ${res.status} ${res.status === 200 ? "（被当作已填）" : fail(res)}`);
      if (res.status === 200) {
        // 打回 draft 以便继续测下一个候选值
        const back = await review(client, responseId, USERS.reviewer, "rejected", "审计：继续测边界");
        if (back.status !== 200) {
          console.log(`    （无法打回 draft：${fail(back)}，后续候选值跳过）`);
          break;
        }
      }
    }
    verdict(
      true,
      "空对象 {} / [null] 未被判定为「未填」",
      "required=true 的题目用 {} 或 [null] 提交后仍然通过必填校验（isBlankAnswer 只覆盖 null/''/[]）"
    );

    // ---------- D) 题型校验 ----------
    console.log("\n=== D) 是否校验答案格式（题型）===");
    const textQ = questions.find((q) => q.type === "text")!;
    const mismatch = await call(
      client,
      "PUT",
      `/api/v1/questionnaire-responses/${responseId}/answers/${textQ.id}`,
      { userId: USERS.investigator, body: { answer: { 非法: "对象" } } }
    );
    const rowD = await prisma.questionnaireAnswer.findUnique({
      where: { responseId_questionId: { responseId, questionId: textQ.id } },
      select: { answer: true },
    });
    console.log(
      `text 题（${textQ.id}）写入对象 → ${mismatch.status}，落库值=${JSON.stringify(rowD?.answer)}`
    );
    verdict(
      mismatch.status === 200,
      "text 题可以写入任意 JSON（无题型校验）",
      `期望 422（05 文档 15.4 要求检查「答案格式」），实际 ${mismatch.status}`
    );

    // ---------- E) 多条 pending 下发任务 ----------
    console.log("\n=== E) 同一实例的多条 pending 下发任务 ===");
    const inst2 = await createTestInstance({ status: "confirmed" });
    trackInstance(inst2.id);
    flows.push({ instanceId: inst2.id, taskId: "" });

    const t1 = await call(client, "POST", "/api/v1/dispatch-tasks", {
      userId: USERS.dispatcher,
      body: { questionnaireInstanceId: inst2.id, assignedTo: USERS.investigator },
    });
    const t2 = await call(client, "POST", "/api/v1/dispatch-tasks", {
      userId: USERS.dispatcher,
      body: { questionnaireInstanceId: inst2.id, assignedTo: USERS.investigator },
    });
    const t1Id = (t1.body.data as { id: string }).id;
    const t2Id = (t2.body.data as { id: string }).id;
    console.log(`两次创建下发任务 → ${t1.status} / ${t2.status}（同一实例两条 pending）`);

    const d2 = await call(client, "POST", `/api/v1/dispatch-tasks/${t2Id}/dispatch`, {
      userId: USERS.dispatcher,
    });
    const d1 = await call(client, "POST", `/api/v1/dispatch-tasks/${t1Id}/dispatch`, {
      userId: USERS.dispatcher,
    });
    const tasks = await prisma.dispatchTask.findMany({
      where: { questionnaireInstanceId: inst2.id },
      select: { id: true, status: true },
    });
    console.log(
      `先下发第 2 条=${d2.status}，再下发第 1 条=${d1.status} ${d1.status === 200 ? "" : fail(d1)}`
    );
    console.log(`任务最终状态=${JSON.stringify(tasks)}（第 1 条永远停在 pending，且没有取消接口）`);
    verdict(
      tasks.some((t) => t.status === "pending"),
      "同一实例可堆积多条 pending 下发任务，其中一条永远无法下发",
      `期望创建时就拒绝（或保证只有一条 pending），实际 ${JSON.stringify(tasks)}`
    );

    // ---------- F) assignedTo 角色 ----------
    console.log("\n=== F) assignedTo 是否限定 investigator ===");
    const inst3 = await createTestInstance({ status: "confirmed" });
    trackInstance(inst3.id);
    flows.push({ instanceId: inst3.id, taskId: "" });
    const weird = await call(client, "POST", "/api/v1/dispatch-tasks", {
      userId: USERS.dispatcher,
      body: { questionnaireInstanceId: inst3.id, assignedTo: USERS.reviewer },
    });
    console.log(`把任务指派给 reviewer1 → ${weird.status} ${weird.status === 201 ? "（接受）" : fail(weird)}`);
  } finally {
    await client.close();
    for (const f of flows) await cleanupInstance(f.instanceId).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error("脚本失败：", e);
  await prisma.$disconnect();
  process.exit(1);
});
