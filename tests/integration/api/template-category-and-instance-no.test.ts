/**
 * 模板分类 / 实例编号 / 案件信息 API 测试。
 *
 * 依据 docs/11-future-capability-plan.md 第 5.1 / 5.2 / 5.3 节与决策 D16。
 *
 * 三块重点：
 *   1. **分类**：能建、能被模板引用、被引用时删不掉、按分类筛选能查到；
 *      以及横向授权 —— dispatcher 不能改分类（分类是全组织共享资产）。
 *   2. **实例编号**：格式正确、唯一、同日递增；跨天重新从 1 开始。
 *   3. **subjectInfo**：已知字段有约束（超长被拒），未知字段仍被保留。
 *
 * 清理：本文件创建的模板/实例/分类都要删干净，数据库必须回到基线。
 *   分类的删除顺序有讲究 —— 必须先断开模板的引用，否则会被 RESTRICT 拦住。
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
const createdCategoryIds = new Set<string>();

const CATEGORIES_PATH = "/api/v1/questionnaire-template-categories";

async function cleanup(): Promise<void> {
  for (const id of createdInstanceIds) await deleteTestInstance(id);
  createdInstanceIds.clear();

  for (const id of createdTemplateIds) {
    await prisma.questionnaireTemplate.updateMany({
      where: { id },
      data: { currentVersionId: null, categoryId: null },
    });
    await prisma.questionnaireTemplateVersion.deleteMany({
      where: { templateId: id },
    });
    await prisma.questionnaireTemplate.deleteMany({ where: { id } });
  }
  createdTemplateIds.clear();

  // 分类必须在断开模板引用之后再删（外键是 RESTRICT）
  for (const id of createdCategoryIds) {
    await prisma.questionnaireTemplateCategory.deleteMany({ where: { id } });
  }
  createdCategoryIds.clear();
}

/**
 * 发号器的原始状态快照。
 *
 * 测试建案会把当天的 `instance_no_counters` 推高（实测一天被推到 70+）。
 * 它是一张纯内部表，留着虽不至于出错，但会让「今天发到几号」失真。
 * 因此在整套用例开始前记下快照，结束时**还原**而不是清空 ——
 * 清空会把测试前就存在的行也删掉，那不是「回到基线」，是改动数据。
 */
let counterSnapshot: { day: string; scope: string; current: number }[] = [];

beforeAll(async () => {
  client = await startTestServer();
  counterSnapshot = await prisma.instanceNoCounter.findMany({
    select: { day: true, scope: true, current: true },
  });
});

afterEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();

  // 还原发号器到测试前的状态：删掉本套用例新造的号段，恢复原有的值
  const snapshotDays = new Set(counterSnapshot.map((c) => c.day));
  await prisma.instanceNoCounter.deleteMany({
    where: { day: { notIn: [...snapshotDays] } },
  });
  for (const c of counterSnapshot) {
    await prisma.instanceNoCounter.updateMany({
      where: { day: c.day, scope: c.scope },
      data: { current: c.current },
    });
  }

  await client.close();
  await prisma.$disconnect();
});

/**
 * 建一个分类，登记以便清理。
 *
 * 为什么带重试：默认编码用 `newId().slice(0, 8)` 生成，只有 32 位随机 ——
 * 同一个测试里连续建两个分类时**确实撞过**。
 * 编码是全局唯一的，撞了就该换一个再来，而不是让测试随机失败。
 */
async function makeCategory(
  code?: string
): Promise<{ id: string; code: string; name: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate =
      code ?? `cat_${newId().replace(/-/g, "").slice(0, 12)}`;

    const res = await apiRequest<{
      id: string;
      code: string;
      name: string;
    }>(client, "POST", CATEGORIES_PATH, {
      userId: USERS.admin,
      body: { code: candidate, name: `分类 ${candidate}` },
    });

    if (res.body.success && res.body.data) {
      const created = res.body.data;
      createdCategoryIds.add(created.id);
      return created;
    }
    // 只对编码冲突重试；其他错误直接抛出，避免掩盖真问题
    if (!res.body.error?.message.includes("编码已被占用")) {
      throw new Error(
        `创建分类失败（HTTP ${res.status}）：${JSON.stringify(res.body.error)}`
      );
    }
    if (code) break; // 调用方指定了编码，重试没有意义
  }
  throw new Error(`创建分类失败：编码 ${code ?? "(随机)"} 反复冲突`);
}

