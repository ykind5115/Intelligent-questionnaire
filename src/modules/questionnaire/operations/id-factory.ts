/**
 * 问卷节点 ID 生成器。
 *
 * 依据 docs/03-questionnaire_schema_ai_tool_calling .md 第 11 至 12 节：
 *   - 所有结构节点（Section / Question / Option）统一使用唯一 ID；
 *   - **ID 由后端生成，不允许 AI 生成**；
 *   - V1 不要求 ID 携带业务含义。
 *
 * 设计要点：生成器是可注入的（IdFactory）。
 * Operation 层接受它作为参数，因此：
 *   1. 生产环境用 UUID v7，与 04 文档第 6 节一致；
 *   2. 单元测试可注入确定性生成器，让断言稳定可读。
 */
import { newId } from "../../../shared/utils/id.js";

export interface IdFactory {
  sectionId(): string;
  questionId(): string;
  optionId(): string;
}

export const uuidIdFactory: IdFactory = {
  sectionId: () => `sec_${newId()}`,
  questionId: () => `q_${newId()}`,
  optionId: () => `opt_${newId()}`,
};

/**
 * 确定性 ID 生成器，仅用于测试。
 *
 * 用法：
 *   const ids = makeSequenceIdFactory();
 *   // sec_1, q_2, opt_3, ...
 */
export function makeSequenceIdFactory(): IdFactory {
  let n = 0;
  const next = () => ++n;
  return {
    sectionId: () => `sec_${next()}`,
    questionId: () => `q_${next()}`,
    optionId: () => `opt_${next()}`,
  };
}
