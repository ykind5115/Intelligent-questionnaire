/**
 * 问卷跳转流程的**纯逻辑**（不依赖 Zod，也不依赖任何 IO）。
 *
 * 依据决策 D16 与 docs/11-future-capability-plan.md 第 4 节。
 *
 * 为什么单独一层：
 *   1. 校验（flow-check）与求值（flow）都要用同一份「题目索引 / 顺序」，
 *      放两处必然漂移；
 *   2. `questionnaire.schema.ts` 需要做跨题目的图校验，但**不能反过来**
 *      依赖结构定义（会形成循环 import），因此 schema 采用
 *      「注入校验回调」的方式，回调由本模块提供；
 *   3. 这里的函数必须保持**纯**：不读时钟、不碰数据库、不生成随机数，
 *      这样它能被单元测试直接覆盖，也与 Operation 层的约定一致。
 */

/** 比较操作符（与 questionnaire.schema.ts 的 branchOperatorSchema 保持同步） */
export const FLOW_OPERATORS = [
  "eq",
  "ne",
  "in",
  "not_in",
  "is_answered",
  "is_empty",
] as const;
export type FlowOperator = (typeof FLOW_OPERATORS)[number];

/** 无效时无需 value 的操作符 */
export const VALUELESS_OPERATORS: readonly FlowOperator[] = [
  "is_answered",
  "is_empty",
];

/** 需要集合形态 value 的操作符 */
export const SET_OPERATORS: readonly FlowOperator[] = ["in", "not_in"];

/** 结构里参与流程的最小形状（只声明流程关心的字段） */
export interface FlowQuestionLike {
  id: string;
  order: number;
  branches?: {
    when: { op: FlowOperator; questionId: string; value?: unknown };
    goTo: string;
  }[];
  defaultNext?: string | null;
}

export interface FlowSectionLike {
  id: string;
  order: number;
  questions: FlowQuestionLike[];
}

export interface FlowSchemaLike {
  sections: FlowSectionLike[];
}

// ============================================================
// 索引
// ============================================================

export interface FlowIndex {
  /** 按 `order` 升序的题目 id（跨分组） */
  ordered: string[];
  /** questionId → 所属 sectionId */
  sectionOf: Map<string, string>;
  /** questionId → 题目 */
  byId: Map<string, FlowQuestionLike>;
}

/**
 * 建立流程索引。
 *
 * 排序规则：先按 section.order，再按 question.order ——
 * 与 `collectQuestions` 的既有展平顺序一致，因此存量问卷的「下一题」
 * 与今天的行为完全相同（这是向后兼容的关键）。
 */
export function buildFlowIndex(schema: FlowSchemaLike): FlowIndex {
  const sections = [...schema.sections].sort((a, b) => a.order - b.order);

  const ordered: string[] = [];
  const sectionOf = new Map<string, string>();
  const byId = new Map<string, FlowQuestionLike>();

  for (const sec of sections) {
    const questions = [...sec.questions].sort((a, b) => a.order - b.order);
    for (const q of questions) {
      ordered.push(q.id);
      sectionOf.set(q.id, sec.id);
      byId.set(q.id, q);
    }
  }

  return { ordered, sectionOf, byId };
}

// ============================================================
// 条件求值
// ============================================================

/** 单题答案的归一化形态（与 questionnaire_answers.answer 的 JSONB 一致） */
export interface AnswerLike {
  optionIds?: string[];
  value?: unknown;
  [key: string]: unknown;
}

/**
 * 把一条答案归一化成「可比较的值」。
 *
 * 真实系统里**两种形态并存**（已在集成测试中实测到）：
 *   - 裸标量：`true`、`"某公园"`、`["o1"]`
 *   - 包装对象：`{ value: true }`、`{ optionIds: ["o1"] }`
 * 前者来自直接保存的答案，后者来自早期/其他客户端写入的历史数据。
 *
 * 比较前必须统一，否则「规则 value 是裸布尔、答案是包装对象」时会漏判 ——
 * 这正是分支门控曾经不生效的原因。
 *
 * 递归解包是必要的：`{value:{value:true}}` 这类嵌套在真实数据里出现过，
 * 而 `{value:["o1"]}` 与 `{optionIds:["o1"]}` 必须归一到同一个数组形态。
 */
