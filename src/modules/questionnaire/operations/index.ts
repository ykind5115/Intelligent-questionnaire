/**
 * Operation 层统一出口。
 *
 * AI Tool、REST Controller、未来的人工编辑器都从这里调用，
 * 保证「同一套业务逻辑」而不是各写一份（03 文档第 47 节）。
 */
export { addSection, type AddSectionResult } from "./add-section.js";
export { addQuestion, type AddQuestionResult } from "./add-question.js";
export { updateSection, type UpdateSectionResult } from "./update-section.js";
export { updateQuestion, type UpdateQuestionResult } from "./update-question.js";
export { removeQuestion, type RemoveQuestionResult } from "./remove-question.js";
export { moveQuestion, type MoveQuestionResult } from "./move-question.js";
export { removeSection, type RemoveSectionResult } from "./remove-section.js";
export {
  reorderSections,
  type ReorderSectionsResult,
} from "./reorder-sections.js";
export {
  reorderQuestions,
  type ReorderQuestionsResult,
} from "./reorder-questions.js";
export {
  planInstanceNoBackfill,
  localDayKey,
  parseInstanceNoSeq,
  type BackfillAssignment,
  type BackfillInput,
  type BackfillPlan,
} from "./backfill-instance-no.js";

export { uuidIdFactory, makeSequenceIdFactory, type IdFactory } from "./id-factory.js";

export type {
  AddSectionInput,
  AddQuestionInput,
  UpdateSectionInput,
  UpdateQuestionInput,
  RemoveQuestionInput,
  MoveQuestionInput,
  RemoveSectionInput,
  ReorderSectionsInput,
  ReorderQuestionsInput,
} from "./types.js";
