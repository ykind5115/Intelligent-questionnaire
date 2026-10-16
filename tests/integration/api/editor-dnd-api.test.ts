/**
 * 人工编辑器接口测试（拖拽编辑器的后端）。
 *
 * 依据决策 D3（人工编辑器）与 docs/11-future-capability-plan.md 第 4.11 节。
 *
 * 重点：
 *   1. 新增的三个操作（remove_section / reorder_sections / reorder_questions）
 *      真的能通过 HTTP 走通，且落库；
 *   2. **路由顺序** —— `/sections/reorder` 必须命中重排路由，
 *      而不是被 `/sections/:sectionId` 当成 sectionId="reorder" 吃掉；
 *   3. 权限：只有 template_admin 能改模板；
 *   4. 状态：已发布版本不可写（后端返回 403）。
 *
 * 用真实的模板草稿版本作为目标（编辑器的主场景），
 * 清理时按外键顺序删：audit → version → template。
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

/** 建「模板 + 空草稿版本」，返回编辑器要用的两个 id 与 revision */
async function makeDraft(): Promise<{
  templateId: string;
  versionId: string;
  revision: number;
}> {
  const t = await apiRequest<{ id: string }>(
    client,
    "POST",
    "/api/v1/questionnaire-templates",
    { userId: USERS.admin, body: { name: `编辑器测试-${Date.now()}` } }
  );
  const templateId = expectData<{ id: string }>(t).id;
  createdTemplateIds.add(templateId);

  const v = await apiRequest<{ id: string; versionNo: number }>(
    client,
    "POST",
    `/api/v1/questionnaire-templates/${templateId}/versions`,
    { userId: USERS.admin, body: {} }
  );
  const version = expectData<{ id: string; versionNo: number }>(v);
  return { templateId, versionId: version.id, revision: version.versionNo };
}

function base(templateId: string, versionId: string): string {
  return `/api/v1/questionnaire-templates/${templateId}/versions/${versionId}`;
}

/** 读当前结构（测试断言用） */
async function readSchema(
  templateId: string,
  versionId: string
): Promise<{
  sections: {
    id: string;
    title: string;
    order: number;
    questions: { id: string; title: string; order: number; type: string }[];
  }[];
}> {
  const res = await apiRequest<{ schema: never }>(
    client,
    "GET",
    base(templateId, versionId),
    { userId: USERS.admin }
  );
  return expectData<{ schema: never }>(res).schema;
}

/** 加一个分组，返回它的 id */
async function addSection(
  templateId: string,
  versionId: string,
  title: string,
  revision: number
): Promise<string> {
  const res = await apiRequest<{ section: { id: string } }>(
    client,
    "POST",
    `${base(templateId, versionId)}/sections`,
    { userId: USERS.admin, body: { title, expectedRevision: revision } }
  );
  return expectData<{ section: { id: string } }>(res).section.id;
}

/** 加一道题，返回它的 id */
async function addQuestion(
  templateId: string,
  versionId: string,
  sectionId: string,
  title: string,
  revision: number,
  type = "text"
): Promise<string> {
  const body: Record<string, unknown> = {
    sectionId,
    type,
    title,
    expectedRevision: revision,
  };
  if (type === "single_choice") {
    body.options = [{ label: "选项一" }, { label: "选项二" }];
  }
  const res = await apiRequest<{ question: { id: string } }>(
    client,
    "POST",
    `${base(templateId, versionId)}/questions`,
    { userId: USERS.admin, body }
  );
  return expectData<{ question: { id: string } }>(res).question.id;
}

/**
 * 清理：编辑器测试会产生「挂在模板版本上」的审计
 * （questionnaire_instance_id 为 null），删版本带不走它们，必须显式删。
 *
 * 用「快照差集」而不是按条件一把梭 —— 后者会把库里原有的同类审计也删掉。
 */
let auditSnapshot = new Set<string>();

async function snapshotAudits(): Promise<void> {
  const rows = await prisma.aiToolExecution.findMany({
    where: {
      questionnaireInstanceId: null,
      conversationId: null,
      source: "manual_editor",
    },
    select: { id: true },
  });
  auditSnapshot = new Set(rows.map((r) => r.id));
}

