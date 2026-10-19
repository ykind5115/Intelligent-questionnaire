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
  setQuestionBranch,
  type SetQuestionBranchResult,
} from "./set-question-branch.js";
export {
  planInstanceNoBackfill,
  localDayKey,
  parseInstanceNoSeq,
  type BackfillAssignment,
  type BackfillInput,
  type BackfillPlan,
} from "./backfill-instance-no.js";

/**
 * 跳转流程（决策 D16 / 计划 §4）。
 *
 * 注意：**必须从本文件导出 `flow-check`** ——
 * 它的模块加载会把图校验注册进 `questionnaireSchema`。
 * 任何结构操作都会经过本文件，因此注册总是发生（见 flow-check.ts 的说明）。
 */
export {
  checkFlow,
  findUnreachable,
  resolveFlow,
  FLOW_OPERATORS,
  VALUELESS_OPERATORS,
  SET_OPERATORS,
  buildFlowIndex,
  defaultMaxSteps,
  evaluateRule,
  isAnswered,
  type FlowIssue,
  type FlowResult,
  type FlowStep,
  type FlowStepReason,
  type FlowIndex,
  type FlowQuestionLike,
  type FlowSectionLike,
  type FlowSchemaLike,
  type FlowOperator,
  type ResolveFlowOptions,
} from "./flow-check.js";

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
  SetQuestionBranchInput,
  SetNodeLayoutInput,
} from "./types.js";

export { setNodeLayout } from "./set-node-layout.js";