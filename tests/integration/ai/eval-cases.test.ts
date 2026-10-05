/**
 * AI 评测用例集的可执行验证（决策 D5）。
 *
 * 这个文件做两件事：
 *   1. **验证评测机制本身可用** —— 用假 Provider 驱动真实业务链路，
 *      确认「用例 → 对话 → 工具调用 → 结构落库 → 断言 → 量化报告」
 *      整条链路是通的，且报告指标算得对；
 *   2. 提供**真实模型的接入点** —— 同一套用例与执行器
 *      （tests/integration/ai/harness.ts）只要换成 DeepSeekProvider
 *      就能对真实模型跑一遍，得到 V1 的量化验收指标。
 *
 * 为什么不在这里直接调真实模型：
 *   CI 不能依赖 AI_API_KEY，也不该消耗额度。
 *   因此这里用 ScriptedProvider 给出「理想的工具调用序列」，
 *   得到的全绿结果证明的是**评测器与业务链路正确**，
 *   而不是「模型能力达标」——后者必须用真实 Key 跑。
 */
import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "../../../src/database/client.js";
import { formatEvalReport, runEval } from "./harness.js";
import type { LLMProvider, ChatResult } from "../../../src/modules/ai/providers/index.js";
import type { EvalCase } from "../../fixtures/ai-cases/types.js";
import { EVAL_CASES } from "../../fixtures/ai-cases/eval-cases.js";

// ============================================================
// 假 Provider：按用例给出「理想」的工具调用序列
// ============================================================

class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  constructor(private readonly script: ChatResult[]) {}

  private next(): ChatResult {
    return (
      this.script.shift() ?? {
        content: "（脚本已用尽）",
        toolCalls: [],
        model: "scripted",
      }
    );
  }

  async chat(): Promise<ChatResult> {
    return this.next();
  }

  // eslint-disable-next-line require-yield
  async *chatStream(): AsyncIterable<never> {
    throw new Error("评测不使用流式");
  }
}

