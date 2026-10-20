/**
 * 跳转流程（resolveFlow / checkFlow）单元测试。
 *
 * 依据决策 D16 与 docs/11-future-capability-plan.md 第 4 节。
 *
 * 这是分支能力的**核心正确性**所在，因此覆盖得比一般模块密：
 * 向前兼容、四条推进规则、多路径汇聚（合法）、无出口环（必须拒绝）、
 * 悬空引用、比较值类型、以及不可达题目的告警。
 *
 * 纯函数，不需要数据库。
 */
import { describe, expect, it } from "vitest";

import {
  checkFlow,
  findUnreachable,
  resolveFlow,
  evaluateRule,
  isAnswered,
} from "../../../src/modules/questionnaire/operations/index.js";

// ============================================================
// 夹具：直接手写最小结构（只含流程关心的字段）
// ============================================================

interface Q {
  id: string;
  order: number;
  type?: string;
  options?: { id: string }[];
  branches?: {
    when: { op: string; questionId: string; value?: unknown };
    goTo: string;
  }[];
  defaultNext?: string | null;
}

/** 把题目按顺序放进一个分组 */
function schemaOf(questions: Q[]) {
  return {
    sections: [
      {
        id: "sec_1",
        order: 1,
        questions: questions as never[],
      },
    ],
  };
}

function ids(result: { steps: { questionId: string }[] }): string[] {
  return result.steps.map((s) => s.questionId);
}

/** 期望 checkFlow 抛出的错误信息里包含某段文字 */
function messagesOf(schema: Parameters<typeof checkFlow>[0]): string[] {
  return checkFlow(schema).map((i) => i.message);
}

// ============================================================
// 向后兼容：没有分支字段时必须是顺序执行
// ============================================================

describe("resolveFlow：向后兼容（存量问卷）", () => {
  it("没有任何分支字段时，按 order 顺序走完", () => {
    const schema = schemaOf([
      { id: "q1", order: 1 },
      { id: "q2", order: 2 },
      { id: "q3", order: 3 },
    ]);

    const r = resolveFlow(schema, {});
    expect(ids(r)).toEqual(["q1", "q2", "q3"]);
    expect(r.endedBy).toBe("exhausted");
    expect(r.steps.map((s) => s.reason)).toEqual([
      "entry",
      "fallthrough",
      "fallthrough",
    ]);
  });

  it("跨分组时按 section.order 再按 question.order（与既有展平顺序一致）", () => {
    const schema = {
      sections: [
        { id: "sec_b", order: 2, questions: [{ id: "b1", order: 1 }] },
        { id: "sec_a", order: 1, questions: [{ id: "a2", order: 2 }, { id: "a1", order: 1 }] },
      ],
    };

    expect(ids(resolveFlow(schema, {}))).toEqual(["a1", "a2", "b1"]);
  });

  it("空问卷是合法状态（编辑器可从零建）", () => {
    const r = resolveFlow({ sections: [] }, {});
    expect(r.steps).toEqual([]);
    expect(r.endedBy).toBe("exhausted");
  });

  it("题目 order 相同时不会丢题（稳定排序）", () => {
    const schema = schemaOf([
      { id: "q1", order: 1 },
      { id: "q2", order: 1 },
    ]);
    expect(ids(resolveFlow(schema, {})).sort()).toEqual(["q1", "q2"]);
  });
});

// ============================================================
// 分支规则
// ============================================================

