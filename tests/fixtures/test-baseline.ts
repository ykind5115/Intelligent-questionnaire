/**
 * 集成测试的「已发布基准模板」。
 *
 * ## 为什么需要它
 *
 * 原先多个测试文件依赖 `pnpm db:seed` 造出来的种子模板，去找「任意一个已发布版本」。
 * 这在真实使用中会碎：需求方把模板全部停用（合理操作）之后，
 * **93 个测试同时失败**，而失败原因与测试想验证的行为毫无关系。
 * 测试依赖「用户可能随时改动的业务数据」本身就是设计缺陷。
 *
 * 现在改为：测试自己在**跑之前**创建一份已发布基准模板，**跑完删掉**。
 * 这样无论用户怎么改模板，测试结果只取决于代码。
 *
 * ## 为什么内容要与 seed 的无人机问卷保持一致
 *
 * `tests/fixtures/ai-cases/eval-cases.ts` 的修改类用例断言的是具体题干
 * （「姓名」「身份证号」「无人机」「联系方式」必须被保留）。
 * 这是**有意义的**断言 —— 它检验「增量修改不能弄丢原有内容」。
 * 因此基准模板沿用同一套题干与 id，让这些断言继续成立，
 * 而不是把断言改松（那等于把真正要测的东西测没了）。
 *
 * ## 生命周期
 *
 * 由 `tests/global-setup.ts` 在整个测试运行前后调用：
 *   setup    → ensureTestBaseline()
 *   teardown → removeTestBaseline()
 * 因此库不会留下残渣。
 */
import { v5 as uuidv5 } from "uuid";

import { prisma } from "../../src/database/client.js";
import { questionnaireSchema } from "../../src/modules/questionnaire/schema/questionnaire.schema.js";

/** 与 helpers.ts 相同的确定性 id 命名空间 */
const NS = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";

const idOf = (kind: string, name: string): string =>
  uuidv5(`${kind}:${name}`, NS);

export const BASELINE_TEMPLATE_ID = idOf("test-baseline-template", "v1");
export const BASELINE_VERSION_ID = idOf("test-baseline-version", "v1");

/** 名称带明显前缀，便于人一眼看出这是测试数据 */
export const BASELINE_TEMPLATE_NAME = "__测试基准模板（自动创建，勿手动使用）__";

export const BASELINE_ADMIN_ID = idOf("user", "admin");

/**
 * 基准结构：与 `prisma/seed.ts` 的「无人机黑飞核查问卷」同构。
 *
 * 通过 questionnaireSchema.parse 构造，保证它本身就是合法结构 ——
 * 与 seed.ts 和 tests/fixtures/questionnaire.ts 的做法一致。
 */
function buildBaselineSchema() {
  const title = (t: string) => t;

  return questionnaireSchema.parse({
    id: BASELINE_VERSION_ID,
    title: "无人机黑飞核查问卷",
    description: "集成测试基准问卷（自动创建）",
    version: 1,
    sections: [
      {
        id: "sec_drone_basic",
        title: "基本信息",
        order: 1,
        questions: [
          { id: "q_name", type: "text", title: title("姓名"), required: true, order: 1 },
          { id: "q_id_card", type: "text", title: "身份证号", required: true, order: 2 },
          { id: "q_phone", type: "text", title: "联系方式", required: false, order: 3 },
          { id: "q_address", type: "text", title: "住址", required: false, order: 4 },
        ],
      },
      {
        id: "sec_drone_device",
        title: "无人机情况",
        order: 2,
        questions: [
          { id: "q_has_drone", type: "boolean", title: "是否拥有无人机？", required: true, order: 1 },
          { id: "q_drone_model", type: "text", title: "无人机型号", required: false, order: 2 },
          { id: "q_drone_count", type: "number", title: "无人机数量", required: false, order: 3 },
          {
            id: "q_drone_purpose",
            type: "multiple_choice",
            title: "无人机用途",
            required: false,
            order: 4,
            options: [
              { id: "opt_purpose_fun", label: "娱乐", value: "fun", order: 1 },
              { id: "opt_purpose_biz", label: "商业", value: "biz", order: 2 },
              { id: "opt_purpose_aerial", label: "航拍", value: "aerial", order: 3 },
              { id: "opt_purpose_other", label: "其他", value: "other", order: 4 },
            ],
          },
        ],
      },
      {
        id: "sec_drone_flight",
        title: "飞行情况",
        order: 3,
        questions: [
          { id: "q_ever_flown", type: "boolean", title: "是否进行过飞行？", required: true, order: 1 },
          { id: "q_flight_date", type: "date", title: "最近一次飞行日期", required: false, order: 2 },
          { id: "q_flight_place", type: "text", title: "飞行地点", required: false, order: 3 },
          { id: "q_flight_reason", type: "textarea", title: "飞行原因", required: false, order: 4 },
        ],
      },
    ],
  });
}