function answerValueOf(answer: unknown): unknown {
  if (answer === null || answer === undefined) return undefined;

  // 标量直接返回（最常见也最快）
  if (typeof answer !== "object") return answer;

  const a = answer as AnswerLike;

  // optionIds 优先（多选题的规范形态）
  if (Array.isArray(a.optionIds)) {
    return a.optionIds.length === 0 ? undefined : a.optionIds;
  }

  if ("value" in a) {
    const inner = answerValueOf(a.value);
    // value 解出来是空集合 → 视为未作答，而不是「答了一个空数组」
    if (Array.isArray(inner) && inner.length === 0) return undefined;
    return inner;
  }

  return a;
}

/** 答案是否算「已作答」（空数组、空字符串、undefined 都算未作答） */
export function isAnswered(answer: unknown): boolean {
  const v = answerValueOf(answer);
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * 判断一条分支规则是否命中。
 *
 * 这里**不抛异常**：求值发生在填写过程中，答案缺字段是常态
 * （用户还没答），此时规则就是不命中，而不是错误。
 */
export function evaluateRule(
  rule: { when: { op: FlowOperator; questionId: string; value?: unknown } },
  answers: Readonly<Record<string, unknown>>
): boolean {
  const { op, questionId, value } = rule.when;
  const actual = answerValueOf(answers[questionId]);
  const answered = isAnswered(answers[questionId]);

  switch (op) {
    case "is_answered":
      return answered;
    case "is_empty":
      return !answered;
    case "eq":

      // 布尔题直接比；其余按字符串比较，避免 1 与 "1" 这类类型差异导致漏判
      if (typeof value === "boolean") return actual === value;
      return String(actual) === String(value);
    case "ne":
      if (typeof value === "boolean") return actual !== value;
      return String(actual) !== String(value);
    case "in": {
      const set = Array.isArray(value) ? value : [];
      if (Array.isArray(actual)) {
        // 多选题：命中任一选项即算命中
        return actual.some((a) => set.some((s) => String(s) === String(a)));
      }
      return set.some((s) => String(s) === String(actual));
    }
    case "not_in": {
      const set = Array.isArray(value) ? value : [];
      if (Array.isArray(actual)) {
        return !actual.some((a) => set.some((s) => String(s) === String(a)));
      }
      return !set.some((s) => String(s) === String(actual));
    }
    default: {
      const never: never = op;
      throw new Error(`未知操作符：${String(never)}`);
    }
  }
}

// ============================================================
// 流程求值
// ============================================================

/** 走到某一题的原因（诊断与 UI 提示都用得上） */
export type FlowStepReason = "entry" | "rule" | "default" | "fallthrough" | "end";

export interface FlowStep {
  questionId: string;
  sectionId: string;
  order: number;
  reason: FlowStepReason;
}

export interface ResolveFlowOptions {
  /** 路径长度上限（收敛检测），默认按题目数推算 */
  maxSteps?: number;
}

export interface FlowResult {
  /** 从入口到结束的题目序列 */
  steps: FlowStep[];
  /** 该路径经过的题目 id 集合（必填校验只看它） */
  visited: Set<string>;
  /** 结束原因：explicit = 某题声明 defaultNext: null；exhausted = 没有下一题了 */
  endedBy: "explicit" | "exhausted";
}

/**
 * 环是否收敛的步数上限。
 *
 * 为什么用「超上限」而不是「检测到重复节点」：
 *   多路径汇聚到同一题是**合法**的 DAG（A→C、B→C），
 *   用「重复即环」会误杀。而一个真正无出口的环会让路径无限增长，
 *   因此用「步数超过上限」判定即可，既不误杀又能拦住真环。
 *
 * 上限取 `题目数 × 2 + 8`：正常路径最多每题走一次（题目数步），
 * 留出余量以便容纳合法的重复经过（如汇聚后再次向下）。
 */
export function defaultMaxSteps(questionCount: number): number {
  return questionCount * 2 + 8;
}

/** 取 `order` 上紧跟在 `id` 之后的那一题（跨分组） */
function nextByOrder(index: FlowIndex, id: string): string | undefined {
  const i = index.ordered.indexOf(id);
  if (i < 0) return undefined;
  return index.ordered[i + 1];
}

/**
 * 按答案求出一条完整路径。
 *
 * 推进规则（计划 §4.4，三条必须写死）：
 *   1. 当前题命中某条分支规则 → 跳 `goTo`；
 *   2. 否则 `defaultNext` 有值 → 跳它；`defaultNext === null` → 问卷在此结束；
 *   3. 否则 → 按 `order` 走下一题；没有下一题 → 问卷结束。
 *
 * 规则 3 是**向后兼容**的关键：存量问卷没有任何分支字段，一律走它，
 * 行为与不带分支时完全一致。
 */
export function resolveFlow(
  schema: FlowSchemaLike,
  answers: Readonly<Record<string, unknown>>,
  options: ResolveFlowOptions = {}
): FlowResult {
  const index = buildFlowIndex(schema);
  const maxSteps = options.maxSteps ?? defaultMaxSteps(index.ordered.length);

  const steps: FlowStep[] = [];
  const visited = new Set<string>();

  const first = index.ordered[0];
  if (!first) {
    // 空问卷是合法状态（编辑器可以从零建）
    return { steps, visited, endedBy: "exhausted" };
  }

  let currentId: string | undefined = first;
  let reason: FlowStepReason = "entry";
  let endedBy: FlowResult["endedBy"] = "exhausted";

  while (currentId) {
    if (steps.length >= maxSteps) {
      throw new Error(
        `问卷分支无法收敛：从入口出发走了 ${steps.length} 步仍未结束，` +
          `可能存在没有出口的环（上限 ${maxSteps} 步）`
      );
    }

    const sectionId = index.sectionOf.get(currentId);
    if (sectionId === undefined) {
      throw new Error(`分支跳转指向了不存在的题目：${currentId}`);
    }
    const question = index.byId.get(currentId);
    if (!question) {
      throw new Error(`分支跳转指向了不存在的题目：${currentId}`);
    }


    steps.push({
      questionId: currentId,
      sectionId,
      order: question.order,
      reason,
    });
    visited.add(currentId);

    // 1) 分支规则（按声明顺序取第一条命中）
    let jumped: string | undefined;
    let nextReason: FlowStepReason = "fallthrough";



    for (const rule of question.branches ?? []) {
      if (evaluateRule(rule, answers)) {
        jumped = rule.goTo;
        nextReason = "rule";
        break;
      }
    }

    if (jumped) {
      currentId = jumped;
      reason = nextReason;
      continue;
    }

    // 2) defaultNext
    if (question.defaultNext === null) {
      endedBy = "explicit";
      currentId = undefined;
      break;
    }
    if (typeof question.defaultNext === "string") {
      currentId = question.defaultNext;
      reason = "default";
      continue;
    }

    // 3) 按 order 走下一题
    currentId = nextByOrder(index, currentId);
    reason = "fallthrough";
  }

  return { steps, visited, endedBy };
}

// ============================================================
// 图校验（供结构定义注入使用）
// ============================================================

export interface FlowIssue {
  /** 出错位置，形如 ["sections", 0, "questions", 1, "branches", 0, "goTo"] */
  path: (string | number)[];
  message: string;
}

/**
 * 校验跳转关系的**图级**正确性。
 *
 * 检查项（计划 §4.7）：
 *   V1  `goTo` / `defaultNext` 指向的题目必须存在（悬空引用）→ 报错
 *   V1b 条件引用的题目必须存在 → 报错
 *   V2  从入口出发必须能走到结束（环必须收敛）→ 报错
 *   V3  比较值的类型必须与被引用题目的题型相容 → 报错
 *
 * 注意「不可达题目」（V5）**不在这里报错**：它只是告警，
 * 而本函数只返回错误。见 `findUnreachable`。
 */
export function checkFlow(schema: FlowSchemaLike): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const index = buildFlowIndex(schema);

  // ---- V1 / V1b：悬空引用 ----
  schema.sections.forEach((section, si) => {
    section.questions.forEach((q, qi) => {
      const base = ["sections", si, "questions", qi] as (string | number)[];

      (q.branches ?? []).forEach((rule, bi) => {
        if (!index.byId.has(rule.goTo)) {
          issues.push({
            path: [...base, "branches", bi, "goTo"],
            message: `分支跳转指向不存在的题目：${rule.goTo}`,
          });
        }
        if (!index.byId.has(rule.when.questionId)) {
          issues.push({
            path: [...base, "branches", bi, "when", "questionId"],
            message: `分支条件引用了不存在的题目：${rule.when.questionId}`,
          });
        }
      });

      if (typeof q.defaultNext === "string" && !index.byId.has(q.defaultNext)) {
        issues.push({
          path: [...base, "defaultNext"],
          message: `默认跳转指向不存在的题目：${q.defaultNext}`,
        });
      }
    });
  });

  // 悬空引用会让后面的搜索无从下手，先返回
  if (issues.length > 0) return issues;

  // ---- V3：比较值类型与题型相容 ----
  schema.sections.forEach((section, si) => {
    section.questions.forEach((q, qi) => {
      (q.branches ?? []).forEach((rule, bi) => {
        const target = index.byId.get(rule.when.questionId);
        if (!target) return; // 上面已报
        const path = [
          "sections",
          si,
          "questions",
          qi,
          "branches",
          bi,
          "when",
          "value",
        ];
        issues.push(...checkValueType(rule.when.op, rule.when.value, target, path));
      });
    });
  });

  // ---- V2：环必须收敛 ----
  // 用「极端答案」探测：分别假设所有条件都命中第一条规则 / 都不命中，
  // 以及每种「只命中第 k 条」的情形 —— 覆盖所有可能的分支走向。
  for (const answers of probeAnswerSets(schema)) {
    try {
      resolveFlow(schema, answers);
    } catch (e) {
      issues.push({
        path: ["sections"],
        message:
          "存在没有出口的分支环（从入口出发永远走不到结束）：" +
          (e instanceof Error ? e.message : String(e)),
      });
      break; // 一个反例就够了，不必重复报
    }
  }

  return issues;
}