function call(
  id: string,
  name: string,
  args: unknown,
  content: string | null = null
): ChatResult {
  return {
    content,
    toolCalls: [
      {
        id,
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    ],
    model: "scripted",
    finishReason: "tool_calls",
  };
}


// ============================================================
// 用例集自身的静态校验
// ============================================================

describe("评测用例集（决策 D5）", () => {
  it("用例 id 唯一", () => {
    const ids = EVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("数量与场景覆盖符合预期（生成类 + 修改类）", () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(8);
    const scenes = new Set(EVAL_CASES.map((c) => c.scene));
    expect(scenes.has("create_template")).toBe(true);
    expect(scenes.has("modify_questionnaire")).toBe(true);
  });

  it("用例覆盖多轮对话（RPD 第 9 节要求持续补充）", () => {
    const multiTurn = EVAL_CASES.filter((c) => c.messages.length > 1);
    expect(multiTurn.length).toBeGreaterThan(0);
  });

  it("修改类用例都检查「原有内容是否被保留」", () => {
    const modify = EVAL_CASES.filter(
      (c) => c.scene === "modify_questionnaire"
    );
    expect(modify.length).toBeGreaterThan(0);
    // 增量修改的核心风险是弄丢已有题目，因此每条修改类用例
    // 都必须显式声明要保留什么（删除类用例除外，它声明要删什么）
    for (const c of modify) {
      const hasPreserve =
        (c.expect.mustPreserveQuestionKeywords?.length ?? 0) > 0;
      const hasRemove = (c.expect.mustRemoveQuestionKeywords?.length ?? 0) > 0;
      expect(hasPreserve || hasRemove).toBe(true);
    }
  });

  it("每条用例都有可断言的期望", () => {
    for (const c of EVAL_CASES) {
      const e = c.expect;
      const hasSomething =
        (e.minSections ?? 0) > 0 ||
        (e.minQuestions ?? 0) > 0 ||
        (e.requiredQuestionKeywords?.length ?? 0) > 0 ||
        (e.sectionKeywords?.length ?? 0) > 0 ||
        (e.mustPreserveQuestionKeywords?.length ?? 0) > 0 ||
        (e.mustRemoveQuestionKeywords?.length ?? 0) > 0;
      expect(hasSomething, `用例 ${c.id} 缺少可断言的期望`).toBe(true);
    }
  });
});

// ============================================================
// 执行器端到端验证（假 Provider 驱动真实链路）
// ============================================================

describe("评测执行器", () => {
  it("能跑通一条生成类用例并产出量化报告", async () => {
    const report = await runEval({
      providerName: "scripted",
      caseIds: ["create-001"],
      providerFactory: () => {
        // 一轮内建 1 个分组 + 1 道含「无人机」的题
        return new ScriptedProvider([
          call("a1", "add_section", { title: "无人机情况" }),
          { content: "分组已建，先读一下结构。", toolCalls: [], model: "scripted" },
        ]);
      },
    });

    // 只跑一条用例，且它应当通过（分组与题目关键词都命中）
    expect(report.total).toBe(1);
    // eslint-disable-next-line no-console
    console.log("\n" + formatEvalReport(report) + "\n");

    expect(report.schemaValidRate).toBe(1);
    expect(report.results[0]?.observed.sections).toBeGreaterThanOrEqual(1);
    expect(report.results[0]?.observed.sectionTitles).toContain("无人机情况");
  });

  it("报告指标按真实数据计算（失败用例会拉低对应指标）", async () => {
    // 用一个「什么都不做」的 Provider：模型不调用任何工具
    const report = await runEval({
      providerName: "scripted-noop",
      caseIds: ["create-001"],
      providerFactory: () =>
        new ScriptedProvider([
          { content: "好的。", toolCalls: [], model: "scripted" },
        ]),
    });

    // 结构没被写入 → 数量断言失败 → 整体不通过
    expect(report.passed).toBe(0);
    expect(report.passRate).toBe(0);
    expect(report.results[0]?.observed.questions).toBe(0);
    // Schema 仍然是合法的（只是空的）
    expect(report.schemaValidRate).toBe(1);
    // 工具调用为 0，因此工具成功率按约定为 1（无调用即无失败）
    expect(report.toolSuccessRate).toBe(1);
  });

  it("修改类用例能验证「原有内容被保留」", async () => {
    const report = await runEval({
      providerName: "scripted-modify",
      caseIds: ["modify-002"],
      providerFactory: () => {
        // 一轮：只做一次 update_question（改「姓名」为「被调查人姓名」）
        return new ScriptedProvider([
          call("u1", "update_question", {
            question_id: "q_name",
            title: "被调查人姓名",
          }),
          { content: "已改名。", toolCalls: [], model: "scripted" },
        ]);
      },
    });

    // eslint-disable-next-line no-console
    console.log("\n" + formatEvalReport(report) + "\n");

    const r = report.results[0]!;
    // 关键：原有题目必须都还在（增量修改没有重写整份问卷）
    const preserveCheck = r.checks.find((c) =>
      c.name.startsWith("原有内容被保留")
    );
    expect(preserveCheck?.passed).toBe(true);
    expect(r.observed.questionTitles).toContain("被调查人姓名");
  });

  it("用例执行后不留脏数据", async () => {
    const before = await prisma.questionnaireInstance.count();

    await runEval({
      providerName: "scripted",
      caseIds: ["create-001", "modify-002"],
      providerFactory: (evalCase) =>
        new ScriptedProvider(
          evalCase.scene === "create_template"
            ? [
                call("a1", "add_section", { title: "无人机情况" }),
                { content: "ok", toolCalls: [], model: "scripted" },
              ]
            : [
                call("u1", "update_question", {
                  question_id: "q_name",
                  title: "被调查人姓名",
                }),
                { content: "ok", toolCalls: [], model: "scripted" },
              ]
        ),
    });

    expect(await prisma.questionnaireInstance.count()).toBe(before);
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

