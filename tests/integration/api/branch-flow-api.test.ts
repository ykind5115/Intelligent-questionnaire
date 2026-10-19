/**
 * 条件分支的端到端测试（决策 D16 / 计划 §4）。
 *
 * 覆盖分支能力真正生效的地方 —— 答卷链路：
 *   1. 通过 REST 给题目设置分支并落库；
 *   2. 下发后按答案**跳过**题目；
 *   3. 提交时**只校验路径内的必填**（被跳过的必填题不该阻塞提交）；
 *   4. 读取答卷时答案按**路径顺序**返回，并带上本次路径；
 *   5. 非法结构（悬空引用、无出口环、自环）被拒绝。
 *
 * ## 夹具设计（这节很重要：前几版在这里反复栽跟头）
 *
 * 题目顺序：
 *   1. has    是否进行过飞行？（是非，**必填**）
 *   2. date   最近一次飞行日期（文本，**必填**）
 *   3. reason 未飞行的原因（文本，**必填**）
 *   4. note   备注（文本，选填）
 *
 * 分支只挂在 `has` 上（**按本题答案决定去向**，条件跳题最常见的形态）：
 *   has = true  → 跳到 note（跳过 date 与 reason）
 *   has = false → 落到 date（顺序往下走）
 *
 * 两条路径**题数不同**：
 *   true  → has, note               （2 题）
 *   false → has, date, reason, note （4 题）
 *
 * 教训：早期版本把门控挂在 date/reason 上、且跳转目标恰好是「顺序下一题」，
 * 于是「跳与不跳」结果完全相同 —— 那种夹具**测不出任何问题**，浪费了大量时间。
 * 因此这里的断言一律比较**完整题序**，而不是只检查「是否包含某题」。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  apiRequest,
  expectData,
  prisma,
  startTestServer,
  type TestHttpClient,
} from "./helpers.js";
import {
  USERS,
  assignInvestigator,
  deleteTestInstance,
} from "../questionnaire/helpers.js";

let client: TestHttpClient;
const createdTemplateIds = new Set<string>();
const createdInstanceIds = new Set<string>();
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
  return `/api/v1/questionnaire-templates/${templateId}/versions/${versionId}`;
}

type QKey = "has" | "date" | "reason" | "note";

interface Fixture {
  templateId: string;
  versionId: string;
  sectionId: string;
  ids: Record<QKey, string>;
  /** 在指定题上装一条「按 has 的答案跳转」的分支 */
  branch: (question: QKey, whenHas: boolean, goTo: QKey) => Promise<void>;
}

async function buildFixture(
  options: { withGates?: boolean } = {}
): Promise<Fixture> {
  const t = await apiRequest<{ id: string }>(
    client,
    "POST",
    "/api/v1/questionnaire-templates",
    { userId: USERS.admin, body: { name: `分支测试-${Date.now()}` } }
  );
  const templateId = expectData<{ id: string }>(t).id;
  createdTemplateIds.add(templateId);

  const v = await apiRequest<{ id: string; versionNo: number }>(
    client,
    "POST",
    `/api/v1/questionnaire-templates/${templateId}/versions`,
    { userId: USERS.admin, body: {} }
  );
  const versionId = expectData<{ id: string; versionNo: number }>(v).id;

  const sec = await apiRequest<{ section: { id: string } }>(
    client,
    "POST",
    `${base(templateId, versionId)}/sections`,
    { userId: USERS.admin, body: { title: "飞行情况" } }
  );
  const sectionId = expectData<{ section: { id: string } }>(sec).section.id;

  const addQ = async (
    title: string,
    type: string,
    required: boolean
  ): Promise<string> => {
    const res = await apiRequest<{ question: { id: string } }>(
      client,
      "POST",
      `${base(templateId, versionId)}/questions`,
      { userId: USERS.admin, body: { sectionId, type, title, required } }
    );
    return expectData<{ question: { id: string } }>(res).question.id;
  };

  const ids: Record<QKey, string> = {
    has: await addQ("是否进行过飞行？", "boolean", true),
    date: await addQ("最近一次飞行日期", "text", true),
    reason: await addQ("未飞行的原因", "text", true),
    note: await addQ("备注", "text", false),
  };

  const branch = async (
    question: QKey,
    whenHas: boolean,
    goTo: QKey
  ): Promise<void> => {
    const res = await apiRequest(
      client,
      "PATCH",
      `${base(templateId, versionId)}/questions/${ids[question]}/branch`,
      {
        userId: USERS.admin,
        body: {
          branches: [
            {
              when: { op: "eq", questionId: ids["has"], value: whenHas },
              goTo: ids[goTo],
            },
          ],
        },
      }
    );
    expect(res.status, JSON.stringify(res.body.error)).toBe(200);
  };

  if (options.withGates !== false) {
    // 只有在「飞过」时才继续问日期与原因；没飞过直接跳到备注
    await branch("has", true, "note");
  }

  return { templateId, versionId, sectionId, ids, branch };
}