/** 比较值与被引用题型的相容性检查 */
function checkValueType(
  op: FlowOperator,
  value: unknown,
  target: FlowQuestionLike,
  path: (string | number)[]
): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const push = (message: string) => issues.push({ path, message });

  if (VALUELESS_OPERATORS.includes(op)) {
    if (value !== undefined) push(`操作符 ${op} 不需要 value`);
    return issues;
  }

  if (value === undefined) {
    push(`操作符 ${op} 必须提供 value`);
    return issues;
  }

  const type = (target as { type?: string }).type;
  const options = (target as { options?: { id: string }[] }).options ?? [];

  // 是否存在选项无法判断时（题目形状不全）跳过，避免误报
  if (type === undefined) return issues;

  const isChoice = type === "single_choice" || type === "multiple_choice";

  if (SET_OPERATORS.includes(op)) {
    if (!Array.isArray(value)) {
      push(`操作符 ${op} 的 value 必须是数组`);
      return issues;
    }
    if (isChoice && options.length > 0) {
      for (const v of value as unknown[]) {
        if (!options.some((o) => o.id === String(v))) {
          push(`选项 id 不属于题目「${target.id}」：${String(v)}`);
        }
      }
    }
    return issues;
  }

  if (Array.isArray(value)) {
    push(`操作符 ${op} 的 value 不能是数组`);
    return issues;
  }

  if (type === "boolean" && typeof value !== "boolean") {
    push(`题目「${target.id}」是是非题，value 必须是 true / false`);
  }
  if (type === "number" && typeof value !== "number") {
    push(`题目「${target.id}」是数字题，value 必须是数字`);
  }
  if (type === "single_choice" && options.length > 0) {
    // 必须先确认是字符串再比较。
    // 直接 String(value) 会在 value 是对象/数组时得到 "[object Object]"，
    // 于是比较**静默失败**，错误信息也变成无意义的 "[object Object]"
    // —— 这正是 ESLint 的 no-base-to-string 想拦的情况。
    if (typeof value !== "string") {
      push(
        `题目「${target.id}」是单选题，value 必须是选项 id（字符串），实际是 ${typeof value}`
      );
    } else if (!options.some((o) => o.id === value)) {
      push(`选项 id 不属于题目「${target.id}」：${value}`);
    }
  }
  if (type === "multiple_choice" && options.length > 0) {
    // 多选题用 in / not_in；用 eq 比较单个选项 id 是常见笔误
    if (!SET_OPERATORS.includes(op)) {
      push(
        `题目「${target.id}」是多选题，应使用 in / not_in 而不是 ${op}`
      );
    }
  }

  return issues;
}

