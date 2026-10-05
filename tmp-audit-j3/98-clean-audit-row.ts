import { prisma } from "../src/database/client.js";
const rows = await prisma.aiToolExecution.findMany({
  where: { questionnaireInstanceId: null, conversationId: null, toolName: "add_section", source: "rest" },
  select: { id: true, createdAt: true },
});
console.log("matched", JSON.stringify(rows));
if (rows.length === 1) {
  const r = await prisma.aiToolExecution.delete({ where: { id: rows[0]!.id } });
  console.log("deleted", r.id);
} else {
  console.log("不删除：无法唯一确定是本次审计产生");
}
await prisma.$disconnect();
