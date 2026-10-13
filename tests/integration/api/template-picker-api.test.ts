/**
 * 本轮后端改动的测试：
 *   1. create_template 支持在创建时指定 templateName
 *   2. GET /questionnaire-templates/published-versions
 *      （每个模板只列当前已发布版本 + 结构规模）
 *   3. 非法 id 返回 422 而不是 500（P2007 回归）
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  apiRequest,
  expectData,
  prisma,
  startTestServer,
  type TestHttpClient,
} from "./helpers.js";
import { USERS, deleteTestInstance } from "../questionnaire/helpers.js";
import { newId } from "../../../src/shared/utils/id.js";

let client: TestHttpClient;
const createdTemplateIds = new Set<string>();
const createdInstanceIds = new Set<string>();
const createdConversationIds = new Set<string>();

async function cleanup(): Promise<void> {
  for (const id of createdConversationIds) {
    await prisma.aiToolExecution.deleteMany({ where: { conversationId: id } });
    await prisma.aiMessage.deleteMany({ where: { conversationId: id } });
    await prisma.aiConversation.deleteMany({ where: { id } });
  }
  createdConversationIds.clear();

  for (const id of createdInstanceIds) await deleteTestInstance(id);
  createdInstanceIds.clear();

  for (const id of createdTemplateIds) {
    await prisma.questionnaireTemplate.updateMany({
      where: { id },
      data: { currentVersionId: null },
    });
    await prisma.questionnaireTemplateVersion.deleteMany({
      where: { templateId: id },
    });
    await prisma.questionnaireTemplate.deleteMany({ where: { id } });
  }
  createdTemplateIds.clear();
}

beforeAll(async () => {
  client = await startTestServer();
});

afterEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await client.close();
  await prisma.$disconnect();
});

/** 建一个带结构的模板并发布，返回 versionId */
async function makePublishedTemplate(
  name: string,
  questionCount = 1
): Promise<{ templateId: string; versionId: string }> {
  const t = await apiRequest<{ id: string }>(
    client,
    "POST",
    "/api/v1/questionnaire-templates",
    { userId: USERS.admin, body: { name } }
  );
  const templateId = expectData<{ id: string }>(t).id;
  createdTemplateIds.add(templateId);

  const questions = Array.from({ length: questionCount }, (_, i) => ({
    id: `q_${i + 1}`,
    type: "text",
    title: `题目${i + 1}`,
    required: false,
    order: i + 1,
  }));

  const v = await apiRequest<{ id: string }>(
    client,
    "POST",
    `/api/v1/questionnaire-templates/${templateId}/versions`,
    {
      userId: USERS.admin,
      body: {
        schema: {
          id: newId(),
          title: name,
          version: 1,
          sections: [
            { id: "sec_a", title: "分组A", order: 1, questions },
          ],
        },
      },
    }
  );
  const versionId = expectData<{ id: string }>(v).id;

  await apiRequest(
    client,
    "POST",
    `/api/v1/questionnaire-templates/${templateId}/versions/${versionId}/publish`,
    { userId: USERS.admin }
  );

  return { templateId, versionId };
}

// ============================================================
// 1. 创建时指定模板名
// ============================================================

describe("从零创建时可指定模板名", () => {
  it("给了 templateName → 模板立刻用这个名字", async () => {
    const NAME = "无人机黑飞核查问卷（指定名）";

    const res = await apiRequest<{
      templateId: string;
      templateVersionId: string;
      createdTemplate: boolean;
      conversationId: string;
    }>(client, "POST", "/api/v1/ai/conversations", {
      userId: USERS.admin,
      body: {
        scene: "create_template",
        targetType: "template",
        templateName: NAME,
      },
    });

    expect(res.status).toBe(201);
    const data = expectData<{
      templateId: string;
      conversationId: string;
    }>(res);
    createdTemplateIds.add(data.templateId);
    createdConversationIds.add(data.conversationId);

    const t = await prisma.questionnaireTemplate.findUnique({
      where: { id: data.templateId },
      select: { name: true },
    });
    // 关键：创建的那一刻名字就是最终名字，不用等 commit
    expect(t?.name).toBe(NAME);
  });

  it("不给 templateName → 回落到带时间戳的占位名（保持向后兼容）", async () => {
    const res = await apiRequest<{
      templateId: string;
      conversationId: string;
    }>(client, "POST", "/api/v1/ai/conversations", {
      userId: USERS.admin,
      body: { scene: "create_template", targetType: "template" },
    });
    expect(res.status).toBe(201);
    const data = expectData<{ templateId: string; conversationId: string }>(res);
    createdTemplateIds.add(data.templateId);
    createdConversationIds.add(data.conversationId);

    const t = await prisma.questionnaireTemplate.findUnique({
      where: { id: data.templateId },
      select: { name: true },
    });
    expect(t?.name).toMatch(/^AI 新建问卷 /);
  });

  it("全空白 templateName → 422（不能创建一个没有名字的模板）", async () => {
    const res = await apiRequest(client, "POST", "/api/v1/ai/conversations", {
      userId: USERS.admin,
      body: {
        scene: "create_template",
        targetType: "template",
        templateName: "   ",
      },
    });
    // 纯空格能过 zod 的 min(1)，由 Service 的 trim 校验拦住
    expect(res.status).toBe(422);
  });
});

