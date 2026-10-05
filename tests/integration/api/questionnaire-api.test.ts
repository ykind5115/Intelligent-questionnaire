/**
 * 问卷模板与实例 API 集成测试。
 *
 * 走真实 HTTP 链路（express + 中间件 + 路由 + Service + 数据库），
 * 验证：状态码、统一响应结构、权限、错误码映射、以及关键业务规则。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  apiRequest,
  expectData,
  prisma,
  startTestServer,
  type TestHttpClient,
} from "./helpers.js";
import { USERS } from "../questionnaire/helpers.js";
import { newId } from "../../../src/shared/utils/id.js";

let client: TestHttpClient;

/** 本文件创建的模板与实例，测试后清理 */
const createdTemplateIds = new Set<string>();
const createdVersionIds = new Set<string>();
const createdInstanceIds = new Set<string>();

async function cleanup(): Promise<void> {
  for (const id of createdInstanceIds) {
    await prisma.aiToolExecution.deleteMany({
      where: { questionnaireInstanceId: id },
    });
    await prisma.questionnaireRevision.deleteMany({
      where: { questionnaireInstanceId: id },
    });
    // 模板版本可能引用实例（扶正来源），先断开该引用
    await prisma.questionnaireTemplateVersion.updateMany({
      where: { sourceInstanceId: id },
      data: { sourceInstanceId: null },
    });
    await prisma.questionnaireInstance.deleteMany({ where: { id } });
  }
  createdInstanceIds.clear();

  for (const id of createdVersionIds) {
    await prisma.questionnaireTemplate.updateMany({
      where: { currentVersionId: id },
      data: { currentVersionId: null },
    });
    await prisma.questionnaireTemplateVersion.deleteMany({ where: { id } });
  }
  createdVersionIds.clear();

  for (const id of createdTemplateIds) {
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

// ============================================================
// 健康检查与鉴权
// ============================================================

describe("基础中间件", () => {
  it("GET /healthz 返回 200 且 db=up", async () => {
    const res = await apiRequest<{ db: string; model: string }>(client, "GET", "/healthz");
    expect(res.status).toBe(200);
    const data = expectData<{ db: string; model: string }>(res);
    expect(data.db).toBe("up");
    expect(data.model).toBe("deepseek-v41-flash");
  });

  it("GET /api/v1/me 返回当前用户与角色", async () => {
    const res = await apiRequest<{ username: string; roles: string[] }>(client, "GET", "/api/v1/me", {
      userId: USERS.admin,
    });
    expect(res.status).toBe(200);
    const data = expectData<{ username: string; roles: string[] }>(res);
    expect(data.username).toBe("admin");
    expect(data.roles).toContain("template_admin");
  });

  it("未知用户 id 返回 401", async () => {
    const res = await apiRequest<{ username: string; roles: string[] }>(client, "GET", "/api/v1/me", {
      userId: "not-a-uuid",
    });
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe("UNAUTHORIZED");
  });

  it("未知路径返回 404 且带统一错误结构", async () => {
    const res = await apiRequest(client, "GET", "/api/v1/nope");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe("NOT_FOUND");
  });

  it("成功响应带 requestId（便于日志关联）", async () => {
    const res = await apiRequest<{ username: string; roles: string[] }>(client, "GET", "/api/v1/me", {
      userId: USERS.admin,
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.requestId).toBe("string");
    expect(res.body.requestId).toBeTruthy();
  });
});

// ============================================================
// 模板 API
// ============================================================

describe("POST /api/v1/questionnaire-templates", () => {
  it("template_admin 创建模板返回 201", async () => {
    const res = await apiRequest<{ id: string; name: string; status: string }>(client, "POST", "/api/v1/questionnaire-templates", {
      userId: USERS.admin,
      body: { name: "测试模板-创建", description: "集成测试" },
    });

    expect(res.status).toBe(201);
    const data = expectData<{ id: string; name: string; status: string }>(res);
    createdTemplateIds.add(data.id);

    expect(data.name).toBe("测试模板-创建");
    // 新模板默认是 draft（未发布）
    expect(data.status).toBe("draft");
  });

  it("缺少 name 返回 422", async () => {
    const res = await apiRequest<{ id: string; name: string; status: string }>(client, "POST", "/api/v1/questionnaire-templates", {
      userId: USERS.admin,
      body: { description: "没有名字" },
    });

    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("VALIDATION_ERROR");
  });

  it("非 template_admin 返回 403", async () => {
    const res = await apiRequest<{ id: string; name: string; status: string }>(client, "POST", "/api/v1/questionnaire-templates", {
      userId: USERS.dispatcher,
      body: { name: "不该创建成功" },
    });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe("PERMISSION_DENIED");
  });
});

describe("模板版本 API", () => {
  /** 建一个模板，返回 id */
  async function createTemplate(name: string): Promise<string> {
    const res = await apiRequest<{ id: string; name: string; status: string }>(client, "POST", "/api/v1/questionnaire-templates", {
      userId: USERS.admin,
      body: { name },
    });
    const data = expectData<{ id: string }>(res);
    createdTemplateIds.add(data.id);
    return data.id;
  }

  it("创建版本 → 发布 → 版本列表", async () => {
    const templateId = await createTemplate("测试模板-版本流转");

    // 创建版本（不传 schema，后端生成空问卷）
    const createRes = await apiRequest<{ id: string; versionNo: number; status: string }>(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions`,
      {
        userId: USERS.admin,
        body: { changeNote: "初始版本" },
      }
    );
    expect(createRes.status).toBe(201);
    const version = expectData<{ id: string; versionNo: number; status: string }>(
      createRes
    );
    createdVersionIds.add(version.id);
    expect(version.versionNo).toBe(1);
    expect(version.status).toBe("draft");

    // 发布
    const publishRes = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions/${version.id}/publish`,
      { userId: USERS.admin }
    );
    expect(publishRes.status).toBe(200);
    const published = expectData<{ status: string }>(publishRes);
    expect(published.status).toBe("published");

    // 列表里能看到
    const listRes = await apiRequest(
      client,
      "GET",
      `/api/v1/questionnaire-templates/${templateId}/versions`,
      { userId: USERS.admin }
    );
    const list = expectData<{ items: { id: string; status: string }[] }>(listRes);
    expect(list.items.some((v) => v.id === version.id)).toBe(true);
  });

  it("传非法 schema 创建版本返回 422", async () => {
    const templateId = await createTemplate("测试模板-非法schema");

    const res = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions`,
      {
        userId: USERS.admin,
        body: {
          schema: {
            id: "s1",
            title: "非法问卷",
            version: 1,
            // 选择题缺少 options，应被 Schema 拒绝
            sections: [
              {
                id: "sec1",
                title: "A",
                order: 1,
                questions: [
                  {
                    id: "q1",
                    type: "single_choice",
                    title: "单选题",
                    required: true,
                    order: 1,
                  },
                ],
              },
            ],
          },
        },
      }
    );

    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("VALIDATION_ERROR");
  });

  it("重复发布同一版本返回 409", async () => {
    const templateId = await createTemplate("测试模板-重复发布");

    const createRes = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions`,
      { userId: USERS.admin, body: {} }
    );
    const version = expectData<{ id: string }>(createRes);
    createdVersionIds.add(version.id);

    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions/${version.id}/publish`,
      { userId: USERS.admin }
    );

    const again = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions/${version.id}/publish`,
      { userId: USERS.admin }
    );
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("模板不存在返回 404", async () => {
    const res = await apiRequest(
      client,
      "GET",
      `/api/v1/questionnaire-templates/${newId()}/versions`,
      { userId: USERS.admin }
    );
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("TEMPLATE_NOT_FOUND");
  });
});

// ============================================================
// 实例 API
// ============================================================

describe("问卷实例 API", () => {
  /** 建一个「已发布版本」的模板，返回版本 id */
  async function createPublishedVersion(
    name: string
  ): Promise<{ templateId: string; versionId: string }> {
    const templateRes = await apiRequest(
      client,
      "POST",
      "/api/v1/questionnaire-templates",
      { userId: USERS.admin, body: { name } }
    );
    const template = expectData<{ id: string }>(templateRes);
    createdTemplateIds.add(template.id);

    const versionRes = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${template.id}/versions`,
      {
        userId: USERS.admin,
        body: {
          changeNote: "含内容的版本",
          schema: {
            id: newId(),
            title: name,
            version: 1,
            sections: [
              {
                id: "sec_basic",
                title: "基本信息",
                order: 1,
                questions: [
                  {
                    id: "q_name",
                    type: "text",
                    title: "姓名",
                    required: true,
                    order: 1,
                  },
                ],
              },
            ],
          },
        },
      }
    );
    const version = expectData<{ id: string }>(versionRes);
    createdVersionIds.add(version.id);

    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${template.id}/versions/${version.id}/publish`,
      { userId: USERS.admin }
    );

    return { templateId: template.id, versionId: version.id };
  }

  it("创建实例：克隆 schema 并生成 Revision 1", async () => {
    const { templateId, versionId } = await createPublishedVersion(
      "测试模板-实例创建"
    );

    const res = await apiRequest<{ id: string; currentRevision: number; status: string; currentSchema: { id: string; sections: unknown[] }; subjectInfo?: Record<string, unknown> }>(client, "POST", "/api/v1/questionnaire-instances", {
      userId: USERS.dispatcher,
      body: {
        templateVersionId: versionId,
        title: "张三 - 测试核查",
        subjectInfo: { name: "张三" },
      },
    });

    expect(res.status).toBe(201);
    const instance = expectData<{
      id: string;
      currentRevision: number;
      status: string;
      currentSchema: { id: string; sections: unknown[] };
      subjectInfo?: Record<string, unknown>;
    }>(res);
    createdInstanceIds.add(instance.id);

    expect(instance.currentRevision).toBe(1);
    expect(instance.status).toBe("draft");
    expect(instance.currentSchema.sections).toHaveLength(1);
    expect(instance.subjectInfo?.["name"]).toBe("张三");

    // 实例结构是从模板克隆的，但换了新的 schema id
    const versionRes = await apiRequest(
      client,
      "GET",
      `/api/v1/questionnaire-templates/${templateId}/versions/${versionId}`,
      { userId: USERS.admin }
    );
    const version = expectData<{ schema: { id: string } }>(versionRes);
    expect(instance.currentSchema.id).not.toBe(version.schema.id);

    // Revision 1 已写入
    const revRes = await apiRequest(
      client,
      "GET",
      `/api/v1/questionnaire-instances/${instance.id}/revisions`,
      { userId: USERS.dispatcher }
    );
    const revisions = expectData<{
      items: { revisionNo: number; operationType: string }[];
    }>(revRes);
    expect(revisions.items).toHaveLength(1);
    expect(revisions.items[0]?.revisionNo).toBe(1);
    expect(revisions.items[0]?.operationType).toBe("create_instance");
  });

  it("用未发布的版本创建实例返回 409", async () => {
    const templateRes = await apiRequest(
      client,
      "POST",
      "/api/v1/questionnaire-templates",
      { userId: USERS.admin, body: { name: "测试模板-未发布" } }
    );
    const template = expectData<{ id: string }>(templateRes);
    createdTemplateIds.add(template.id);

    const versionRes = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${template.id}/versions`,
      { userId: USERS.admin, body: {} }
    );
    const version = expectData<{ id: string }>(versionRes);
    createdVersionIds.add(version.id);

    const res = await apiRequest<{ id: string; currentRevision: number; status: string; currentSchema: { id: string; sections: unknown[] }; subjectInfo?: Record<string, unknown> }>(client, "POST", "/api/v1/questionnaire-instances", {
      userId: USERS.dispatcher,
      body: { templateVersionId: version.id, title: "不该创建成功" },
    });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("实例详情可读；investigator 也能读", async () => {
    const { versionId } = await createPublishedVersion("测试模板-实例详情");

    const createRes = await apiRequest(
      client,
      "POST",
      "/api/v1/questionnaire-instances",
      {
        userId: USERS.dispatcher,
        body: { templateVersionId: versionId, title: "李四 - 测试" },
      }
    );
    const instance = expectData<{ id: string }>(createRes);
    createdInstanceIds.add(instance.id);

    const res = await apiRequest(
      client,
      "GET",
      `/api/v1/questionnaire-instances/${instance.id}`,
      { userId: USERS.investigator }
    );
    expect(res.status).toBe(200);
    const data = expectData<{ id: string; title: string }>(res);
    expect(data.title).toBe("李四 - 测试");
  });

  it("实例不存在返回 404", async () => {
    const res = await apiRequest(
      client,
      "GET",
      `/api/v1/questionnaire-instances/${newId()}`,
      { userId: USERS.dispatcher }
    );
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("QUESTIONNAIRE_NOT_FOUND");
  });

  it("指定修订快照可读", async () => {
    const { versionId } = await createPublishedVersion("测试模板-修订快照");

    const createRes = await apiRequest(
      client,
      "POST",
      "/api/v1/questionnaire-instances",
      {
        userId: USERS.dispatcher,
        body: { templateVersionId: versionId, title: "王五 - 测试" },
      }
    );
    const instance = expectData<{ id: string }>(createRes);
    createdInstanceIds.add(instance.id);

    const res = await apiRequest(
      client,
      "GET",
      `/api/v1/questionnaire-instances/${instance.id}/revisions/1`,
      { userId: USERS.dispatcher }
    );
    expect(res.status).toBe(200);
    const data = expectData<{ revisionNo: number; schema: { sections: unknown[] } }>(
      res
    );
    expect(data.revisionNo).toBe(1);
    expect(data.schema.sections).toHaveLength(1);
  });
});

// ============================================================
// 确认 / 撤回 / 扶正
// ============================================================

describe("实例状态流转 API", () => {
  /** 建一个实例，返回 id */
  async function makeInstance(): Promise<string> {
    const templateRes = await apiRequest(
      client,
      "POST",
      "/api/v1/questionnaire-templates",
      { userId: USERS.admin, body: { name: "测试模板-状态流转" } }
    );
    const template = expectData<{ id: string }>(templateRes);
    createdTemplateIds.add(template.id);

    const versionRes = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${template.id}/versions`,
      {
        userId: USERS.admin,
        body: {
          changeNote: "v1",
          schema: {
            id: newId(),
            title: "状态流转测试",
            version: 1,
            sections: [
              {
                id: "sec_a",
                title: "分组A",
                order: 1,
                questions: [
                  {
                    id: "q1",
                    type: "text",
                    title: "问题一",
                    required: true,
                    order: 1,
                  },
                ],
              },
            ],
          },
        },
      }
    );
    const version = expectData<{ id: string }>(versionRes);
    createdVersionIds.add(version.id);

    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${template.id}/versions/${version.id}/publish`,
      { userId: USERS.admin }
    );

    const createRes = await apiRequest(
      client,
      "POST",
      "/api/v1/questionnaire-instances",
      {
        userId: USERS.dispatcher,
        body: { templateVersionId: version.id, title: "状态流转实例" },
      }
    );
    const instance = expectData<{ id: string }>(createRes);
    createdInstanceIds.add(instance.id);
    return instance.id;
  }

  it("confirm：draft → confirmed", async () => {
    const instanceId = await makeInstance();

    const res = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${instanceId}/confirm`,
      { userId: USERS.dispatcher }
    );

    expect(res.status).toBe(200);
    const data = expectData<{ status: string }>(res);
    expect(data.status).toBe("confirmed");
  });

  it("重复 confirm 返回 409", async () => {
    const instanceId = await makeInstance();

    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${instanceId}/confirm`,
      { userId: USERS.dispatcher }
    );

    const again = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${instanceId}/confirm`,
      { userId: USERS.dispatcher }
    );
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("withdraw：已下发 → draft（决策 D1）", async () => {
    const instanceId = await makeInstance();

    // 直接改库模拟已下发（下发 API 由另一模块负责）
    await prisma.questionnaireInstance.update({
      where: { id: instanceId },
      data: { status: "dispatched" },
    });

    const res = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${instanceId}/withdraw`,
      { userId: USERS.dispatcher, body: { reason: "需要增加团伙调查" } }
    );

    expect(res.status).toBe(200);
    const data = expectData<{ status: string }>(res);
    expect(data.status).toBe("draft");
  });

  it("draft 状态撤回返回 409 WITHDRAW_NOT_ALLOWED", async () => {
    const instanceId = await makeInstance();

    const res = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${instanceId}/withdraw`,
      { userId: USERS.dispatcher }
    );

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("WITHDRAW_NOT_ALLOWED");
  });

  it("promote：实例扶正为模板草稿版本（决策 D2）", async () => {
    const instanceId = await makeInstance();

    const res = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${instanceId}/promote`,
      { userId: USERS.admin, body: { changeNote: "由实例扶正" } }
    );

    expect(res.status).toBe(201);
    const data = expectData<{
      templateId: string;
      templateVersionId: string;
      versionNo: number;
      status: string;
    }>(res);

    // 扶正产生的是 draft 版本，不是直接发布
    expect(data.status).toBe("draft");
    expect(data.versionNo).toBe(2);

    const version = await prisma.questionnaireTemplateVersion.findUnique({
      where: { id: data.templateVersionId },
    });
    expect(version?.sourceType).toBe("promoted_from_instance");
    expect(version?.sourceInstanceId).toBe(instanceId);
  });

  it("已下发实例不能扶正（409 PROMOTE_NOT_ALLOWED）", async () => {
    const instanceId = await makeInstance();
    await prisma.questionnaireInstance.update({
      where: { id: instanceId },
      data: { status: "dispatched" },
    });

    const res = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${instanceId}/promote`,
      { userId: USERS.admin }
    );

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("PROMOTE_NOT_ALLOWED");
  });

  it("非模板管理员扶正返回 403", async () => {
    const instanceId = await makeInstance();

    const res = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${instanceId}/promote`,
      { userId: USERS.investigator }
    );

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe("PERMISSION_DENIED");
  });
});