/** 发布模板版本并建一个已下发的案件（指派给 investigator） */
async function publishAndDispatch(
  templateId: string,
  versionId: string
): Promise<string> {
  const pub = await apiRequest(
    client,
    "POST",
    `/api/v1/questionnaire-templates/${templateId}/versions/${versionId}/publish`,
    { userId: USERS.admin, body: {} }
  );
  expect(pub.status, JSON.stringify(pub.body.error)).toBe(200);

  const inst = await apiRequest<{ id: string }>(
    client,
    "POST",
    "/api/v1/questionnaire-instances",
    {
      userId: USERS.dispatcher,
      body: { templateVersionId: versionId, title: "分支填写测试" },
    }
  );
  const instanceId = expectData<{ id: string }>(inst).id;
  createdInstanceIds.add(instanceId);

  await prisma.questionnaireInstance.update({
    where: { id: instanceId },
    data: { status: "dispatched" },
  });
  await assignInvestigator(instanceId);

  return instanceId;
}

/** 取答卷（GET 返回扁平结构：responseId 在顶层，结构在 questionnaire 下） */
async function readFill(instanceId: string): Promise<{
  responseId: string;
  flow: { questionIds: string[]; endedBy: string };
  answers: { questionId: string; answer: unknown }[];
  questionnaire: {
    sections: { questions: { id: string; branches?: unknown[] }[] }[];
  };
}> {
  const res = await apiRequest<{
    responseId: string;
    flow: { questionIds: string[]; endedBy: string };
    answers: { questionId: string; answer: unknown }[];
    questionnaire: {
      sections: { questions: { id: string; branches?: unknown[] }[] }[];
    };
  }>(
    client,
    "GET",
    `/api/v1/questionnaire-instances/${instanceId}/response`,
    { userId: USERS.investigator }
  );
  return expectData(res);
}

async function saveAnswers(
  responseId: string,
  answers: { questionId: string; answer: unknown }[]
): Promise<number> {
  const res = await apiRequest(
    client,
    "PUT",
    `/api/v1/questionnaire-responses/${responseId}/answers`,
    { userId: USERS.investigator, body: { answers } }
  );
  return res.status;
}

// ============================================================
// 设置分支
// ============================================================

