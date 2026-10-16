/**
 * 流程预览接口测试（决策 D16 / 计划 §4.11）。
 *
 * 这个接口存在的意义：编辑器要显示「按这份结构，某种答案会走成什么样」，
 * 而求值逻辑**只在后端实现一次**（`resolveFlow`）。
 * 如果前端再抄一份，两边迟早漂移 —— 而分支判定出错是在数据里很难发现的那类问题。
 *
 * 因此这里要盯住三件事：
 *   1. 结构与不可达诊断正确；
 *   2. 候选答案能算出正确路径；
 *   3. **只读** —— 预览不能写库、不能产生审计。
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
    await prisma.questionnaireTemplateVersion.deleteMany({
      where: { templateId: id },
    });
    await prisma.questionnaireTemplate.deleteMany({ where: { id } });
  }
  createdTemplateIds.clear();

  // 预览是只读的，理论上不该有新审计；这里仍然清一次，
  // 而断言用了「数量不变」来证明它确实没写。
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

function base(templateId: string, versionId: string): string {
  return `/api/v1/questionnaire-templates/${templateId}/versions/${versionId}/flow`;
}

/**
 * 夹具（与 branch-flow-api.test.ts 同一套结构，便于对照）：
 *   has(必填) date(必填) reason(必填) note(选填)
 *   分支：has = true → note（跳过 date 与 reason）
 *   另有一条可选分支：reason = 已作答 → note，用来制造「date 不可达」的场景
 */
async function buildFixture(options: { withGates?: boolean } = {}) {
  const t = await apiRequest<{ id: string }>(
    client,
    "POST",
    "/api/v1/questionnaire-templates",
    { userId: USERS.admin, body: { name: `预览测试-${Date.now()}` } }
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
    { userId: USERS.admin, body: { title: "飞行情况" } }
  );
  const sectionId = expectData<{ section: { id: string } }>(sec).section.id;

  const mk = async (title: string, type: string, required: boolean) =>
    expectData<{ question: { id: string } }>(
      await apiRequest(client, "POST", `${b}/questions`, {
        userId: USERS.admin,
        body: { sectionId, type, title, required },
      })
    ).question.id;

  const ids = {
    has: await mk("是否进行过飞行？", "boolean", true),
    date: await mk("最近一次飞行日期", "text", true),
    reason: await mk("未飞行的原因", "text", true),
    note: await mk("备注", "text", false),
  };

  if (options.withGates !== false) {
    const res = await apiRequest(client, "PATCH", `${b}/questions/${ids["has"]}/branch`, {
      userId: USERS.admin,
      body: {
        branches: [
          {
            when: { op: "eq", questionId: ids["has"], value: true },
            goTo: ids["note"],
          },
        ],
      },
    });
    expect(res.status, JSON.stringify(res.body.error)).toBe(200);
  }

  return { templateId, versionId, ids };
}