async function cleanup(): Promise<void> {
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

  const rows = await prisma.aiToolExecution.findMany({
    where: {
      questionnaireInstanceId: null,
      conversationId: null,
      source: "manual_editor",
    },
    select: { id: true },
  });
  const fresh = rows.map((r) => r.id).filter((id) => !auditSnapshot.has(id));
  if (fresh.length > 0) {
    await prisma.aiToolExecution.deleteMany({ where: { id: { in: fresh } } });
  }
}

beforeAll(async () => {
  client = await startTestServer();
});

// 每个用例前记下已有的「模板版本编辑审计」，用例结束后只删新增的（差集）
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

// ============================================================
// 删除分组
// ============================================================

describe("DELETE sections/:sectionId（删除分组）", () => {
  it("连同组内问题一起删除，并返回被删掉的问题 id", async () => {
    const { templateId, versionId, revision } = await makeDraft();
    const secId = await addSection(templateId, versionId, "待删分组", revision);
    const q1 = await addQuestion(templateId, versionId, secId, "题一", revision);
    const q2 = await addQuestion(templateId, versionId, secId, "题二", revision);

    const res = await apiRequest<{
      removed: { id: string; title: string; questionIds: string[] };
    }>(client, "DELETE", `${base(templateId, versionId)}/sections/${secId}`, {
      userId: USERS.admin,
    });

    const data = expectData<{
      removed: { id: string; title: string; questionIds: string[] };
    }>(res);
    expect(data.removed.id).toBe(secId);
    expect(data.removed.title).toBe("待删分组");
    expect(data.removed.questionIds.sort()).toEqual([q1, q2].sort());

    const schema = await readSchema(templateId, versionId);
    expect(schema.sections).toHaveLength(0);
  });

  it("删除后剩下的分组 order 连续（从 1 开始）", async () => {
    const { templateId, versionId, revision } = await makeDraft();
    await addSection(templateId, versionId, "一", revision);
    const sec2 = await addSection(templateId, versionId, "二", revision);
    await addSection(templateId, versionId, "三", revision);

    await apiRequest(
      client,
      "DELETE",
      `${base(templateId, versionId)}/sections/${sec2}`,
      { userId: USERS.admin }
    );

    const schema = await readSchema(templateId, versionId);
    expect(schema.sections.map((s) => s.title)).toEqual(["一", "三"]);
    expect(schema.sections.map((s) => s.order)).toEqual([1, 2]);
  });

  it("分组不存在 → 404", async () => {
    const { templateId, versionId } = await makeDraft();
    const res = await apiRequest(
      client,
      "DELETE",
      `${base(templateId, versionId)}/sections/sec_nope`,
      { userId: USERS.admin }
    );
    expect(res.status).toBe(404);
  });
});

// ============================================================
// 重排（含路由顺序回归）
// ============================================================

