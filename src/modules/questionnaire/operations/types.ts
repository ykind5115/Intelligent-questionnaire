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

/**
 * remove_section：删除分组（连同组内问题）。
 *
 * 人工编辑器（拖拽画布）需要它 —— 从零建模板时加错分组要能撤销掉，
 * 而不是逐题删除后留下一个空分组。
 */
export interface RemoveSectionInput {
  sectionId: string;
}

/**
 * reorder_sections：按给定的 id 顺序整体重排分组。
 *
 * 只给顺序，order 由后端重算（03 文档第 21 节）。
 * 一次拖拽会牵动被拖项跨过的所有项，用「整表重排」表达最不容易错。
 */
export interface ReorderSectionsInput {
  /** 必须恰好是当前全部分组的一个排列 */
  sectionIds: string[];
}

/** reorder_questions：把单个分组内的问题按给定顺序重排 */
export interface ReorderQuestionsInput {
  sectionId: string;
  /** 必须恰好是该分组当前全部问题的一个排列 */
  questionIds: string[];
}

/**
 * set_question_branch：设置 / 清除某题的跳转分支。
 *
 * 为什么是整体替换而不是增删单条：编辑器（下拉改完保存）与 AI
 * （一次给出完整意图）都天然产出完整的分支列表；
 * 增删单条会让前端自己维护下标，两侧不同步时就会写出与用户意图不符的分支。
 */
export interface SetQuestionBranchInput {
  questionId: string;
  /**
   * 分支规则。按声明顺序取第一条命中。
   * 传空数组或省略 = 清除该题的全部分支。
   */
  branches?: {
    when: {
      op: "eq" | "ne" | "in" | "not_in" | "is_answered" | "is_empty";
      /** 比较对象：同一份结构内的题目 id */
      questionId: string;
      value?: unknown;
    };
    goTo: string;
  }[];
  /**
   * 都不命中时去哪一题：
   *   undefined（省略） = 不定义，按 order 走下一题
   *   null              = 显式声明「本题是终点，问卷到此结束」
   *   题目 id           = 跳到该题
   */
  defaultNext?: string | null;
}
