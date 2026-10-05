/**
 * 测试用问卷夹具。
 *
 * 结构刻意贴近真实业务（无人机黑飞核查），
 * 覆盖 text / textarea / boolean / single_choice / multiple_choice / number / date。
 */
import {
  questionnaireSchema,
  type QuestionnaireSchema,
} from "../../src/modules/questionnaire/schema/questionnaire.schema.js";

/**
 * 构造一份合法问卷。
 *
 * 注意：这里**故意**不直接手写完整对象再 as，
 * 而是通过 questionnaireSchema.parse 得到，
 * 保证夹具本身就是合法结构（与 seed.ts 的做法一致）。
 */
export function makeBaseSchema(
  overrides: Partial<QuestionnaireSchema> = {}
): QuestionnaireSchema {
  return questionnaireSchema.parse({
    id: "schema-fixture",
    title: "无人机黑飞核查问卷",
    description: "测试夹具",
    version: 1,
    sections: [
      {
        id: "sec_basic",
        title: "基本信息",
        order: 1,
        questions: [
          { id: "q_name", type: "text", title: "姓名", required: true, order: 1 },
          {
            id: "q_phone",
            type: "text",
            title: "联系方式",
            required: false,
            order: 2,
          },
        ],
      },
      {
        id: "sec_drone",
        title: "无人机情况",
        order: 2,
        questions: [
          {
            id: "q_has_drone",
            type: "boolean",
            title: "是否拥有无人机？",
            required: true,
            order: 1,
          },
          {
            id: "q_purpose",
            type: "multiple_choice",
            title: "无人机用途",
            required: false,
            order: 2,
            options: [
              { id: "opt_1", label: "娱乐", value: "娱乐", order: 1 },
              { id: "opt_2", label: "商业", value: "商业", order: 2 },
            ],
          },
        ],
      },
    ],
    ...overrides,
  });
}

/** 深拷贝，避免测试之间互相污染 */
export function cloneFixture(s: QuestionnaireSchema): QuestionnaireSchema {
  return structuredClone(s);
}
