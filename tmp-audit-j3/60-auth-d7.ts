/**
 * 审计脚本 F：D11（固定测试账号 + x-user-id）与 D7（prisma dev）可执行验证。
 */
import { createApp } from "../src/app/app.js";
import { startTestServer, apiRequest } from "../tests/integration/api/helpers.js";
import { USERS } from "../tests/integration/questionnaire/helpers.js";
import { prisma } from "../src/database/client.js";
import { newId } from "../src/shared/utils/id.js";

const results: Record<string, unknown> = {};
const app = createApp();
const server = await startTestServer(app);

try {
  const me = async (userId?: string) =>
    apiRequest<{ id: string; username: string; roles: string[] }>(
      server,
      "GET",
      "/api/v1/me",
      userId ? { userId } : {}
    );

  const asAdmin = await me(USERS.admin);
  const asInvestigator = await me(USERS.investigator);
  const noHeader = await me();
  const unknown = await me(newId());

  results["D11_me"] = {
    withXUserId_admin: { http: asAdmin.status, data: asAdmin.body.data },
    withXUserId_investigator: { http: asInvestigator.status, data: asInvestigator.body.data },
    withoutHeader_fallback: { http: noHeader.status, data: noHeader.body.data },
    unknownUserId: { http: unknown.status, error: unknown.body.error?.code },
  };

  // 4 个种子账号的 roles 是否符合 D8
  const users = await prisma.user.findMany({
    select: { username: true, roles: true, status: true },
    orderBy: { username: "asc" },
  });
  results["D11_seedUsers"] = users;

  // 生产环境必须拒绝启动（业务代码只依赖 CurrentUser 的兜底要求）
  results["D11_productionGuard_note"] =
    "见 src/shared/auth/auth.middleware.ts:131 productionAuthGuard（app.ts:30 调用）；" +
    "由独立进程用 NODE_ENV=production 验证";
} finally {
  console.log(JSON.stringify(results, null, 2));
  await server.close();
  await prisma.$disconnect();
}
