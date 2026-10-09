/**
 * 模板管理 API 测试（更新 / 删除 / 发布 / 停用）。
 *
 * 重点在**删除的安全约束**：
 *   模板被案件引用过就不能删，否则既有案件会失去来源依据。
 *   这类约束必须由后端拦住，不能靠数据库外键抛一个难懂的错误。
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

async function cleanup(): Promise<void> {
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

/** 建一个只有空草稿版本的模板 */
async function makeTemplate(
  name = `管理测试-${newId().slice(0, 8)}`
): Promise<{ templateId: string; versionId: string }> {
  const t = await apiRequest<{ id: string }>(
    client,
    "POST",
    "/api/v1/questionnaire-templates",
    { userId: USERS.admin, body: { name } }
  );
  const templateId = expectData<{ id: string }>(t).id;
  createdTemplateIds.add(templateId);

  const v = await apiRequest<{ id: string }>(
    client,
    "POST",
    `/api/v1/questionnaire-templates/${templateId}/versions`,
    { userId: USERS.admin, body: {} }
  );
  return { templateId, versionId: expectData<{ id: string }>(v).id };
}

// ============================================================
// 列表与搜索
// ============================================================

describe("模板列表与搜索", () => {
  it("支持按名称关键字搜索（大小写不敏感）", async () => {
    const { templateId } = await makeTemplate("搜索测试-无人机核查-ABC");

    const byUpper = await apiRequest<{ items: { id: string }[] }>(
      client,
      "GET",
      "/api/v1/questionnaire-templates?keyword=ABC&page=1&pageSize=50",
      { userId: USERS.admin }
    );
    expect(byUpper.status).toBe(200);
    expect(
      expectData<{ items: { id: string }[] }>(byUpper).items.map((x) => x.id)
    ).toContain(templateId);

    const byLower = await apiRequest<{ items: { id: string }[] }>(
      client,
      "GET",
      "/api/v1/questionnaire-templates?keyword=abc&page=1&pageSize=50",
      { userId: USERS.admin }
    );
    expect(
      expectData<{ items: { id: string }[] }>(byLower).items.map((x) => x.id)
    ).toContain(templateId);
  });

  it("搜不到时返回空列表而不是报错", async () => {
    const res = await apiRequest<{ items: unknown[]; total: number }>(
      client,
      "GET",
      "/api/v1/questionnaire-templates?keyword=绝不存在的模板名zzz&page=1&pageSize=10",
      { userId: USERS.admin }
    );
    expect(res.status).toBe(200);
    const data = expectData<{ items: unknown[]; total: number }>(res);
    expect(data.items).toHaveLength(0);
    expect(data.total).toBe(0);
  });

  it("支持按状态筛选", async () => {
    const { templateId } = await makeTemplate("状态筛选测试");
    const res = await apiRequest<{ items: { id: string; status: string }[] }>(
      client,
      "GET",
      "/api/v1/questionnaire-templates?status=draft&page=1&pageSize=50",
      { userId: USERS.admin }
    );
    const items = expectData<{ items: { id: string; status: string }[] }>(res)
      .items;
    expect(items.some((x) => x.id === templateId)).toBe(true);
    expect(items.every((x) => x.status === "draft")).toBe(true);
  });
});

// ============================================================
// 更新
// ============================================================