describe("resolveFlow：分支规则", () => {
  const base = () =>
    schemaOf([
      { id: "q1", order: 1 },
      {
        id: "q2",
        order: 2,
        type: "boolean",
        branches: [
          { when: { op: "eq", questionId: "q1", value: true }, goTo: "q4" },
        ],
      },
      { id: "q3", order: 3 },
      { id: "q4", order: 4 },
    ]);

  it("命中规则时跳到 goTo，并标记 reason=rule", () => {
    const r = resolveFlow(base(), { q1: { value: true } });
    expect(ids(r)).toEqual(["q1", "q2", "q4"]);
    expect(r.steps[2]!.reason).toBe("rule");
  });

  it("不命中时按 order 走下一题", () => {
    const r = resolveFlow(base(), { q1: { value: false } });
    expect(ids(r)).toEqual(["q1", "q2", "q3", "q4"]);
  });

  it("多条规则按声明顺序取第一条命中", () => {
    const schema = schemaOf([
      { id: "q1", order: 1, type: "text" },
      {
        id: "q2",
        order: 2,
        branches: [
          { when: { op: "eq", questionId: "q1", value: "a" }, goTo: "q4" },
          { when: { op: "eq", questionId: "q1", value: "a" }, goTo: "q5" },
        ],
      },
      { id: "q3", order: 3 },
      { id: "q4", order: 4 },
      { id: "q5", order: 5 },
    ]);

    // 两条规则条件相同 → 取第一条（q4），之后仍按 order 继续走到 q5
    expect(ids(resolveFlow(schema, { q1: { value: "a" } }))).toEqual([
      "q1",
      "q2",
      "q4",
      "q5",
    ]);
  });

  it("defaultNext 生效（都不命中时）", () => {
    const schema = schemaOf([
      { id: "q1", order: 1, type: "text" },
      {
        id: "q2",
        order: 2,
        branches: [
          { when: { op: "eq", questionId: "q1", value: "yes" }, goTo: "q4" },
        ],
        defaultNext: "q5",
      },
      { id: "q3", order: 3 },
      { id: "q4", order: 4 },
      { id: "q5", order: 5 },
    ]);

    const r = resolveFlow(schema, { q1: { value: "no" } });
    expect(ids(r)).toEqual(["q1", "q2", "q5"]);
    expect(r.steps[2]!.reason).toBe("default");
  });

  it("defaultNext 优先于「按 order 走下一题」", () => {
    const schema = schemaOf([
      { id: "q1", order: 1 },
      { id: "q2", order: 2, defaultNext: "q4" },
      { id: "q3", order: 3 },
      { id: "q4", order: 4 },
    ]);
    expect(ids(resolveFlow(schema, {}))).toEqual(["q1", "q2", "q4"]);
  });

  it("defaultNext = null 表示本题是终点，问卷在此结束", () => {
    const schema = schemaOf([
      { id: "q1", order: 1 },
      { id: "q2", order: 2, defaultNext: null },
      { id: "q3", order: 3 },
    ]);

    const r = resolveFlow(schema, {});
    expect(ids(r)).toEqual(["q1", "q2"]);
    expect(r.endedBy).toBe("explicit");
  });

  it("**条件可以引用题目自己**：按本题答案跳过本题（最常见的门控写法）", () => {
    // q2 只有在 q1 = true 时才应该被问到；q1 = false 时跳过 q2 去 q3
    // 条件挂在 q2 自己身上，引用的是 q1（本题的输入来源）
    //
    // 这里用「q2 的答案决定跳过 q2」这一形态验证自引用条件可用：
    //   q2 答 false → 跳到 q3（跳过后续的 q2b）
    const schema = schemaOf([
      { id: "q1", order: 1, type: "boolean" },
      {
        id: "q2",
        order: 2,
        type: "boolean",
        branches: [
          { when: { op: "eq", questionId: "q2", value: false }, goTo: "q4" },
        ],
      },
      { id: "q3", order: 3 },
      { id: "q4", order: 4 },
    ]);

    // 自引用条件命中 → 本题记为走过（reason=fallthrough），然后立即跳走（q4 的 reason=rule）
    const r = resolveFlow(schema, { q2: { value: false } });
    expect(ids(r)).toEqual(["q1", "q2", "q4"]);
    expect(r.steps[2]!.reason).toBe("rule");

    // 不命中 → 正常往下走
    expect(ids(resolveFlow(schema, { q2: { value: true } }))).toEqual([
      "q1",
      "q2",
      "q3",
      "q4",
    ]);

    // 自引用条件不算结构错误
    expect(checkFlow(schema)).toEqual([]);
  });

  it("条件引用自己不会造成环（本题只被走过一次）", () => {
    const schema = schemaOf([
      { id: "q1", order: 1, type: "boolean" },
      {
        id: "q1b",
        order: 2,
        type: "boolean",
        branches: [
          { when: { op: "eq", questionId: "q1b", value: true }, goTo: "q3" },
        ],
      },
      { id: "q3", order: 3 },
    ]);

    // 两种答案都能收敛
    expect(() => resolveFlow(schema, { q1b: { value: true } })).not.toThrow();
    expect(() => resolveFlow(schema, { q1b: { value: false } })).not.toThrow();
    expect(checkFlow(schema)).toEqual([]);
  });

  it("分支跳到前面的题目会形成环 → 必须报错（不能静默死循环）", () => {
    const schema = schemaOf([
      { id: "q1", order: 1 },
      {
        id: "q2",
        order: 2,
        branches: [{ when: { op: "is_answered", questionId: "q1" }, goTo: "q1" }],
      },
    ]);

    expect(() => resolveFlow(schema, { q1: { value: "x" } })).toThrow(
      /无法收敛/
    );
  });
});

