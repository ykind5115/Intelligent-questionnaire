/**
 * 测试数据 seed。
 *
 * 依据决策 D11（固定测试账号）与 D5（先有测试数据）。
 *
 * 设计要点：
 *   1. 用户 ID 使用确定性 UUIDv5（由 username 派生），
 *      这样每次重跑 seed 得到相同 ID，
 *      开发时可以直接把 `x-user-id: <某个固定 UUID>` 写进 Postman，
 *      不会因为重跑 seed 而失效。
 *   2. 密码哈希为占位值：V1 不做登录接口（D11），
 *      鉴权走 x-user-id 中间件，因此不需要真实密码校验。
 *   3. 问卷结构全部经 questionnaireSchema 校验后落库，
 *      保证 seed 数据本身就是「合法问卷」的样板。
 */
import { v5 as uuidv5 } from "uuid";
import { prisma } from "../src/database/client.js";
import {
  questionnaireSchema,
  type QuestionnaireSchema,
} from "../src/modules/questionnaire/schema/questionnaire.schema.js";
import { toJsonValue } from "../src/shared/utils/json.js";

/** 固定命名空间，保证用户名 → ID 的映射稳定 */
const ID_NAMESPACE = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";

/** 由用户名派生确定性 UUID */
function userIdOf(username: string): string {
  return uuidv5(`user:${username}`, ID_NAMESPACE);
}

function idOf(kind: string, key: string): string {
  return uuidv5(`${kind}:${key}`, ID_NAMESPACE);
}

// ============================================================
// 测试账号（决策 D11）
// ============================================================

const TEST_USERS = [
  {
    username: "admin",
    displayName: "模板管理员",
    roles: ["template_admin"],
  },
  {
    username: "dispatcher1",
    displayName: "下发人员一号",
    roles: ["dispatcher"],
  },
  {
    username: "investigator1",
    displayName: "调查人员一号",
    roles: ["investigator"],
  },
  {
    username: "reviewer1",
    displayName: "审核人员一号",
    roles: ["reviewer"],
  },
] as const;

// ============================================================
// 问卷结构构造辅助
// ============================================================

interface QSpec {
  id: string;
  type: QuestionnaireSchema["sections"][number]["questions"][number]["type"];
  title: string;
  required?: boolean;
  options?: string[];
}

interface SectionSpec {
  id: string;
  title: string;
  description?: string;
  questions: QSpec[];
}

function buildSchema(
  id: string,
  title: string,
  description: string,
  sectionSpecs: SectionSpec[]
): QuestionnaireSchema {
  const raw = {
    id,
    title,
    description,
    version: 1,
    sections: sectionSpecs.map((sec, si) => ({
      id: sec.id,
      title: sec.title,
      ...(sec.description ? { description: sec.description } : {}),
      order: si + 1,
      questions: sec.questions.map((q, qi) => ({
        id: q.id,
        type: q.type,
        title: q.title,
        required: q.required ?? true,
        order: qi + 1,
        ...(q.options
          ? {
              options: q.options.map((label, oi) => ({
                id: `${q.id}_opt${oi + 1}`,
                label,
                value: label,
                order: oi + 1,
              })),
            }
          : {}),
      })),
    })),
  };

  // 落库前强制校验：seed 数据必须本身就是合法问卷
  return questionnaireSchema.parse(raw);
}

// ============================================================
// 模板一：无人机黑飞核查问卷
// ============================================================

const DRONE_TEMPLATE_ID = idOf("template", "drone-black-flight");
const DRONE_VERSION_ID = idOf("template-version", "drone-black-flight:v1");