describe("更新模板（名称 / 描述）", () => {
  it("改名称与描述 → 200 且落库", async () => {
    const { templateId } = await makeTemplate("改名前");

    const res = await apiRequest<{ name: string; description: string }>(
      client,
      "PATCH",
      `/api/v1/questionnaire-templates/${templateId}`,
      {
        userId: USERS.admin,
        body: { name: "改名后", description: "新的描述" },
      }
    );

    expect(res.status).toBe(200);
    const data = expectData<{ name: string; description: string }>(res);
    expect(data.name).toBe("改名后");
    expect(data.description).toBe("新的描述");

    const row = await prisma.questionnaireTemplate.findUnique({
      where: { id: templateId },
      select: { name: true, description: true },
    });
    expect(row?.name).toBe("改名后");
  });

  it("description 传 null 表示清空", async () => {
    const { templateId } = await makeTemplate("清空描述测试");
    await apiRequest(client, "PATCH", `/api/v1/questionnaire-templates/${templateId}`, {
      userId: USERS.admin,
      body: { description: "先有描述" },
    });

    const res = await apiRequest<{ description: string | null }>(
      client,
      "PATCH",
      `/api/v1/questionnaire-templates/${templateId}`,
      { userId: USERS.admin, body: { description: null } }
    );
    expect(expectData<{ description: string | null }>(res).description).toBeNull();
  });

  it("只给 description 不改名称 → 名称保持原样", async () => {
    const { templateId } = await makeTemplate("名称不变测试");

    const res = await apiRequest<{ name: string; description: string }>(
      client,
      "PATCH",
      `/api/v1/questionnaire-templates/${templateId}`,
      { userId: USERS.admin, body: { description: "只改描述" } }
    );
    const data = expectData<{ name: string; description: string }>(res);
    expect(data.name).toBe("名称不变测试");
    expect(data.description).toBe("只改描述");
  });

  it("什么都不给 → 422", async () => {
    const { templateId } = await makeTemplate();
    const res = await apiRequest(
      client,
      "PATCH",
      `/api/v1/questionnaire-templates/${templateId}`,
      { userId: USERS.admin, body: {} }
    );
    expect(res.status).toBe(422);
  });

  it("名称给空串 → 422", async () => {
    const { templateId } = await makeTemplate();
    const res = await apiRequest(
      client,
      "PATCH",
      `/api/v1/questionnaire-templates/${templateId}`,
      { userId: USERS.admin, body: { name: "   " } }
    );
    // zod 的 min(1) 会拦住纯空格之外的空串；纯空格交给 Service 再判一次
    expect([422]).toContain(res.status);
  });

  it("模板不存在 → 404", async () => {
    const res = await apiRequest(
      client,
      "PATCH",
      `/api/v1/questionnaire-templates/${newId()}`,
      { userId: USERS.admin, body: { name: "x" } }
    );
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("TEMPLATE_NOT_FOUND");
  });

  it("非模板管理员 → 403", async () => {
    const { templateId } = await makeTemplate();
    const res = await apiRequest(
      client,
      "PATCH",
      `/api/v1/questionnaire-templates/${templateId}`,
      { userId: USERS.dispatcher, body: { name: "偷改" } }
    );
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe("PERMISSION_DENIED");
  });
});

// ============================================================
// 删除
// ============================================================

