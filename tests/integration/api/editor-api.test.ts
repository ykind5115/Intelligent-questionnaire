/**
 * 人工编辑器 API 集成测试（决策 D3）。
 *
 * 重点验证：它复用了与 AI Tool **完全相同**的 Service 与 Operation 层，
 * 因此权限、状态冻结、越权、校验规则都自动一致 ——
 * 不需要为「人改问卷」再写一套规则。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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
import { newId } from "../../../src/shared/utils/id.js";

let client: TestHttpClient;
const createdInstanceIds = new Set<string>();
const createdTemplateIds = new Set<string>();
/** 编辑器用例会在实例上留下审计与修订，deleteTestInstance 已覆盖 */


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

// ============================================================
// 准备一个可编辑的实例
// ============================================================

interface Prepared {
  instanceId: string;
  revision: number;
  firstSectionId: string;
  secondSectionId: string;
  firstQuestionId: string;
}

/** 建模板（两个分组、各一题）→ 发布 → 建实例 */
async function prepareInstance(): Promise<Prepared> {
  const t = await apiRequest<{ id: string }>(
    client,
    "POST",
    "/api/v1/questionnaire-templates",
    { userId: USERS.admin, body: { name: `编辑器测试-${newId().slice(0, 8)}` } }
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
          title: "编辑器测试问卷",
          version: 1,
          sections: [
            {
              id: "sec_a",
              title: "分组A",
              order: 1,
              questions: [
                {
                  id: "q_a1",
                  type: "text",
                  title: "题A1",
                  required: true,
                  order: 1,
                },
              ],
            },
            {
              id: "sec_b",
              title: "分组B",
              order: 2,
              questions: [
                {
                  id: "q_b1",
                  type: "text",
                  title: "题B1",
                  required: false,
                  order: 1,
                },
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

  const inst = await apiRequest<{ id: string; currentRevision: number }>(
    client,
    "POST",
    "/api/v1/questionnaire-instances",
    {
      userId: USERS.dispatcher,
      body: { templateVersionId: versionId, title: "编辑器测试实例" },
    }
  );
  const instance = expectData<{ id: string; currentRevision: number }>(inst);
  createdInstanceIds.add(instance.id);

  return {
    instanceId: instance.id,
    revision: instance.currentRevision,
    firstSectionId: "sec_a",
    secondSectionId: "sec_b",
    firstQuestionId: "q_a1",
  };
}

/** 读当前结构（便于断言） */
async function readSchema(instanceId: string) {
  const res = await apiRequest<{
    currentRevision: number;
    currentSchema: {
      sections: {
        id: string;
        title: string;
        questions: { id: string; title: string; type: string }[];
      }[];
    };
  }>(client, "GET", `/api/v1/questionnaire-instances/${instanceId}`, {
    userId: USERS.dispatcher,
  });
  const data = expectData<{
    currentRevision: number;
    currentSchema: {
      sections: {
        id: string;
        title: string;
        questions: { id: string; title: string; type: string }[];
      }[];
    };
  }>(res);
  return { revision: data.currentRevision, sections: data.currentSchema.sections };
}

// ============================================================
// 增删改移
// ============================================================

describe("人工编辑器：分组", () => {
  it("新增分组 → 201 且结构落库、revision 递增", async () => {
    const p = await prepareInstance();

    const res = await apiRequest<{
      section: { id: string; title: string };
      revision: number;
    }>(client, "POST", `/api/v1/questionnaire-instances/${p.instanceId}/sections`, {
      userId: USERS.dispatcher,
      body: { title: "团伙关系调查" },
    });

    expect(res.status).toBe(200);
    const data = expectData<{
      section: { id: string; title: string };
      revision: number;
    }>(res);
    expect(data.section.title).toBe("团伙关系调查");
    expect(data.revision).toBe(p.revision + 1);

    const after = await readSchema(p.instanceId);
    expect(after.sections.map((s) => s.title)).toEqual([
      "分组A",
      "分组B",
      "团伙关系调查",
    ]);
  });

  it("修改分组标题", async () => {
    const p = await prepareInstance();

    const res = await apiRequest<{ section: { id: string } }>(
      client,
      "PATCH",
      `/api/v1/questionnaire-instances/${p.instanceId}/sections/${p.firstSectionId}`,
      { userId: USERS.dispatcher, body: { title: "基本信息" } }
    );

    expect(res.status).toBe(200);
    const after = await readSchema(p.instanceId);
    expect(after.sections[0]?.title).toBe("基本信息");
  });

  it("修改分组时既不给 title 也不给 description → 422", async () => {
    const p = await prepareInstance();

    const res = await apiRequest(
      client,
      "PATCH",
      `/api/v1/questionnaire-instances/${p.instanceId}/sections/${p.firstSectionId}`,
      { userId: USERS.dispatcher, body: {} }
    );

    expect(res.status).toBe(422);
  });

  it("修改不存在的分组 → 404 SECTION_NOT_FOUND", async () => {
    const p = await prepareInstance();

    const res = await apiRequest(
      client,
      "PATCH",
      `/api/v1/questionnaire-instances/${p.instanceId}/sections/sec_nope`,
      { userId: USERS.dispatcher, body: { title: "x" } }
    );

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("SECTION_NOT_FOUND");
  });
});

describe("人工编辑器：问题", () => {
  it("新增问题（含选项）→ 落库并返回后端生成的 id", async () => {
    const p = await prepareInstance();

    const res = await apiRequest<{
      question: { id: string; title: string };
      revision: number;
    }>(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${p.instanceId}/questions`,
      {
        userId: USERS.dispatcher,
        body: {
          sectionId: p.firstSectionId,
          type: "single_choice",
          title: "是否拥有无人机？",
          required: true,
          options: [{ label: "是" }, { label: "否" }],
        },
      }
    );

    expect(res.status).toBe(200);
    const data = expectData<{
      question: { id: string; title: string };
      revision: number;
    }>(res);
    expect(data.question.id).toMatch(/^q_/);

    const after = await readSchema(p.instanceId);
    const section = after.sections.find((s) => s.id === p.firstSectionId);
    expect(section?.questions.map((q) => q.title)).toEqual([
      "题A1",
      "是否拥有无人机？",
    ]);
  });

  it("选择题缺选项 → 422（与 AI Tool 同一套校验）", async () => {
    const p = await prepareInstance();

    const res = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${p.instanceId}/questions`,
      {
        userId: USERS.dispatcher,
        body: {
          sectionId: p.firstSectionId,
          type: "single_choice",
          title: "缺选项的题",
        },
      }
    );

    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("INVALID_OPTIONS");
  });

  it("修改问题：改标题与必填，id 不变", async () => {
    const p = await prepareInstance();

    const res = await apiRequest<{ question: { id: string } }>(
      client,
      "PATCH",
      `/api/v1/questionnaire-instances/${p.instanceId}/questions/${p.firstQuestionId}`,
      {
        userId: USERS.dispatcher,
        body: { title: "被调查人姓名", required: false },
      }
    );

    expect(res.status).toBe(200);
    const after = await readSchema(p.instanceId);
    const q = after.sections[0]?.questions[0];
    expect(q?.title).toBe("被调查人姓名");
    // id 不变（改变 id 会丢失历史答案关联）
    expect(q?.id).toBe(p.firstQuestionId);
  });

  it("修改问题时不给任何字段 → 422", async () => {
    const p = await prepareInstance();

    const res = await apiRequest(
      client,
      "PATCH",
      `/api/v1/questionnaire-instances/${p.instanceId}/questions/${p.firstQuestionId}`,
      { userId: USERS.dispatcher, body: {} }
    );

    expect(res.status).toBe(422);
  });

  it("移动问题到另一个分组", async () => {
    const p = await prepareInstance();

    const res = await apiRequest<{ question: { id: string } }>(
      client,
      "PATCH",
      `/api/v1/questionnaire-instances/${p.instanceId}/questions/${p.firstQuestionId}/move`,
      {
        userId: USERS.dispatcher,
        body: { targetSectionId: p.secondSectionId, targetOrder: 1 },
      }
    );

    expect(res.status).toBe(200);
    const after = await readSchema(p.instanceId);
    expect(after.sections[0]?.questions).toHaveLength(0);
    expect(after.sections[1]?.questions.map((q) => q.title)).toEqual([
      "题A1",
      "题B1",
    ]);
  });

  it("删除问题", async () => {
    const p = await prepareInstance();

    const res = await apiRequest<{ removed: { id: string } }>(
      client,
      "DELETE",
      `/api/v1/questionnaire-instances/${p.instanceId}/questions/${p.firstQuestionId}`,
      { userId: USERS.dispatcher }
    );

    expect(res.status).toBe(200);
    const after = await readSchema(p.instanceId);
    expect(after.sections[0]?.questions).toHaveLength(0);
  });

  it("删除不存在的问题 → 404", async () => {
    const p = await prepareInstance();

    const res = await apiRequest(
      client,
      "DELETE",
      `/api/v1/questionnaire-instances/${p.instanceId}/questions/q_nope`,
      { userId: USERS.dispatcher }
    );

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("QUESTION_NOT_FOUND");
  });
});

// ============================================================
// 与 AI 通道一致的约束
// ============================================================

describe("人工编辑器：与 AI 通道一致的约束", () => {
  it("已下发的实例结构冻结 → 409 QUESTIONNAIRE_LOCKED（决策 D1）", async () => {
    const p = await prepareInstance();

    await prisma.questionnaireInstance.update({
      where: { id: p.instanceId },
      data: { status: "dispatched" },
    });

    const res = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${p.instanceId}/sections`,
      { userId: USERS.dispatcher, body: { title: "下发后不该能加" } }
    );

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("QUESTIONNAIRE_LOCKED");

    // 确认真的没写进去
    const after = await readSchema(p.instanceId);
    expect(after.sections.map((s) => s.title)).not.toContain("下发后不该能加");
  });

  it("investigator 无权编辑结构 → 403（决策 D8）", async () => {
    const p = await prepareInstance();

    const res = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${p.instanceId}/sections`,
      { userId: USERS.investigator, body: { title: "调查员不该能加" } }
    );

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe("PERMISSION_DENIED");
  });

  it("横向越权：另一个 dispatcher 不能编辑他人实例 → 403", async () => {
    const p = await prepareInstance();

    // 造第二个 dispatcher
    const otherId = newId();
    await prisma.user.upsert({
      where: { username: "editor_other_dispatcher" },
      update: { id: otherId },
      create: {
        id: otherId,
        username: "editor_other_dispatcher",
        displayName: "另一个下发员",
        status: "active",
        roles: ["dispatcher"],
      },
    });

    try {
      const res = await apiRequest(
        client,
        "POST",
        `/api/v1/questionnaire-instances/${p.instanceId}/sections`,
        { userId: otherId, body: { title: "别人的案件不该能改" } }
      );

      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe("PERMISSION_DENIED");
    } finally {
      await prisma.user.deleteMany({
        where: { username: "editor_other_dispatcher" },
      });
    }
  });

  it("乐观锁：expectedRevision 不一致 → 409", async () => {
    const p = await prepareInstance();

    const res = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${p.instanceId}/sections`,
      {
        userId: USERS.dispatcher,
        body: { title: "不该生效", expectedRevision: 99 },
      }
    );

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("REVISION_CONFLICT");
  });

  it("每次编辑都产生 Revision 与审计记录（source=manual_editor）", async () => {
    const p = await prepareInstance();

    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${p.instanceId}/sections`,
      { userId: USERS.dispatcher, body: { title: "审计校验组" } }
    );

    const revision = await prisma.questionnaireRevision.findFirst({
      where: { questionnaireInstanceId: p.instanceId },
      orderBy: { revisionNo: "desc" },
    });
    expect(revision?.operationType).toBe("add_section");

    const audit = await prisma.aiToolExecution.findFirst({
      where: { questionnaireInstanceId: p.instanceId },
      orderBy: { createdAt: "desc" },
    });
    // 人工编辑与 AI 编辑共用审计表，但来源可区分
    expect(audit?.source).toBe("manual_editor");
  });

  it("被指派并下发的实例，调查员仍无权改结构（只读+填写）", async () => {
    const p = await prepareInstance();
    await assignInvestigator(p.instanceId);
    await prisma.questionnaireInstance.update({
      where: { id: p.instanceId },
      data: { status: "dispatched" },
    });

    // 调查员此时能读（被指派了）
    const read = await apiRequest(
      client,
      "GET",
      `/api/v1/questionnaire-instances/${p.instanceId}`,
      { userId: USERS.investigator }
    );
    expect(read.status).toBe(200);

    // 但仍不能改结构：先被权限拦（不是 dispatcher），
    // 即使绕过权限，也会被状态冻结拦住
    const write = await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${p.instanceId}/sections`,
      { userId: USERS.investigator, body: { title: "x" } }
    );
    expect(write.status).toBe(403);
  });
});
