/**
 * Questionnaire Schema 定义。
 *
 * 权威来源：docs/03-questionnaire_schema_ai_tool_calling .md 第 4 至 12 节。
 *
 * 这是 AI / 后端 / 前端三方共同的结构语言，**只允许有一份定义**。
 * 任何其他文档或模块中出现不一致的字段名，都以本文件为准。
 *
 * V1 范围限制（03 文档第 5A 节）：
 *   - Section.children 字段保留，但 V1 不启用 section 嵌套；
 *   - 不存在 Question.children（不支持问题套问题）。
 */
import { z } from "zod";

/** 题型：03 文档第 7 节，共 8 种 */
export const questionTypeSchema = z.enum([
  "text",
  "textarea",
  "number",
  "single_choice",
  "multiple_choice",
  "date",
  "datetime",
  "boolean",
]);

export type QuestionType = z.infer<typeof questionTypeSchema>;

/** 需要 options 的题型 */
export const CHOICE_TYPES: readonly QuestionType[] = [
  "single_choice",
  "multiple_choice",
];

export const optionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.string().min(1),
  order: z.number().int().nonnegative(),
});

export type QuestionOption = z.infer<typeof optionSchema>;

/** 基础校验规则：03 文档第 9 节 */
export const questionValidationSchema = z.object({
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  pattern: z.string().optional(),
});

export type QuestionValidation = z.infer<typeof questionValidationSchema>;

export const questionSchema = z
  .object({
    id: z.string().min(1),
    type: questionTypeSchema,
    title: z.string().min(1),
    description: z.string().optional(),
    required: z.boolean(),
    order: z.number().int().nonnegative(),
    options: z.array(optionSchema).optional(),
    validation: questionValidationSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((q, ctx) => {
    const needsOptions = CHOICE_TYPES.includes(q.type);

    if (needsOptions && (!q.options || q.options.length < 2)) {
      ctx.addIssue({
        code: "custom",
        message: `题型 ${q.type} 至少需要 2 个选项`,
        path: ["options"],
      });
    }

    if (!needsOptions && q.options && q.options.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `题型 ${q.type} 不应携带选项`,
        path: ["options"],
      });
    }
  });

export type QuestionnaireQuestion = z.infer<typeof questionSchema>;

/**
 * Section。
 *
 * children 使用 z.lazy 以支持自引用类型；
 * 但 V1 的运行期约束是「不嵌套」（见 03 文档第 5A 节），
 * 该校验放在问卷级 superRefine 中，而不是在这里。
 */
export const sectionSchema: z.ZodType<QuestionnaireSection> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    order: z.number().int().nonnegative(),
    questions: z.array(questionSchema),
    children: z.array(sectionSchema).optional(),
  })
);

export interface QuestionnaireSection {
  id: string;
  title: string;
  description?: string;
  order: number;
  questions: QuestionnaireQuestion[];
  children?: QuestionnaireSection[];
}

export const questionnaireSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    sections: z.array(sectionSchema),
    version: z.number().int().nonnegative(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((q, ctx) => {
    // 决策：V1 不支持 section 嵌套（03 文档第 5A 节）
    q.sections.forEach((s, i) => {
      if (s.children && s.children.length > 0) {
        ctx.addIssue({
          code: "custom",
          message:
            "V1 不支持 section 嵌套，children 必须为空。" +
            "详见 03-questionnaire_schema_ai_tool_calling .md 第 5A 节",
          path: ["sections", i, "children"],
        });
      }
    });

    // section id 唯一
    const sectionIds = q.sections.map((s) => s.id);
    if (new Set(sectionIds).size !== sectionIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "section id 必须唯一",
        path: ["sections"],
      });
    }

    // question id 全局唯一（答案表按 question_id 关联，必须唯一）
    const questionIds = q.sections.flatMap((s) =>
      s.questions.map((x) => x.id)
    );
    if (new Set(questionIds).size !== questionIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "question id 必须全局唯一",
        path: ["sections"],
      });
    }
  });

export type QuestionnaireSchema = z.infer<typeof questionnaireSchema>;

/** 版本号：V1 用 1 起步的整数（04 文档第 12 节 / 01 文档的 V1.0 显示层映射） */
export const INITIAL_SCHEMA_VERSION = 1;
