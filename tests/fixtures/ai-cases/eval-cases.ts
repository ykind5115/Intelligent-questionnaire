/**
 * AI 评测用例集（决策 D5）。
 *
 * 这些用例把「AI 能不能把一句话变成可用问卷」变成可量化的断言。
 *
 * 两条使用路径：
 *   1. CI 回归（不需要 API Key）：用 ScriptedProvider 驱动真实业务链路，
 *      验证评测机制本身、以及「工具调用 → 结构落库」的正确性；
 *   2. 真实评测（需要 AI_API_KEY）：把同一个用例集喂给真实模型，
 *      得到的 passRate / keywordCoverageRate 就是 V1 的量化验收指标。
 *
 * 用例设计原则：
 *   - 覆盖 RPD 里真实出现的业务（无人机黑飞、宠物饲养）；
 *   - 包含多轮补充（RPD 第 9 节要求「用户持续对话补充信息」）；
 *   - 修改类用例必须检查「原有内容是否被保留」，
 *     因为增量修改的核心风险就是弄丢已有题目。
 */
import type { EvalCase } from "./types.js";

// ============================================================
// 生成类（create_template）
// ============================================================

const createCases: EvalCase[] = [
  {
    id: "create-001",
    description: "单轮：无人机黑飞核查问卷，明确给出三个调查要点",
    scene: "create_template",
    templateName: "无人机黑飞核查问卷",
    messages: [
      "帮我做一个无人机黑飞核查问卷，主要调查有没有购买无人机、有没有飞过、在哪里飞过，还需要了解无人机的型号。",
    ],
    expect: {
      minSections: 1,
      minQuestions: 3,
      requiredQuestionKeywords: ["无人机"],
    },
  },
  {
    id: "create-002",
    description: "多轮：先给部分信息，再补充调查重点（RPD 第 9 节的持续对话）",
    scene: "create_template",
    templateName: "宠物饲养规范核查问卷",
    messages: [
      "做一个宠物饲养规范核查的问卷。",
      "还要问清楚有没有办理养犬登记，以及疫苗有没有按期打。",
    ],
    expect: {
      minSections: 1,
      minQuestions: 3,
      requiredQuestionKeywords: ["登记", "疫苗"],
    },
  },
  {
    id: "create-003",
    description: "隐含分组：需要按调查维度自行组织分组结构",
    scene: "create_template",
    templateName: "电信诈骗核查问卷",
    messages: [
      "做一个电信网络诈骗的核查问卷，要了解涉案人员的基本信息、资金流向，以及和同伙的关联情况。",
    ],
    expect: {
      // 用户没明说「要分成几个部分」，模型应自行组织
      minSections: 2,
      minQuestions: 4,
    },
  },
  {
    id: "create-004",
    description: "题型选择：应当使用合适题型而不是全部用文本",
    scene: "create_template",
    templateName: "无人机使用情况核查问卷",
    messages: [
      "做一个无人机使用情况核查问卷，要问是否拥有无人机、拥有几台、平时用来做什么。",
    ],
    expect: {
      minSections: 1,
      minQuestions: 3,
      requiredQuestionKeywords: ["无人机"],
    },
  },
];

// ============================================================
// 修改类（modify_questionnaire）
// ============================================================

const modifyCases: EvalCase[] = [
  {
    id: "modify-001",
    description: "增加一个分组：团伙关系调查（RPD 第 3 节的核心场景）",
    scene: "modify_questionnaire",
    messages: [
      "这次调查张三，重点关注他有没有团伙，另外想了解一下他最近半年去过哪些地方。",
    ],
    expect: {
      // 修改后原有分组必须还在
      mustPreserveQuestionKeywords: ["姓名", "无人机"],
      minQuestions: 1,
    },
  },
  {
    id: "modify-002",
    description: "只改一处措辞，不应影响其它题目（最小变更原则）",
    scene: "modify_questionnaire",
    messages: ["把「姓名」这一题的题干改成「被调查人姓名」。"],
    expect: {
      requiredQuestionKeywords: ["被调查人姓名"],
      // 其余题目不能被删掉
      mustPreserveQuestionKeywords: ["身份证号", "无人机"],
    },
  },
  {
    id: "modify-003",
    description: "明确要求删除某一题",
    scene: "modify_questionnaire",
    messages: ["「联系方式」这道题不需要了，删掉。"],
    expect: {
      mustRemoveQuestionKeywords: ["联系方式"],
      mustPreserveQuestionKeywords: ["姓名", "身份证号"],
    },
  },
  {
    id: "modify-004",
    description: "多轮增量：先加分组，再往分组里加题",
    scene: "modify_questionnaire",
    messages: [
      "增加一个「活动轨迹」的分组。",
      "在这个分组里问一下他去过哪些地方、什么时间去的。",
    ],
    expect: {
      minQuestions: 2,
      mustPreserveQuestionKeywords: ["姓名"],
    },
  },
];

export const EVAL_CASES: EvalCase[] = [...createCases, ...modifyCases];

/** 按 id 取用例 */
export function findEvalCase(id: string): EvalCase | undefined {
  return EVAL_CASES.find((c) => c.id === id);
}

/** 只取某一类用例 */
export function casesOfScene(
  scene: EvalCase["scene"]
): EvalCase[] {
  return EVAL_CASES.filter((c) => c.scene === scene);
}