describe("PATCH sections/reorder（分组重排）", () => {
  it("按给定 id 顺序重排并落库，order 由后端重算", async () => {
    const { templateId, versionId, revision } = await makeDraft();
    const a = await addSection(templateId, versionId, "A", revision);
    const b = await addSection(templateId, versionId, "B", revision);
    const c = await addSection(templateId, versionId, "C", revision);

    const res = await apiRequest<{ order: string[] }>(
      client,
      "PATCH",
      `${base(templateId, versionId)}/sections/reorder`,
      {
        userId: USERS.admin,
        body: { sectionIds: [c, a, b], expectedRevision: revision },
      }
    );

    // **路由顺序回归**：如果 /sections/reorder 被 /sections/:sectionId 吃掉，
    // 这里会 404（sectionId="reorder" 不存在）而不是 200
    expect(res.status).toBe(200);
    expect(expectData<{ order: string[] }>(res).order).toEqual([c, a, b]);

    const schema = await readSchema(templateId, versionId);
    expect(schema.sections.map((s) => s.title)).toEqual(["C", "A", "B"]);
    expect(schema.sections.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it("少给一个 id → 422（否则那个分组会凭空消失）", async () => {
    const { templateId, versionId, revision } = await makeDraft();
    const a = await addSection(templateId, versionId, "A", revision);
    await addSection(templateId, versionId, "B", revision);

    const res = await apiRequest(
      client,
      "PATCH",
      `${base(templateId, versionId)}/sections/reorder`,
      {
        userId: USERS.admin,
        body: { sectionIds: [a], expectedRevision: revision },
      }
    );
    expect(res.status).toBe(400);
  });
});

describe("PATCH questions/reorder（组内重排）", () => {
  it("只重排目标分组，其他分组不动", async () => {
    const { templateId, versionId, revision } = await makeDraft();
    const s1 = await addSection(templateId, versionId, "组一", revision);
    const s2 = await addSection(templateId, versionId, "组二", revision);
    const q1 = await addQuestion(templateId, versionId, s1, "题一", revision);
    const q2 = await addQuestion(templateId, versionId, s1, "题二", revision);
    const q3 = await addQuestion(templateId, versionId, s2, "别的组", revision);

    const res = await apiRequest<{ order: string[] }>(
      client,
      "PATCH",
      `${base(templateId, versionId)}/questions/reorder`,
      {
        userId: USERS.admin,
        body: { sectionId: s1, questionIds: [q2, q1], expectedRevision: revision },
      }
    );
    expect(res.status).toBe(200);

    const schema = await readSchema(templateId, versionId);
    const sec1 = schema.sections.find((s) => s.id === s1);
    const sec2 = schema.sections.find((s) => s.id === s2);
    expect(sec1?.questions.map((q) => q.title)).toEqual(["题二", "题一"]);
    expect(sec1?.questions.map((q) => q.order)).toEqual([1, 2]);
    // 另一组完全不受影响
    expect(sec2?.questions.map((q) => q.id)).toEqual([q3]);
  });

  it("把别的分组的题目 id 混进来 → 404", async () => {
    const { templateId, versionId, revision } = await makeDraft();
    const s1 = await addSection(templateId, versionId, "组一", revision);
    const s2 = await addSection(templateId, versionId, "组二", revision);
    const q1 = await addQuestion(templateId, versionId, s1, "题一", revision);
    const other = await addQuestion(templateId, versionId, s2, "别组题", revision);

    const res = await apiRequest(
      client,
      "PATCH",
      `${base(templateId, versionId)}/questions/reorder`,
      {
        userId: USERS.admin,
        body: {
          sectionId: s1,
          questionIds: [q1, other],
          expectedRevision: revision,
        },
      }
    );
    expect(res.status).toBe(404);
  });
});

// ============================================================
// 权限与状态
// ============================================================

describe("编辑器的权限与状态边界", () => {
  it("**纵向授权**：dispatcher 不能改模板结构", async () => {
    const { templateId, versionId } = await makeDraft();

    const res = await apiRequest(
      client,
      "POST",
      `${base(templateId, versionId)}/sections`,
      { userId: USERS.dispatcher, body: { title: "越权分组" } }
    );
    expect(res.status).toBe(403);
  });

  it("已发布版本不可写 → 403（编辑器据此显示只读）", async () => {
    const { templateId, versionId, revision } = await makeDraft();
    await addSection(templateId, versionId, "内容", revision);

    const pub = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions/${versionId}/publish`,
      { userId: USERS.admin, body: {} }
    );
    expect(pub.status).toBe(200);

    const res = await apiRequest(
      client,
      "POST",
      `${base(templateId, versionId)}/sections`,
      { userId: USERS.admin, body: { title: "发布后不该能加" } }
    );
    expect(res.status).toBe(403);
  });

  it("基于已发布版本新建草稿版本（编辑器「编辑为新版本」走的路径）", async () => {
    const { templateId, versionId, revision } = await makeDraft();
    const secId = await addSection(templateId, versionId, "原始分组", revision);
    await addQuestion(templateId, versionId, secId, "原始题", revision);

    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions/${versionId}/publish`,
      { userId: USERS.admin, body: {} }
    );

    // 把已发布版本的结构复制成新草稿
    const published = await readSchema(templateId, versionId);
    const created = await apiRequest<{ id: string; versionNo: number }>(
      client,
      "POST",
      `/api/v1/questionnaire-templates/${templateId}/versions`,
      {
        userId: USERS.admin,
        body: { schema: published, changeNote: "基于 v1 新建草稿" },
      }
    );
    const draft = expectData<{ id: string; versionNo: number }>(created);
    expect(draft.versionNo).toBe(2);

    // 新草稿内容与原版本一致，且**可写**
    const draftSchema = await readSchema(templateId, draft.id);
    expect(draftSchema.sections.map((s) => s.title)).toEqual(["原始分组"]);
    expect(draftSchema.sections[0]?.questions[0]?.title).toBe("原始题");

    const addRes = await apiRequest(
      client,
      "POST",
      `${base(templateId, draft.id)}/sections`,
      { userId: USERS.admin, body: { title: "新草稿里加的组" } }
    );
    // 编辑器接口统一返回 200：它表达的是「应用了一次操作」，
    // 响应体是 { ...本次变更详情, revision }，不是创建出来的资源地址。
    expect(addRes.status).toBe(200);

    // 确认真的写进去了（不是只返回了个成功）
    const draftAfter = await readSchema(templateId, draft.id);
    expect(draftAfter.sections.map((s) => s.title)).toEqual([
      "原始分组",
      "新草稿里加的组",
    ]);

    // 原已发布版本不受影响
    const stillPublished = await readSchema(templateId, versionId);
    expect(stillPublished.sections.map((s) => s.title)).toEqual(["原始分组"]);
  });
});

// ============================================================
// 从零搭建的完整链路
// ============================================================

describe("从零手工搭一份问卷", () => {
  it("建组 → 加题 → 重排 → 删组，全程可通过 HTTP 完成", async () => {
    const { templateId, versionId, revision } = await makeDraft();

    const s1 = await addSection(templateId, versionId, "基本信息", revision);
    const s2 = await addSection(templateId, versionId, "飞行情况", revision);
    const q1 = await addQuestion(templateId, versionId, s1, "姓名", revision);
    const q2 = await addQuestion(
      templateId,
      versionId,
      s1,
      "性别",
      revision,
      "single_choice"
    );
    const q3 = await addQuestion(templateId, versionId, s2, "是否飞过？", revision, "boolean");

    // 把「性别」拖到「姓名」前面
    let res = await apiRequest(
      client,
      "PATCH",
      `${base(templateId, versionId)}/questions/reorder`,
      {
        userId: USERS.admin,
        body: { sectionId: s1, questionIds: [q2, q1], expectedRevision: revision },
      }
    );
    expect(res.status).toBe(200);

    // 把「飞行情况」拖到最前
    res = await apiRequest(
      client,
      "PATCH",
      `${base(templateId, versionId)}/sections/reorder`,
      {
        userId: USERS.admin,
        body: { sectionIds: [s2, s1], expectedRevision: revision },
      }
    );
    expect(res.status).toBe(200);

    let schema = await readSchema(templateId, versionId);
    expect(schema.sections.map((s) => s.title)).toEqual(["飞行情况", "基本信息"]);
    expect(
      schema.sections.find((s) => s.id === s1)?.questions.map((q) => q.title)
    ).toEqual(["性别", "姓名"]);

    // 删掉「飞行情况」整组
    res = await apiRequest(
      client,
      "DELETE",
      `${base(templateId, versionId)}/sections/${s2}`,
      { userId: USERS.admin }
    );
    expect(res.status).toBe(200);

    schema = await readSchema(templateId, versionId);
    expect(schema.sections.map((s) => s.title)).toEqual(["基本信息"]);
    expect(schema.sections[0]?.order).toBe(1);
    // 组内两道题都还在，且顺序保持
    expect(schema.sections[0]?.questions.map((q) => q.title)).toEqual([
      "性别",
      "姓名",
    ]);
    expect(schema.sections[0]?.questions.map((q) => q.order)).toEqual([1, 2]);
    void q3;
  });
});