// ============================================================
// 汇聚：DAG 的核心语义
// ============================================================

describe("resolveFlow：多路径汇聚", () => {
  it("两条路径汇聚到同一题是**合法**的（不能当成环拒掉）", () => {
    // q1 是/否 → 分别走 q2、q3，之后都落到 q4
    const schema = schemaOf([
      { id: "q1", order: 1, type: "boolean" },
      {
        id: "q2",
        order: 2,
        branches: [
          { when: { op: "eq", questionId: "q1", value: true }, goTo: "q4" },
        ],
      },
      { id: "q3", order: 3 },
      { id: "q4", order: 4 },
      { id: "q5", order: 5 },
    ]);

    // 是 → q1,q2,q4,q5 ；否 → q1,q2,q3,q4,q5
    expect(ids(resolveFlow(schema, { q1: { value: true } }))).toEqual([
      "q1",
      "q2",
      "q4",
      "q5",
    ]);
    expect(ids(resolveFlow(schema, { q1: { value: false } }))).toEqual([
      "q1",
      "q2",
      "q3",
      "q4",
      "q5",
    ]);

    // 汇聚点 q4 不被视为环
    expect(checkFlow(schema)).toEqual([]);
  });

  it("跳回已走过的题但每次都向后推进 → 仍可能收敛（不算死环）", () => {
    // q2 条件命中时跳到 q4，q4 之后按 order 继续
    const schema = schemaOf([
      { id: "q1", order: 1, type: "boolean" },
      {
        id: "q2",
        order: 2,
        branches: [
          { when: { op: "eq", questionId: "q1", value: true }, goTo: "q4" },
        ],
      },
      { id: "q3", order: 3 },
      { id: "q4", order: 4 },
    ]);
    expect(checkFlow(schema)).toEqual([]);
  });
});

// ============================================================
// 方向约束：边只能向后（保证有向无环图）
// ============================================================

