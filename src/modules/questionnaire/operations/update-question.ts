/**
 * update_question：修改问题。
 *
 * 依据 docs/03-questionnaire_schema_ai_tool_calling .md 第 19 节与第 38 节。
 *
 * 关键规则：
 *   1. 最小变更 —— 只改传入的字段；
 *   2. 不改变 id（改 id 等价于删旧增新，会丢失历史答案关联）；
 *   3. 题型在「需要选项」与「不需要选项」之间切换时，
 *      必须正确处理 options：要么要求提供，要么丢弃。
 */
import { uuidIdFactory, type IdFactory } from "./id-factory.js";
import {
  assertValidSchema,
  buildOptions,
  cloneSchema,
  findQuestion,
  normalizeQuestionType,
  renumberQuestions,
  requireNonEmptyText,
  CHOICE_TYPES,
  type QuestionnaireSchema,
} from "./helpers.js";
import { invalidOptions, questionNotFound } from "../../../shared/errors/index.js";
import type { UpdateQuestionInput } from "./types.js";

export interface UpdateQuestionResult {
  schema: QuestionnaireSchema;
  question: { id: string; title: string; type: string };
}

export function updateQuestion(
  schema: QuestionnaireSchema,
  input: UpdateQuestionInput,
  ids: IdFactory = uuidIdFactory
): UpdateQuestionResult {
  const found = findQuestion(schema, input.questionId);
  if (!found) {
    throw questionNotFound(input.questionId);
  }

  const next = cloneSchema(schema);
  const section = next.sections[found.sectionIndex];
  if (!section) throw questionNotFound(input.questionId);
  const question = section.questions[found.questionIndex];
  if (!question) throw questionNotFound(input.questionId);

  // ---- title ----
  if (input.title !== undefined) {
    question.title = requireNonEmptyText(input.title, "title", 500);
  }

  // ---- description ----
  if (input.description !== undefined) {
    question.description = input.description;
  }

  // ---- required ----
  if (input.required !== undefined) {
    question.required = input.required;
  }

  // ---- type 与 options 需要一起考虑 ----
  const nextType =
    input.type !== undefined ? normalizeQuestionType(input.type) : question.type;

  const typeChanged = nextType !== question.type;
  const becomesChoice = CHOICE_TYPES.includes(nextType);

  if (input.options !== undefined) {
    // 显式传了 options：按新题型重建（题型不变时也允许整体替换选项）
    const options = buildOptions(input.options, nextType, ids);
    if (options) {
      question.options = options;
    } else {
      delete question.options;
    }
  } else if (typeChanged) {
    // 改了题型但没传 options
    if (becomesChoice) {
      throw invalidOptions(
        `题型改为 ${nextType} 时必须提供 options`
      );
    }
    // 从选择题改为非选择题：必须丢弃选项，否则 Schema 校验会失败
    delete question.options;
  } else if (becomesChoice && !question.options) {
    // 题型本来就是选择题却没有选项 —— 理论上不可能，防御性检查
    throw invalidOptions(`题型 ${nextType} 缺少 options`);
  }

  question.type = nextType;

  renumberQuestions(section);

  const validated = assertValidSchema(next);

  return {
    schema: validated,
    question: {
      id: input.questionId,
      title: question.title,
      type: question.type,
    },
  };
}
