/**
 * 审计残留清理：删除本审计创建的所有数据（按命名前缀识别），不影响 seed 数据。
 *
 * 覆盖：
 *  - 标题以「审计」开头的问卷实例及其 response/answer/review/task/revision/audit
 *  - 名称以「审计B-」开头的模板及其版本
 *  - 指向上述目标的 AI 会话与消息
 */
import { prisma } from "../src/database/client.js";

async function main(): Promise<void> {
  const instances = await prisma.questionnaireInstance.findMany({
    where: { title: { startsWith: "审计" } },
    select: { id: true },
  });
  const instanceIds = instances.map((i) => i.id);

  const templates = await prisma.questionnaireTemplate.findMany({
    where: { name: { startsWith: "审计" } },
    select: { id: true },
  });
  const templateIds = templates.map((t) => t.id);
  const versions = templateIds.length
    ? await prisma.questionnaireTemplateVersion.findMany({
        where: { templateId: { in: templateIds } },
        select: { id: true },
      })
    : [];
  const versionIds = versions.map((v) => v.id);

  // 本审计产生的扶正版本（挂在 seed 模板下，但 source_type = promoted_from_instance
  // 且 source_instance_id 指向审计实例）
  const promoted = instanceIds.length
    ? await prisma.questionnaireTemplateVersion.findMany({
        where: { sourceInstanceId: { in: instanceIds } },
        select: { id: true },
      })
    : [];

  const conversations = await prisma.aiConversation.findMany({
    where: {
      OR: [
        ...(instanceIds.length
          ? [{ targetType: "questionnaire_instance", targetId: { in: instanceIds } }]
          : []),
        ...(versionIds.length
          ? [{ targetType: "template", targetId: { in: versionIds } }]
          : []),
        ...(promoted.length
          ? [{ targetType: "template", targetId: { in: promoted.map((p) => p.id) } }]
          : []),
      ],
    },
    select: { id: true },
  });
  const conversationIds = conversations.map((c) => c.id);

  const del = async (label: string, fn: () => Promise<{ count: number }>) => {
    const r = await fn();
    if (r.count > 0) console.log(`  删除 ${label}: ${r.count}`);
  };

  // AI 会话相关
  if (conversationIds.length) {
    await del("ai_tool_executions(conversation)", () =>
      prisma.aiToolExecution.deleteMany({ where: { conversationId: { in: conversationIds } } })
    );
    await del("ai_messages", () =>
      prisma.aiMessage.deleteMany({ where: { conversationId: { in: conversationIds } } })
    );
  }
  if (instanceIds.length) {
    await del("questionnaire_answers", () =>
      prisma.questionnaireAnswer.deleteMany({
        where: { response: { questionnaireInstanceId: { in: instanceIds } } },
      })
    );
    await del("review_records", () =>
      prisma.reviewRecord.deleteMany({
        where: { response: { questionnaireInstanceId: { in: instanceIds } } },
      })
    );
    await del("questionnaire_responses", () =>
      prisma.questionnaireResponse.deleteMany({
        where: { questionnaireInstanceId: { in: instanceIds } },
      })
    );
    await del("dispatch_tasks", () =>
      prisma.dispatchTask.deleteMany({
        where: { questionnaireInstanceId: { in: instanceIds } },
      })
    );
    await del("ai_tool_executions(instance)", () =>
      prisma.aiToolExecution.deleteMany({
        where: { questionnaireInstanceId: { in: instanceIds } },
      })
    );
    await del("questionnaire_revisions", () =>
      prisma.questionnaireRevision.deleteMany({
        where: { questionnaireInstanceId: { in: instanceIds } },
      })
    );
  }
  await del("ai_conversations", () =>
    conversationIds.length
      ? prisma.aiConversation.deleteMany({ where: { id: { in: conversationIds } } })
      : Promise.resolve({ count: 0 })
  );
  const allVersionIds = [...versionIds, ...promoted.map((p) => p.id)];
  await del("questionnaire_template_versions", () =>
    allVersionIds.length
      ? prisma.questionnaireTemplateVersion.deleteMany({ where: { id: { in: allVersionIds } } })
      : Promise.resolve({ count: 0 })
  );
  await del("questionnaire_instances", () =>
    instanceIds.length
      ? prisma.questionnaireInstance.deleteMany({ where: { id: { in: instanceIds } } })
      : Promise.resolve({ count: 0 })
  );
  await del("questionnaire_templates", () =>
    templateIds.length
      ? prisma.questionnaireTemplate.deleteMany({ where: { id: { in: templateIds } } })
      : Promise.resolve({ count: 0 })
  );

  console.log("清理完成");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("清理失败：", e);
  await prisma.$disconnect();
  process.exit(1);
});