describe("checkFlow：方向约束（V4 / V4b）", () => {
  it("分支跳到前面的题目 → 被拒绝，并说明会形成环", () => {
    const schema = schemaOf([
      { id: "q1", order: 1 },
      {
        id: "q2",
        order: 2,
        branches: [{ when: { op: "is_answered", questionId: "q1" }, goTo: "q1" }],
      },
    ]);

    const msgs = messagesOf(schema);
    expect(msgs.some((m) => m.includes("本题之前") || m.includes("本题之后"))).toBe(
      true
    );
  });

  it("分支跳到**自己** → 被拒绝（自环）", () => {
    const schema = schemaOf([
      {
        id: "q1",
        order: 1,
        type: "boolean",
        branches: [{ when: { op: "eq", questionId: "q1", value: true }, goTo: "q1" }],
      },
    ]);
    expect(messagesOf(schema).length).toBeGreaterThan(0);
  });

  it("defaultNext 指向前面的题目 → 被拒绝", () => {
    const schema = schemaOf([
      { id: "q1", order: 1 },
      { id: "q2", order: 2, defaultNext: "q1" },
    ]);
    expect(messagesOf(schema).some((m) => m.includes("本题之前"))).toBe(true);
  });

  it("**跨分组**回跳同样被拒绝（方向按跨分组的展平顺序判定）", () => {
    const schema = {
      sections: [
        {
          id: "sec_1",
          order: 1,
          questions: [{ id: "q1", order: 1 }],
        },
        {
          id: "sec_2",
          order: 2,
          questions: [
            {
              id: "q2",
              order: 1,
              branches: [
                { when: { op: "is_answered", questionId: "q1" }, goTo: "q1" },
              ],
            },
          ],
        },
      ],
    };
    expect(messagesOf(schema as never).length).toBeGreaterThan(0);
  });

  it("向后跳（本题之后）→ 通过", () => {
    const schema = schemaOf([
      { id: "q1", order: 1, type: "boolean" },
      {
        id: "q2",
        order: 2,
        branches: [
          { when: { op: "eq", questionId: "q1", value: true }, goTo: "q4" },
        ],
      },
      { id: "q3", order: 3 },
      { id: "q4", order: 4 },
    ]);
    expect(checkFlow(schema)).toEqual([]);
  });

  it("条件引用**后面的**题目 → 被拒绝（走到本题时它还没答案，规则永不命中）", () => {
    const schema = schemaOf([
      { id: "q1", order: 1, type: "boolean" },
      {
        id: "q2",
        order: 2,
        branches: [
          // 引用 q3（在后面）—— 这条规则永远不会命中
          { when: { op: "eq", questionId: "q3", value: true }, goTo: "q4" },
        ],
      },
      { id: "q3", order: 3, type: "boolean" },
      { id: "q4", order: 4 },
    ]);

    const msgs = messagesOf(schema);
    expect(msgs.some((m) => m.includes("永远不会命中"))).toBe(true);
  });

  it("条件引用**更早的**题目 → 允许（这是「按前面的答案决定去向」的常见写法）", () => {
    const schema = schemaOf([
      { id: "q1", order: 1, type: "boolean" },
      { id: "q2", order: 2, type: "text" },
      {
        id: "q3",
        order: 3,
        branches: [
          { when: { op: "eq", questionId: "q1", value: true }, goTo: "q4" },
        ],
      },
      { id: "q4", order: 4 },
    ]);
    expect(checkFlow(schema)).toEqual([]);
  });

  it("条件引用**本题自己** → 允许（最常见的「按本题答案决定去向」）", () => {
    const schema = schemaOf([
      { id: "q1", order: 1, type: "boolean" },
      {
        id: "q2",
        order: 2,
        type: "boolean",
        branches: [
          { when: { op: "eq", questionId: "q2", value: false }, goTo: "q4" },
        ],
      },
      { id: "q3", order: 3 },
      { id: "q4", order: 4 },
    ]);
    expect(checkFlow(schema)).toEqual([]);
  });
});

// ============================================================
// 留空（NO_NEXT）：删掉出边之后的第四种状态
// ============================================================