/**
 * 构造一组「探测答案」，用于穷举可能的分支走向。
 *
 * 思路：每道题都可以「让某一条规则命中」或「都不命中」。
 * 对每条规则各生成一份「只有它命中」的答案，再加上「都不命中」，
 * 就覆盖了所有单点分支；组合分支（多条同时命中）不会产生新的走向，
 * 因为求值是按顺序取**第一条命中**，单点覆盖已经涵盖了每个出口。
 */
function probeAnswerSets(
  schema: FlowSchemaLike
): Record<string, unknown>[] {
  const index = buildFlowIndex(schema);
  const questions = [...index.byId.values()];

  // 让某个条件命中所需的答案片段
  const fragmentFor = (
    when: { op: FlowOperator; questionId: string; value?: unknown }
  ): Record<string, unknown> => {
    switch (when.op) {
      case "is_answered":
        return { [when.questionId]: { value: "x" } };
      case "is_empty":
        return {};
      case "eq":
        return { [when.questionId]: { value: when.value } };
      case "ne":
        return {};
      case "in":
      case "not_in": {
        const arr = Array.isArray(when.value) ? when.value : [];
        if (when.op === "in") return { [when.questionId]: { optionIds: arr } };
        return {};
      }
      default:
        return {};
    }
  };

  // 基线：所有条件都不命中（一律走 defaultNext / fallthrough）
  const sets: Record<string, unknown>[] = [{}];

  for (const q of questions) {
    (q.branches ?? []).forEach((rule) => {
      sets.push(fragmentFor(rule.when));
    });
  }

  // 「全部条件都尽量命中」的组合，用来探测多分支叠加后的走向
  const all: Record<string, unknown> = {};
  for (const q of questions) {
    for (const rule of q.branches ?? []) {
      Object.assign(all, fragmentFor(rule.when));
    }
  }
  sets.push(all);

  return sets;
}

