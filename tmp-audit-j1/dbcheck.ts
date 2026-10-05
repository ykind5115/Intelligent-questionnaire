/** 连通性自检：直接跑一条最简查询，确认数据库可用 */
import { prisma } from "../src/database/client.js";

const rows = await prisma.$queryRawUnsafe<{ ok: number }[]>("select 1 as ok");
console.log("query ok:", JSON.stringify(rows));
const n = await prisma.user.count();
console.log("users:", n);
await prisma.$disconnect();