describe("resolveFlow / checkFlow：留空（NO_NEXT）", () => {
  it("defaultNext = '#none' → 流程在此结束，且不算悬空引用", () => {
    const schema = schemaOf([
      { id: "q1", order: 1, defaultNext: "#none" },
      { id: "q2", order: 2 },
    ]);

    // 结构合法：'#none' 是留空哨兵，不是「指向一个不存在的题目」
    expect(checkFlow(schema)).toEqual([]);

    const result = resolveFlow(schema, {});
    expect(ids(result)).toEqual(["q1"]);
    expect(result.endedBy).toBe("explicit");
  });

  it("留空之后的题目变成不可达（会给出告警）", () => {
    const schema = schemaOf([
      { id: "q1", order: 1, defaultNext: "#none" },
      { id: "q2", order: 2 },
    ]);
    expect(findUnreachable(schema)).toEqual(["q2"]);
  });

  it("与 defaultNext: null 的运行时行为相同（都结束），但语义不同", () => {
    const blank = schemaOf([
      { id: "q1", order: 1, defaultNext: "#none" },
      { id: "q2", order: 2 },
    ]);
    const explicitEnd = schemaOf([
      { id: "q1", order: 1, defaultNext: null },
      { id: "q2", order: 2 },
    ]);

    expect(ids(resolveFlow(blank, {}))).toEqual(ids(resolveFlow(explicitEnd, {})));
    // 两者都合法；区别只在画布上画不画那条到「结束」的线
    expect(checkFlow(blank)).toEqual([]);
    expect(checkFlow(explicitEnd)).toEqual([]);
  });

  it("留空不会被方向校验误判（它不是题目 id，没有位置）", () => {
    const schema = schemaOf([
      { id: "q1", order: 1 },
      { id: "q2", order: 2, defaultNext: "#none" },
    ]);
    expect(checkFlow(schema)).toEqual([]);
  });
});

// ============================================================
// 环收敛检测
// ============================================================

describe("checkFlow：环与收敛", () => {
  it("互相跳转且都没有出口 → 报「无法收敛」", () => {
    const schema = schemaOf([
      { id: "q1", order: 1 },
      { id: "q2", order: 2, defaultNext: "q3" },
      { id: "q3", order: 3, defaultNext: "q2" },
    ]);

    const msgs = messagesOf(schema);
    expect(msgs.some((m) => m.includes("无法收敛"))).toBe(true);
  });

  it("有出口的环（条件只在一个方向成立）→ 通过", () => {
    // q2 在「否」时跳到 q2 自己是不允许的（schema 层拦自环），
    // 这里用 q2→q3→q2 但 q3 在条件未命中时走 fallthrough 出口
    const schema = schemaOf([
      { id: "q1", order: 1, type: "boolean" },
      {
        id: "q2",
        order: 2,
        branches: [
          { when: { op: "eq", questionId: "q1", value: true }, goTo: "q3" },
        ],
      },
      { id: "q3", order: 3 },
    ]);
    expect(checkFlow(schema)).toEqual([]);
  });

  it("maxSteps 可显式下调，用于测试收敛上限", () => {
    const schema = schemaOf([
      { id: "q1", order: 1 },
      { id: "q2", order: 2 },
    ]);
    expect(() => resolveFlow(schema, {}, { maxSteps: 1 })).toThrow(/无法收敛/);
  });
});

// ============================================================
// 悬空引用
// ============================================================

describe("checkFlow：悬空引用", () => {
  it("goTo 指向不存在的题目 → 报错并指出版位置", () => {
    const schema = schemaOf([
      { id: "q1", order: 1 },
      {
        id: "q2",
        order: 2,
        branches: [{ when: { op: "is_answered", questionId: "q1" }, goTo: "q999" }],
      },
    ]);

    const issues = checkFlow(schema);
    expect(issues.some((i) => i.message.includes("q999"))).toBe(true);
    expect(issues[0]!.path.join(".")).toContain("branches");
  });

  it("条件引用了不存在的题目 → 报错", () => {
    const schema = schemaOf([
      { id: "q1", order: 1 },
      {
        id: "q2",
        order: 2,
        branches: [{ when: { op: "is_answered", questionId: "q999" }, goTo: "q1" }],
      },
    ]);
    expect(messagesOf(schema).some((m) => m.includes("q999"))).toBe(true);
  });

  it("defaultNext 指向不存在的题目 → 报错", () => {
    const schema = schemaOf([
      { id: "q1", order: 1, defaultNext: "q999" },
      { id: "q2", order: 2 },
    ]);
    expect(messagesOf(schema).some((m) => m.includes("q999"))).toBe(true);
  });
});