/**
 * 找出从入口不可达的题目（V5）。
 *
 * 只作**告警**：编辑过程中的中间态常常存在暂时不可达的题目
 * （例如刚加了一道题还没接上分支），阻断保存会很难用。
 */
export function findUnreachable(schema: FlowSchemaLike): string[] {
  const index = buildFlowIndex(schema);
  const reachable = new Set<string>();

  // 从入口沿「所有可能的出口」做广度优先：可选边 = 每条分支的 goTo
  // + defaultNext + order 上的下一题（因为「都不命中」时会走它）
  const queue: string[] = [];
  const first = index.ordered[0];
  if (first) queue.push(first);

  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (reachable.has(id)) continue;
    if (!index.byId.has(id)) continue;
    reachable.add(id);

    const q = index.byId.get(id);
    if (!q) continue;

    for (const rule of q.branches ?? []) {
      if (!reachable.has(rule.goTo)) queue.push(rule.goTo);
    }
    if (typeof q.defaultNext === "string") {
      if (!reachable.has(q.defaultNext)) queue.push(q.defaultNext);
    } else if (q.defaultNext === undefined) {
      // 都不命中时会按 order 往下走 —— 这条边必须算进去，
      // 否则凡是靠 fallthrough 到达的题目都会被误报为不可达
      const next = index.ordered[index.ordered.indexOf(id) + 1];
      if (next && !reachable.has(next)) queue.push(next);
    }
  }

  return index.ordered.filter((id) => !reachable.has(id));
}

