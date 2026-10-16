/**
 * reorder_questions：把某个分组内的问题按给定顺序重排。
 *
 * 与 reorder_sections 同理：调用方只给 id 顺序，order 由后端算。
 *
 * 为什么限定在「单个分组内」：
 *   跨分组拖拽会同时改变两个分组的顺序，语义上属于 move_question 的职责
 *   （它已支持 targetSectionId + targetOrder）。
 *   这里只处理组内重排，边界清楚；跨组拖拽由前端调 move_question。
 */
import {
  assertValidSchema,
  cloneSchema,
  findSectionIndex,
  renumberQuestions,
  type QuestionnaireSchema,
} from "./helpers.js";
import {
  invalidParameter,
  questionNotFound,
  sectionNotFound,
} from "../../../shared/errors/index.js";
import type { ReorderQuestionsInput } from "./types.js";

export interface ReorderQuestionsResult {
  schema: QuestionnaireSchema;
  sectionId: string;
  order: string[];
}

export function reorderQuestions(
  schema: QuestionnaireSchema,
  input: ReorderQuestionsInput
): ReorderQuestionsResult {
  const sectionIndex = findSectionIndex(schema, input.sectionId);
  if (sectionIndex < 0) {
    throw sectionNotFound(input.sectionId);
  }

  const section = schema.sections[sectionIndex];
  if (!section) throw sectionNotFound(input.sectionId);

  const wanted = input.questionIds;
  const existing = section.questions.map((q) => q.id);

  if (new Set(wanted).size !== wanted.length) {
    throw invalidParameter("questionIds 中存在重复的 id", {
      path: "questionIds",
    });
  }

  // 先查「是不是本组的题」，再查数量。
  // 顺序有意如此：把别的分组的题混进来时，报「题目不属于该分组」比报
  // 「数量不对」准确得多 —— 数量通常恰好也是错的，先查数量会掩盖真正的原因。
  for (const id of wanted) {
    if (!existing.includes(id)) {
      throw questionNotFound(id);
    }
  }

  // 集合校验通过后再查数量，拦住「少给/多给本组题目」的情况。
  // 少给会让那道题凭空消失，是最危险的一种输入。
  if (wanted.length !== existing.length) {
    throw invalidParameter(
      `questionIds 必须包含该分组的全部问题（当前 ${existing.length} 个，收到 ${wanted.length} 个）`,
      { path: "questionIds", expected: existing.length, received: wanted.length }
    );
  }

  const next = cloneSchema(schema);
  const nextSection = next.sections[sectionIndex];
  if (!nextSection) throw sectionNotFound(input.sectionId);

  const byId = new Map(nextSection.questions.map((q) => [q.id, q]));
  nextSection.questions = wanted.map((id) => {
    const q = byId.get(id);
    if (!q) throw questionNotFound(id);
    return q;
  });

  renumberQuestions(nextSection);

  return {
    schema: assertValidSchema(next),
    sectionId: nextSection.id,
    order: nextSection.questions.map((q) => q.id),
  };
}