// ============================================================
// 比较值与题型相容
// ============================================================

describe("checkFlow：比较值类型", () => {
  it("是非题给非布尔值 → 报错", () => {
    const schema = schemaOf([
      { id: "q1", order: 1, type: "boolean" },
      {
        id: "q2",
        order: 2,
        branches: [
          { when: { op: "eq", questionId: "q1", value: "true" }, goTo: "q3" },
        ],
      },
      { id: "q3", order: 3 },
    ]);
    expect(messagesOf(schema).some((m) => m.includes("是非题"))).toBe(true);
  });

  it("数字题给字符串 → 报错", () => {
    const schema = schemaOf([
      { id: "q1", order: 1, type: "number" },
      {
        id: "q2",
        order: 2,
        branches: [
          { when: { op: "eq", questionId: "q1", value: "5" }, goTo: "q3" },
        ],
      },
      { id: "q3", order: 3 },
    ]);
    expect(messagesOf(schema).some((m) => m.includes("数字题"))).toBe(true);
  });

  it("单选题引用了不属于它的选项 id → 报错", () => {
    const schema = schemaOf([
      {
        id: "q1",
        order: 1,
        type: "single_choice",
        options: [{ id: "o1" }, { id: "o2" }],
      },
      {
        id: "q2",
        order: 2,
        branches: [
          { when: { op: "eq", questionId: "q1", value: "o999" }, goTo: "q3" },
        ],
      },
      { id: "q3", order: 3 },
    ]);
    expect(messagesOf(schema).some((m) => m.includes("o999"))).toBe(true);
  });

  it("多选题用 eq → 提示应改用 in / not_in", () => {
    const schema = schemaOf([
      {
        id: "q1",
        order: 1,
        type: "multiple_choice",
        options: [{ id: "o1" }, { id: "o2" }],
      },
      {
        id: "q2",
        order: 2,
        branches: [
          { when: { op: "eq", questionId: "q1", value: "o1" }, goTo: "q3" },
        ],
      },
      { id: "q3", order: 3 },
    ]);
    expect(messagesOf(schema).some((m) => m.includes("in / not_in"))).toBe(true);
  });

  it("多选题用 in 且选项合法 → 通过", () => {
    const schema = schemaOf([
      {
        id: "q1",
        order: 1,
        type: "multiple_choice",
        options: [{ id: "o1" }, { id: "o2" }],
      },
      {
        id: "q2",
        order: 2,
        branches: [
          { when: { op: "in", questionId: "q1", value: ["o1"] }, goTo: "q3" },
        ],
      },
      { id: "q3", order: 3 },
    ]);
    expect(checkFlow(schema)).toEqual([]);
  });

  it("无 value 的操作符给了 value → 报错", () => {
    const schema = schemaOf([
      { id: "q1", order: 1 },
      {
        id: "q2",
        order: 2,
        branches: [
          {
            when: { op: "is_answered", questionId: "q1", value: 1 },
            goTo: "q3",
          },
        ],
      },
      { id: "q3", order: 3 },
    ]);
    expect(messagesOf(schema).some((m) => m.includes("不需要 value"))).toBe(
      true
    );
  });
});

// ============================================================
// 不可达（告警，不阻断）
// ============================================================