describe("删除模板", () => {
  it("删除草稿模板 → 200，且版本一并删除", async () => {
    const { templateId, versionId } = await makeTemplate("待删除模板");

    const res = await apiRequest<{ id: string; deletedVersions: number }>(
      client,
      "DELETE",
      `/api/v1/questionnaire-templates/${templateId}`,
      { userId: USERS.admin }
    );

    expect(res.status).toBe(200);
    expect(expectData<{ deletedVersions: number }>(res).deletedVersions).toBe(1);

    expect(
      await prisma.questionnaireTemplate.findUnique({ where: { id: templateId } })
    ).toBeNull();
    expect(
      await prisma.questionnaireTemplateVersion.findUnique({
        where: { id: versionId },
      })
    ).toBeNull();

    // 已删除，不需要再清理
    createdTemplateIds.delete(templateId);
  });

  it("已发布的模板不能直接删除 → 409（提示先停用）", async () => {
    const { templateId, versionId } = await makeTemplate("已发布模板");
    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions/${versionId}/publish`,
      { userId: USERS.admin }
    );

    const res = await apiRequest(
      client,
      "DELETE",
      `/api/v1/questionnaire-templates/${templateId}`,
      { userId: USERS.admin }
    );

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("INVALID_STATUS_TRANSITION");
    // 错误信息要能指导下一步操作
    expect(res.body.error?.message ?? "").toContain("停用");

    // 确实没删掉
    expect(
      await prisma.questionnaireTemplate.findUnique({ where: { id: templateId } })
    ).not.toBeNull();
  });

  it("版本被案件引用过 → 409，且说明被几个实例引用（关键安全约束）", async () => {
    // 建模板 + 带结构的草稿版本，发布后建一个案件
    const t = await apiRequest<{ id: string }>(
      client,
      "POST",
      "/api/v1/questionnaire-templates",
      { userId: USERS.admin, body: { name: "被引用的模板" } }
    );
    const templateId = expectData<{ id: string }>(t).id;
    createdTemplateIds.add(templateId);

    const v = await apiRequest<{ id: string }>(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions`,
      {
        userId: USERS.admin,
        body: {
          schema: {
            id: newId(),
            title: "被引用的问卷",
            version: 1,
            sections: [
              {
                id: "sec_a",
                title: "分组A",
                order: 1,
                questions: [
                  { id: "q_a", type: "text", title: "题A", required: true, order: 1 },
                ],
              },
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

    // 先用**已发布**的版本建一个案件（只有已发布版本能派生实例）
    const inst = await apiRequest<{ id: string }>(
      client,
      "POST",
      "/api/v1/questionnaire-instances",
      {
        userId: USERS.dispatcher,
        body: { templateVersionId: versionId, title: "引用该模板的案件" },
      }
    );
    createdInstanceIds.add(expectData<{ id: string }>(inst).id);

    // 再停用模板，绕过「已发布不能删」那一层，
    // 专门验证「被案件引用不能删」这条约束本身
    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions/${versionId}/disable`,
      { userId: USERS.admin }
    );

    const res = await apiRequest(
      client,
      "DELETE",
      `/api/v1/questionnaire-templates/${templateId}`,
      { userId: USERS.admin }
    );

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("INVALID_STATUS_TRANSITION");
    expect(res.body.error?.message ?? "").toContain("引用");
    expect(
      (res.body.error?.detail as { usedByInstances?: number })?.usedByInstances
    ).toBe(1);

    // 模板仍在
    expect(
      await prisma.questionnaireTemplate.findUnique({ where: { id: templateId } })
    ).not.toBeNull();
  });

  it("非模板管理员 → 403", async () => {
    const { templateId } = await makeTemplate();
    const res = await apiRequest(
      client,
      "DELETE",
      `/api/v1/questionnaire-templates/${templateId}`,
      { userId: USERS.dispatcher }
    );
    expect(res.status).toBe(403);
  });
});

// ============================================================
// 发布 / 停用的状态一致性
// ============================================================

describe("发布与停用", () => {
  it("发布草稿版本 → 模板变为已发布，currentVersionId 指向它", async () => {
    const { templateId, versionId } = await makeTemplate("发布状态测试");

    const res = await apiRequest<{ status: string }>(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions/${versionId}/publish`,
      { userId: USERS.admin }
    );
    expect(res.status).toBe(200);

    const t = await prisma.questionnaireTemplate.findUnique({
      where: { id: templateId },
      select: { status: true, currentVersionId: true },
    });
    expect(t?.status).toBe("published");
    expect(t?.currentVersionId).toBe(versionId);
  });

  it("停用唯一的已发布版本 → 模板状态同步降为 disabled（回归：曾一直是 published）", async () => {
    // 这是个真实的状态不一致 bug：
    //   disableVersion 原先只把版本置为 disabled 并清空 currentVersionId，
    //   却不改模板 status，于是模板一直显示「已发布」，
    //   但既没有可用版本、又因「已发布不能删」而删不掉 —— 用户被卡死。
    const { templateId, versionId } = await makeTemplate("停用状态测试");

    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions/${versionId}/publish`,
      { userId: USERS.admin }
    );

    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions/${versionId}/disable`,
      { userId: USERS.admin }
    );

    const t = await prisma.questionnaireTemplate.findUnique({
      where: { id: templateId },
      select: { status: true, currentVersionId: true },
    });
    expect(t?.status).toBe("disabled");
    expect(t?.currentVersionId).toBeNull();

    // 状态一致之后，删除就不再被卡住（没有实例引用）
    const del = await apiRequest(
      client,
      "DELETE",
      `/api/v1/questionnaire-templates/${templateId}`,
      { userId: USERS.admin }
    );
    expect(del.status).toBe(200);
    createdTemplateIds.delete(templateId);
  });

  it("停用其中一个版本，但还有其它已发布版本 → 模板仍为已发布", async () => {
    const { templateId, versionId } = await makeTemplate("多版本停用测试");

    // 两个版本都发布
    const v2 = await apiRequest<{ id: string }>(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions`,
      { userId: USERS.admin, body: {} }
    );
    const version2Id = expectData<{ id: string }>(v2).id;

    for (const vid of [versionId, version2Id]) {
      await apiRequest(
        client,
        "POST",
        `/api/v1/questionnaire-templates/${templateId}/versions/${vid}/publish`,
        { userId: USERS.admin }
      );
    }

    // 停用第一个，还有第二个是已发布
    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions/${versionId}/disable`,
      { userId: USERS.admin }
    );

    const t = await prisma.questionnaireTemplate.findUnique({
      where: { id: templateId },
      select: { status: true },
    });
    expect(t?.status).toBe("published");
  });
});
