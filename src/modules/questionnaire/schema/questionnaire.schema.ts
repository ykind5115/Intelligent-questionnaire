/**
 * Questionnaire Schema 定义。
 *
 * 权威来源：docs/03-questionnaire_schema_ai_tool_calling .md 第 4 至 12 节。
 *
 * 这是 AI / 后端 / 前端三方共同的结构语言，**只允许有一份定义**。
 * 任何其他文档或模块中出现不一致的字段名，都以本文件为准。
 *
 * V1 范围限制（03 文档第 5A 节）：
 *   - Section.children 字段保留，但 V1 不启用 section 嵌套；
 *   - 不存在 Question.children（不支持问题套问题）。
 */
import { z } from "zod";

/** 题型：03 文档第 7 节，共 8 种 */
export const questionTypeSchema = z.enum([
  "text",
  "textarea",
  "number",
  "single_choice",
  "multiple_choice",
  "date",
  "datetime",
  "boolean",
]);

export type QuestionType = z.infer<typeof questionTypeSchema>;

/** 需要 options 的题型 */
export const CHOICE_TYPES: readonly QuestionType[] = [
  "single_choice",
  "multiple_choice",
];

export const optionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.string().min(1),
  order: z.number().int().nonnegative(),
});

export type QuestionOption = z.infer<typeof optionSchema>;

/** 基础校验规则：03 文档第 9 节 */
export const questionValidationSchema = z.object({
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  pattern: z.string().optional(),
});

export type QuestionValidation = z.infer<typeof questionValidationSchema>;

// ============================================================
// 条件分支 / 跳题（决策 D16，计划 §4）
// ============================================================

/**
 * 比较操作符白名单。
 *
 * 只做**可枚举**的比较，不做任意表达式 —— 后者（动态计算、跨题公式、
 * 多层级联动）在 `01-rpd.md` §17.2 被归为「高级问卷逻辑」，与本特性分开。
 */
export const branchOperatorSchema = z.enum([
  "eq",
  "ne",
  "in",
  "not_in",
  "is_answered",
  "is_empty",
]);
export type BranchOperator = z.infer<typeof branchOperatorSchema>;

/** 没有 value 的操作符（是否作答无法用「值」表达） */
export const VALUELESS_BRANCH_OPERATORS: readonly BranchOperator[] = [
  "is_answered",
  "is_empty",
];

/** 需要「集合」形态 value 的操作符 */
export const SET_BRANCH_OPERATORS: readonly BranchOperator[] = ["in", "not_in"];

/**
 * 一条分支规则：满足 when 就跳到 goTo。
 *
 * `when` 用扁平结构（op + questionId + value）而不是嵌套表达式树：
 * 表达式树会让 AI 工具参数、前端表单、后端校验三处都复杂一大截，
 * 而 V1 只需要单题比较。
 */
export const branchRuleSchema = z
  .object({
    when: z.object({
      op: branchOperatorSchema,
      /** 比较对象：同一份结构内的题目 id（如 q_004） */
      questionId: z.string().min(1),
      /**
       * 比较值。类型随题型而变：
       *   布尔题 → boolean；数字题 → number；单选 → 选项 id（字符串）
       *   多选 → 选项 id 数组；文本 → 字符串
       */
      value: z.unknown().optional(),
    }),
    /** 命中后跳到的题目 id */
    goTo: z.string().min(1),
  })
  .superRefine((rule, ctx) => {
    const { op, value } = rule.when;
    const valueless = VALUELESS_BRANCH_OPERATORS.includes(op);

    if (valueless && value !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `操作符 ${op} 不需要 value`,
        path: ["when", "value"],
      });
      return;
    }

    if (!valueless && value === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `操作符 ${op} 必须提供 value`,
        path: ["when", "value"],
      });
      return;
    }

    if (!valueless) {
      if (SET_BRANCH_OPERATORS.includes(op)) {
        if (!Array.isArray(value) || value.length === 0) {
          ctx.addIssue({
            code: "custom",
            message: `操作符 ${op} 的 value 必须是非空数组`,
            path: ["when", "value"],
          });
        }
      } else if (Array.isArray(value)) {
        ctx.addIssue({
          code: "custom",
          message: `操作符 ${op} 的 value 不能是数组`,
          path: ["when", "value"],
        });
      }
    }
  });

export type BranchRule = z.infer<typeof branchRuleSchema>;

