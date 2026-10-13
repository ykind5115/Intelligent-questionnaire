/**
 * 实例列表端点测试（案件管理页）。
 *
 * 重点在**横向授权**：列表的过滤规则必须与详情接口的
 * `resolveInstanceAccess` 一致，否则会出现
 * 「列表里看得到、点进去 403」这种自相矛盾的行为。
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
const createdTemplateIds = new Set<string>();
const createdInstanceIds = new Set<string>();
const createdUserIds = new Set<string>();

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

  for (const id of createdUserIds) {
    await prisma.user.deleteMany({ where: { id } });
  }
  createdUserIds.clear();
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

/** 造一个临时用户 */
async function makeUser(
  username: string,
  roles: string[]
): Promise<string> {
  const id = newId();
  await prisma.user.create({
    data: {
      id,
      username,
      displayName: `临时-${username}`,
      status: "active",
      roles,
    },
  });
  createdUserIds.add(id);
  return id;
}

/** 建一个可用的已发布模板版本 */
async function makePublishedVersion(): Promise<string> {
  const t = await apiRequest<{ id: string }>(
    client,
    "POST",
    "/api/v1/questionnaire-templates",
    { userId: USERS.admin, body: { name: `列表测试-${newId().slice(0, 8)}` } }
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
          title: "列表测试问卷",
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
  return versionId;
}

/** 建一个实例（默认由 dispatcher1 创建） */
async function makeInstance(
  versionId: string,
  title: string,
  createdBy: string = USERS.dispatcher
): Promise<string> {
  const res = await apiRequest<{ id: string }>(
    client,
    "POST",
    "/api/v1/questionnaire-instances",
    { userId: createdBy, body: { templateVersionId: versionId, title } }
  );
  const id = expectData<{ id: string }>(res).id;
  createdInstanceIds.add(id);
  return id;
}

interface ListData {
  items: {
    id: string;
    title: string;
    status: string;
    currentRevision: number;
    createdBy: string;
    dispatch: {
      assignedTo: string;
      status: string;
      dueAt: string | null;
    } | null;
    response: { status: string; respondentId: string } | null;
  }[];
  users: Record<string, string>;
  total: number;
}

async function list(
  query: string,
  userId: string
): Promise<{ status: number; data?: ListData; code?: string }> {
  const res = await apiRequest<ListData>(
    client,
    "GET",
    `/api/v1/questionnaire-instances?${query}`,
    { userId }
  );
  return {
    status: res.status,
    ...(res.body.data ? { data: res.body.data } : {}),
    ...(res.body.error ? { code: res.body.error.code } : {}),
  };
}

// ============================================================
// 基本能力
// ============================================================

describe("实例列表：基本能力", () => {
  it("能列出并带上标题、状态、修订号", async () => {
    const versionId = await makePublishedVersion();
    const title = `列表基本-${newId().slice(0, 8)}`;
    const instanceId = await makeInstance(versionId, title);

    const res = await list(`keyword=${encodeURIComponent(title)}`, USERS.dispatcher);
    expect(res.status).toBe(200);
    const hit = res.data?.items.find((x) => x.id === instanceId);
    expect(hit).toBeDefined();
    expect(hit?.title).toBe(title);
    expect(hit?.status).toBe("draft");
    expect(hit?.currentRevision).toBe(1);
  });

  it("**不含 current_schema**（列表不该带整份结构）", async () => {
    const versionId = await makePublishedVersion();
    const instanceId = await makeInstance(versionId, "不含结构测试");

    const res = await apiRequest<{ items: Record<string, unknown>[] }>(
      client,
      "GET",
      "/api/v1/questionnaire-instances?page=1&pageSize=50",
      { userId: USERS.dispatcher }
    );
    const hit = expectData<{ items: Record<string, unknown>[] }>(res).items.find(
      (x) => x.id === instanceId
    );
    expect(hit).toBeDefined();
    expect(hit).not.toHaveProperty("currentSchema");
  });

  it("返回用户名映射，便于显示「下发给谁」", async () => {
    const versionId = await makePublishedVersion();
    const title = `用户名映射-${newId().slice(0, 8)}`;
    const instanceId = await makeInstance(versionId, title);
    await assignInvestigator(instanceId);

    const res = await list(`keyword=${encodeURIComponent(title)}`, USERS.dispatcher);
    // 实例创建者与指派对象都应出现在映射里
    expect(res.data?.users[USERS.dispatcher]).toBeTruthy();
    expect(res.data?.users[USERS.investigator]).toBeTruthy();
  });

  it("支持按状态筛选", async () => {
    const versionId = await makePublishedVersion();
    const title = `状态筛选-${newId().slice(0, 8)}`;
    const instanceId = await makeInstance(versionId, title);

    const draftOnly = await list(
      `status=draft&keyword=${encodeURIComponent(title)}`,
      USERS.dispatcher
    );
    expect(draftOnly.data?.items.some((x) => x.id === instanceId)).toBe(true);

    const confirmedOnly = await list(
      `status=confirmed&keyword=${encodeURIComponent(title)}`,
      USERS.dispatcher
    );
    expect(confirmedOnly.data?.items.some((x) => x.id === instanceId)).toBe(false);
  });

  it("非法 status → 422", async () => {
    const res = await list("status=不存在的状态", USERS.dispatcher);
    expect(res.status).toBe(422);
  });
});

// ============================================================
// 关联信息
// ============================================================

describe("实例列表：下发与答卷信息", () => {
  it("已下发实例带出被指派人、任务状态与截止时间", async () => {
    const versionId = await makePublishedVersion();
    const title = `下发信息-${newId().slice(0, 8)}`;
    const instanceId = await makeInstance(versionId, title);

    // 确认 → 建下发任务 → 执行下发
    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${instanceId}/confirm`,
      { userId: USERS.dispatcher }
    );
    const task = await apiRequest<{ id: string }>(
      client,
      "POST",
      "/api/v1/dispatch-tasks",
      {
        userId: USERS.dispatcher,
        body: {
          questionnaireInstanceId: instanceId,
          assignedTo: USERS.investigator,
          dueAt: "2026-12-31T18:00:00Z",
        },
      }
    );
    const taskId = expectData<{ id: string }>(task).id;
    await apiRequest(
      client,
      "POST",
      `/api/v1/dispatch-tasks/${taskId}/dispatch`,
      { userId: USERS.dispatcher }
    );

    const res = await list(`keyword=${encodeURIComponent(title)}`, USERS.dispatcher);
    const hit = res.data?.items.find((x) => x.id === instanceId);
    expect(hit?.status).toBe("dispatched");
    expect(hit?.dispatch?.assignedTo).toBe(USERS.investigator);
    expect(hit?.dispatch?.status).toBe("dispatched");
    expect(hit?.dispatch?.dueAt).toBeTruthy();
  });

  it("撤回后带出 withdrawn 状态与撤回时间", async () => {
    const versionId = await makePublishedVersion();
    const title = `撤回信息-${newId().slice(0, 8)}`;
    const instanceId = await makeInstance(versionId, title);

    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${instanceId}/confirm`,
      { userId: USERS.dispatcher }
    );
    const task = await apiRequest<{ id: string }>(
      client,
      "POST",
      "/api/v1/dispatch-tasks",
      {
        userId: USERS.dispatcher,
        body: {
          questionnaireInstanceId: instanceId,
          assignedTo: USERS.investigator,
        },
      }
    );
    const taskId = expectData<{ id: string }>(task).id;
    await apiRequest(
      client,
      "POST",
      `/api/v1/dispatch-tasks/${taskId}/dispatch`,
      { userId: USERS.dispatcher }
    );
    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${instanceId}/withdraw`,
      { userId: USERS.dispatcher, body: { reason: "测试撤回" } }
    );

    const res = await list(`keyword=${encodeURIComponent(title)}`, USERS.dispatcher);
    const hit = res.data?.items.find((x) => x.id === instanceId);
    // 实例回到 draft，任务变为 withdrawn
    expect(hit?.status).toBe("draft");
    expect(hit?.dispatch?.status).toBe("withdrawn");
  });

  it("有答卷时带出答卷状态与填写人", async () => {
    const versionId = await makePublishedVersion();
    const title = `答卷信息-${newId().slice(0, 8)}`;
    const instanceId = await makeInstance(versionId, title);

    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${instanceId}/confirm`,
      { userId: USERS.dispatcher }
    );
    const task = await apiRequest<{ id: string }>(
      client,
      "POST",
      "/api/v1/dispatch-tasks",
      {
        userId: USERS.dispatcher,
        body: {
          questionnaireInstanceId: instanceId,
          assignedTo: USERS.investigator,
        },
      }
    );
    const taskId = expectData<{ id: string }>(task).id;
    await apiRequest(
      client,
      "POST",
      `/api/v1/dispatch-tasks/${taskId}/dispatch`,
      { userId: USERS.dispatcher }
    );
    await apiRequest(
      client,
      "GET",
      `/api/v1/questionnaire-instances/${instanceId}/response`,
      { userId: USERS.investigator }
    );

    const res = await list(`keyword=${encodeURIComponent(title)}`, USERS.dispatcher);
    const hit = res.data?.items.find((x) => x.id === instanceId);
    expect(hit?.response?.status).toBe("draft");
    expect(hit?.response?.respondentId).toBe(USERS.investigator);
  });
});

