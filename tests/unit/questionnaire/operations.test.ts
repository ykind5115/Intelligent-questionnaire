/**
 * Operation 层单元测试。
 *
 * 对应 docs/06-proj_init.md 第 57 节的 V1 测试重点：
 *   - Questionnaire Operation（add / update / remove / move）
 *   - Schema Validation（非法题型、缺失 options、非法问卷）
 *
 * 这一层是纯函数，因此测试不需要数据库，也不依赖 AI。
 */
import { describe, expect, it } from "vitest";

import {
  addSection,
  addQuestion,
  updateSection,
  updateQuestion,
  removeQuestion,
  moveQuestion,
  makeSequenceIdFactory,
} from "../../../src/modules/questionnaire/operations/index.js";
import { ErrorCode, isOperationError } from "../../../src/shared/errors/index.js";
import { makeBaseSchema } from "../../fixtures/questionnaire.js";

/** 断言抛出指定错误码 */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(isOperationError(e)).toBe(true);
    if (isOperationError(e)) {
      expect(e.code).toBe(code);
    }
    return;
  }
  throw new Error(`期望抛出 ${code}，但没有抛出任何错误`);
}

/** 每次拿一份全新夹具 + 确定性 ID 生成器 */
function setup() {
  return { schema: makeBaseSchema(), ids: makeSequenceIdFactory() };
}

// ============================================================
// 不可变性：所有 Operation 都不得修改入参
// ============================================================

describe("Operation 的纯函数性质", () => {
  it("所有操作都不修改传入的 schema（不可变）", () => {
    const { schema, ids } = setup();
    const snapshot = JSON.stringify(schema);

    addSection(schema, { title: "新分组" }, ids);
    addQuestion(
      schema,
      { sectionId: "sec_basic", type: "text", title: "新问题" },
      ids
    );
    updateSection(schema, { sectionId: "sec_basic", title: "改名" });
    updateQuestion(schema, { questionId: "q_name", title: "改名" });
    removeQuestion(schema, { questionId: "q_name" });
    moveQuestion(schema, {
      questionId: "q_name",
      targetSectionId: "sec_drone",
    });

    expect(JSON.stringify(schema)).toBe(snapshot);
  });
});

// ============================================================
// add_section
// ============================================================