const droneSchema = buildSchema(
  DRONE_VERSION_ID,
  "无人机黑飞核查问卷",
  "用于无人机违规飞行相关调查",
  [
    {
      id: "sec_drone_basic",
      title: "基本信息",
      questions: [
        { id: "q_name", type: "text", title: "姓名" },
        { id: "q_id_card", type: "text", title: "身份证号" },
        { id: "q_phone", type: "text", title: "联系方式", required: false },
        { id: "q_address", type: "text", title: "住址", required: false },
      ],
    },
    {
      id: "sec_drone_device",
      title: "无人机情况",
      questions: [
        { id: "q_has_drone", type: "boolean", title: "是否拥有无人机？" },
        { id: "q_drone_model", type: "text", title: "无人机型号", required: false },
        { id: "q_drone_count", type: "number", title: "无人机数量", required: false },
        {
          id: "q_drone_purpose",
          type: "multiple_choice",
          title: "无人机用途",
          required: false,
          options: ["娱乐", "商业", "航拍", "其他"],
        },
        {
          id: "q_buy_channel",
          type: "single_choice",
          title: "购买渠道",
          required: false,
          options: ["线上官方店", "线下实体店", "二手交易", "他人赠送", "不清楚"],
        },
      ],
    },
    {
      id: "sec_drone_flight",
      title: "飞行情况",
      questions: [
        { id: "q_ever_flown", type: "boolean", title: "是否进行过飞行？" },
        { id: "q_flight_date", type: "date", title: "最近一次飞行日期", required: false },
        { id: "q_flight_place", type: "text", title: "飞行地点", required: false },
        { id: "q_flight_reason", type: "textarea", title: "飞行原因", required: false },
        { id: "q_flight_count", type: "number", title: "累计飞行次数", required: false },
      ],
    },
    {
      id: "sec_drone_relation",
      title: "关联人员",
      questions: [
        { id: "q_with_others", type: "boolean", title: "是否与他人共同飞行？" },
        { id: "q_others_detail", type: "textarea", title: "共同飞行人员情况", required: false },
      ],
    },
  ]
);

// ============================================================
// 模板二：宠物饲养规范核查问卷
// ============================================================

const PET_TEMPLATE_ID = idOf("template", "pet-keeping");
const PET_VERSION_ID = idOf("template-version", "pet-keeping:v1");

const petSchema = buildSchema(
  PET_VERSION_ID,
  "宠物饲养规范核查问卷",
  "用于宠物饲养合规性调查",
  [
    {
      id: "sec_pet_basic",
      title: "基本信息",
      questions: [
        { id: "p_name", type: "text", title: "饲养人姓名" },
        { id: "p_phone", type: "text", title: "联系方式", required: false },
        { id: "p_address", type: "text", title: "饲养地址" },
      ],
    },
    {
      id: "sec_pet_animal",
      title: "宠物情况",
      questions: [
        {
          id: "p_species",
          type: "single_choice",
          title: "宠物种类",
          options: ["犬", "猫", "鸟类", "爬行类", "其他"],
        },
        { id: "p_count", type: "number", title: "饲养数量" },
        { id: "p_breed", type: "text", title: "品种", required: false },
      ],
    },
    {
      id: "sec_pet_compliance",
      title: "合规情况",
      questions: [
        { id: "p_licensed", type: "boolean", title: "是否办理养犬登记？" },
        { id: "p_vaccinated", type: "boolean", title: "是否按期接种疫苗？" },
        { id: "p_vaccine_date", type: "date", title: "最近接种日期", required: false },
        { id: "p_note", type: "textarea", title: "其他需要说明的情况", required: false },
      ],
    },
  ]
);

// ============================================================
// 执行 seed
// ============================================================