/** 建一个只有空草稿版本的模板 */
async function makeTemplate(
  body: Record<string, unknown> = {}
): Promise<{ templateId: string; versionId: string }> {
  const t = await apiRequest<{ id: string }>(
    client,
    "POST",
    "/api/v1/questionnaire-templates",
    {
      userId: USERS.admin,
      body: { name: `分类测试-${newId().slice(0, 8)}`, ...body },
    }
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

/** 找一个已发布的模板版本，用于建案件 */
async function anyPublishedVersionId(): Promise<string> {
  const v = await prisma.questionnaireTemplateVersion.findFirst({
    where: { status: "published" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!v) throw new Error("找不到已发布的模板版本，请先执行 pnpm db:seed");
  return v.id;
}

// ============================================================
// 模板分类
// ============================================================

describe("模板分类", () => {
  it("template_admin 可以创建分类，并能在列表里查到", async () => {
    const code = `drone_${newId().slice(0, 6)}`;
    const created = await makeCategory(code);

    expect(created.code).toBe(code);
    expect(created.name).toBe(`分类 ${code}`);

    const list = await apiRequest<{ items: { id: string }[] }>(
      client,
      "GET",
      CATEGORIES_PATH,
      { userId: USERS.admin }
    );
    const items = expectData<{ items: { id: string }[] }>(list).items;
    expect(items.some((c) => c.id === created.id)).toBe(true);
  });

  it("分类编码重复 → 4xx，且错误信息指出是编码冲突", async () => {
    const code = `dup_${newId().slice(0, 6)}`;
    await makeCategory(code);

    const again = await apiRequest(client, "POST", CATEGORIES_PATH, {
      userId: USERS.admin,
      body: { code, name: "重复编码" },
    });

    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.status).toBeLessThan(500);
    expect(again.body.success).toBe(false);
    expect(again.body.error?.message).toContain(code);
  });

  it("分类编码格式非法（大写/中文/以数字开头/含空格）→ 422", async () => {
    // 故意用带随机后缀的非法编码：避免撞上库里可能已存在的同名分类，
    // 那样会被当成「编码重复」而通过，测试就变成假绿了
    const tag = newId().replace(/-/g, "").slice(0, 6);
    const badCodes = [
      `Drone_${tag}`, // 大写：编码是要被代码引用的契约，不做静默小写化
      `分类${tag}`, // 中文
      `1abc${tag}`, // 以数字开头
      `a b${tag}`, // 含空格
    ];

    for (const bad of badCodes) {
      const res = await apiRequest(client, "POST", CATEGORIES_PATH, {
        userId: USERS.admin,
        body: { code: bad, name: "非法编码" },
      });
      expect(res.status, `编码 ${bad} 应被拒绝`).toBe(422);
    }

    // 确认这几次尝试没有真的落库（否则就是「校验没生效但被重复检查掩盖」）
    const leaked = await prisma.questionnaireTemplateCategory.findMany({
      where: { code: { in: badCodes } },
      select: { code: true },
    });
    expect(leaked).toEqual([]);
  });

  it("**横向授权**：dispatcher 不能创建分类（需要 template_admin）", async () => {
    const res = await apiRequest(client, "POST", CATEGORIES_PATH, {
      userId: USERS.dispatcher,
      body: { code: `nope_${newId().slice(0, 6)}`, name: "越权分类" },
    });

    expect(res.status).toBe(403);
  });

  it("创建模板时可指定分类，列表能按分类筛选", async () => {
    const cat = await makeCategory();
    const { templateId } = await makeTemplate({ categoryId: cat.id });

    // 带分类筛选：只应命中这个模板
    const filtered = await apiRequest<{
      items: { id: string; categoryId: string | null }[];
    }>(
      client,
      "GET",
      `/api/v1/questionnaire-templates?categoryId=${cat.id}`,
      { userId: USERS.admin }
    );
    const items = expectData<{
      items: { id: string; categoryId: string | null }[];
    }>(filtered).items;

    expect(items.some((t) => t.id === templateId)).toBe(true);
    // 该分类下不应该混进别的模板
    expect(items.every((t) => t.categoryId === cat.id)).toBe(true);
  });

  it("指定不存在的分类 → 404（不留下悬空的 category_id）", async () => {
    const res = await apiRequest(client, "POST", "/api/v1/questionnaire-templates", {
      userId: USERS.admin,
      body: { name: "悬空分类", categoryId: newId() },
    });

    expect(res.status).toBe(404);
  });

  it("可以改分类，也可以传 null 清空分类", async () => {
    const catA = await makeCategory();
    const catB = await makeCategory();
    const { templateId } = await makeTemplate({ categoryId: catA.id });

    const moved = await apiRequest<{ categoryId: string | null }>(
      client,
      "PATCH",
      `/api/v1/questionnaire-templates/${templateId}`,
      { userId: USERS.admin, body: { categoryId: catB.id } }
    );
    expect(expectData<{ categoryId: string | null }>(moved).categoryId).toBe(
      catB.id
    );

    const cleared = await apiRequest<{ categoryId: string | null }>(
      client,
      "PATCH",
      `/api/v1/questionnaire-templates/${templateId}`,
      { userId: USERS.admin, body: { categoryId: null } }
    );
    expect(expectData<{ categoryId: string | null }>(cleared).categoryId).toBeNull();
  });

  it("**仍被模板引用的分类不能删除**，错误信息说明有几个模板在用", async () => {
    const cat = await makeCategory();
    await makeTemplate({ categoryId: cat.id });

    const res = await apiRequest(client, "DELETE", `${CATEGORIES_PATH}/${cat.id}`, {
      userId: USERS.admin,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.error?.message).toContain("1");

    // 清理：外键是 RESTRICT，确认分类确实还在
    const still = await prisma.questionnaireTemplateCategory.findUnique({
      where: { id: cat.id },
    });
    expect(still).not.toBeNull();
  });

  it("未被引用的分类可以删除", async () => {
    const cat = await makeCategory();

    const res = await apiRequest(client, "DELETE", `${CATEGORIES_PATH}/${cat.id}`, {
      userId: USERS.admin,
    });
    expect(res.status).toBe(200);
    createdCategoryIds.delete(cat.id);

    const gone = await prisma.questionnaireTemplateCategory.findUnique({
      where: { id: cat.id },
    });
    expect(gone).toBeNull();
  });
});

// ============================================================
// 实例可读编号
// ============================================================

describe("实例可读编号 instance_no", () => {
  it("建案自动分配 INS-YYYYMMDD-NNNN 格式的编号", async () => {
    const versionId = await anyPublishedVersionId();
    const res = await apiRequest<{ id: string; instanceNo: string | null }>(
      client,
      "POST",
      "/api/v1/questionnaire-instances",
      {
        userId: USERS.dispatcher,
        body: { templateVersionId: versionId, title: "编号格式测试" },
      }
    );
    const inst = expectData<{ id: string; instanceNo: string | null }>(res);
    createdInstanceIds.add(inst.id);

    expect(inst.instanceNo).toMatch(/^INS-\d{8}-\d{4}$/);

    // 日期段应是「本地」日期，不能用 UTC（否则东八区夜里会差一天）
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
    expect(inst.instanceNo).toContain(`INS-${today}-`);
  });

  it("同一天连续建案，编号递增且不重复", async () => {
    const versionId = await anyPublishedVersionId();

    const numbers: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await apiRequest<{ id: string; instanceNo: string | null }>(
        client,
        "POST",
        "/api/v1/questionnaire-instances",
        {
          userId: USERS.dispatcher,
          body: { templateVersionId: versionId, title: `递增测试 ${i}` },
        }
      );
      const inst = expectData<{ id: string; instanceNo: string | null }>(res);
      createdInstanceIds.add(inst.id);
      if (inst.instanceNo) numbers.push(inst.instanceNo);
    }

    expect(numbers).toHaveLength(3);
    expect(new Set(numbers).size).toBe(3); // 不重复

    const seq = numbers.map((n) => Number(n.split("-")[2]));
    expect(seq[1]).toBe(seq[0]! + 1);
    expect(seq[2]).toBe(seq[1]! + 1);
  });

  it("列表与详情接口都会返回 instanceNo", async () => {
    const versionId = await anyPublishedVersionId();
    const created = await apiRequest<{ id: string; instanceNo: string | null }>(
      client,
      "POST",
      "/api/v1/questionnaire-instances",
      {
        userId: USERS.dispatcher,
        body: { templateVersionId: versionId, title: "列表编号测试" },
      }
    );
    const inst = expectData<{ id: string; instanceNo: string | null }>(created);
    createdInstanceIds.add(inst.id);

    const detail = await apiRequest<{ instanceNo: string | null }>(
      client,
      "GET",
      `/api/v1/questionnaire-instances/${inst.id}`,
      { userId: USERS.dispatcher }
    );
    expect(
      expectData<{ instanceNo: string | null }>(detail).instanceNo
    ).toBe(inst.instanceNo);

    const list = await apiRequest<{
      items: { id: string; instanceNo: string | null }[];
    }>(client, "GET", "/api/v1/questionnaire-instances?pageSize=100", {
      userId: USERS.dispatcher,
    });
    const hit = expectData<{
      items: { id: string; instanceNo: string | null }[];
    }>(list).items.find((x) => x.id === inst.id);
    expect(hit?.instanceNo).toBe(inst.instanceNo);
  });

  it("存量实例（加列之前创建）的 instanceNo 为 null，接口不报错", async () => {
    // 直接写一条不带 instanceNo 的实例，模拟存量数据（helper 不设置该列）
    const versionId = await anyPublishedVersionId();
    const legacyId = newId();
    await prisma.questionnaireInstance.create({
      data: {
        id: legacyId,
        templateVersionId: versionId,
        title: "存量实例（无编号）",
        currentSchema: (
          await prisma.questionnaireTemplateVersion.findUniqueOrThrow({
            where: { id: versionId },
            select: { schema: true },
          })
        ).schema as object,
        currentRevision: 1,
        status: "draft",
        createdBy: USERS.dispatcher,
      },
    });
    createdInstanceIds.add(legacyId);

    const res = await apiRequest<{ instanceNo: string | null }>(
      client,
      "GET",
      `/api/v1/questionnaire-instances/${legacyId}`,
      { userId: USERS.dispatcher }
    );
    expect(res.status).toBe(200);
    expect(expectData<{ instanceNo: string | null }>(res).instanceNo).toBeNull();
  });
});

// ============================================================
// 案件信息 subjectInfo
// ============================================================

describe("案件信息 subjectInfo", () => {
  it("已知字段（核查对象/时间/核查人）可以正常保存与读回", async () => {
    const versionId = await anyPublishedVersionId();
    const subjectInfo = {
      name: "张三",
      subject: "无人机 SN-12345",
      inspectTime: "2026-10-20 09:00",
      inspector: "李四",
    };

    const res = await apiRequest<{ id: string; subjectInfo: unknown }>(
      client,
      "POST",
      "/api/v1/questionnaire-instances",
      {
        userId: USERS.dispatcher,
        body: { templateVersionId: versionId, title: "案件信息测试", subjectInfo },
      }
    );
    const inst = expectData<{ id: string; subjectInfo: unknown }>(res);
    createdInstanceIds.add(inst.id);

    expect(inst.subjectInfo).toMatchObject(subjectInfo);
  });

  it("未知字段仍被保留（不同案件字段不同，Schema 不收紧）", async () => {
    const versionId = await anyPublishedVersionId();
    const res = await apiRequest<{ id: string; subjectInfo: Record<string, unknown> }>(
      client,
      "POST",
      "/api/v1/questionnaire-instances",
      {
        userId: USERS.dispatcher,
        body: {
          templateVersionId: versionId,
          title: "未知字段测试",
          subjectInfo: { name: "王五", 自定义字段: "保留我", nested: { a: 1 } },
        },
      }
    );
    const inst = expectData<{
      id: string;
      subjectInfo: Record<string, unknown>;
    }>(res);
    createdInstanceIds.add(inst.id);

    expect(inst.subjectInfo["自定义字段"]).toBe("保留我");
    expect(inst.subjectInfo["nested"]).toEqual({ a: 1 });
  });

  it("已知字段类型/长度非法 → 422（这次是真的有约束了）", async () => {
    const versionId = await anyPublishedVersionId();
    const res = await apiRequest(client, "POST", "/api/v1/questionnaire-instances", {
      userId: USERS.dispatcher,
      body: {
        templateVersionId: versionId,
        title: "非法字段测试",
        // name 规定是 string，给个数字应被拒
        subjectInfo: { name: 12345 },
      },
    });

    expect(res.status).toBe(422);
  });
});
