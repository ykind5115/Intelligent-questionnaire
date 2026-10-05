/**
 * 类型定义：AI 评测用例。
 *
 * 依据决策 D5（docs/09-review-and-decisions.md 第 7 节）：
 *   把「AI 生成/修改问卷的成功率」变成**可量化、可回归**的指标，
 *   而不是靠人工主观判断（01-rpd 第 18/25 节的原始验收方式无法自动测）。
 *
 * 两类场景：
 *   create_template      —— AI 从自然语言从零建模板
 *   modify_questionnaire —— AI 在已有实例上做增量修改
 */

export interface EvalExpectations {
  /** 生成结果必须包含的分组标题关键词（任一命中即可） */
  sectionKeywords?: string[];

  /** 必须出现的题目关键词（**全部**都要命中） */
  requiredQuestionKeywords?: string[];

  /** 至少要有几个分组 / 题目 */
  minSections?: number;
  minQuestions?: number;

  /**
   * 修改类用例：这些题目关键词在修改后**必须仍然存在**。
   * 用来验证「增量修改没有把原有内容弄丢」——这是 02 文档第 10 节
   * 选择增量 Tool 而非整份重写的核心原因之一。
   */
  mustPreserveQuestionKeywords?: string[];

  /** 修改类用例：这些题目关键词在修改后应当**不再存在** */
  mustRemoveQuestionKeywords?: string[];
}

export interface EvalCase {
  /** 用例标识，稳定不变（用于跨运行对比成功率） */
  id: string;

  /** 这条用例想验证什么（写给人看） */
  description: string;

  scene: "create_template" | "modify_questionnaire";

  /** 建模板用例的模板名称 */
  templateName?: string;

  /**
   * 给（真实或假）模型的多轮用户消息。
   *
   * 多轮是刻意设计的：RPD 明确要求支持「用户持续对话补充信息」
   * （01-rpd 第 9 节），单轮用例测不出这一点。
   */
  messages: string[];

  expect: EvalExpectations;
}

/** 单条用例的执行结果 */
export interface EvalCaseResult {
  caseId: string;
  description: string;
  passed: boolean;

  /** 逐项断言的结果，便于定位「差在哪」 */
  checks: { name: string; passed: boolean; detail?: string }[];

  /** 实际生成的结构摘要 */
  observed: {
    sections: number;
    questions: number;
    sectionTitles: string[];
    questionTitles: string[];
  };

  /** 模型调用次数与工具调用次数（成本与效率指标） */
  modelCalls: number;
  toolCalls: number;
  /** 其中失败的工具调用数（成功的工具调用率由此推导） */
  failedToolCalls: number;

  error?: string;
  durationMs: number;
}

/** 一次完整评测的汇总指标 */
export interface EvalReport {
  /** 使用的 Provider 名称（真实模型名或 fake） */
  provider: string;
  model?: string;

  total: number;
  passed: number;

  /** 核心指标：Schema 合法性必须 100% */
  schemaValidRate: number;
  /** 关键点覆盖率：用例里要求的关键词是否都出现 */
  keywordCoverageRate: number;
  /** 工具调用正确率：是否未出现失败的工具调用 */
  toolSuccessRate: number;
  /** 多轮增量正确性：原有内容是否被保留（仅修改类用例） */
  preservationRate: number;
  /** 整体通过率 */
  passRate: number;

  results: EvalCaseResult[];
  durationMs: number;
}
