/**
 * 存量编号回填的纯逻辑测试。
 *
 * 为什么测纯函数而不是跑脚本：`scripts/backfill-instance-no.ts` 是**全库扫描**，
 * 在测试里真跑会连带改动真实数据（包括用户在开发期间自己建的案件）。
 * 把编号规则抽成纯函数后，这里可以放心覆盖各种边界。
 */
import { describe, expect, it } from "vitest";

import {
  localDayKey,
  parseInstanceNoSeq,
  planInstanceNoBackfill,
} from "../../../src/modules/questionnaire/operations/backfill-instance-no.js";

/** 造一条实例输入 */
function inst(
  id: string,
  createdAt: Date,
  instanceNo: string | null = null
) {
  return { id, title: `案件 ${id}`, instanceNo, createdAt };
}

/** 本地时间构造，避免时区跨界把日期算错 */
function at(y: number, m: number, d: number, h = 12): Date {
  return new Date(y, m - 1, d, h, 0, 0, 0);
}

describe("localDayKey", () => {
  it("用本地日期而不是 UTC", () => {
    // 本地 2026-10-15 23:30：UTC 可能已经是 10-16，但这里必须是本地日
    expect(localDayKey(at(2026, 10, 15, 23))).toBe("20261015");
    // 本地 2026-01-05 00:30：UTC 可能还是 01-04
    expect(localDayKey(at(2026, 1, 5, 0))).toBe("20260105");
  });
});

describe("parseInstanceNoSeq", () => {
  it("解析合法编号", () => {
    expect(parseInstanceNoSeq("INS-20261015-0001")).toBe(1);
    expect(parseInstanceNoSeq("INS-20261015-0142")).toBe(142);
    // 超过 4 位也能解析（序号大于 9999 时不再补零）
    expect(parseInstanceNoSeq("INS-20261015-10000")).toBe(10000);
  });

  it("格式不符返回 null", () => {
    for (const bad of [
      "ins-20261015-0001",
      "INS-20261015",
      "INS-20261015-",
      "20261015-0001",
      "INS-20261015-abc",
      "",
    ]) {
      expect(parseInstanceNoSeq(bad), bad).toBeNull();
    }
  });
});

describe("planInstanceNoBackfill", () => {
  it("按本地日分组，组内按创建时间升序编号", () => {
    const plan = planInstanceNoBackfill([
      inst("c", at(2026, 10, 13, 15)),
      inst("a", at(2026, 10, 13, 9)),
      inst("b", at(2026, 10, 13, 10)),
      inst("d", at(2026, 10, 9, 8)),
    ]);

    const byId = new Map(plan.assignments.map((x) => [x.id, x.no]));
    expect(byId.get("a")).toBe("INS-20261013-0001");
    expect(byId.get("b")).toBe("INS-20261013-0002");
    expect(byId.get("c")).toBe("INS-20261013-0003");
    // 另一天从 1 重新开始
    expect(byId.get("d")).toBe("INS-20261009-0001");
  });

  it("已有编号的实例不进入回填列表（幂等）", () => {
    const plan = planInstanceNoBackfill([
      inst("keep", at(2026, 10, 13, 9), "INS-20261013-0001"),
      inst("new", at(2026, 10, 13, 10)),
    ]);

    expect(plan.assignments.map((a) => a.id)).toEqual(["new"]);
    // 新号必须避开已占用的 0001
    expect(plan.assignments[0]!.no).toBe("INS-20261013-0002");
  });

  it("已有编号的**最大**序号被计入，避免与它们撞号", () => {
    // 手动造一条序号很大的记录（模拟历史数据跳号）
    const plan = planInstanceNoBackfill([
      inst("big", at(2026, 10, 13, 9), "INS-20261013-0042"),
      inst("new", at(2026, 10, 13, 10)),
    ]);

    expect(plan.assignments[0]!.no).toBe("INS-20261013-0043");
  });

  it("发号器目标取每组最大序号（含已有编号）", () => {
    const plan = planInstanceNoBackfill([
      inst("a", at(2026, 10, 13, 9)),
      inst("b", at(2026, 10, 13, 10)),
      inst("c", at(2026, 10, 9, 9), "INS-20261009-0007"),
    ]);

    expect(plan.counterTargets.get("20261013")).toBe(2);
    // 该组没有待回填项，但目标仍要反映已有编号
    expect(plan.counterTargets.get("20261009")).toBe(7);
  });

  it("没有待回填项时 assignments 为空，但 counterTargets 仍然有值", () => {
    const plan = planInstanceNoBackfill([
      inst("a", at(2026, 10, 13, 9), "INS-20261013-0003"),
    ]);

    expect(plan.assignments).toEqual([]);
    expect(plan.counterTargets.get("20261013")).toBe(3);
  });

  it("无法解析的编号被记录并跳过，不影响其他实例", () => {
    const plan = planInstanceNoBackfill([
      inst("weird", at(2026, 10, 13, 9), "手工编号-001"),
      inst("new", at(2026, 10, 13, 10)),
    ]);

    expect(plan.unparsable).toEqual([
      { id: "weird", instanceNo: "手工编号-001" },
    ]);
    // 无法解析 ⇒ 序号从 0 起算，新号是 0001
    expect(plan.assignments[0]!.no).toBe("INS-20261013-0001");
  });

  it("输入顺序被打乱也不影响结果（内部会排序）", () => {
    const plan = planInstanceNoBackfill([
      inst("z", at(2026, 10, 13, 20)),
      inst("a", at(2026, 10, 13, 1)),
      inst("m", at(2026, 10, 13, 10)),
    ]);

    const order = plan.assignments.map((x) => x.id);
    expect(order).toEqual(["a", "m", "z"]);
  });

  it("空输入不报错", () => {
    const plan = planInstanceNoBackfill([]);
    expect(plan.assignments).toEqual([]);
    expect(plan.counterTargets.size).toBe(0);
    expect(plan.unparsable).toEqual([]);
  });
});