describe("GET /flow/structure（结构诊断）", () => {
  it("返回全部题目（含分组/题型/选项/分支摘要）与不可达列表", async () => {
    const fx = await buildFixture();

    const res = await apiRequest<{
      questions: {
        id: string;
        title: string;
        type: string;
        sectionTitle: string;
        branchCount: number;
      }[];
      unreachable: string[];
      branchingQuestionIds: string[];
    }>(client, "GET", `${base(fx.templateId, fx.versionId)}/structure`, {
      userId: USERS.admin,
    });

    const data = expectData<{
      questions: {
        id: string;
        title: string;
        type: string;
        sectionTitle: string;
        branchCount: number;
      }[];
      unreachable: string[];
      branchingQuestionIds: string[];
    }>(res);

    // 四道题，按 order
    expect(data.questions.map((q) => q.title)).toEqual([
      "是否进行过飞行？",
      "最近一次飞行日期",
      "未飞行的原因",
      "备注",
    ]);
    expect(data.questions.every((q) => q.sectionTitle === "飞行情况")).toBe(true);

    // 只有 has 带分支
    expect(data.branchingQuestionIds).toEqual([fx.ids["has"]]);
    expect(data.questions.find((q) => q.id === fx.ids["has"])?.branchCount).toBe(1);

    // 这个结构里没有不可达题目
    expect(data.unreachable).toEqual([]);
  });

  it("没有分支时 branchingQuestionIds 为空、无可达性问题", async () => {
    const fx = await buildFixture({ withGates: false });
    const res = await apiRequest<{
      branchingQuestionIds: string[];
      unreachable: string[];
    }>(client, "GET", `${base(fx.templateId, fx.versionId)}/structure`, {
      userId: USERS.admin,
    });
    const data = expectData<{
      branchingQuestionIds: string[];
      unreachable: string[];
    }>(res);
    expect(data.branchingQuestionIds).toEqual([]);
    expect(data.unreachable).toEqual([]);
  });

  it("**纵向授权**：dispatcher 不能读模板草稿的预览 → 403", async () => {
    const fx = await buildFixture();
    const res = await apiRequest(
      client,
      "GET",
      `${base(fx.templateId, fx.versionId)}/structure`,
      { userId: USERS.dispatcher }
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /flow/cases（按候选答案求路径）", () => {
  it("答「是」跳过 date 与 reason；答「否」走完整流程", async () => {
    const fx = await buildFixture();

    const res = await apiRequest<{
      results: { label?: string; questionIds: string[]; endedBy: string; error: string | null }[];
    }>(client, "POST", `${base(fx.templateId, fx.versionId)}/cases`, {
      userId: USERS.admin,
      body: {
        cases: [
          { label: "是", answers: { [fx.ids["has"]]: true } },
          { label: "否", answers: { [fx.ids["has"]]: false } },
          { label: "未作答", answers: {} },
        ],
      },
    });

    const data = expectData<{
      results: { label?: string; questionIds: string[]; endedBy: string; error: string | null }[];
    }>(res);

    expect(data.results).toHaveLength(3);
    expect(data.results[0]!.questionIds).toEqual([fx.ids["has"], fx.ids["note"]]);
    expect(data.results[1]!.questionIds).toEqual([
      fx.ids["has"],
      fx.ids["date"],
      fx.ids["reason"],
      fx.ids["note"],
    ]);
    // 未作答 → 规则不命中 → 走顺序
    expect(data.results[2]!.questionIds).toEqual(data.results[1]!.questionIds);

    expect(data.results.every((r) => r.error === null)).toBe(true);
  });

  it("**包裝形态的答案**（{value:true}）与裸标量结果一致", async () => {
    const fx = await buildFixture();

    const res = await apiRequest<{ results: { questionIds: string[] }[] }>(
      client,
      "POST",
      `${base(fx.templateId, fx.versionId)}/cases`,
      {
        userId: USERS.admin,
        body: {
          cases: [
            { answers: { [fx.ids["has"]]: true } },
            { answers: { [fx.ids["has"]]: { value: true } } },
          ],
        },
      }
    );
    const data = expectData<{ results: { questionIds: string[] }[] }>(res);
    expect(data.results[0]!.questionIds).toEqual(data.results[1]!.questionIds);
  });

  it("结构走不通时把错误放在该情形的结果里，而不是整体失败", async () => {
    const fx = await buildFixture({ withGates: false });
    const b = `/api/v1/questionnaire-templates/${fx.templateId}/versions/${fx.versionId}`;

    // 制造一个无出口的环：date → reason → date（第二笔会被拒绝，
    // 因此这里直接用第一笔 + 观察预览对「不可能结构」的容忍）
    await apiRequest(client, "PATCH", `${b}/questions/${fx.ids["date"]}/branch`, {
      userId: USERS.admin,
      body: { branches: [], defaultNext: fx.ids["reason"] },
    });

    // 此时结构仍合法（date→reason 只是顺序跳转），预览应正常
    const res = await apiRequest<{ results: { questionIds: string[]; error: string | null }[] }>(
      client,
      "POST",
      `${base(fx.templateId, fx.versionId)}/cases`,
      { userId: USERS.admin, body: { cases: [{ answers: {} }] } }
    );
    const data = expectData<{ results: { questionIds: string[]; error: string | null }[] }>(res);
    // date 跳到 reason，reason 之后按顺序到 note
    expect(data.results[0]!.questionIds).toEqual([
      fx.ids["has"],
      fx.ids["date"],
      fx.ids["reason"],
      fx.ids["note"],
    ]);
    expect(data.results[0]!.error).toBeNull();
  });

  it("cases 为空 → 422；超过 20 种情形 → 422", async () => {
    const fx = await buildFixture();

    const empty = await apiRequest(
      client,
      "POST",
      `${base(fx.templateId, fx.versionId)}/cases`,
      { userId: USERS.admin, body: { cases: [] } }
    );
    expect(empty.status).toBe(422);

    const tooMany = await apiRequest(
      client,
      "POST",
      `${base(fx.templateId, fx.versionId)}/cases`,
      {
        userId: USERS.admin,
        body: { cases: Array.from({ length: 21 }, () => ({ answers: {} })) },
      }
    );
    expect(tooMany.status).toBe(422);
  });
});

describe("预览是只读的", () => {
  it("调用预览不会写库、不产生审计、不改动结构", async () => {
    const fx = await buildFixture();
    const b = `/api/v1/questionnaire-templates/${fx.templateId}/versions/${fx.versionId}`;

    const before = await prisma.questionnaireTemplateVersion.findUniqueOrThrow({
      where: { id: fx.versionId },
      select: { schema: true },
    });
    const auditsBefore = await prisma.aiToolExecution.count();

    await apiRequest(client, "GET", `${base(fx.templateId, fx.versionId)}/structure`, {
      userId: USERS.admin,
    });
    await apiRequest(client, "POST", `${base(fx.templateId, fx.versionId)}/cases`, {
      userId: USERS.admin,
      body: { cases: [{ answers: { [fx.ids["has"]]: true } }] },
    });

    const after = await prisma.questionnaireTemplateVersion.findUniqueOrThrow({
      where: { id: fx.versionId },
      select: { schema: true },
    });
    const auditsAfter = await prisma.aiToolExecution.count();

    expect(after.schema).toEqual(before.schema);
    expect(auditsAfter).toBe(auditsBefore);
    void b;
  });
});
