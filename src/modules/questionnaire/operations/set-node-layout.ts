/**
 * 写入节点画布坐标（纯函数操作）。
 *
 * 依据决策 D16（只做加法）与 docs/11 §4.12。
 *
 * 这个操作与其它结构操作的关键区别：
 *   **它只动 layout，绝不动 sections**。
 *   原因是坐标是纯呈现信息，而结构编辑是业务改动；
 *   如果坐标写入走「整份结构覆盖」，那么
 *   两个人同时编辑（一个拖节点、一个改题目）时，后写者会冲掉前者。
 *   Service 层据此把它落成一个**只更新 layout 键**的局部写入
 *   （见 questionnaire.repository.mergeTemplateVersionLayout）。
 *
 * 纯函数：不碰 DB、不读时钟、不生成随机数。
 */
import type { QuestionnaireSchema } from "../schema/questionnaire.schema.js";
import type { SetNodeLayoutInput } from "./types.js";

/**
 * 「结束」节点的坐标键。
 *
 * `layout` 的键本来是题目 id，但「结束」节点不是题目、又需要能拖动，
 * 因此给它一个保留键。用 `__` 前后包住，是因为题目 id 一律是 `q_<uuid>`，
 * 不可能撞上。
 *
 * 前端 `public/editor-graph.js` 里有一份同名常量（原生 JS 无法 import TS），
 * 两处必须保持一致。
 */
export const END_NODE_KEY = "__end__";

/** 收集结构里所有题目 id（只一层 section，见 V1 限制） */
function collectQuestionIds(schema: QuestionnaireSchema): Set<string> {
  const ids = new Set<string>();
  for (const section of schema.sections) {
    for (const question of section.questions) {
      ids.add(question.id);
    }
  }
  return ids;
}

/**
 * 合并坐标。
 *
 * 语义：
 *   - 传入的坐标按 id 合并进已有的 layout；
 *   - **指向不存在题目的坐标会被丢弃**（删题后不该留下幽灵节点）；
 *   - 坐标取整（避免浮点噪声进 JSONB，也便于比较）。
 *
 * 为什么不整体替换 layout：
 *   前端可能只保存「本次拖动过的那几个节点」，
 *   其余节点的位置必须原样保留。
 */
export function setNodeLayout(
  schema: QuestionnaireSchema,
  input: SetNodeLayoutInput
): QuestionnaireSchema {
  const existing = schema.layout ?? {};
  const validIds = collectQuestionIds(schema);

  const merged: Record<string, { x: number; y: number }> = {};

  // 「结束」节点没有对应题目，必须特批保留，否则每次保存都会被当成幽灵坐标删掉
  const isValidKey = (id: string): boolean =>
    validIds.has(id) || id === END_NODE_KEY;

  // 先保留仍然有效的旧坐标
  for (const [id, position] of Object.entries(existing)) {
    if (isValidKey(id)) {
      merged[id] = { x: position.x, y: position.y };
    }
  }

  // 再覆盖/新增本次传入的坐标
  for (const [id, position] of Object.entries(input.positions)) {
    if (!isValidKey(id)) continue;
    merged[id] = {
      x: Math.round(position.x),
      y: Math.round(position.y),
    };
  }

  return { ...schema, layout: merged };
}
