/**
 * move_question：调整问题位置。
 *
 * 依据 docs/03-questionnaire_schema_ai_tool_calling .md 第 21 节：
 *   - 可以移动到另一个分组；
 *   - 可以在同组内调整顺序；
 *   - **后端重新计算 order，而不是相信调用方传入的所有顺序值**。
 *
 * 实现要点：
 *   同组内移动时，必须先摘除再插入，否则索引会错位。
 */
import {
  assertValidSchema,
  cloneSchema,
  findQuestion,
  findSectionIndex,
  renumberQuestions,
  type QuestionnaireSchema,
} from "./helpers.js";
import {
  invalidParameter,
  questionNotFound,
  sectionNotFound,
} from "../../../shared/errors/index.js";
import type { MoveQuestionInput } from "./types.js";

export interface MoveQuestionResult {
  schema: QuestionnaireSchema;
  question: { id: string; sectionId: string; order: number };
}

export function moveQuestion(
  schema: QuestionnaireSchema,
  input: MoveQuestionInput
): MoveQuestionResult {
  const found = findQuestion(schema, input.questionId);
  if (!found) {
    throw questionNotFound(input.questionId);
  }

  const targetSectionIndex = findSectionIndex(schema, input.targetSectionId);
  if (targetSectionIndex < 0) {
    throw sectionNotFound(input.targetSectionId);
  }

  const next = cloneSchema(schema);

  const sourceSection = next.sections[found.sectionIndex];
  if (!sourceSection) throw questionNotFound(input.questionId);

  // 先摘除
  const [moved] = sourceSection.questions.splice(found.questionIndex, 1);
  if (!moved) throw questionNotFound(input.questionId);

  const targetSection = next.sections[targetSectionIndex];
  if (!targetSection) throw sectionNotFound(input.targetSectionId);

  // 计算插入位置
  const maxOrder = targetSection.questions.length + 1;
  let insertAt: number;

  if (input.targetOrder === undefined) {
    insertAt = targetSection.questions.length; // 追加到末尾
  } else {
    if (
      !Number.isInteger(input.targetOrder) ||
      input.targetOrder < 1 ||
      input.targetOrder > maxOrder
    ) {
      throw invalidParameter(
        `targetOrder 必须在 1 到 ${maxOrder} 之间`,
        { path: "targetOrder", targetOrder: input.targetOrder, maxOrder }
      );
    }
    insertAt = input.targetOrder - 1;
  }

  targetSection.questions.splice(insertAt, 0, moved);

  // 源分组与目标分组的 order 都要重算
  renumberQuestions(sourceSection);
  if (targetSection.id !== sourceSection.id) {
    renumberQuestions(targetSection);
  }

  const validated = assertValidSchema(next);

  const finalSection = validated.sections[targetSectionIndex];
  const finalQuestion = finalSection?.questions.find(
    (q) => q.id === input.questionId
  );
  if (!finalSection || !finalQuestion) {
    throw questionNotFound(input.questionId);
  }

  return {
    schema: validated,
    question: {
      id: input.questionId,
      sectionId: finalSection.id,
      order: finalQuestion.order,
    },
  };
}
