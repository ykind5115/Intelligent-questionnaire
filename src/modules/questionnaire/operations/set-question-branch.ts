/**
 * set_question_branch：设置 / 清除某个题目的跳转分支。
 *
 * 依据决策 D16 与 docs/11-future-capability-plan.md 第 4.9 节第 4 步。
 *
 * 为什么是「整体替换」而不是「加一条规则 / 删一条规则」：
 *   编辑器的交互是「下拉里选规则、改完点保存」，AI 的交互是
 *   「我理解完整的分支意图，一次给出」——
 *   两者都天然产出**完整的分支列表**。
 *   若提供增删单条的接口，前端还要自己维护下标与顺序，
 *   而且一旦两侧状态不同步就会写出与用户意图不符的分支。
 *   整体替换让「用户看到的」与「存进去的」严格一致。
 *
 * `branches` 传空数组 / `defaultNext` 传 undefined 表示清除该字段
 * —— 用缺失而不是空数组表示「没有分支」，保持存量结构干净。
 */
import {
  assertValidSchema,
  cloneSchema,
  findQuestion,
  type QuestionnaireSchema,
} from "./helpers.js";
import { invalidParameter, questionNotFound } from "../../../shared/errors/index.js";
import { checkFlow } from "./flow.js";
import type { SetQuestionBranchInput } from "./types.js";

export interface SetQuestionBranchResult {
  schema: QuestionnaireSchema;
  question: {
    id: string;
    /** 设置后的分支条数（0 表示已清除） */
    branchCount: number;
    defaultNext: string | null | undefined;
  };
}

export function setQuestionBranch(
  schema: QuestionnaireSchema,
  input: SetQuestionBranchInput
): SetQuestionBranchResult {
  const found = findQuestion(schema, input.questionId);
  if (!found) {
    throw questionNotFound(input.questionId);
  }

  const next = cloneSchema(schema);
  const section = next.sections[found.sectionIndex];
  if (!section) throw questionNotFound(input.questionId);
  const question = section.questions[found.questionIndex];
  if (!question) throw questionNotFound(input.questionId);

  // ---- 自环的即时拒绝 ----
  // schema 层也会拦，但那需要走一遍完整 parse；这里给出更直接的错误信息，
  // 让 AI/编辑器的报错更好懂（尤其是「跳到自己」这种最常见的误操作）。
  const targets = [
    ...(input.branches ?? []).map((r) => r.goTo),
    ...(typeof input.defaultNext === "string" ? [input.defaultNext] : []),
  ];
  if (targets.includes(input.questionId)) {
    throw invalidParameter("分支不能跳到自己", {
      path: "branches",
      questionId: input.questionId,
    });
  }

  // 条件可以引用题目自己。
  // 「按本题的答案决定要不要跳过本题」正是问卷里最常见的需求：
  //   「是否飞过？→ 否 → 跳过后面的飞行细节」
  // 实现上本题会被记为已走过，然后立即跳走 —— 见 flow.ts 的推进规则。
  // 因此这里**刻意不禁止自引用条件**。

  // ---- 写入 ----
  if (input.branches && input.branches.length > 0) {
    question.branches = input.branches;
  } else {
    // 空数组 = 清除。用 delete 而不是留一个空数组，
    // 否则序列化出来的结构里到处是 "branches": []，既占体积又干扰人工阅读。
    delete question.branches;
  }

  if (input.defaultNext === undefined || input.defaultNext === null) {
    if (input.defaultNext === null) {
      question.defaultNext = null; // 显式终点
    } else {
      delete question.defaultNext;
    }
  } else {
    question.defaultNext = input.defaultNext;
  }

  // ---- 图校验：**先跑这个，再跑结构校验** ----
  //
  // 顺序很重要：`assertValidSchema` 失败时抛的是 ZodError，
  // 它不是 OperationError，会被兜底成 500 —— 而「跳转指向不存在的题目」
  // 明明是调用方参数错误，应该是 400。
  // 先把图问题翻成 invalidParameter，错误码与错误信息都正确。
  const issues = checkFlow(next);
  if (issues.length > 0) {
    throw invalidParameter(issues[0]!.message, {
      path: issues[0]!.path.join("."),
    });
  }

  // ---- 结构校验（此时图已合法，剩下的只有结构性约束，如选项数量）----
  const validated = assertValidSchema(next);

  return {
    schema: validated,
    question: {
      id: input.questionId,
      branchCount: validated.sections[found.sectionIndex]?.questions[
        found.questionIndex
      ]?.branches?.length ?? 0,
      defaultNext: validated.sections[found.sectionIndex]?.questions[
        found.questionIndex
      ]?.defaultNext,
    },
  };
}