/**
 * 创建（或修复）基准模板并确保它是「已发布」。
 *
 * 用 upsert 而不是 create：测试可能被中断，上次的残渣还在；
 * upsert 能把它修复成可用状态，而不是报主键冲突。
 */
export async function ensureTestBaseline(): Promise<{
  templateId: string;
  versionId: string;
}> {
  const schema = buildBaselineSchema();

  await prisma.questionnaireTemplate.upsert({
    where: { id: BASELINE_TEMPLATE_ID },
    create: {
      id: BASELINE_TEMPLATE_ID,
      name: BASELINE_TEMPLATE_NAME,
      description: "集成测试用的已发布基准问卷，由 globalSetup 创建、跑完删除",
      status: "published",
      createdBy: BASELINE_ADMIN_ID,
    },
    update: {
      name: BASELINE_TEMPLATE_NAME,
      status: "published",
    },
  });

  await prisma.questionnaireTemplateVersion.upsert({
    where: { id: BASELINE_VERSION_ID },
    create: {
      id: BASELINE_VERSION_ID,
      templateId: BASELINE_TEMPLATE_ID,
      versionNo: 1,
      schema: schema as object,
      changeNote: "集成测试基准",
      status: "published",
      sourceType: "manual",
      createdBy: BASELINE_ADMIN_ID,
    },
    update: {
      schema: schema as object,
      status: "published",
    },
  });

  // 模板要指向这份版本，否则「当前版本」为空，列表页看起来是空的
  await prisma.questionnaireTemplate.update({
    where: { id: BASELINE_TEMPLATE_ID },
    data: { currentVersionId: BASELINE_VERSION_ID },
  });

  return { templateId: BASELINE_TEMPLATE_ID, versionId: BASELINE_VERSION_ID };
}

/**
 * 删除基准模板。
 *
 * 顺序有讲究：先断开 current_version_id 的外键，再删版本，最后删模板 ——
 * 否则会被循环引用挡住（模板 ↔ 版本互为外键）。
 * 若基准模板上被测试派生过实例，则一并清掉（用固定 id 判定，不会误伤用户数据）。
 */
export async function removeTestBaseline(): Promise<void> {
  const exists = await prisma.questionnaireTemplate.findUnique({
    where: { id: BASELINE_TEMPLATE_ID },
    select: { id: true },
  });
  if (!exists) return;

  // 用基准版本派生的实例（只可能是测试造的）
  const instances = await prisma.questionnaireInstance.findMany({
    where: { templateVersionId: BASELINE_VERSION_ID },
    select: { id: true },
  });
  const instanceIds = instances.map((i) => i.id);

  if (instanceIds.length > 0) {
    await prisma.reviewRecord.deleteMany({
      where: { response: { questionnaireInstanceId: { in: instanceIds } } },
    });
    await prisma.questionnaireAnswer.deleteMany({
      where: { response: { questionnaireInstanceId: { in: instanceIds } } },
    });
    await prisma.questionnaireResponse.deleteMany({
      where: { questionnaireInstanceId: { in: instanceIds } },
    });
    await prisma.dispatchTask.deleteMany({
      where: { questionnaireInstanceId: { in: instanceIds } },
    });
    await prisma.aiToolExecution.deleteMany({
      where: { questionnaireInstanceId: { in: instanceIds } },
    });
    await prisma.questionnaireRevision.deleteMany({
      where: { questionnaireInstanceId: { in: instanceIds } },
    });
    await prisma.questionnaireInstance.deleteMany({
      where: { id: { in: instanceIds } },
    });
  }

  await prisma.questionnaireTemplate.update({
    where: { id: BASELINE_TEMPLATE_ID },
    data: { currentVersionId: null },
  });
  await prisma.questionnaireTemplateVersion.deleteMany({
    where: { templateId: BASELINE_TEMPLATE_ID },
  });
  await prisma.questionnaireTemplate.deleteMany({
    where: { id: BASELINE_TEMPLATE_ID },
  });
}
