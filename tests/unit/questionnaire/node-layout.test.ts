/**
 * 节点画布坐标的纯函数操作（`setNodeLayout`）。
 *
 * 这一层要盯住的是「合并语义」而不是「画得对不对」：
 *   坐标是纯呈现信息，所以它的正确性标准是
 *   **只影响自己、不污染结构、不留幽灵、不出浮点噪声**。
 */
import { describe, expect, it } from "vitest";

import { setNodeLayout } from "../../../src/modules/questionnaire/operations/set-node-layout.js";
import { makeBaseSchema } from "../../fixtures/questionnaire.js";

/** 夹具里的题目 id（见 tests/fixtures/questionnaire.ts） */
const KNOWN = "q_name";

describe("setNodeLayout", () => {
  it("写入坐标后结构其余部分完全不变", () => {
    const before = makeBaseSchema();
    const after = setNodeLayout(before, { positions: { [KNOWN]: { x: 10, y: 20 } } });

    expect(after.layout).toEqual({ [KNOWN]: { x: 10, y: 20 } });
    // 结构本身（分组/题目）必须一模一样
    expect(after.sections).toEqual(before.sections);
    expect(after.id).toBe(before.id);
    expect(after.title).toBe(before.title);
  });

  it("**合并**而不是替换：只传一个节点时其它节点的坐标要保留", () => {
    const base = makeBaseSchema({ layout: { q_phone: { x: 5, y: 5 } } });
    const after = setNodeLayout(base, { positions: { [KNOWN]: { x: 100, y: 200 } } });

    expect(after.layout).toEqual({
      q_phone: { x: 5, y: 5 },
      [KNOWN]: { x: 100, y: 200 },
    });
  });

  it("同一节点重复写入时以后者为准", () => {
    const base = makeBaseSchema({ layout: { [KNOWN]: { x: 1, y: 2 } } });
    const after = setNodeLayout(base, {
      positions: { [KNOWN]: { x: 300, y: 400 } },
    });

    expect(after.layout).toEqual({ [KNOWN]: { x: 300, y: 400 } });
  });

  it("**指向已删除题目的坐标被丢弃**（不留幽灵节点）", () => {
    const base = makeBaseSchema({
      layout: {
        q_deleted_long_ago: { x: 1, y: 1 },
        [KNOWN]: { x: 2, y: 2 },
      },
    });
    const after = setNodeLayout(base, { positions: {} });

    expect(after.layout).toEqual({ [KNOWN]: { x: 2, y: 2 } });
    expect(after.layout).not.toHaveProperty("q_deleted_long_ago");
  });

  it("传入不存在题目的坐标 → 忽略（不报错、不写库）", () => {
    const after = setNodeLayout(makeBaseSchema(), {
      positions: { q_nope: { x: 9, y: 9 } },
    });

    expect(after.layout).toEqual({});
  });

  it("坐标取整（避免浮点噪声进 JSONB）", () => {
    const after = setNodeLayout(makeBaseSchema(), {
      positions: { [KNOWN]: { x: 12.7, y: -3.2 } },
    });

    expect(after.layout).toEqual({ [KNOWN]: { x: 13, y: -3 } });
  });

  it("不改动传入的 schema（纯函数）", () => {
    const base = makeBaseSchema();
    const snapshot = JSON.stringify(base);
    setNodeLayout(base, { positions: { [KNOWN]: { x: 1, y: 1 } } });

    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it("没有 layout 的结构也能写入", () => {
    const base = makeBaseSchema();
    expect(base.layout).toBeUndefined();

    const after = setNodeLayout(base, { positions: { [KNOWN]: { x: 0, y: 0 } } });
    expect(after.layout).toEqual({ [KNOWN]: { x: 0, y: 0 } });
  });
});
