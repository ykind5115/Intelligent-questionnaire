/**
 * Operation 层共用辅助。
 *
 * 这一层是**纯函数**：不依赖 Prisma、不依赖 Express、不依赖 AI 上下文。
 * 输入 (QuestionnaireSchema, Input) → 输出新的 QuestionnaireSchema。
 *
 * 依据 docs/06-proj_init.md 第 18 至 19 节与第 5 节（决策 D3）：
 *   AI Tool 只是入口之一，未来的人工编辑器 / 批量修改 / 导入
 *   都会复用这一层，因此修改逻辑不能写死在 tool 里。
 */
import {
  questionnaireSchema,
  questionTypeSchema,
  CHOICE_TYPES,
  type QuestionnaireSchema,
  type QuestionnaireSection,
  type QuestionnaireQuestion,
  type QuestionOption,
  type QuestionType,
} from "../schema/questionnaire.schema.js";
import { invalidOptions, invalidQuestionType, invalidParameter } from "../../../shared/errors/index.js";

/** 深拷贝问卷结构（结构是纯 JSON，用结构化克隆即可） */
export function cloneSchema(schema: QuestionnaireSchema): QuestionnaireSchema {
  return structuredClone(schema);
}

/**
 * 重新计算 order，保证在同一容器内连续、从 1 开始、无重复。
 *
 * 依据 03 文档第 21 节：
 *   后端重新计算 order，而不是相信调用方传入的所有顺序值。
 */
export function renumberSections(schema: QuestionnaireSchema): void {
  schema.sections.forEach((sec, i) => {
    sec.order = i + 1;
  });
}

export function renumberQuestions(section: QuestionnaireSection): void {
  section.questions.forEach((q, i) => {
    q.order = i + 1;
  });
}

/** 校验并返回格式化的题型（拒绝未知题型） */
export function normalizeQuestionType(type: string): QuestionType {
  const parsed = questionTypeSchema.safeParse(type);
  if (!parsed.success) {
    throw invalidQuestionType(type);
  }
  return parsed.data;
}

export interface OptionInput {
  label: string;
  value?: string;
}

/**
 * 把调用方传入的选项转换成合法 Option 数组。
 *
 * 依据 03 文档第 17.3 节：
 *   AI 只需要给出 label（和可选 value），
 *   真正的 Option ID 与 order 由后端生成。
 */
export function buildOptions(
  options: OptionInput[] | undefined,
  type: QuestionType,
  ids: { optionId: () => string }
): QuestionOption[] | undefined {
  const needsOptions = CHOICE_TYPES.includes(type);

  if (!needsOptions) {
    if (options && options.length > 0) {
      throw invalidOptions(`题型 ${type} 不应携带选项`);
    }
    return undefined;
  }

  if (!options || options.length < 2) {
    throw invalidOptions(`题型 ${type} 至少需要 2 个选项`);
  }

  const labels = options.map((o) => o.label.trim());
  if (labels.some((l) => l.length === 0)) {
    throw invalidOptions("选项内容不能为空");
  }

  const seen = new Set<string>();
  for (const l of labels) {
    if (seen.has(l)) {
      throw invalidOptions(`选项重复：${l}`);
    }
    seen.add(l);
  }

  return options.map((o, i) => ({
    id: ids.optionId(),
    label: o.label.trim(),
    value: (o.value ?? o.label).trim(),
    order: i + 1,
  }));
}

/** 在问卷中查找分组；返回其索引 */
export function findSectionIndex(
  schema: QuestionnaireSchema,
  sectionId: string
): number {
  return schema.sections.findIndex((s) => s.id === sectionId);
}

/** 在问卷中查找问题；返回所在分组索引与问题索引 */
export function findQuestion(
  schema: QuestionnaireSchema,
  questionId: string
): { sectionIndex: number; questionIndex: number } | undefined {
  for (let si = 0; si < schema.sections.length; si++) {
    const sec = schema.sections[si];
    if (!sec) continue;
    const qi = sec.questions.findIndex((q) => q.id === questionId);
    if (qi >= 0) return { sectionIndex: si, questionIndex: qi };
  }
  return undefined;
}

/** 问题 ID 全局唯一性检查（答案表按 question_id 关联，必须唯一） */
export function questionIdExists(
  schema: QuestionnaireSchema,
  questionId: string
): boolean {
  return findQuestion(schema, questionId) !== undefined;
}

/**
 * 校验字符串参数非空，并去除首尾空白。
 * 用于 title 之类的必填文本。
 */
export function requireNonEmptyText(
  value: unknown,
  fieldName: string,
  maxLength = 500
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidParameter(`${fieldName} 不能为空`, { path: fieldName });
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw invalidParameter(
      `${fieldName} 长度不能超过 ${maxLength} 个字符`,
      { path: fieldName, length: trimmed.length }
    );
  }
  return trimmed;
}

/**
 * 最终校验：所有 Operation 在返回前都必须调用。
 *
 * 这是「Operation 层不可能产出非法结构」的保证点 ——
 * 任何绕过它的修改路径都不允许存在。
 */
export function assertValidSchema(
  schema: QuestionnaireSchema
): QuestionnaireSchema {
  return questionnaireSchema.parse(schema);
}

export type { QuestionnaireSchema, QuestionnaireSection, QuestionnaireQuestion };

/** 需要 options 的题型，转发给 Operation 层使用 */
export { CHOICE_TYPES };
