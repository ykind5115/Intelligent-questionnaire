/**
 * add_question：向指定分组新增问题。
 *
 * 依据 docs/03-questionnaire_schema_ai_tool_calling .md 第 17 节。
 *
 * ID 由后端生成（第 12 节），调用方不得指定。
 */
import { uuidIdFactory, type IdFactory } from "./id-factory.js";
import {
  assertValidSchema,
  buildOptions,
  cloneSchema,
  findSectionIndex,
  normalizeQuestionType,
  renumberQuestions,
  requireNonEmptyText,
  type QuestionnaireSchema,
} from "./helpers.js";
import { sectionNotFound } from "../../../shared/errors/index.js";
import type { AddQuestionInput } from "./types.js";

export interface AddQuestionResult {
  schema: QuestionnaireSchema;
  question: { id: string; title: string; order: number };
}

export function addQuestion(
  schema: QuestionnaireSchema,
  input: AddQuestionInput,
  ids: IdFactory = uuidIdFactory
): AddQuestionResult {
  const sectionIndex = findSectionIndex(schema, input.sectionId);
  if (sectionIndex < 0) {
    throw sectionNotFound(input.sectionId);
  }

  const type = normalizeQuestionType(input.type);
  const title = requireNonEmptyText(input.title, "title", 500);
  const options = buildOptions(input.options, type, ids);

  const next = cloneSchema(schema);
  const section = next.sections[sectionIndex];
  // findSectionIndex 已确认存在，此处仅为满足类型收窄
  if (!section) throw sectionNotFound(input.sectionId);

  const questionId = ids.questionId();

  section.questions.push({
    id: questionId,
    type,
    title,
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    required: input.required ?? false,
    order: section.questions.length + 1,
    ...(options ? { options } : {}),
  });

  renumberQuestions(section);

  const validated = assertValidSchema(next);
  const created = validated.sections[sectionIndex]?.questions.find(
    (q) => q.id === questionId
  );

  return {
    schema: validated,
    question: {
      id: questionId,
      title,
      order: created?.order ?? section.questions.length,
    },
  };
}
