/**
 * 节点画布坐标接口（`PATCH .../layout`）。
 *
 * 这个接口存在的意义是让节点画布的位置能跨会话保留，
 * 同时**不污染结构**。因此测试要盯住三件事：
 *   1. 坐标能存能读；
 *   2. **结构完全不受影响**（这是它与其它编辑接口的本质区别）；
 *   3. 权限与状态仍然受控（非管理员、已发布版本都要拒绝）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  apiRequest,
  expectData,
  prisma,
  startTestServer,
  type TestHttpClient,
} from "./helpers.js";
import { USERS } from "../questionnaire/helpers.js";

let client: TestHttpClient;
const createdTemplateIds = new Set<string>();
let auditSnapshot: Set<string> = new Set();

async function snapshotAudits(): Promise<void> {
  const rows = await prisma.aiToolExecution.findMany({ select: { id: true } });
  auditSnapshot = new Set(rows.map((r) => r.id));
}

async function cleanup(): Promise<void> {
  for (const id of createdTemplateIds) {
    await prisma.questionnaireTemplate.updateMany({
      where: { id },
      data: { currentVersionId: null },
    });
    await prisma.questionnaireTemplateVersion.deleteMany({ where: { templateId: id } });
    await prisma.questionnaireTemplate.deleteMany({ where: { id } });
  }
  createdTemplateIds.clear();

  const rows = await prisma.aiToolExecution.findMany({ select: { id: true } });
  const fresh = rows.map((r) => r.id).filter((id) => !auditSnapshot.has(id));
  if (fresh.length > 0) {
    await prisma.aiToolExecution.deleteMany({ where: { id: { in: fresh } } });
  }
}

beforeAll(async () => {
  client = await startTestServer();
});
beforeEach(async () => {
  await snapshotAudits();
});
afterEach(async () => {
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  await client.close();
  await prisma.$disconnect();
});

async function buildFixture() {
  const t = await apiRequest<{ id: string }>(
    client,
    "POST",
    "/api/v1/questionnaire-templates",
    { userId: USERS.admin, body: { name: `坐标测试-${Date.now()}` } }
  );
  const templateId = expectData<{ id: string }>(t).id;
  createdTemplateIds.add(templateId);

  const v = await apiRequest<{ id: string }>(
    client,
    "POST",
    `/api/v1/questionnaire-templates/${templateId}/versions`,
    { userId: USERS.admin, body: {} }
  );
  const versionId = expectData<{ id: string }>(v).id;

  const b = `/api/v1/questionnaire-templates/${templateId}/versions/${versionId}`;
  const sec = await apiRequest<{ section: { id: string } }>(
    client,
    "POST",
    `${b}/sections`,
    { userId: USERS.admin, body: { title: "基本情况" } }
  );
  const sectionId = expectData<{ section: { id: string } }>(sec).section.id;

  const mk = async (title: string, type: string) =>
    expectData<{ question: { id: string } }>(
      await apiRequest(client, "POST", `${b}/questions`, {
        userId: USERS.admin,
        body: { sectionId, type, title, required: false },
      })
    ).question.id;

  const ids = {
    a: await mk("第一题", "text"),
    b: await mk("第二题", "boolean"),
  };

  return { templateId, versionId, base: b, ids };
}

async function readSchema(templateId: string, versionId: string) {
  const res = await apiRequest<{ schema: Record<string, unknown> }>(
    client,
    "GET",
    `/api/v1/questionnaire-templates/${templateId}/versions/${versionId}`,
    { userId: USERS.admin }
  );
  return expectData<{ schema: Record<string, unknown> }>(res).schema;
}

describe("保存节点坐标", () => {
  it("写入后能读回，并且**结构完全不变**", async () => {
    const fx = await buildFixture();
    const before = await readSchema(fx.templateId, fx.versionId);

    const res = await apiRequest(
      client,
      "PATCH",
      `${fx.base}/layout`,
      {
        userId: USERS.admin,
        body: { positions: { [fx.ids.a]: { x: 120, y: 40 } } },
      }
    );
    expect(res.status, JSON.stringify(res.body.error)).toBe(200);

    const after = await readSchema(fx.templateId, fx.versionId);

    // 坐标写进去了
    expect(after["layout"]).toEqual({ [fx.ids.a]: { x: 120, y: 40 } });
    // 结构一字未改（这是本接口与其它编辑接口的本质区别）
    expect(after["sections"]).toEqual(before["sections"]);
    expect(after["title"]).toBe(before["title"]);
  });

  it("分两次保存不同节点 → 合并而不是覆盖", async () => {
    const fx = await buildFixture();

    await apiRequest(client, "PATCH", `${fx.base}/layout`, {
      userId: USERS.admin,
      body: { positions: { [fx.ids.a]: { x: 10, y: 10 } } },
    });
    await apiRequest(client, "PATCH", `${fx.base}/layout`, {
      userId: USERS.admin,
      body: { positions: { [fx.ids.b]: { x: 200, y: 300 } } },
    });

    const schema = await readSchema(fx.templateId, fx.versionId);
    expect(schema["layout"]).toEqual({
      [fx.ids.a]: { x: 10, y: 10 },
      [fx.ids.b]: { x: 200, y: 300 },
    });
  });

  it("坐标不会产生审计（拖节点不是工具调用）", async () => {
    const fx = await buildFixture();
    const before = await prisma.aiToolExecution.count();

    await apiRequest(client, "PATCH", `${fx.base}/layout`, {
      userId: USERS.admin,
      body: { positions: { [fx.ids.a]: { x: 1, y: 2 } } },
    });

    expect(await prisma.aiToolExecution.count()).toBe(before);
  });

  it("删掉题目后再保存坐标 → 该题的坐标被清掉（不留幽灵）", async () => {
    const fx = await buildFixture();

    await apiRequest(client, "PATCH", `${fx.base}/layout`, {
      userId: USERS.admin,
      body: { positions: { [fx.ids.a]: { x: 1, y: 2 } } },
    });
    await apiRequest(client, "DELETE", `${fx.base}/questions/${fx.ids.a}`, {
      userId: USERS.admin,
    });

    // 再存一次（哪怕只存另一个节点），被删题目的坐标应被剔除
    await apiRequest(client, "PATCH", `${fx.base}/layout`, {
      userId: USERS.admin,
      body: { positions: { [fx.ids.b]: { x: 7, y: 8 } } },
    });

    const schema = await readSchema(fx.templateId, fx.versionId);
    expect(schema["layout"]).toEqual({ [fx.ids.b]: { x: 7, y: 8 } });
  });

  it("**纵向授权**：dispatcher 不能改模板坐标 → 403", async () => {
    const fx = await buildFixture();
    const res = await apiRequest(client, "PATCH", `${fx.base}/layout`, {
      userId: USERS.dispatcher,
      body: { positions: { [fx.ids.a]: { x: 1, y: 1 } } },
    });
    expect(res.status).toBe(403);
  });

  it("已发布的版本不能改坐标（只读）", async () => {
    const fx = await buildFixture();

    const pub = await apiRequest(
      client,
      "POST",
      `${fx.base}/publish`,
      { userId: USERS.admin, body: {} }
    );
    expect(pub.status, JSON.stringify(pub.body.error)).toBe(200);

    const res = await apiRequest(client, "PATCH", `${fx.base}/layout`, {
      userId: USERS.admin,
      body: { positions: { [fx.ids.a]: { x: 1, y: 1 } } },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("坐标不是数字 → 422", async () => {
    const fx = await buildFixture();
    const res = await apiRequest(client, "PATCH", `${fx.base}/layout`, {
      userId: USERS.admin,
      body: { positions: { [fx.ids.a]: { x: "abc", y: 1 } } },
    });
    expect(res.status).toBe(422);
  });
});
