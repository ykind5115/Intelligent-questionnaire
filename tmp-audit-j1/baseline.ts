/** 基线核对：确认数据库只剩 seed 基线数据（并列出额外实例的创建时间，便于判断归属） */
import { prisma } from "../src/database/client.js";

const users = await prisma.user.findMany({
  select: { id: true, username: true, roles: true },
  orderBy: { username: "asc" },
});
const instances = await prisma.questionnaireInstance.findMany({
  select: { id: true, title: true, status: true, createdBy: true, createdAt: true },
  orderBy: { createdAt: "asc" },
});
const counts = {
  templates: await prisma.questionnaireTemplate.count(),
  templateVersions: await prisma.questionnaireTemplateVersion.count(),
  revisions: await prisma.questionnaireRevision.count(),
  conversations: await prisma.aiConversation.count(),
  messages: await prisma.aiMessage.count(),
  audits: await prisma.aiToolExecution.count(),
  dispatchTasks: await prisma.dispatchTask.count(),
  responses: await prisma.questionnaireResponse.count(),
  answers: await prisma.questionnaireAnswer.count(),
  reviews: await prisma.reviewRecord.count(),
};

console.log("users:", JSON.stringify(users, null, 1));
console.log("instances:", JSON.stringify(instances, null, 1));
console.log("counts:", JSON.stringify(counts));
await prisma.$disconnect();