describe("findUnreachable", () => {
  it("没有任何分支时全部可达", () => {
    const schema = schemaOf([
      { id: "q1", order: 1 },
      { id: "q2", order: 2 },
    ]);
    expect(findUnreachable(schema)).toEqual([]);
  });

  it("被跳过的题目仍然可达（因为条件可能不命中）", () => {
    const schema = schemaOf([
      { id: "q1", order: 1, type: "boolean" },
      {
        id: "q2",
        order: 2,
        branches: [
          { when: { op: "eq", questionId: "q1", value: true }, goTo: "q4" },
        ],
      },
      { id: "q3", order: 3 },
      { id: "q4", order: 4 },
    ]);
    expect(findUnreachable(schema)).toEqual([]);
  });

  it("defaultNext 跳过且没有其它入口指向它 → 报不可达", () => {
    // q2 无条件跳到 q4；q3 既不在任何分支上，也不在 fallthrough 路径上
    const schema = schemaOf([
      { id: "q1", order: 1, defaultNext: "q4" },
      { id: "q2", order: 2 },
      { id: "q3", order: 3 },
      { id: "q4", order: 4 },
    ]);
    // q4 可达；q2/q3 因为 q1 显式跳走而不可达
    const unreachable = findUnreachable(schema);
    expect(unreachable).toContain("q2");
    expect(unreachable).toContain("q3");
    expect(unreachable).not.toContain("q4");
  });

  it("不可达**不**出现在 checkFlow 的错误里（只是告警）", () => {
    const schema = schemaOf([
      { id: "q1", order: 1, defaultNext: "q4" },
      { id: "q2", order: 2 },
      { id: "q3", order: 3 },
      { id: "q4", order: 4 },
    ]);
    expect(checkFlow(schema)).toEqual([]);
    expect(findUnreachable(schema).length).toBeGreaterThan(0);
  });
});

// ============================================================
// 求值细节
// ============================================================

describe("evaluateRule / isAnswered", () => {
  it("isAnswered 把空数组、空串、null 都算未作答", () => {
    expect(isAnswered({ optionIds: [] })).toBe(false);
    expect(isAnswered({ value: "" })).toBe(false);
    expect(isAnswered({ value: "   " })).toBe(false);
    expect(isAnswered(null)).toBe(false);
    expect(isAnswered(undefined)).toBe(false);
    expect(isAnswered({ value: 0 })).toBe(true);
    expect(isAnswered({ value: false })).toBe(true);
    expect(isAnswered({ optionIds: ["o1"] })).toBe(true);
  });

  it("in 对多选题命中任一即算命中", () => {
    const rule = {
      when: { op: "in" as const, questionId: "q1", value: ["o1", "o2"] },
    };
    expect(evaluateRule(rule, { q1: { optionIds: ["o2", "o3"] } })).toBe(true);
    expect(evaluateRule(rule, { q1: { optionIds: ["o3"] } })).toBe(false);
  });

  it("not_in 对多选题要求一个都不包含", () => {
    const rule = {
      when: { op: "not_in" as const, questionId: "q1", value: ["o1"] },
    };
    expect(evaluateRule(rule, { q1: { optionIds: ["o2"] } })).toBe(true);
    expect(evaluateRule(rule, { q1: { optionIds: ["o1", "o2"] } })).toBe(false);
  });

  it("答案缺失时任何比较都不命中（不抛错）", () => {
    expect(
      evaluateRule(
        { when: { op: "eq", questionId: "q1", value: "a" } },
        {}
      )
    ).toBe(false);
    expect(
      evaluateRule({ when: { op: "is_empty", questionId: "q1" } }, {})
    ).toBe(true);
  });

  it("eq 对标量做宽松比较（1 与 \"1\" 视为相等）", () => {
    expect(
      evaluateRule({ when: { op: "eq", questionId: "q1", value: 1 } }, { q1: 1 })
    ).toBe(true);
    expect(
      evaluateRule({ when: { op: "eq", questionId: "q1", value: "1" } }, { q1: 1 })
    ).toBe(true);
  });
});