export const questionSchema = z
  .object({
    id: z.string().min(1),
    type: questionTypeSchema,
    title: z.string().min(1),
    description: z.string().optional(),
    required: z.boolean(),
    order: z.number().int().nonnegative(),
    options: z.array(optionSchema).optional(),
    validation: questionValidationSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),

    /**
     * 按顺序取**第一条命中**的规则跳转。
     *
     * 为什么是数组而不是单个对象：一个题目常常有多条规则（选项 A 跳这里、
     * 选项 B 跳那里），再加上「都不命中」这第三种情况，
     * 用单对象会把它压缩成 `elseGoTo` 一个字段，反而不好扩展。
     */
    branches: z.array(branchRuleSchema).optional(),

    /**
     * 分支都不命中时去哪一题。
     *
     * `undefined` = 没定义，按 `order` 走下一题（**存量问卷都是这种，行为不变**）
     * `null`      = 显式声明「本题是终点，问卷到此结束」
     */
    defaultNext: z.string().min(1).nullable().optional(),
  })
  .superRefine((q, ctx) => {
    const needsOptions = CHOICE_TYPES.includes(q.type);

    if (needsOptions && (!q.options || q.options.length < 2)) {
      ctx.addIssue({
        code: "custom",
        message: `题型 ${q.type} 至少需要 2 个选项`,
        path: ["options"],
      });
    }

    if (!needsOptions && q.options && q.options.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `题型 ${q.type} 不应携带选项`,
        path: ["options"],
      });
    }

    // ---- 分支规则的自环与重复 ----
    if (q.branches) {
      q.branches.forEach((rule, i) => {
        if (rule.goTo === q.id) {
          ctx.addIssue({
            code: "custom",
            message: "分支不能跳到自己（会形成无法推进的自环）",
            path: ["branches", i, "goTo"],
          });
        }
        // 注意：**允许**条件引用题目自己。
        // 「按本题答案决定是否跳过本题」是问卷里最常见的分支需求
        // （如「是否飞过？→ 否 → 跳过后面的飞行细节」），
        // 实现上本题会被记为已走过再立即跳走（见 flow.ts）。
      });

      // 同一题 + 同一比较值 出现两条规则时，后一条永远不可能命中 —— 多半是复制粘贴出错
      const seen = new Set<string>();
      q.branches.forEach((rule, i) => {
        const key = JSON.stringify([rule.when.op, rule.when.questionId, rule.when.value]);
        if (seen.has(key)) {
          ctx.addIssue({
            code: "custom",
            message: "存在完全相同的两条分支条件，后一条永远不会命中",
            path: ["branches", i],
          });
        }
        seen.add(key);
      });
    }

    // ---- value 类型必须与「被引用题目的题型」相容 ----
    // 题目级 superRefine 里拿不到同问卷的其他题目，因此这里只能做
    // 「自身的 value 形态与自身题型」一致性检查；
    // 跨题目的引用有效性（悬空 goTo、题型相容）在问卷级 superRefine 里做。
  });

export type QuestionnaireQuestion = z.infer<typeof questionSchema>;

/**
 * Section。
 *
 * children 使用 z.lazy 以支持自引用类型；
 * 但 V1 的运行期约束是「不嵌套」（见 03 文档第 5A 节），
 * 该校验放在问卷级 superRefine 中，而不是在这里。
 */
export const sectionSchema: z.ZodType<QuestionnaireSection> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    order: z.number().int().nonnegative(),
    questions: z.array(questionSchema),
    children: z.array(sectionSchema).optional(),
  })
);

export interface QuestionnaireSection {
  id: string;
  title: string;
  description?: string;
  order: number;
  questions: QuestionnaireQuestion[];
  children?: QuestionnaireSection[];
}

/**
 * 图级校验的**注入点**。
 *
 * 为什么用注入而不是直接 import：
 *   「跳转关系是否正确」属于图算法（悬空引用、环是否收敛、选项 id 是否属于该题），
 *   实现放在 `operations/flow.ts`；而 flow.ts 又需要本文件的类型，
 *   直接互相 import 会形成循环。
 *
 *   因此这里只保留一个注册表：flow.ts 在自己模块加载时注册校验函数，
 *   本文件在 `superRefine` 里调用它。任一侧没被加载时退化为「不做图校验」，
 *   不会抛错 —— 这对纯结构测试（只加载 schema）是必要的。
 */
export interface FlowIssueLike {
  path: (string | number)[];
  message: string;
}
type FlowChecker = (schema: unknown) => FlowIssueLike[];

let flowChecker: FlowChecker | null = null;

export function registerFlowChecker(checker: FlowChecker): void {
  flowChecker = checker;
}

export const questionnaireSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    sections: z.array(sectionSchema),
    version: z.number().int().nonnegative(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((q, ctx) => {
    // 决策：V1 不支持 section 嵌套（03 文档第 5A 节）
    q.sections.forEach((s, i) => {
      if (s.children && s.children.length > 0) {
        ctx.addIssue({
          code: "custom",
          message:
            "V1 不支持 section 嵌套，children 必须为空。" +
            "详见 03-questionnaire_schema_ai_tool_calling .md 第 5A 节",
          path: ["sections", i, "children"],
        });
      }
    });

    // section id 唯一
    const sectionIds = q.sections.map((s) => s.id);
    if (new Set(sectionIds).size !== sectionIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "section id 必须唯一",
        path: ["sections"],
      });
    }

    // question id 全局唯一（答案表按 question_id 关联，必须唯一）
    const questionIds = q.sections.flatMap((s) =>
      s.questions.map((x) => x.id)
    );
    if (new Set(questionIds).size !== questionIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "question id 必须全局唯一",
        path: ["sections"],
      });
    }

    // 图级校验（悬空引用 / 比较值类型 / 环是否收敛）。
    // 只在题目 id 唯一时才做 —— 否则索引会丢项，报出来的错会误导。
    const idsUnique = new Set(questionIds).size === questionIds.length;
    if (flowChecker && idsUnique) {
      for (const issue of flowChecker(q)) {
        ctx.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path,
        });
      }
    }
  });

export type QuestionnaireSchema = z.infer<typeof questionnaireSchema>;

/** 版本号：V1 用 1 起步的整数（04 文档第 12 节 / 01 文档的 V1.0 显示层映射） */
export const INITIAL_SCHEMA_VERSION = 1;
