/**
 * 审计脚本 I：模板内容的可用写入路径确认。
 *
 * 假设：
 *  路径1：POST /questionnaire-templates/{id}/versions 直接提交完整 schema（手工 JSON）→ 可行
 *  路径2：POST /questionnaire-instances/{id}/promote（D2 扶正）→ 可行
 *  路径3：AI 对话（create_template）→ 已验证不可行
 */
import { createApp } from "../src/app/app.js";
import {
  startTestServer,
    apiRequest,
  expectData,
} from "../tests/integration/api/helpers.js";
import { USERS } from "../tests/integration/questionnaire/helpers.js";
import { prisma } from "../src/database/client.js";
import { newId } from "../src/shared/utils/id.js";

const results: Record<string, unknown> = {};
const created = { templates: [] as string[], instances: [] as string[] };

async function cleanup(): Promise<void> {
  for (const id of created.instances) {
    await prisma.questionnaireRevision.deleteMany({
      where: { questionnaireInstanceId: id },
    });
    await prisma.aiToolExecution.deleteMany({
      where: { questionnaireInstanceId: id },
    });
    await prisma.questionnaireInstance.deleteMany({ where: { id } });
  }
  for (const id of created.templates) {
    await prisma.questionnaireTemplateVersion.deleteMany({ where: { templateId: id } });
    await prisma.questionnaireTemplate.deleteMany({ where: { id } });
  }
}

async function main(): Promise<void> {
  const app = createApp();
  const server = await startTestServer(app);
  const base = "/api/v1";

  try {
    const tpl = await apiRequest<{ id: string }>(server, "POST", `${base}/questionnaire-templates`, {
      userId: USERS.admin,
      body: { name: "审计I-手工schema" },
    });
    const templateId = expectData<{ id: string }>(tpl).id;
    created.templates.push(templateId);

    const schemaId = newId();
    const schema = {
      id: schemaId,
      title: "审计I-手工schema",
      version: 1,
      sections: [
        {
          id: "sec_manual",
          title: "手工分组",
          order: 1,
          questions: [
            {
              id: "q_manual",
              type: "text",
              title: "手工题目",
              required: true,
              order: 1,
            },
          ],
        },
      ],
    };

    const ver = await apiRequest<{ id: string; status: string; versionNo: number }>(
      server,
      "POST",
      `${base}/questionnaire-templates/${templateId}/versions`,
      { userId: USERS.admin, body: { schema, changeNote: "手工提交完整 schema" } }
    );
    const versionId = expectData<{ id: string }>(ver).id;

    const pub = await apiRequest<{ status: string }>(
      server,
      "POST",
      `${base}/questionnaire-templates/${templateId}/versions/${versionId}/publish`,
      { userId: USERS.admin }
    );

    const inst = await apiRequest<{ id: string; currentSchema: unknown }>(
      server,
      "POST",
      `${base}/questionnaire-instances`,
      {
        userId: USERS.dispatcher,
        body: { templateVersionId: versionId, title: "审计I-由手工版本派生" },
      }
    );
    const instanceId = expectData<{ id: string }>(inst).id;
    created.instances.push(instanceId);

    results["path1_manualSchema"] = {
      createVersionHttp: ver.status,
      versionStatus: expectData<{ status: string }>(ver).status,
      publishHttp: pub.status,
      instanceHttp: inst.status,
      instanceSections: (
        expectData<{ currentSchema: { sections: unknown[] } }>(inst).currentSchema
      ).sections.length,
    };

    // 额外：请求体里带 status 试图绕过发布？
    const bypass = await apiRequest(
      server,
      "POST",
      `${base}/questionnaire-templates/${templateId}/versions`,
      {
        userId: USERS.admin,
        body: { schema, status: "published" },
      }
    );
    results["path1b_statusInjection"] = {
      http: bypass.status,
      createdStatus: bypass.body.success
        ? (bypass.body.data as { status: string }).status
        : null,
    };
  } finally {
    console.log(JSON.stringify(results, null, 2));
    await cleanup();
    await server.close();
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error("脚本失败：", e);
  try {
    await cleanup();
  } catch {
    /* ignore */
  }
  await prisma.$disconnect();
  process.exit(1);
});
