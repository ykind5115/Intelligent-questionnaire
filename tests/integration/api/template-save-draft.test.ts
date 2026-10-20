/**
 * 「保存为草稿」接口（`POST .../save-draft`）。
 *
 * 背景：`commitDraftVersion` 原先只被 AI 的 commit 调用，
 * 纯手工编辑的模板没有任何定稿动作 —— 内容其实每次操作都已落库，
 * 但用户没有「确认名称 / 写变更说明」的地方，也拿不到「结构非空」这道校验。
 *
 * 这个测试盯住：定稿能落名称与说明、空问卷被拒、权限与状态受控、
 * 以及「版本不属于该模板」这种 URL 与内容不一致的情况。
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

/** 建一个模板 + 草稿版本；withQuestion 决定是否给一道题 */
async function buildFixture(options: { withQuestion?: boolean } = {}) {
  const t = await apiRequest<{ id: string }>(
    client,
    "POST",
    "/api/v1/questionnaire-templates",
    { userId: USERS.admin, body: { name: `定稿测试-${Date.now()}` } }
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

  const base = `/api/v1/questionnaire-templates/${templateId}/versions/${versionId}`;

  if (options.withQuestion !== false) {
    const sec = await apiRequest<{ section: { id: string } }>(
      client,
      "POST",
      `${base}/sections`,
      { userId: USERS.admin, body: { title: "基本情况" } }
    );
    const sectionId = expectData<{ section: { id: string } }>(sec).section.id;
    await apiRequest(client, "POST", `${base}/questions`, {
      userId: USERS.admin,
      body: { sectionId, type: "text", title: "姓名", required: false },
    });
  }

  return { templateId, versionId, base };
}

describe("保存为草稿", () => {
  it("写入名称与变更说明，模板名随之更新", async () => {
    const fx = await buildFixture();

    const res = await apiRequest<{
      templateId: string;
      templateVersionId: string;
      versionNo: number;
      status: string;
    }>(client, "POST", `${fx.base}/save-draft`, {
      userId: USERS.admin,
      body: { name: "正式名称", changeNote: "第一次定稿" },
    });

    const data = expectData<{ templateVersionId: string; status: string }>(res);
    expect(data.templateVersionId).toBe(fx.versionId);
    expect(data.status).toBe("draft");

    const t = await prisma.questionnaireTemplate.findUniqueOrThrow({
      where: { id: fx.templateId },
      select: { name: true },
    });
    expect(t.name).toBe("正式名称");

    const v = await prisma.questionnaireTemplateVersion.findUniqueOrThrow({
      where: { id: fx.versionId },
      select: { changeNote: true, status: true },
    });
    expect(v.changeNote).toBe("第一次定稿");
    // 定稿不等于发布
    expect(v.status).toBe("draft");
  });

  it("**空问卷不能定稿** → 422（避免模板库里多出空模板）", async () => {
    const fx = await buildFixture({ withQuestion: false });

    const res = await apiRequest(client, "POST", `${fx.base}/save-draft`, {
      userId: USERS.admin,
      body: { name: "空问卷" },
    });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error)).toMatch(/空|至少/);
  });

  it("**纵向授权**：dispatcher 不能定稿模板 → 403", async () => {
    const fx = await buildFixture();
    const res = await apiRequest(client, "POST", `${fx.base}/save-draft`, {
      userId: USERS.dispatcher,
      body: { name: "改名" },
    });
    expect(res.status).toBe(403);
  });

  it("已发布的版本不能再定稿", async () => {
    const fx = await buildFixture();

    const pub = await apiRequest(client, "POST", `${fx.base}/publish`, {
      userId: USERS.admin,
      body: {},
    });
    expect(pub.status, JSON.stringify(pub.body.error)).toBe(200);

    const res = await apiRequest(client, "POST", `${fx.base}/save-draft`, {
      userId: USERS.admin,
      body: { name: "发布后改名" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("**版本不属于该模板** → 400（URL 与内容必须一致）", async () => {
    const a = await buildFixture();
    const b = await buildFixture();

    // 用 A 的 templateId 拼上 B 的 versionId
    const res = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${a.templateId}/versions/${b.versionId}/save-draft`,
      { userId: USERS.admin, body: { name: "错配" } }
    );
    expect(res.status).toBe(400);
  });

  it("名称留空 → 422（请求体校验）", async () => {
    const fx = await buildFixture();
    const res = await apiRequest(client, "POST", `${fx.base}/save-draft`, {
      userId: USERS.admin,
      body: { name: "   " },
    });
    expect(res.status).toBe(422);
  });
});