// ============================================================
// 横向授权（重点）
// ============================================================

describe("实例列表：横向授权", () => {
  it("另一个 dispatcher 看不到别人创建的实例（与详情接口一致）", async () => {
    const versionId = await makePublishedVersion();
    const title = `越权列表-${newId().slice(0, 8)}`;
    const instanceId = await makeInstance(versionId, title, USERS.dispatcher);

    const other = await makeUser(
      `list_other_disp_${newId().slice(0, 6)}`,
      ["dispatcher"]
    );

    const res = await list(`keyword=${encodeURIComponent(title)}`, other);
    expect(res.status).toBe(200);
    expect(res.data?.items.some((x) => x.id === instanceId)).toBe(false);

    // 一致性：详情也必须是 403
    const detail = await apiRequest(
      client,
      "GET",
      `/api/v1/questionnaire-instances/${instanceId}`,
      { userId: other }
    );
    expect(detail.status).toBe(403);
  });

  it("investigator 只看到被指派给自己的实例", async () => {
    const versionId = await makePublishedVersion();
    const mineTitle = `指派给我-${newId().slice(0, 8)}`;
    const otherTitle = `指派给别人-${newId().slice(0, 8)}`;

    const mine = await makeInstance(versionId, mineTitle);
    const notMine = await makeInstance(versionId, otherTitle);

    await assignInvestigator(mine, { assignedTo: USERS.investigator });
    const otherInv = await makeUser(
      `list_other_inv_${newId().slice(0, 6)}`,
      ["investigator"]
    );
    await prisma.dispatchTask.create({
      data: {
        id: newId(),
        questionnaireInstanceId: notMine,
        assignedTo: otherInv,
        dispatchedBy: USERS.dispatcher,
        status: "dispatched",
        dispatchedAt: new Date(),
      },
    });

    const res = await list("page=1&pageSize=100", USERS.investigator);
    expect(res.status).toBe(200);
    const ids = res.data?.items.map((x) => x.id) ?? [];
    expect(ids).toContain(mine);
    expect(ids).not.toContain(notMine);
  });

  it("template_admin 能看到全部（模板治理需要）", async () => {
    const versionId = await makePublishedVersion();
    const title = `管理员可见-${newId().slice(0, 8)}`;
    const instanceId = await makeInstance(versionId, title, USERS.dispatcher);

    const res = await list(`keyword=${encodeURIComponent(title)}`, USERS.admin);
    expect(res.data?.items.some((x) => x.id === instanceId)).toBe(true);
  });

  it("reviewer 能看到有已提交答卷的实例", async () => {
    const versionId = await makePublishedVersion();
    const title = `审核可见-${newId().slice(0, 8)}`;
    const instanceId = await makeInstance(versionId, title);

    // 先确认这不是「谁都能看」：提交前 reviewer 看不到
    const beforeRes = await list(
      `keyword=${encodeURIComponent(title)}`,
      USERS.reviewer
    );
    expect(beforeRes.data?.items.some((x) => x.id === instanceId)).toBe(false);

    // 走完下发与提交
    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-instances/${instanceId}/confirm`,
      { userId: USERS.dispatcher }
    );
    const task = await apiRequest<{ id: string }>(
      client,
      "POST",
      "/api/v1/dispatch-tasks",
      {
        userId: USERS.dispatcher,
        body: {
          questionnaireInstanceId: instanceId,
          assignedTo: USERS.investigator,
        },
      }
    );
    const taskId = expectData<{ id: string }>(task).id;
    await apiRequest(
      client,
      "POST",
      `/api/v1/dispatch-tasks/${taskId}/dispatch`,
      { userId: USERS.dispatcher }
    );
    const fill = await apiRequest<{ responseId: string }>(
      client,
      "GET",
      `/api/v1/questionnaire-instances/${instanceId}/response`,
      { userId: USERS.investigator }
    );
    const responseId = expectData<{ responseId: string }>(fill).responseId;
    await apiRequest(
      client,
      "PUT",
      `/api/v1/questionnaire-responses/${responseId}/answers/q_a`,
      { userId: USERS.investigator, body: { answer: "有" } }
    );
    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-responses/${responseId}/submit`,
      { userId: USERS.investigator }
    );

    const afterRes = await list(
      `keyword=${encodeURIComponent(title)}`,
      USERS.reviewer
    );
    expect(afterRes.data?.items.some((x) => x.id === instanceId)).toBe(true);
  });

  it("没有任何读权限的角色 → 403", async () => {
    const nobody = await makeUser(
      `list_nobody_${newId().slice(0, 6)}`,
      ["some_other_role"]
    );
    const res = await list("page=1&pageSize=10", nobody);
    expect(res.status).toBe(403);
    expect(res.code).toBe("PERMISSION_DENIED");
  });

  it("assignedToMe 只返回下发给我的", async () => {
    const versionId = await makePublishedVersion();
    const title = `只给我的-${newId().slice(0, 8)}`;
    const instanceId = await makeInstance(versionId, title);
    await assignInvestigator(instanceId, { assignedTo: USERS.investigator });

    const res = await list(
      `assignedToMe=true&keyword=${encodeURIComponent(title)}`,
      USERS.investigator
    );
    expect(res.data?.items.some((x) => x.id === instanceId)).toBe(true);

    // 对没被指派的人（admin 例外：能看到全部）用另一个 investigator 验证
    const otherInv = await makeUser(
      `list_me_other_${newId().slice(0, 6)}`,
      ["investigator"]
    );
    const notMine = await list(
      `assignedToMe=true&keyword=${encodeURIComponent(title)}`,
      otherInv
    );
    expect(notMine.data?.items.some((x) => x.id === instanceId)).toBe(false);
  });
});

// ============================================================
// 分页
// ============================================================

describe("实例列表：分页", () => {
  it("分页参数生效且 total 正确", async () => {
    const versionId = await makePublishedVersion();
    const prefix = `分页-${newId().slice(0, 8)}`;
    for (let i = 1; i <= 3; i++) {
      await makeInstance(versionId, `${prefix}-${i}`);
    }

    const page1 = await list(
      `keyword=${encodeURIComponent(prefix)}&page=1&pageSize=2`,
      USERS.dispatcher
    );
    expect(page1.data?.total).toBe(3);
    expect(page1.data?.items).toHaveLength(2);

    const page2 = await list(
      `keyword=${encodeURIComponent(prefix)}&page=2&pageSize=2`,
      USERS.dispatcher
    );
    expect(page2.data?.items).toHaveLength(1);
  });
});
