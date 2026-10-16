/**
 * remove_section：删除分组（连同组内所有问题）。
 *
 * 为什么必须单独有这个 Operation（而不是让前端「把组内问题一个个删掉」）：
 *   「从零建模板」时加错一个分组是常事，逐题删除既啰嗦又会在中途留下
 *   「分组是空的」这种中间态。一次调用删干净，审计里也是一条清晰的记录。
 *
 * 依据 03 文档第 20 节的精神：删除必须是**显式**动作，
 * 不做任何隐式级联（例如「自动把组内问题搬去上一个分组」）——
 * 那会让用户丢失他没打算删的内容。这里删的就是整组，返回删掉了什么。
 */
import {
  assertValidSchema,
  cloneSchema,
  findSectionIndex,
  renumberSections,
  type QuestionnaireSchema,
} from "./helpers.js";
import { sectionNotFound } from "../../../shared/errors/index.js";
import type { RemoveSectionInput } from "./types.js";

export interface RemoveSectionResult {
  schema: QuestionnaireSchema;
  removed: {
    id: string;
    title: string;
    /** 一并删掉的问题 id，便于调用方知道影响面（审计与前端提示都用得上） */
    questionIds: string[];
  };
}

export function removeSection(
  schema: QuestionnaireSchema,
  input: RemoveSectionInput
): RemoveSectionResult {
  const sectionIndex = findSectionIndex(schema, input.sectionId);
  if (sectionIndex < 0) {
    throw sectionNotFound(input.sectionId);
  }

  const next = cloneSchema(schema);
  const [removed] = next.sections.splice(sectionIndex, 1);
  if (!removed) throw sectionNotFound(input.sectionId);

  // 删除后重排，保证 order 连续（03 文档第 21 节）
  renumberSections(next);

  return {
    schema: assertValidSchema(next),
    removed: {
      id: removed.id,
      title: removed.title,
      questionIds: removed.questions.map((q) => q.id),
    },
  };
}