// ============================================================
// 2. 可用的已发布版本
// ============================================================

describe("GET /questionnaire-templates/published-versions", () => {
  it("返回已发布模板及其当前版本与结构规模", async () => {
    const NAME = `选择测试-${newId().slice(0, 8)}`;
    const { templateId, versionId } = await makePublishedTemplate(NAME, 3);

    const res = await apiRequest<{
      items: {
        versionId: string;
        templateId: string;
        templateName: string;
        versionNo: number;
        sectionCount: number;
        questionCount: number;
      }[];
      total: number;
    }>(
      client,
      "GET",
      `/api/v1/questionnaire-templates/published-versions?keyword=${encodeURIComponent(NAME)}&page=1&pageSize=20`,
      { userId: USERS.dispatcher }
    );

    expect(res.status).toBe(200);
    const data = expectData<{
      items: {
        versionId: string;
        templateId: string;
        templateName: string;
        sectionCount: number;
        questionCount: number;
      }[];
    }>(res);

    const hit = data.items.find((x) => x.templateId === templateId);
    expect(hit).toBeDefined();
    expect(hit?.versionId).toBe(versionId);
    // 结构规模：只显示名字没法判断该选哪个模板
    expect(hit?.sectionCount).toBe(1);
    expect(hit?.questionCount).toBe(3);
  });

  it("一个模板有多个已发布版本时，只列当前生效的那一个", async () => {
    const NAME = `多版本-${newId().slice(0, 8)}`;
    const { templateId, versionId: v1 } = await makePublishedTemplate(NAME, 1);

    // 再加一个版本并发布 → currentVersionId 应指向 v2
    const v2Res = await apiRequest<{ id: string }>(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions`,
      {
        userId: USERS.admin,
        body: {
          schema: {
            id: newId(),
            title: NAME,
            version: 2,
            sections: [
              {
                id: "sec_a",
                title: "分组A",
                order: 1,
                questions: [
                  { id: "q_1", type: "text", title: "题", required: false, order: 1 },
                ],
              },
            ],
          },
        },
      }
    );
    const v2 = expectData<{ id: string }>(v2Res).id;
    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions/${v2}/publish`,
      { userId: USERS.admin }
    );

    const res = await apiRequest<{
      items: { templateId: string; versionId: string }[];
    }>(
      client,
      "GET",
      `/api/v1/questionnaire-templates/published-versions?keyword=${encodeURIComponent(NAME)}&page=1&pageSize=20`,
      { userId: USERS.admin }
    );

    const mine = expectData<{
      items: { templateId: string; versionId: string }[];
    }>(res).items.filter((x) => x.templateId === templateId);

    // 只出现一行，且是当前版本
    expect(mine).toHaveLength(1);
    expect(mine[0]?.versionId).toBe(v2);
    expect(mine[0]?.versionId).not.toBe(v1);
  });

  it("草稿模板不出现在列表里（只有已发布可用）", async () => {
    const NAME = `草稿不该出现-${newId().slice(0, 8)}`;
    const t = await apiRequest<{ id: string }>(
      client,
      "POST",
      "/api/v1/questionnaire-templates",
      { userId: USERS.admin, body: { name: NAME } }
    );
    const templateId = expectData<{ id: string }>(t).id;
    createdTemplateIds.add(templateId);
    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions`,
      { userId: USERS.admin, body: {} }
    );

    const res = await apiRequest<{ items: { templateId: string }[] }>(
      client,
      "GET",
      `/api/v1/questionnaire-templates/published-versions?keyword=${encodeURIComponent(NAME)}&page=1&pageSize=20`,
      { userId: USERS.admin }
    );
    const items = expectData<{ items: { templateId: string }[] }>(res).items;
    expect(items.some((x) => x.templateId === templateId)).toBe(false);
  });

  it("停用后不再出现在列表里", async () => {
    const NAME = `停用后消失-${newId().slice(0, 8)}`;
    const { templateId, versionId } = await makePublishedTemplate(NAME, 1);

    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions/${versionId}/disable`,
      { userId: USERS.admin }
    );

    const res = await apiRequest<{ items: { templateId: string }[] }>(
      client,
      "GET",
      `/api/v1/questionnaire-templates/published-versions?keyword=${encodeURIComponent(NAME)}&page=1&pageSize=20`,
      { userId: USERS.admin }
    );
    const items = expectData<{ items: { templateId: string }[] }>(res).items;
    expect(items.some((x) => x.templateId === templateId)).toBe(false);
  });

  it("返回的 versionId 可以直接用来建实例", async () => {
    const NAME = `可直接建案件-${newId().slice(0, 8)}`;
    const { versionId } = await makePublishedTemplate(NAME, 2);

    const inst = await apiRequest<{
      id: string;
      currentSchema: { sections: { questions: unknown[] }[] };
    }>(client, "POST", "/api/v1/questionnaire-instances", {
      userId: USERS.dispatcher,
      body: { templateVersionId: versionId, title: "用列表里的版本建案件" },
    });

    expect(inst.status).toBe(201);
    const data = expectData<{
      id: string;
      currentSchema: { sections: { questions: unknown[] }[] };
    }>(inst);
    createdInstanceIds.add(data.id);
    expect(data.currentSchema.sections[0]?.questions).toHaveLength(2);
  });
});

