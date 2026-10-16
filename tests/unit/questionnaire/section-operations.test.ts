/**
 * remove_section / reorder_sections / reorder_questions 的单元测试。
 *
 * 这三个操作是拖拽式人工编辑器（docs/11 §4.11）必需的：
 *   - 从零建模板时要能删掉加错的分组；
 *   - 拖拽排序只把「期望的 id 顺序」发给后端，order 由后端重算。
 *
 * 纯函数，因此不需要数据库。
 */
import { describe, expect, it } from "vitest";

import {
  addQuestion,
  addSection,
  makeSequenceIdFactory,
  removeSection,
  reorderQuestions,
  reorderSections,
} from "../../../src/modules/questionnaire/operations/index.js";
import { ErrorCode, isOperationError } from "../../../src/shared/errors/index.js";
import { makeBaseSchema, cloneFixture } from "../../fixtures/questionnaire.js";

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(isOperationError(e)).toBe(true);
    if (isOperationError(e)) expect(e.code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 ${code}，但没有抛出任何错误`);
}

// ============================================================
// remove_section
// ============================================================

describe("removeSection", () => {
  it("删除分组并把它的问题一并带走，其他分组不受影响", () => {
    const schema = makeBaseSchema();

    const result = removeSection(schema, { sectionId: "sec_drone" });

    expect(result.removed.id).toBe("sec_drone");
    expect(result.removed.title).toBe("无人机情况");
    // 组内问题 id 要报出来，前端与审计都靠它知道影响面
    expect(result.removed.questionIds).toEqual(["q_has_drone", "q_purpose"]);

    expect(result.schema.sections.map((s) => s.id)).toEqual(["sec_basic"]);
    // 剩下的问题不能被误删
    expect(
      result.schema.sections[0]!.questions.map((q) => q.id)
    ).toEqual(["q_name", "q_phone"]);
  });

  it("删除后重排 order，保证从 1 连续", () => {
    const schema = makeBaseSchema();

    const result = removeSection(schema, { sectionId: "sec_basic" });

    expect(result.schema.sections).toHaveLength(1);
    expect(result.schema.sections[0]!.order).toBe(1);
    expect(result.schema.sections[0]!.id).toBe("sec_drone");
  });

  it("删到空问卷是允许的（编辑器可以从零建）", () => {
    let schema = makeBaseSchema();
    schema = removeSection(schema, { sectionId: "sec_basic" }).schema;
    schema = removeSection(schema, { sectionId: "sec_drone" }).schema;

    expect(schema.sections).toEqual([]);
  });

  it("分组不存在 → SECTION_NOT_FOUND", () => {
    const schema = makeBaseSchema();
    expectCode(
      () => removeSection(schema, { sectionId: "sec_nope" }),
      ErrorCode.SECTION_NOT_FOUND
    );
  });

  it("不修改入参（纯函数）", () => {
    const schema = makeBaseSchema();
    const snapshot = JSON.stringify(schema);

    removeSection(schema, { sectionId: "sec_basic" });

    expect(JSON.stringify(schema)).toBe(snapshot);
  });
});

// ============================================================
// reorder_sections
// ============================================================

describe("reorderSections", () => {
  it("按给定 id 顺序重排，并重算 order", () => {
    const schema = makeBaseSchema();

    const result = reorderSections(schema, {
      sectionIds: ["sec_drone", "sec_basic"],
    });

    expect(result.order).toEqual(["sec_drone", "sec_basic"]);
    expect(result.schema.sections.map((s) => s.id)).toEqual([
      "sec_drone",
      "sec_basic",
    ]);
    expect(result.schema.sections.map((s) => s.order)).toEqual([1, 2]);
  });

  it("顺序不变时也合法（幂等）", () => {
    const schema = makeBaseSchema();

    const result = reorderSections(schema, {
      sectionIds: ["sec_basic", "sec_drone"],
    });

    expect(result.schema.sections.map((s) => s.id)).toEqual([
      "sec_basic",
      "sec_drone",
    ]);
  });

  it("分组内容跟随移动，不丢失问题", () => {
    const schema = makeBaseSchema();

    const result = reorderSections(schema, {
      sectionIds: ["sec_drone", "sec_basic"],
    });

    const drone = result.schema.sections.find((s) => s.id === "sec_drone");
    expect(drone?.questions.map((q) => q.id)).toEqual([
      "q_has_drone",
      "q_purpose",
    ]);
  });

  it("少给一个 id → 拒绝（否则那个分组会凭空消失）", () => {
    const schema = makeBaseSchema();
    expectCode(
      () => reorderSections(schema, { sectionIds: ["sec_basic"] }),
      ErrorCode.INVALID_PARAMETER
    );
  });

  it("多给一个 id → 拒绝（前端状态陈旧）", () => {
    const schema = makeBaseSchema();
    expectCode(
      () =>
        reorderSections(schema, {
          sectionIds: ["sec_basic", "sec_drone", "sec_extra"],
        }),
      ErrorCode.INVALID_PARAMETER
    );
  });

  it("重复 id → 拒绝", () => {
    const schema = makeBaseSchema();
    expectCode(
      () =>
        reorderSections(schema, {
          sectionIds: ["sec_basic", "sec_basic"],
        }),
      ErrorCode.INVALID_PARAMETER
    );
  });

  it("含不存在的 id → SECTION_NOT_FOUND", () => {
    const schema = makeBaseSchema();
    expectCode(
      () =>
        reorderSections(schema, {
          sectionIds: ["sec_basic", "sec_nope"],
        }),
      ErrorCode.SECTION_NOT_FOUND
    );
  });

  it("不修改入参（纯函数）", () => {
    const schema = cloneFixture(makeBaseSchema());
    const snapshot = JSON.stringify(schema);

    reorderSections(schema, { sectionIds: ["sec_drone", "sec_basic"] });

    expect(JSON.stringify(schema)).toBe(snapshot);
  });
});

// ============================================================
// reorder_questions
// ============================================================

describe("reorderQuestions", () => {
  it("按给定 id 顺序重排组内问题并重算 order", () => {
    const schema = makeBaseSchema();

    const result = reorderQuestions(schema, {
      sectionId: "sec_basic",
      questionIds: ["q_phone", "q_name"],
    });

    expect(result.order).toEqual(["q_phone", "q_name"]);
    const sec = result.schema.sections.find((s) => s.id === "sec_basic");
    expect(sec?.questions.map((q) => q.id)).toEqual(["q_phone", "q_name"]);
    expect(sec?.questions.map((q) => q.order)).toEqual([1, 2]);
  });

  it("只影响目标分组，别的分组顺序不变", () => {
    const schema = makeBaseSchema();

    const result = reorderQuestions(schema, {
      sectionId: "sec_basic",
      questionIds: ["q_phone", "q_name"],
    });

    const drone = result.schema.sections.find((s) => s.id === "sec_drone");
    expect(drone?.questions.map((q) => q.id)).toEqual([
      "q_has_drone",
      "q_purpose",
    ]);
    expect(drone?.questions.map((q) => q.order)).toEqual([1, 2]);
  });

  it("题目数量不一致 → 拒绝", () => {
    const schema = makeBaseSchema();
    expectCode(
      () =>
        reorderQuestions(schema, {
          sectionId: "sec_basic",
          questionIds: ["q_name"],
        }),
      ErrorCode.INVALID_PARAMETER
    );
  });

  it("重复 id → 拒绝", () => {
    const schema = makeBaseSchema();
    expectCode(
      () =>
        reorderQuestions(schema, {
          sectionId: "sec_basic",
          questionIds: ["q_name", "q_name"],
        }),
      ErrorCode.INVALID_PARAMETER
    );
  });

  it("把别的分组的题目 id 混进来 → QUESTION_NOT_FOUND", () => {
    const schema = makeBaseSchema();
    expectCode(
      () =>
        reorderQuestions(schema, {
          sectionId: "sec_basic",
          questionIds: ["q_name", "q_has_drone"],
        }),
      ErrorCode.QUESTION_NOT_FOUND
    );
  });

  it("分组不存在 → SECTION_NOT_FOUND", () => {
    const schema = makeBaseSchema();
    expectCode(
      () =>
        reorderQuestions(schema, {
          sectionId: "sec_nope",
          questionIds: [],
        }),
      ErrorCode.SECTION_NOT_FOUND
    );
  });

  it("空分组配空数组是合法的（新建分组还没加题）", () => {
    const schema = makeBaseSchema();
    schema.sections[0]!.questions = [];

    const result = reorderQuestions(schema, {
      sectionId: "sec_basic",
      questionIds: [],
    });

    expect(result.order).toEqual([]);
  });

  it("不修改入参（纯函数）", () => {
    const schema = cloneFixture(makeBaseSchema());
    const snapshot = JSON.stringify(schema);

    reorderQuestions(schema, {
      sectionId: "sec_basic",
      questionIds: ["q_phone", "q_name"],
    });

    expect(JSON.stringify(schema)).toBe(snapshot);
  });
});

// ============================================================
// 组合场景：模拟一次拖拽后的完整编辑流程
// ============================================================

describe("拖拽编辑的组合场景", () => {
  it("建组 → 加题 → 组内重排 → 分组重排 → 删组，全程结构合法", () => {
    const ids = makeSequenceIdFactory();

    // 从空问卷开始（对应「从零建模板」）
    let schema = cloneFixture(makeBaseSchema());
    schema.sections = [];
    schema = reorderSections(schema, { sectionIds: [] }).schema;
    expect(schema.sections).toEqual([]);

    // 加两个分组
    const s1 = addSection(schema, { title: "第一部分" }, ids);
    schema = s1.schema;
    const s2 = addSection(schema, { title: "第二部分" }, ids);
    schema = s2.schema;
    expect(schema.sections.map((x) => x.title)).toEqual([
      "第一部分",
      "第二部分",
    ]);

    // 往第一组加两道题
    const q1 = addQuestion(
      schema,
      { sectionId: s1.section.id, type: "text", title: "题一" },
      ids
    );
    schema = q1.schema;
    const q2 = addQuestion(
      schema,
      { sectionId: s1.section.id, type: "text", title: "题二" },
      ids
    );
    schema = q2.schema;

    // 组内重排：把第二题拖到前面
    schema = reorderQuestions(schema, {
      sectionId: s1.section.id,
      questionIds: [q2.question.id, q1.question.id],
    }).schema;
    expect(
      schema.sections.find((x) => x.id === s1.section.id)?.questions.map((q) => q.title)
    ).toEqual(["题二", "题一"]);

    // 分组重排：把第二组拖到最前
    schema = reorderSections(schema, {
      sectionIds: [s2.section.id, s1.section.id],
    }).schema;
    expect(schema.sections.map((x) => x.title)).toEqual([
      "第二部分",
      "第一部分",
    ]);

    // 删掉第二组（连同它的问题，本题它没有题）
    schema = removeSection(schema, { sectionId: s2.section.id }).schema;
    expect(schema.sections.map((x) => x.title)).toEqual(["第一部分"]);
    expect(schema.sections[0]!.order).toBe(1);
  });
});