describe("设置分支（REST）", () => {
  it("设置分支并落库，结构里能读回（**允许条件引用题目自己**）", async () => {
    const fx = await buildFixture({ withGates: false });
    await fx.branch("has", true, "note");

    const v = await apiRequest<{
      schema: { sections: { questions: { id: string; branches?: unknown[] }[] }[] };
    }>(client, "GET", base(fx.templateId, fx.versionId), {
      userId: USERS.admin,
    });
    const schema = expectData<{
      schema: { sections: { questions: { id: string; branches?: unknown[] }[] }[] };
    }>(v).schema;

    const q = schema.sections[0]!.questions.find((x) => x.id === fx.ids["has"]);
    expect(q?.branches).toHaveLength(1);
  });

  it("branches 传空数组 = 清除分支", async () => {
    const fx = await buildFixture();

    const res = await apiRequest(
      client,
      "PATCH",
      `${base(fx.templateId, fx.versionId)}/questions/${fx.ids["has"]}/branch`,
      { userId: USERS.admin, body: { branches: [] } }
    );
    expect(res.status).toBe(200);

    const v = await apiRequest<{
      schema: { sections: { questions: { id: string; branches?: unknown[] }[] }[] };
    }>(client, "GET", base(fx.templateId, fx.versionId), {
      userId: USERS.admin,
    });
    const q = expectData<{
      schema: { sections: { questions: { id: string; branches?: unknown[] }[] }[] };
    }>(v).schema.sections[0]!.questions.find((x) => x.id === fx.ids["has"]);
    expect(q?.branches).toBeUndefined();
  });

  it("**纵向授权**：dispatcher 不能改模板分支", async () => {
    const fx = await buildFixture();
    const res = await apiRequest(
      client,
      "PATCH",
      `${base(fx.templateId, fx.versionId)}/questions/${fx.ids["has"]}/branch`,
      { userId: USERS.dispatcher, body: { branches: [] } }
    );
    expect(res.status).toBe(403);
  });

  it("悬空引用（跳到不存在的题）→ 400（不能是 500：那是调用方参数错误）", async () => {
    const fx = await buildFixture();
    const res = await apiRequest(
      client,
      "PATCH",
      `${base(fx.templateId, fx.versionId)}/questions/${fx.ids["has"]}/branch`,
      {
        userId: USERS.admin,
        body: {
          branches: [
            {
              when: { op: "eq", questionId: fx.ids["has"], value: true },
              goTo: "q_nope",
            },
          ],
        },
      }
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error)).toContain("q_nope");
  });

  it("跳到自己 → 被拒绝", async () => {
    const fx = await buildFixture();
    const res = await apiRequest(
      client,
      "PATCH",
      `${base(fx.templateId, fx.versionId)}/questions/${fx.ids["has"]}/branch`,
      {
        userId: USERS.admin,
        body: {
          branches: [
            {
              when: { op: "eq", questionId: fx.ids["has"], value: true },
              goTo: fx.ids["has"],
            },
          ],
        },
      }
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("形成无出口的环 → 被拒绝（不能保存一个填不完的问卷）", async () => {
    const fx = await buildFixture({ withGates: false });

    const first = await apiRequest(
      client,
      "PATCH",
      `${base(fx.templateId, fx.versionId)}/questions/${fx.ids["date"]}/branch`,
      {
        userId: USERS.admin,
        body: { branches: [], defaultNext: fx.ids["reason"] },
      }
    );
    expect(first.status).toBe(200);

    const res = await apiRequest(
      client,
      "PATCH",
      `${base(fx.templateId, fx.versionId)}/questions/${fx.ids["reason"]}/branch`,
      {
        userId: USERS.admin,
        body: { branches: [], defaultNext: fx.ids["date"] },
      }
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body.error)).toMatch(/收敛|环/);
  });

  it("**往前跳**（目标是本题之前的题）→ 400，并说明会形成环", async () => {
    const fx = await buildFixture({ withGates: false });

    // reason 是第 3 题，date 是第 2 题 —— 往前跳
    const res = await apiRequest(
      client,
      "PATCH",
      `${base(fx.templateId, fx.versionId)}/questions/${fx.ids["reason"]}/branch`,
      {
        userId: USERS.admin,
        body: {
          branches: [
            {
              when: { op: "is_answered", questionId: fx.ids["reason"] },
              goTo: fx.ids["date"],
            },
          ],
        },
      }
    );

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error)).toMatch(/本题之前|本题之后/);
  });

  it("**条件引用后面的题目** → 400（那种规则永远不会命中）", async () => {
    const fx = await buildFixture({ withGates: false });

    // has 是第 1 题，却拿第 4 题 note 的答案做判断
    const res = await apiRequest(
      client,
      "PATCH",
      `${base(fx.templateId, fx.versionId)}/questions/${fx.ids["has"]}/branch`,
      {
        userId: USERS.admin,
        body: {
          branches: [
            {
              when: { op: "is_answered", questionId: fx.ids["note"] },
              goTo: fx.ids["date"],
            },
          ],
        },
      }
    );

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error)).toMatch(/永远不会命中|更早/);
  });

  it("**重排导致既有分支变成往前跳** → 400 而不是 500（回归）", async () => {
    // 这是 assertValidSchema 曾把 ZodError 直接抛出的后果：
    // error-handler 只认 OperationError，于是结构不合法被兜成 500 SYSTEM_ERROR，
    // 调用方会以为服务端崩了。分支落地后「重排/删题让既有分支失效」很常见。
    const fx = await buildFixture({ withGates: false });

    // date(第2题) 分支到 note(第4题)：合法
    const set = await apiRequest(
      client,
      "PATCH",
      `${base(fx.templateId, fx.versionId)}/questions/${fx.ids["date"]}/branch`,
      {
        userId: USERS.admin,
        body: {
          branches: [
            {
              when: { op: "is_answered", questionId: fx.ids["date"] },
              goTo: fx.ids["note"],
            },
          ],
        },
      }
    );
    expect(set.status, JSON.stringify(set.body.error)).toBe(200);

    // 把 note 挪到最前 → date 的分支变成往前跳
    const reorder = await apiRequest(
      client,
      "PATCH",
      `${base(fx.templateId, fx.versionId)}/questions/reorder`,
      {
        userId: USERS.admin,
        body: {
          sectionId: fx.sectionId,
          questionIds: [fx.ids["note"], fx.ids["has"], fx.ids["date"], fx.ids["reason"]],
        },
      }
    );

    expect(reorder.status).toBe(400);
    expect(JSON.stringify(reorder.body.error)).toMatch(/本题之前|本题之后/);
  });

  it("分支指向不存在的**条件**题目 → 被拒绝", async () => {
    const fx = await buildFixture();
    const res = await apiRequest(
      client,
      "PATCH",
      `${base(fx.templateId, fx.versionId)}/questions/${fx.ids["has"]}/branch`,
      {
        userId: USERS.admin,
        body: {
          branches: [
            { when: { op: "is_answered", questionId: "q_nope" }, goTo: fx.ids["note"] },
          ],
        },
      }
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ============================================================
// 填写时的跳题与条件必填
// ============================================================

describe("填写时按分支跳题", () => {
  it("答「是」→ 只有 has,note；答「否」→ has,date,reason,note（完整题序断言）", async () => {
    const fx = await buildFixture();
    const instanceId = await publishAndDispatch(fx.templateId, fx.versionId);
    const fill = await readFill(instanceId);

    expect(
      await saveAnswers(fill.responseId, [
        { questionId: fx.ids["has"], answer: true },
      ])
    ).toBe(200);

    const yes = await readFill(instanceId);
    expect(yes.flow.questionIds).toEqual([fx.ids["has"], fx.ids["note"]]);

    expect(
      await saveAnswers(fill.responseId, [
        { questionId: fx.ids["has"], answer: false },
      ])
    ).toBe(200);

    const no = await readFill(instanceId);
    expect(no.flow.questionIds).toEqual([
      fx.ids["has"],
      fx.ids["date"],
      fx.ids["reason"],
      fx.ids["note"],
    ]);
  });

  it("**被跳过的必填题不阻塞提交**（分支落地后必填语义的正确形态）", async () => {
    const fx = await buildFixture();
    const instanceId = await publishAndDispatch(fx.templateId, fx.versionId);
    const fill = await readFill(instanceId);

    // 答「是」→ date 与 reason（都是必填）被跳过，只答 has 与 note 即可提交
    expect(
      await saveAnswers(fill.responseId, [
        { questionId: fx.ids["has"], answer: true },
        { questionId: fx.ids["note"], answer: "没什么要补充的" },
      ])
    ).toBe(200);

    const submit = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-responses/${fill.responseId}/submit`,
      { userId: USERS.investigator }
    );

    expect(
      submit.status,
      `被跳过的必填题不该阻塞提交，实际：${JSON.stringify(submit.body.error)}`
    ).toBe(200);
  });

  it("路径内的必填题没填 → 仍然拒绝提交（不能因为分支把必填校验放过）", async () => {
    const fx = await buildFixture();
    const instanceId = await publishAndDispatch(fx.templateId, fx.versionId);
    const fill = await readFill(instanceId);

    // 答「否」→ date 与 reason 都在路径上且必填，但一个都没填
    await saveAnswers(fill.responseId, [
      { questionId: fx.ids["has"], answer: false },
    ]);

    const submit = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-responses/${fill.responseId}/submit`,
      { userId: USERS.investigator }
    );

    expect(submit.status).toBe(422);
    expect(JSON.stringify(submit.body.error)).toContain(fx.ids["date"]);
  });

  it("答案按**路径顺序**返回，而不是 questionId 字典序", async () => {
    const fx = await buildFixture();
    const instanceId = await publishAndDispatch(fx.templateId, fx.versionId);
    const fill = await readFill(instanceId);

    // 走「否」这条完整路径，故意乱序提交
    await saveAnswers(fill.responseId, [
      { questionId: fx.ids["note"], answer: "备注内容" },
      { questionId: fx.ids["reason"], answer: "天气不好" },
      { questionId: fx.ids["date"], answer: "2026-10-01" },
      { questionId: fx.ids["has"], answer: false },
    ]);

    const after = await readFill(instanceId);
    expect(after.answers.map((a) => a.questionId)).toEqual([
      fx.ids["has"],
      fx.ids["date"],
      fx.ids["reason"],
      fx.ids["note"],
    ]);

    const submit = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-responses/${fill.responseId}/submit`,
      { userId: USERS.investigator }
    );
    expect(submit.status).toBe(200);
  });

  it("切回「是」后：历史答案不丢，但路径只认 has 与 note", async () => {
    const fx = await buildFixture();
    const instanceId = await publishAndDispatch(fx.templateId, fx.versionId);
    const fill = await readFill(instanceId);

    // 先走「否」并填满必填
    await saveAnswers(fill.responseId, [
      { questionId: fx.ids["has"], answer: false },
      { questionId: fx.ids["date"], answer: "2026-10-01" },
      { questionId: fx.ids["reason"], answer: "天气不好" },
    ]);
    // 再改成「是」→ date/reason 被跳过，但库里仍有它们的答案
    await saveAnswers(fill.responseId, [
      { questionId: fx.ids["has"], answer: true },
    ]);

    const yes = await readFill(instanceId);
    expect(yes.flow.questionIds).toEqual([fx.ids["has"], fx.ids["note"]]);

    // 历史答案不丢（数据不能因为排序或跳过而消失）
    const stored = yes.answers.map((a) => a.questionId);
    expect(stored).toContain(fx.ids["date"]);
    expect(stored).toContain(fx.ids["reason"]);
  });

  it("没有分支的问卷路径与题目顺序一致（向后兼容）", async () => {
    const fx = await buildFixture({ withGates: false });
    const instanceId = await publishAndDispatch(fx.templateId, fx.versionId);

    const fill = await readFill(instanceId);
    expect(fill.flow.questionIds).toEqual([
      fx.ids["has"],
      fx.ids["date"],
      fx.ids["reason"],
      fx.ids["note"],
    ]);
  });
});
