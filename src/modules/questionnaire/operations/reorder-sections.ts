/**
 * reorder_sections：按给定的 id 顺序重排分组。
 *
 * 依据 03 文档第 21 节「后端重新计算 order，而不是相信调用方传入的顺序值」：
 *   调用方只提供**期望的 id 顺序**，真正的 order 由后端写。
 *   这样前端不需要自己算 1..N（拖拽后最容易算错的就是这个）。
 *
 * 为什么需要它（而不是多次 move_section）：
 *   一次拖拽会改变被拖项**以及它跨过的所有项**的顺序。
 *   用「移动一个」的接口表达，前端要做一串推算，且中途失败会留下半截顺序。
 *   整表重排是一次原子写，前端只需把新的 id 数组发过来。
 */
import {
  assertValidSchema,
  cloneSchema,
  type QuestionnaireSchema,
} from "./helpers.js";
import { invalidParameter, sectionNotFound } from "../../../shared/errors/index.js";
import type { ReorderSectionsInput } from "./types.js";

export interface ReorderSectionsResult {
  schema: QuestionnaireSchema;
  /** 重排后的分组 id 顺序，便于前端核对 */
  order: string[];
}

export function reorderSections(
  schema: QuestionnaireSchema,
  input: ReorderSectionsInput
): ReorderSectionsResult {
  const wanted = input.sectionIds;
  const existing = schema.sections.map((s) => s.id);

  // 必须是同一个集合的排列：既不允许多、也不允许少。
  // 少一个会让那个分组凭空消失（最危险），多一个则是前端状态陈旧。
  if (wanted.length !== existing.length) {
    throw invalidParameter(
      `sectionIds 必须包含全部分组（当前 ${existing.length} 个，收到 ${wanted.length} 个）`,
      { path: "sectionIds", expected: existing.length, received: wanted.length }
    );
  }

  const wantedSet = new Set(wanted);
  if (wantedSet.size !== wanted.length) {
    throw invalidParameter("sectionIds 中存在重复的 id", { path: "sectionIds" });
  }
  for (const id of wanted) {
    if (!existing.includes(id)) {
      throw sectionNotFound(id);
    }
  }

  const next = cloneSchema(schema);
  // 按给定顺序取；此时已校验过集合相等，因此不会丢项
  const byId = new Map(next.sections.map((s) => [s.id, s]));
  next.sections = wanted.map((id) => {
    const sec = byId.get(id);
    if (!sec) throw sectionNotFound(id);
    return sec;
  });

  next.sections.forEach((sec, i) => {
    sec.order = i + 1;
  });

  return {
    schema: assertValidSchema(next),
    order: next.sections.map((s) => s.id),
  };
}
