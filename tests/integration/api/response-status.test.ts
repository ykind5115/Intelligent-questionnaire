/**
 * 答卷状态常量的完备性测试。
 *
 * 背景：`RESPONSE_STATUSES` 曾被当作「答卷状态的全部取值」使用
 * （review 控制器用它做查询参数校验），但它漏了 `reviewed` ——
 * 而审核通过时确实会写入该值。常量与实现不一致会误导读者，
 * 也会让「按 reviewed 过滤」这种合理查询被 422 拒掉。
 *
 * 这个测试用「实际能被写入的取值」来约束常量，避免再次漏项。
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
import {
  RESPONSE_FILLABLE_STATUSES,
  RESPONSE_STATUSES,
} from "../../../src/modules/response/service/response.service.js";

let client: TestHttpClient;
const createdInstanceIds = new Set<string>();
const createdTemplateIds = new Set<string>();

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

/** 建一个已下发、已指派给 investigator1 的实例 */
async function makeDispatchedInstance(): Promise<{
  instanceId: string;
  firstQuestionId: string;
}> {
  const t = await apiRequest<{ id: string }>(
    client,
    "POST",
    "/api/v1/questionnaire-templates",
    { userId: USERS.admin, body: { name: `状态常量-${newId().slice(0, 8)}` } }
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
          title: "状态常量测试",
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

  const inst = await apiRequest<{ id: string }>(
    client,
    "POST",
    "/api/v1/questionnaire-instances",
    {
      userId: USERS.dispatcher,
      body: { templateVersionId: versionId, title: "状态常量测试案件" },
    }
  );
  const instanceId = expectData<{ id: string }>(inst).id;
  createdInstanceIds.add(instanceId);

  await assignInvestigator(instanceId, { status: "dispatched" });
  await prisma.questionnaireInstance.update({
    where: { id: instanceId },
    data: { status: "dispatched" },
  });

  return { instanceId, firstQuestionId: "q_a" };
}

describe("答卷状态常量", () => {
  it("RESPONSE_STATUSES 覆盖实现会写入的全部取值（回归：曾漏 reviewed）", () => {
    // 这四类取值分别由以下路径写入：
    //   draft      getOrCreateResponse 新建；审核退回时回置
    //   submitted  submitResponse
    //   reviewed   review approved
    //   withdrawn  withdrawInstance
    const writtenByCode = ["draft", "submitted", "reviewed", "withdrawn"];
    for (const s of writtenByCode) {
      expect(
        (RESPONSE_STATUSES as readonly string[]).includes(s),
        `RESPONSE_STATUSES 缺少会被写入的取值：${s}`
      ).toBe(true);
    }
  });

  it("RESPONSE_FILLABLE_STATUSES 只含 draft（与上面是两个不同用途的常量）", () => {
    expect([...RESPONSE_FILLABLE_STATUSES]).toEqual(["draft"]);
    // 可填写状态必须是全部状态的真子集
    for (const s of RESPONSE_FILLABLE_STATUSES) {
      expect((RESPONSE_STATUSES as readonly string[]).includes(s)).toBe(true);
    }
  });

  it("可以按 reviewed 过滤待审核列表（修复前该查询参数会被 422 拒掉）", async () => {
    const { instanceId } = await makeDispatchedInstance();

    // 取答卷 id 并填答 + 提交
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

    // 审核通过 → response 变为 reviewed
    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-responses/${responseId}/review`,
      { userId: USERS.reviewer, body: { result: "approved" } }
    );

    const row = await prisma.questionnaireResponse.findUnique({
      where: { id: responseId },
      select: { status: true },
    });
    expect(row?.status).toBe("reviewed");

    // 关键：status=reviewed 必须是一个合法的查询参数（修复前 422）
    const res = await apiRequest<{ items: { responseId: string }[] }>(
      client,
      "GET",
      "/api/v1/questionnaire-responses/review/pending?status=reviewed&page=1&pageSize=50",
      { userId: USERS.reviewer }
    );
    expect(res.status).toBe(200);
    const ids = expectData<{ items: { responseId: string }[] }>(res).items.map(
      (x) => x.responseId
    );
    expect(ids).toContain(responseId);
  });

  it("默认（不传 status）只列 submitted，已审核的不出现", async () => {
    const { instanceId } = await makeDispatchedInstance();
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
    await apiRequest(
      client,
      "POST",
      `/api/v1/questionnaire-responses/${responseId}/review`,
      { userId: USERS.reviewer, body: { result: "approved" } }
    );

    const res = await apiRequest<{ items: { responseId: string }[] }>(
      client,
      "GET",
      "/api/v1/questionnaire-responses/review/pending?page=1&pageSize=100",
      { userId: USERS.reviewer }
    );
    const ids = expectData<{ items: { responseId: string }[] }>(res).items.map(
      (x) => x.responseId
    );
    expect(ids).not.toContain(responseId);
  });
});
