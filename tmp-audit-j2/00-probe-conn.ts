/**
 * 探针 0：确认数据库可连接，并打印基线。
 */
import { prisma } from "../src/database/client.js";

async function main() {
  const users = await prisma.user.count();
  const templates = await prisma.questionnaireTemplate.count();
  const versions = await prisma.questionnaireTemplateVersion.count();
  const instances = await prisma.questionnaireInstance.count();
  const revisions = await prisma.questionnaireRevision.count();
  const audits = await prisma.aiToolExecution.count();
  const responses = await prisma.questionnaireResponse.count();
  const tasks = await prisma.dispatchTask.count();
  const messages = await prisma.aiMessage.count();
  const conversations = await prisma.aiConversation.count();

  console.log(
    JSON.stringify(
      { users, templates, versions, instances, revisions, audits, responses, tasks, messages, conversations },
      null,
      2
    )
  );

  const instanceRows = await prisma.questionnaireInstance.findMany({
    select: { id: true, title: true, status: true, currentRevision: true },
  });
  console.log("instances:", JSON.stringify(instanceRows, null, 2));

  const versionRows = await prisma.questionnaireTemplateVersion.findMany({
    select: { id: true, templateId: true, versionNo: true, status: true },
  });
  console.log("versions:", JSON.stringify(versionRows, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED", e);
    process.exit(1);
  });
