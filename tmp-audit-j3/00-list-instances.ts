import { prisma } from "../src/database/client.js";
const rows = await prisma.questionnaireInstance.findMany({ select: { id: true, title: true, status: true, currentRevision: true, createdBy: true, createdAt: true }, orderBy: { createdAt: "asc" } });
console.log(JSON.stringify(rows, null, 2));
await prisma.$disconnect();
