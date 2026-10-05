import { prisma } from "../src/database/client.js";
const inst = await prisma.questionnaireInstance.findMany({ select: { title: true, status: true }, orderBy: { createdAt: "asc" } });
const audits = await prisma.aiToolExecution.findMany({ select: { toolName: true, source: true, questionnaireInstanceId: true, conversationId: true, createdAt: true } });
console.log(JSON.stringify({ inst, audits }, null, 2));
await prisma.$disconnect();
