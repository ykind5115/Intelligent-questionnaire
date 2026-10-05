/**
 * update_section：修改分组信息。
 *
 * 依据 docs/03-questionnaire_schema_ai_tool_calling .md 第 18 节：
 *   V1 只支持修改 title / description。
 *
 * 最小变更原则（第 38 节）：
 *   只改传入的字段，其余原样保留。
 */
import {
  assertValidSchema,
  cloneSchema,
  findSectionIndex,
  requireNonEmptyText,
  type QuestionnaireSchema,
} from "./helpers.js";
import { sectionNotFound } from "../../../shared/errors/index.js";
import type { UpdateSectionInput } from "./types.js";

export interface UpdateSectionResult {
  schema: QuestionnaireSchema;
  section: { id: string; title: string };
}

export function updateSection(
  schema: QuestionnaireSchema,
  input: UpdateSectionInput
): UpdateSectionResult {
  const sectionIndex = findSectionIndex(schema, input.sectionId);
  if (sectionIndex < 0) {
    throw sectionNotFound(input.sectionId);
  }

  const next = cloneSchema(schema);
  const section = next.sections[sectionIndex];
  if (!section) throw sectionNotFound(input.sectionId);

  if (input.title !== undefined) {
    section.title = requireNonEmptyText(input.title, "title", 200);
  }

  if (input.description !== undefined) {
    section.description = input.description;
  }

  const validated = assertValidSchema(next);
  const updated = validated.sections[sectionIndex];
  if (!updated) throw sectionNotFound(input.sectionId);

  return {
    schema: validated,
    section: { id: updated.id, title: updated.title },
  };
}
