/**
 * Operation 层的输入类型。
 *
 * 依据 docs/03-questionnaire_schema_ai_tool_calling .md 第 16 至 21 节，
 * 并遵守决策 B1：Tool 参数命名。
 *
 * 命名约定（03 文档第 22.2 节）：
 *   Tool 参数（发给 LLM 的 JSON Schema）：snake_case
 *   TypeScript 内部类型：camelCase
 * 因此 Tool 层负责 snake_case → camelCase 的转换，
 * 本文件与 Operation 函数都只使用 camelCase。
 */
import type { QuestionType } from "../schema/questionnaire.schema.js";
import type { OptionInput } from "./helpers.js";

/** add_section */
export interface AddSectionInput {
  title: string;
  description?: string;
  /**
   * V1 不支持嵌套（决策：03 文档第 5A 节）。
   * 该字段保留以保持接口稳定，传入即报错。
   */
  parentSectionId?: string;
}

/** add_question */
export interface AddQuestionInput {
  sectionId: string;
  type: QuestionType;
  title: string;
  description?: string;
  required?: boolean;
  options?: OptionInput[];
}

/** update_section：只允许改 title / description（03 文档第 18 节） */
export interface UpdateSectionInput {
  sectionId: string;
  title?: string;
  description?: string;
}

/**
 * update_question：只传要改的字段。
 *
 * 依据 03 文档第 38 节最小变更原则：
 *   不要用「删除 + 新增」来改一道题。
 */
export interface UpdateQuestionInput {
  questionId: string;
  title?: string;
  description?: string;
  type?: QuestionType;
  required?: boolean;
  options?: OptionInput[];
}

/** remove_question */
export interface RemoveQuestionInput {
  questionId: string;
}

/** move_question */
export interface MoveQuestionInput {
  questionId: string;
  targetSectionId: string;
  /** 目标位置（1 开始）。不传则追加到末尾。 */
  targetOrder?: number;
}
