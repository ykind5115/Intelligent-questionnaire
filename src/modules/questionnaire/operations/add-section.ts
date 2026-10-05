/**
 * add_section：新增问卷分组。
 *
 * 依据 docs/03-questionnaire_schema_ai_tool_calling .md 第 16 节。
 *
 * V1 只支持一级 section（第 5A 节）：
 *   parentSectionId 传入即拒绝，返回 NESTED_SECTION_UNSUPPORTED。
 */
import { OperationError, ErrorCode } from "../../../shared/errors/index.js";
import { uuidIdFactory, type IdFactory } from "./id-factory.js";
import {
  assertValidSchema,
  cloneSchema,
  renumberSections,
  requireNonEmptyText,
  type QuestionnaireSchema,
} from "./helpers.js";
import type { AddSectionInput } from "./types.js";

export interface AddSectionResult {
  schema: QuestionnaireSchema;
  section: { id: string; title: string; order: number };
}

export function addSection(
  schema: QuestionnaireSchema,
  input: AddSectionInput,
  ids: IdFactory = uuidIdFactory
): AddSectionResult {
  if (input.parentSectionId !== undefined && input.parentSectionId !== null) {
    throw new OperationError(
      ErrorCode.NESTED_SECTION_UNSUPPORTED,
      "V1 不支持嵌套分组（parent_section_id）。" +
        "详见 03-questionnaire_schema_ai_tool_calling .md 第 5A 节",
      { path: "parentSectionId" }
    );
  }

  const title = requireNonEmptyText(input.title, "title", 200);

  const next = cloneSchema(schema);

  const sectionId = ids.sectionId();

  next.sections.push({
    id: sectionId,
    title,
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    order: next.sections.length + 1,
    questions: [],
  });

  // 后端重算 order，不相信调用方传入的顺序（03 文档第 21 节）
  renumberSections(next);

  const validated = assertValidSchema(next);

  return {
    schema: validated,
    section: { id: sectionId, title, order: validated.sections.length },
  };
}
