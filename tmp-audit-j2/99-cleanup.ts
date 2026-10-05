/**
 * 清理：删除所有审计脚本创建的测试实例及其关联数据，并输出基线。
 * 用法：pnpm exec tsx tmp-audit-j2/99-cleanup.ts [--apply]
 */
import { prisma } from "../src/database/client.js";

const APPLY = process.argv.includes("--apply");

/** 基线：应保留的实例 */
const KEEP_TITLES = ["张三 - 无人机黑飞核查"];

async function main() {
  const instances = await prisma.questionnaireInstance.findMany({
    select: { id: true, title: true, status: true, currentRevision: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const toDelete = instances.filter((i) => !KEEP_TITLES.includes(i.title));
  console.log("全部实例:");
  for (const i of instances) {
    console.log(
      `  ${KEEP_TITLES.includes(i.title) ? "[保留]" : "[待删]"} ${i.id} | ${i.title} | ${i.status} | rev=${i.currentRevision}`
    );
  }
  console.log(`\n需要删除的实例数: ${toDelete.length} (apply=${APPLY})`);

  if (!APPLY) {
    console.log("（未传 --apply，仅预览）");
    return;
  }

  const ids = toDelete.map((i) => i.id);

  // 先拿到所有 response，再按外键顺序删除
  const responses = await prisma.questionnaireResponse.findMany({
    where: { questionnaireInstanceId: { in: ids } },
    select: { id: true },
  });
  const responseIds = responses.map((r) => r.id);

  const del = await prisma.$transaction([
    prisma.reviewRecord.deleteMany({ where: { questionnaireResponseId: { in: responseIds } } }),
    prisma.questionnaireAnswer.deleteMany({ where: { responseId: { in: responseIds } } }),
    prisma.aiToolExecution.deleteMany({ where: { questionnaireInstanceId: { in: ids } } }),
    prisma.questionnaireRevision.deleteMany({ where: { questionnaireInstanceId: { in: ids } } }),
    prisma.dispatchTask.deleteMany({ where: { questionnaireInstanceId: { in: ids } } }),
    prisma.questionnaireResponse.deleteMany({ where: { questionnaireInstanceId: { in: ids } } }),
    prisma.questionnaireTemplateVersion.deleteMany({ where: { sourceInstanceId: { in: ids } } }),
    prisma.questionnaireInstance.deleteMany({ where: { id: { in: ids } } }),
  ]);
  console.log("删除计数:", del.map((d) => d.count).join(", "));

  // 清理审计脚本产生的独立会话/消息/工具执行（不带实例的）
  const convs = await prisma.aiConversation.findMany({
    where: { scene: "modify_questionnaire", targetId: null },
    select: { id: true },
  });
  if (convs.length > 0) {
    const cids = convs.map((c) => c.id);
    const d1 = await prisma.aiToolExecution.deleteMany({ where: { conversationId: { in: cids } } });
    const d2 = await prisma.aiMessage.deleteMany({ where: { conversationId: { in: cids } } });
    const d3 = await prisma.aiConversation.deleteMany({ where: { id: { in: cids } } });
    console.log(`清理无目标会话: tool=${d1.count} msg=${d2.count} conv=${d3.count}`);
  }

  // 最终基线
  const final = {
    users: await prisma.user.count(),
    templates: await prisma.questionnaireTemplate.count(),
    versions: await prisma.questionnaireTemplateVersion.count(),
    instances: await prisma.questionnaireInstance.count(),
    revisions: await prisma.questionnaireRevision.count(),
    audits: await prisma.aiToolExecution.count(),
    responses: await prisma.questionnaireResponse.count(),
    answers: await prisma.questionnaireAnswer.count(),
    tasks: await prisma.dispatchTask.count(),
    reviews: await prisma.reviewRecord.count(),
    conversations: await prisma.aiConversation.count(),
    messages: await prisma.aiMessage.count(),
  };
  console.log("\n最终基线:", JSON.stringify(final, null, 2));

  const remaining = await prisma.questionnaireInstance.findMany({
    select: { id: true, title: true, status: true, currentRevision: true },
  });
  console.log("剩余实例:", JSON.stringify(remaining, null, 2));
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