// ============================================================
// 3. 非法 id → 422（而不是 500）
// ============================================================

describe("非法 id 返回 422 而不是 500（P2007 回归）", () => {
  const NOT_UUID = "AI 新建问卷 2026-10-13 09:51";

  const cases: { name: string; method: "GET" | "POST" | "PATCH" | "DELETE"; path: string }[] = [
    { name: "实例详情", method: "GET", path: `/api/v1/questionnaire-instances/${encodeURIComponent(NOT_UUID)}` },
    { name: "实例修订历史", method: "GET", path: `/api/v1/questionnaire-instances/${encodeURIComponent(NOT_UUID)}/revisions` },
    { name: "实例确认", method: "POST", path: `/api/v1/questionnaire-instances/${encodeURIComponent(NOT_UUID)}/confirm` },
    { name: "实例撤回", method: "POST", path: `/api/v1/questionnaire-instances/${encodeURIComponent(NOT_UUID)}/withdraw` },
    { name: "模板详情", method: "GET", path: `/api/v1/questionnaire-templates/${encodeURIComponent(NOT_UUID)}` },
    { name: "模板更新", method: "PATCH", path: `/api/v1/questionnaire-templates/${encodeURIComponent(NOT_UUID)}` },
    { name: "模板删除", method: "DELETE", path: `/api/v1/questionnaire-templates/${encodeURIComponent(NOT_UUID)}` },
    { name: "模板版本", method: "GET", path: `/api/v1/questionnaire-templates/${encodeURIComponent(NOT_UUID)}/versions/${encodeURIComponent(NOT_UUID)}` },
    { name: "会话详情", method: "GET", path: `/api/v1/ai/conversations/${encodeURIComponent(NOT_UUID)}` },
    {
      name: "编辑器（实例）",
      method: "POST",
      path: `/api/v1/questionnaire-instances/${encodeURIComponent(NOT_UUID)}/sections`,
    },
    {
      name: "编辑器（模板草稿）",
      method: "POST",
      path: `/api/v1/questionnaire-templates/${encodeURIComponent(NOT_UUID)}/versions/${encodeURIComponent(NOT_UUID)}/sections`,
    },
  ];

  for (const c of cases) {
    it(`${c.name} → 422`, async () => {
      const res = await apiRequest(
        client,
        c.method,
        c.path,
        {
          userId: USERS.admin,
          ...(c.method === "GET" || c.method === "DELETE"
            ? {}
            : { body: { title: "x" } }),
        }
      );

      // 关键：以前是 500（Prisma P2007 直接冒到响应里）
      expect(res.status, `实际 ${res.status}：${JSON.stringify(res.body.error)}`).toBe(422);
      expect(res.body.success).toBe(false);
    });
  }

  it("合法的 UUID 但不存在 → 404（区分「格式错」与「没这条数据」）", async () => {
    const res = await apiRequest(
      client,
      "GET",
      `/api/v1/questionnaire-instances/${newId()}`,
      { userId: USERS.dispatcher }
    );
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("QUESTIONNAIRE_NOT_FOUND");
  });
});