describe("addSection", () => {
  it("新增分组并返回后端生成的 ID", () => {
    const { schema, ids } = setup();

    const result = addSection(schema, { title: "团伙关系调查" }, ids);

    expect(result.section.id).toMatch(/^sec_/);
    expect(result.section.title).toBe("团伙关系调查");
    expect(result.schema.sections).toHaveLength(3);

    const created = result.schema.sections.find(
      (s) => s.id === result.section.id
    );
    expect(created).toBeDefined();
    expect(created?.questions).toEqual([]);
  });

  it("order 由后端重算：连续且从 1 开始", () => {
    const { schema, ids } = setup();

    const result = addSection(schema, { title: "第三组" }, ids);

    expect(result.schema.sections.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it("拒绝嵌套分组（V1 不支持，03 文档第 5A 节）", () => {
    const { schema, ids } = setup();

    expectCode(
      () =>
        addSection(
          schema,
          { title: "嵌套组", parentSectionId: "sec_basic" },
          ids
        ),
      ErrorCode.NESTED_SECTION_UNSUPPORTED
    );
  });

  it("拒绝空标题", () => {
    const { schema, ids } = setup();
    expectCode(
      () => addSection(schema, { title: "   " }, ids),
      ErrorCode.INVALID_PARAMETER
    );
  });

  it("标题超长被拒绝", () => {
    const { schema, ids } = setup();
    expectCode(
      () => addSection(schema, { title: "x".repeat(201) }, ids),
      ErrorCode.INVALID_PARAMETER
    );
  });
});

// ============================================================
// add_question
// ============================================================

describe("addQuestion", () => {
  it("向已有分组新增问题", () => {
    const { schema, ids } = setup();

    const result = addQuestion(
      schema,
      {
        sectionId: "sec_drone",
        type: "text",
        title: "无人机型号",
        required: true,
      },
      ids
    );

    expect(result.question.id).toMatch(/^q_/);
    const section = result.schema.sections.find((s) => s.id === "sec_drone");
    expect(section?.questions).toHaveLength(3);
    expect(section?.questions.at(-1)?.title).toBe("无人机型号");
    expect(section?.questions.at(-1)?.required).toBe(true);
  });

  it("题干 order 重算为连续序列", () => {
    const { schema, ids } = setup();

    const result = addQuestion(
      schema,
      { sectionId: "sec_basic", type: "text", title: "身份证号" },
      ids
    );

    const section = result.schema.sections.find((s) => s.id === "sec_basic");
    expect(section?.questions.map((q) => q.order)).toEqual([1, 2, 3]);
  });

  it("分组不存在时报 SECTION_NOT_FOUND", () => {
    const { schema, ids } = setup();
    expectCode(
      () =>
        addQuestion(
          schema,
          { sectionId: "sec_not_exist", type: "text", title: "x" },
          ids
        ),
      ErrorCode.SECTION_NOT_FOUND
    );
  });

  it("非法题型被拒绝", () => {
    const { schema, ids } = setup();
    expectCode(
      () =>
        addQuestion(
          schema,
          {
            sectionId: "sec_basic",
            // 故意用非法值，模拟模型幻觉
            type: "unknown_type" as never,
            title: "x",
          },
          ids
        ),
      ErrorCode.INVALID_QUESTION_TYPE
    );
  });

  it("单选题缺少 options 被拒绝", () => {
    const { schema, ids } = setup();
    expectCode(
      () =>
        addQuestion(
          schema,
          {
            sectionId: "sec_basic",
            type: "single_choice",
            title: "购买渠道",
          },
          ids
        ),
      ErrorCode.INVALID_OPTIONS
    );
  });

  it("单选题只有 1 个选项被拒绝", () => {
    const { schema, ids } = setup();
    expectCode(
      () =>
        addQuestion(
          schema,
          {
            sectionId: "sec_basic",
            type: "single_choice",
            title: "购买渠道",
            options: [{ label: "线上" }],
          },
          ids
        ),
      ErrorCode.INVALID_OPTIONS
    );
  });

  it("多选题选项重复被拒绝", () => {
    const { schema, ids } = setup();
    expectCode(
      () =>
        addQuestion(
          schema,
          {
            sectionId: "sec_basic",
            type: "multiple_choice",
            title: "用途",
            options: [{ label: "娱乐" }, { label: "娱乐" }],
          },
          ids
        ),
      ErrorCode.INVALID_OPTIONS
    );
  });

  it("非选择题携带 options 被拒绝", () => {
    const { schema, ids } = setup();
    expectCode(
      () =>
        addQuestion(
          schema,
          {
            sectionId: "sec_basic",
            type: "text",
            title: "姓名",
            options: [{ label: "甲" }, { label: "乙" }],
          },
          ids
        ),
      ErrorCode.INVALID_OPTIONS
    );
  });

  it("选项 ID 与 order 由后端生成，value 缺省时取 label", () => {
    const { schema, ids } = setup();

    const result = addQuestion(
      schema,
      {
        sectionId: "sec_drone",
        type: "single_choice",
        title: "购买渠道",
        options: [{ label: "线上官方店" }, { label: "线下实体店", value: "offline" }],
      },
      ids
    );

    const q = result.schema.sections
      .find((s) => s.id === "sec_drone")
      ?.questions.find((x) => x.id === result.question.id);

    expect(q?.options?.map((o) => o.order)).toEqual([1, 2]);
    expect(q?.options?.every((o) => o.id.startsWith("opt_"))).toBe(true);
    expect(q?.options?.[0]?.value).toBe("线上官方店");
    expect(q?.options?.[1]?.value).toBe("offline");
  });

  it("required 缺省为 false", () => {
    const { schema, ids } = setup();
    const result = addQuestion(
      schema,
      { sectionId: "sec_basic", type: "text", title: "备注" },
      ids
    );
    const q = result.schema.sections
      .find((s) => s.id === "sec_basic")
      ?.questions.find((x) => x.id === result.question.id);
    expect(q?.required).toBe(false);
  });
});

// ============================================================
// update_section
// ============================================================

describe("updateSection", () => {
  it("修改分组标题", () => {
    const { schema } = setup();

    const result = updateSection(schema, {
      sectionId: "sec_drone",
      title: "团伙及关联人员调查",
    });

    expect(
      result.schema.sections.find((s) => s.id === "sec_drone")?.title
    ).toBe("团伙及关联人员调查");
  });

  it("只改传入的字段，其余保持原样（最小变更）", () => {
    const { schema } = setup();

    const result = updateSection(schema, {
      sectionId: "sec_drone",
      description: "补充说明",
    });

    const sec = result.schema.sections.find((s) => s.id === "sec_drone");
    expect(sec?.title).toBe("无人机情况");
    expect(sec?.description).toBe("补充说明");
    expect(sec?.questions).toHaveLength(2);
  });

  it("分组不存在时报错", () => {
    const { schema } = setup();
    expectCode(
      () => updateSection(schema, { sectionId: "nope", title: "x" }),
      ErrorCode.SECTION_NOT_FOUND
    );
  });

  it("空标题被拒绝", () => {
    const { schema } = setup();
    expectCode(
      () => updateSection(schema, { sectionId: "sec_basic", title: "  " }),
      ErrorCode.INVALID_PARAMETER
    );
  });
});

// ============================================================
// update_question
// ============================================================

describe("updateQuestion", () => {
  it("修改题干，id 保持不变（不改变历史答案关联）", () => {
    const { schema } = setup();

    const result = updateQuestion(schema, {
      questionId: "q_name",
      title: "被调查人姓名",
    });

    const q = result.schema.sections
      .find((s) => s.id === "sec_basic")
      ?.questions.find((x) => x.id === "q_name");
    expect(q?.title).toBe("被调查人姓名");
    expect(q?.id).toBe("q_name");
  });

  it("修改 required", () => {
    const { schema } = setup();
    const result = updateQuestion(schema, {
      questionId: "q_phone",
      required: true,
    });
    const q = result.schema.sections
      .find((s) => s.id === "sec_basic")
      ?.questions.find((x) => x.id === "q_phone");
    expect(q?.required).toBe(true);
  });

  it("text → single_choice 时必须提供 options", () => {
    const { schema } = setup();
    expectCode(
      () =>
        updateQuestion(schema, {
          questionId: "q_name",
          type: "single_choice",
        }),
      ErrorCode.INVALID_OPTIONS
    );
  });

  it("text → single_choice 且提供 options 时成功", () => {
    const { schema, ids } = setup();

    const result = updateQuestion(
      schema,
      {
        questionId: "q_name",
        type: "single_choice",
        options: [{ label: "是" }, { label: "否" }],
      },
      ids
    );

    const q = result.schema.sections
      .find((s) => s.id === "sec_basic")
      ?.questions.find((x) => x.id === "q_name");
    expect(q?.type).toBe("single_choice");
    expect(q?.options).toHaveLength(2);
  });

  it("multiple_choice → text 时自动丢弃 options（否则 Schema 不合法）", () => {
    const { schema } = setup();

    const result = updateQuestion(schema, {
      questionId: "q_purpose",
      type: "text",
    });

    const q = result.schema.sections
      .find((s) => s.id === "sec_drone")
      ?.questions.find((x) => x.id === "q_purpose");
    expect(q?.type).toBe("text");
    expect(q?.options).toBeUndefined();
  });

  it("题型不变时整体替换选项，并重新生成选项 ID", () => {
    const { schema, ids } = setup();

    const result = updateQuestion(
      schema,
      {
        questionId: "q_purpose",
        options: [{ label: "航拍" }, { label: "测绘" }, { label: "其他" }],
      },
      ids
    );

    const q = result.schema.sections
      .find((s) => s.id === "sec_drone")
      ?.questions.find((x) => x.id === "q_purpose");
    expect(q?.options?.map((o) => o.label)).toEqual(["航拍", "测绘", "其他"]);
    expect(q?.options?.map((o) => o.order)).toEqual([1, 2, 3]);
    expect(q?.options?.every((o) => o.id.startsWith("opt_"))).toBe(true);
  });

  it("问题不存在时报 QUESTION_NOT_FOUND", () => {
    const { schema } = setup();
    expectCode(
      () => updateQuestion(schema, { questionId: "nope", title: "x" }),
      ErrorCode.QUESTION_NOT_FOUND
    );
  });

  it("非法题型被拒绝", () => {
    const { schema } = setup();
    expectCode(
      () =>
        updateQuestion(schema, {
          questionId: "q_name",
          type: "radio" as never,
        }),
      ErrorCode.INVALID_QUESTION_TYPE
    );
  });

  it("空题干被拒绝", () => {
    const { schema } = setup();
    expectCode(
      () => updateQuestion(schema, { questionId: "q_name", title: " " }),
      ErrorCode.INVALID_PARAMETER
    );
  });
});

// ============================================================
// remove_question
// ============================================================

describe("removeQuestion", () => {
  it("删除问题并返回被删信息", () => {
    const { schema } = setup();

    const result = removeQuestion(schema, { questionId: "q_phone" });

    expect(result.removed.id).toBe("q_phone");
    expect(result.removed.sectionId).toBe("sec_basic");
    const section = result.schema.sections.find((s) => s.id === "sec_basic");
    expect(section?.questions).toHaveLength(1);
  });

  it("删除后 order 重排为连续序列", () => {
    const { schema } = setup();

    // 先加一道题，让 sec_basic 有 3 道
    const withThree = addQuestion(
      schema,
      { sectionId: "sec_basic", type: "text", title: "身份证号" },
      makeSequenceIdFactory()
    ).schema;

    // 删掉中间那道
    const result = removeQuestion(withThree, { questionId: "q_phone" });

    const section = result.schema.sections.find((s) => s.id === "sec_basic");
    expect(section?.questions.map((q) => q.order)).toEqual([1, 2]);
    expect(section?.questions.map((q) => q.title)).toEqual([
      "姓名",
      "身份证号",
    ]);
  });

  it("问题不存在时报 QUESTION_NOT_FOUND", () => {
    const { schema } = setup();
    expectCode(
      () => removeQuestion(schema, { questionId: "nope" }),
      ErrorCode.QUESTION_NOT_FOUND
    );
  });
});

// ============================================================
// move_question
// ============================================================

describe("moveQuestion", () => {
  it("同组内移动到指定位置", () => {
    const { schema } = setup();

    // sec_basic: [姓名(1), 联系方式(2)]
    // 把"联系方式"移到第 1 位
    const result = moveQuestion(schema, {
      questionId: "q_phone",
      targetSectionId: "sec_basic",
      targetOrder: 1,
    });

    const section = result.schema.sections.find((s) => s.id === "sec_basic");
    expect(section?.questions.map((q) => q.title)).toEqual([
      "联系方式",
      "姓名",
    ]);
    expect(section?.questions.map((q) => q.order)).toEqual([1, 2]);
    expect(result.question.order).toBe(1);
  });

  it("同组内移动到末尾：targetOrder 省略时追加", () => {
    const { schema } = setup();

    const result = moveQuestion(schema, {
      questionId: "q_name",
      targetSectionId: "sec_basic",
    });

    const section = result.schema.sections.find((s) => s.id === "sec_basic");
    expect(section?.questions.map((q) => q.title)).toEqual([
      "联系方式",
      "姓名",
    ]);
    expect(result.question.order).toBe(2);
  });

  it("跨组移动，两组 order 都重算", () => {
    const { schema } = setup();

    const result = moveQuestion(schema, {
      questionId: "q_phone",
      targetSectionId: "sec_drone",
      targetOrder: 1,
    });

    const basic = result.schema.sections.find((s) => s.id === "sec_basic");
    const drone = result.schema.sections.find((s) => s.id === "sec_drone");

    expect(basic?.questions.map((q) => q.title)).toEqual(["姓名"]);
    expect(basic?.questions.map((q) => q.order)).toEqual([1]);

    expect(drone?.questions.map((q) => q.title)).toEqual([
      "联系方式",
      "是否拥有无人机？",
      "无人机用途",
    ]);
    expect(drone?.questions.map((q) => q.order)).toEqual([1, 2, 3]);

    expect(result.question.sectionId).toBe("sec_drone");
    expect(result.question.order).toBe(1);
  });

  it("targetOrder 允许等于 maxOrder（即放到最末）", () => {
    const { schema } = setup();

    // sec_basic 有 2 道题，移走 1 道后剩 1 道，maxOrder = 2
    const result = moveQuestion(schema, {
      questionId: "q_name",
      targetSectionId: "sec_basic",
      targetOrder: 2,
    });

    expect(result.question.order).toBe(2);
  });

  it("targetOrder 越界被拒绝", () => {
    const { schema } = setup();
    // sec_basic 有 2 道题，移走 1 道后剩 1 道 => maxOrder = 2
    expectCode(
      () =>
        moveQuestion(schema, {
          questionId: "q_name",
          targetSectionId: "sec_basic",
          targetOrder: 5,
        }),
      ErrorCode.INVALID_PARAMETER
    );
  });

  it("targetOrder 为 0 被拒绝", () => {
    const { schema } = setup();
    expectCode(
      () =>
        moveQuestion(schema, {
          questionId: "q_name",
          targetSectionId: "sec_basic",
          targetOrder: 0,
        }),
      ErrorCode.INVALID_PARAMETER
    );
  });

  it("目标分组不存在时报 SECTION_NOT_FOUND", () => {
    const { schema } = setup();
    expectCode(
      () =>
        moveQuestion(schema, {
          questionId: "q_name",
          targetSectionId: "nope",
        }),
      ErrorCode.SECTION_NOT_FOUND
    );
  });

  it("问题不存在时报 QUESTION_NOT_FOUND", () => {
    const { schema } = setup();
    expectCode(
      () =>
        moveQuestion(schema, {
          questionId: "nope",
          targetSectionId: "sec_drone",
        }),
      ErrorCode.QUESTION_NOT_FOUND
    );
  });
});

// ============================================================
// Schema 校验：Operation 不可能产出非法结构
// ============================================================

describe("Schema 校验", () => {
  it("构造非法问卷会被 questionnaireSchema 拒绝（嵌套 section）", async () => {
    const { questionnaireSchema } = await import(
      "../../../src/modules/questionnaire/schema/questionnaire.schema.js"
    );

    const bad = {
      id: "s1",
      title: "非法问卷",
      version: 1,
      sections: [
        {
          id: "sec_a",
          title: "父分组",
          order: 1,
          questions: [],
          children: [
            { id: "sec_b", title: "子分组", order: 1, questions: [] },
          ],
        },
      ],
    };

    const parsed = questionnaireSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  it("question id 重复会被拒绝", async () => {
    const { questionnaireSchema } = await import(
      "../../../src/modules/questionnaire/schema/questionnaire.schema.js"
    );

    const bad = {
      id: "s1",
      title: "非法问卷",
      version: 1,
      sections: [
        {
          id: "sec_a",
          title: "A",
          order: 1,
          questions: [
            { id: "dup", type: "text", title: "题一", required: true, order: 1 },
          ],
        },
        {
          id: "sec_b",
          title: "B",
          order: 2,
          questions: [
            { id: "dup", type: "text", title: "题二", required: true, order: 1 },
          ],
        },
      ],
    };

    const parsed = questionnaireSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  it("选择题缺少选项会被拒绝", async () => {
    const { questionnaireSchema } = await import(
      "../../../src/modules/questionnaire/schema/questionnaire.schema.js"
    );

    const bad = {
      id: "s1",
      title: "非法问卷",
      version: 1,
      sections: [
        {
          id: "sec_a",
          title: "A",
          order: 1,
          questions: [
            {
              id: "q1",
              type: "single_choice",
              title: "单选题",
              required: true,
              order: 1,
            },
          ],
        },
      ],
    };

    const parsed = questionnaireSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  it("连续操作后仍保持合法（多步编辑链路）", () => {
    let schema = makeBaseSchema();
    const ids = makeSequenceIdFactory();

    const added = addSection(schema, { title: "团伙关系调查" }, ids);
    schema = added.schema;

    const withQ1 = addQuestion(
      schema,
      {
        sectionId: added.section.id,
        type: "boolean",
        title: "是否存在团伙？",
        required: true,
      },
      ids
    );
    schema = withQ1.schema;

    const withQ2 = addQuestion(
      schema,
      {
        sectionId: added.section.id,
        type: "textarea",
        title: "团伙成员情况",
      },
      ids
    );
    schema = withQ2.schema;

    const moved = moveQuestion(schema, {
      questionId: withQ2.question.id,
      targetSectionId: added.section.id,
      targetOrder: 1,
    });
    schema = moved.schema;

    // 每一步都已通过 assertValidSchema；
    // 这里再确认最终结构的形状符合预期
    const sec = schema.sections.find((s) => s.id === added.section.id);
    expect(sec?.questions.map((q) => q.title)).toEqual([
      "团伙成员情况",
      "是否存在团伙？",
    ]);
    expect(schema.sections.map((s) => s.order)).toEqual([1, 2, 3]);
  });
});
