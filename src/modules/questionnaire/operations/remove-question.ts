/**
 * remove_question：删除问题。
 *
 * 依据 docs/03-questionnaire_schema_ai_tool_calling .md 第 20 节。
 *
 * 重要业务规则（第 20.2 节）：
 *   V1 不允许 AI 静默删除重要问题。
 *   删除必须来源于用户明确要求。
 *
 * 本函数只负责「结构和法性」；
 * 「是否得到用户明确授权」属于 Prompt 约束 + 审计范畴，
 * 由 Tool 层的 description 与审计日志共同保证。
 */
import {
  assertValidSchema,
  cloneSchema,
  findQuestion,
  renumberQuestions,
  type QuestionnaireSchema,
} from "./helpers.js";
import { questionNotFound } from "../../../shared/errors/index.js";
import type { RemoveQuestionInput } from "./types.js";

export interface RemoveQuestionResult {
  schema: QuestionnaireSchema;
  removed: { id: string; title: string; sectionId: string };
}

export function removeQuestion(
  schema: QuestionnaireSchema,
  input: RemoveQuestionInput
): RemoveQuestionResult {
  const found = findQuestion(schema, input.questionId);
  if (!found) {
    throw questionNotFound(input.questionId);
  }

  const next = cloneSchema(schema);
  const section = next.sections[found.sectionIndex];
  if (!section) throw questionNotFound(input.questionId);

  const [removed] = section.questions.splice(found.questionIndex, 1);
  if (!removed) throw questionNotFound(input.questionId);

  // 删除后重排，保证 order 连续（03 文档第 21 节精神）
  renumberQuestions(section);

  const validated = assertValidSchema(next);

  return {
    schema: validated,
    removed: {
      id: removed.id,
      title: removed.title,
      sectionId: section.id,
    },
  };
}
