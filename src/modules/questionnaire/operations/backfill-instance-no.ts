/**
 * 实例编号回填的**纯逻辑**。
 *
 * 依据 docs/11-future-capability-plan.md 第 5.3 节。
 *
 * 抽成纯函数的理由：
 *   回填脚本会直接改库，且是**全库扫描**（不分环境）。
 *   因此它的正确性不能靠「跑一遍脚本看结果」来验证 ——
 *   那会连带改动真实数据。把「怎么编号」与「怎么落库」分开后，
 *   前者可以放心地做单元测试，后者只剩几行直白的 upsert。
 */

/** 取「本地」日期的 YYYYMMDD，与运行时发号（repository.allocateInstanceNo）一致 */
export function localDayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 从既有编号里解析序号；格式不符返回 null */
export function parseInstanceNoSeq(no: string): number | null {
  const m = /^INS-\d{8}-(\d+)$/.exec(no);
  if (!m || !m[1]) return null;
  return Number(m[1]);
}

export interface BackfillInput {
  id: string;
  title: string;
  instanceNo: string | null;
  createdAt: Date;
}

export interface BackfillAssignment {
  id: string;
  title: string;
  no: string;
}

export interface BackfillPlan {
  /** 需要回填的实例（已有编号的不会出现在这里） */
  assignments: BackfillAssignment[];
  /** 每个日期段应把发号器校准到的值 */
  counterTargets: Map<string, number>;
  /** 编号格式无法解析、被跳过的实例（仅告警，不改动） */
  unparsable: { id: string; instanceNo: string }[];
}

/**
 * 计算回填方案。
 *
 * 规则：
 *   1. 按**本地日**分组（与运行时发号同一套日期口径）；
 *   2. 组内按 `createdAt` 升序编号，每组从 1 开始；
 *   3. **已有编号要计入组内序号**，否则回填值会与它们撞号；
 *   4. 已有编号的实例本身不动（幂等，可重复执行）。
 */
export function planInstanceNoBackfill(
  instances: readonly BackfillInput[]
): BackfillPlan {
  const byDay = new Map<string, BackfillInput[]>();
  for (const i of instances) {
    const day = localDayKey(i.createdAt);
    const list = byDay.get(day) ?? [];
    list.push(i);
    byDay.set(day, list);
  }

  const assignments: BackfillAssignment[] = [];
  const counterTargets = new Map<string, number>();
  const unparsable: { id: string; instanceNo: string }[] = [];

  for (const [day, list] of byDay) {
    // 先按创建时间排序，保证「谁先建的谁号小」
    const sorted = [...list].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    );

    // 第一遍：把已有编号的最大序号作为起点
    let seq = 0;
    for (const i of sorted) {
      if (!i.instanceNo) continue;
      const parsed = parseInstanceNoSeq(i.instanceNo);
      if (parsed === null) {
        unparsable.push({ id: i.id, instanceNo: i.instanceNo });
        continue;
      }
      seq = Math.max(seq, parsed);
    }

    // 第二遍：给没有编号的依次分配
    for (const i of sorted) {
      if (i.instanceNo) continue;
      seq += 1;
      assignments.push({
        id: i.id,
        title: i.title,
        no: `INS-${day}-${String(seq).padStart(4, "0")}`,
      });
    }

    counterTargets.set(day, seq);
  }

  return { assignments, counterTargets, unparsable };
}