async function main(): Promise<void> {
  console.log("开始写入测试数据...\n");

  // ---------- 用户 ----------
  for (const u of TEST_USERS) {
    const id = userIdOf(u.username);
    await prisma.user.upsert({
      where: { id },
      update: {
        displayName: u.displayName,
        roles: [...u.roles],
      },
      create: {
        id,
        username: u.username,
        displayName: u.displayName,
        // V1 无登录接口（D11），占位值
        passwordHash: null,
        status: "active",
        roles: [...u.roles],
      },
    });
    console.log(`  用户 ${u.username.padEnd(14)} id=${id}  roles=${u.roles.join(",")}`);
  }

  const adminId = userIdOf("admin");
  const dispatcherId = userIdOf("dispatcher1");
  const investigatorId = userIdOf("investigator1");

  // ---------- 模板 + 版本 ----------
  const templates = [
    {
      id: DRONE_TEMPLATE_ID,
      versionId: DRONE_VERSION_ID,
      name: "无人机黑飞核查问卷",
      description: "用于无人机违规飞行相关调查",
      schema: droneSchema,
    },
    {
      id: PET_TEMPLATE_ID,
      versionId: PET_VERSION_ID,
      name: "宠物饲养规范核查问卷",
      description: "用于宠物饲养合规性调查",
      schema: petSchema,
    },
  ];

  console.log("");

  for (const t of templates) {
    // 循环外键：先建模板（currentVersionId 暂空），再建版本，最后回填
    await prisma.questionnaireTemplate.upsert({
      where: { id: t.id },
      update: { name: t.name, description: t.description },
      create: {
        id: t.id,
        name: t.name,
        description: t.description,
        status: "published",
        createdBy: adminId,
      },
    });

    await prisma.questionnaireTemplateVersion.upsert({
      where: { id: t.versionId },
      update: { schema: toJsonValue(t.schema), status: "published" },
      create: {
        id: t.versionId,
        templateId: t.id,
        versionNo: 1,
        schema: toJsonValue(t.schema),
        changeNote: "初始版本",
        status: "published",
        sourceType: "manual",
        createdBy: adminId,
      },
    });

    await prisma.questionnaireTemplate.update({
      where: { id: t.id },
      data: { currentVersionId: t.versionId, status: "published" },
    });

    const qCount = t.schema.sections.reduce((n, s) => n + s.questions.length, 0);
    console.log(
      `  模板 ${t.name.padEnd(14)} sections=${t.schema.sections.length} questions=${qCount}`
    );
  }

  // ---------- 问卷实例 ----------
  const instanceId = idOf("instance", "zhangsan-drone");
  const revisionId = idOf("revision", "zhangsan-drone:1");

  await prisma.questionnaireInstance.upsert({
    where: { id: instanceId },
    update: {},
    create: {
      id: instanceId,
      templateVersionId: DRONE_VERSION_ID,
      title: "张三 - 无人机黑飞核查",
      subjectInfo: toJsonValue({
        name: "张三",
        idCard: "3301**********1234",
        phone: "138****0000",
        address: "某市某区某街道",
      }),
      // 实例从模板版本克隆出自己的结构（04 文档第 14 节）
      currentSchema: toJsonValue(droneSchema),
      currentRevision: 1,
      status: "draft",
      createdBy: dispatcherId,
    },
  });

  // 实例出生即带 Revision 1 快照（04 文档第 46 节）
  await prisma.questionnaireRevision.upsert({
    where: {
      questionnaireInstanceId_revisionNo: {
        questionnaireInstanceId: instanceId,
        revisionNo: 1,
      },
    },
    update: {},
    create: {
      id: revisionId,
      questionnaireInstanceId: instanceId,
      revisionNo: 1,
      schemaSnapshot: toJsonValue(droneSchema),
      operationType: "create_instance",
      createdBy: dispatcherId,
    },
  });

  console.log(`\n  实例 张三 - 无人机黑飞核查  id=${instanceId}  revision=1`);

  console.log(`
完成。

开发时可用以下固定账号（决策 D11，走请求头 x-user-id）：

  admin          ${userIdOf("admin")}
  dispatcher1    ${dispatcherId}
  investigator1  ${investigatorId}
  reviewer1      ${userIdOf("reviewer1")}
`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error("seed 失败：", e);
    await prisma.$disconnect();
    process.exit(1);
  });
