/** 审计用：读取数据库基线规模（只读） */
import { prisma } from "../src/database/client.js";

const [users, templates, versions, instances, revisions, responses, answers, tasks, convs, msgs, audits, reviews] =
  await Promise.all([
    prisma.user.count(),
    prisma.questionnaireTemplate.count(),
    prisma.questionnaireTemplateVersion.count(),
    prisma.questionnaireInstance.count(),
    prisma.questionnaireRevision.count(),
    prisma.questionnaireResponse.count(),
    prisma.questionnaireAnswer.count(),
    prisma.dispatchTask.count(),
    prisma.aiConversation.count(),
    prisma.aiMessage.count(),
    prisma.aiToolExecution.count(),
    prisma.reviewRecord.count(),
  ]);

console.log(
  JSON.stringify(
    { users, templates, versions, instances, revisions, responses, answers, tasks, convs, msgs, audits, reviews },
    null,
    2
  )
);

await prisma.$disconnect();
