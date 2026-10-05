/**
 * AI 评测执行器（决策 D5）。
 *
 * 把用例集跑一遍并产出量化指标。
 *
 * 设计要点：
 *   1. **与真实模型解耦**：执行器只依赖 LLMProvider 接口，
 *      因此既能接真实 DeepSeek（需要 Key），也能接假 Provider（CI 用）；
 *   2. 每个用例都在真实数据库上跑（建实例/建模板草稿），
 *      断言读的是**落库后的结构**，而不是模型嘴上说的内容；
 *   3. 指标分成四类，对应决策 D5 要求的四个可量化维度。
 */
import { prisma } from "../../../src/database/client.js";
import { newId } from "../../../src/shared/utils/id.js";
import { runTurn } from "../../../src/modules/ai/orchestrator/ai.orchestrator.js";
import { summarizeQuestionnaire } from "../../../src/modules/ai/prompts/prompt-builder.js";
import type { LLMProvider } from "../../../src/modules/ai/providers/index.js";
import { templateService } from "../../../src/modules/questionnaire/service/template.service.js";
import { questionnaireService } from "../../../src/modules/questionnaire/service/questionnaire.service.js";
import { USERS } from "../questionnaire/helpers.js";
import { EVAL_CASES } from "../../fixtures/ai-cases/eval-cases.js";
import type {
  EvalCase,
  EvalCaseResult,
  EvalReport,
} from "../../fixtures/ai-cases/types.js";

/** 由用例构造 Provider（假 Provider 按用例 id 分发脚本；真实评测返回同一个 Provider） */
export type ProviderFactory = (
  evalCase: EvalCase,
  round: number
) => LLMProvider;

interface FlatQuestion {
  id: string;
  title: string;
  type: string;
  sectionTitle: string;
}

function flatten(schema: {
  sections: {
    title: string;
    questions: { id: string; title: string; type: string }[];
    children?: unknown;
  }[];
}): FlatQuestion[] {
  const out: FlatQuestion[] = [];
  for (const section of schema.sections) {
    for (const q of section.questions) {
      out.push({
        id: q.id,
        title: q.title,
        type: q.type,
        sectionTitle: section.title,
      });
    }
  }
  return out;
}

function contains(haystack: string[], needle: string): boolean {
  return haystack.some((h) => h.includes(needle));
}

/** 跑单条用例 */
async function runCase(
  evalCase: EvalCase,
  providerFactory: ProviderFactory
): Promise<EvalCaseResult> {
  const startedAt = Date.now();
  const checks: EvalCaseResult["checks"] = [];

  let templateId: string | undefined;
  let instanceId: string | undefined;
  let conversationId: string | undefined;

  let toolCalls = 0;
  let failedToolCalls = 0;
  let modelCalls = 0;
  let schemaValid = true;

  try {
    // ---- 准备落库目标 ----
    let targetType: "template" | "questionnaire_instance";
    let targetId: string;
    let scene: string;

    if (evalCase.scene === "create_template") {
      const template = await templateService.createTemplate(
        { name: evalCase.templateName ?? `评测用例 ${evalCase.id}` },
        { userId: USERS.admin, roles: ["template_admin"], source: "rest" }
      );
      templateId = template.id;

      const version = await templateService.createVersion(
        template.id,
        {},
        { userId: USERS.admin, roles: ["template_admin"], source: "rest" }
      );
      targetType = "template";
      targetId = version.id;
      scene = "create_template";
    } else {
      // 修改类：基于 seed 的无人机模板建一个实例
      const seedVersion = await prisma.questionnaireTemplateVersion.findFirst({
        where: { status: "published", template: { name: { contains: "无人机" } } },
        orderBy: { versionNo: "desc" },
      });
      if (!seedVersion) {
        throw new Error("找不到 seed 的无人机模板版本，请先执行 pnpm db:seed");
      }

      const instance = await questionnaireService.createInstance(
        {
          templateVersionId: seedVersion.id,
          title: `评测用例 ${evalCase.id}`,
        },
        {
          userId: USERS.dispatcher,
          roles: ["dispatcher"],
          source: "rest",
        }
      );
      instanceId = instance.id;

      targetType = "questionnaire_instance";
      targetId = instance.id;
      scene = "modify_questionnaire";
    }

    // ---- 多轮对话 ----
    //
    // 关键：必须先建一条真实的 ai_conversations 记录。
    //   ai_tool_executions.conversation_id 有外键约束，
    //   若传一个数据库里不存在的 UUID，审计写入会撞外键，
    //   进而把整个事务（含本次业务写入）一起回滚 ——
    //   表现为「工具返回 SYSTEM_ERROR 且结构没变」。
    const conversation = await prisma.aiConversation.create({
      data: {
        id: newId(),
        userId:
          targetType === "template" ? USERS.admin : USERS.dispatcher,
        scene,
        targetType,
        targetId,
        status: "active",
      },
    });
    conversationId = conversation.id;

    for (let round = 0; round < evalCase.messages.length; round++) {
      const message = evalCase.messages[round]!;
      const provider = providerFactory(evalCase, round);

      // 每轮都读一次当前结构，作为 Prompt 上下文
      let questionnaireContext: string | undefined;
      if (targetType === "template") {
        const v = await prisma.questionnaireTemplateVersion.findUnique({
          where: { id: targetId },
          select: { schema: true },
        });
        if (v) {
          questionnaireContext = summarizeQuestionnaire(
            v.schema as Parameters<typeof summarizeQuestionnaire>[0]
          );
        }
      } else {
        const i = await prisma.questionnaireInstance.findUnique({
          where: { id: targetId },
          select: { currentSchema: true },
        });
        if (i) {
          questionnaireContext = summarizeQuestionnaire(
            i.currentSchema as Parameters<typeof summarizeQuestionnaire>[0]
          );
        }
      }

      const result = await runTurn({
        provider,
        conversationId: conversation.id,
        targetType,
        targetId,
        scene,
        userId:
          targetType === "template" ? USERS.admin : USERS.dispatcher,
        roles:
          targetType === "template" ? ["template_admin"] : ["dispatcher"],
        userMessage: message,
        ...(questionnaireContext ? { questionnaireContext } : {}),
      });

      modelCalls += 1;
      toolCalls += result.traces.length;
      failedToolCalls += result.traces.filter((t) => !t.result.success).length;
    }

    // ---- 读取最终落库结构 ----
    let finalSchema: Parameters<typeof flatten>[0];
    let statusOk = true;

    if (targetType === "template") {
      const v = await prisma.questionnaireTemplateVersion.findUnique({
        where: { id: targetId },
        select: { schema: true, status: true },
      });
      finalSchema = v?.schema as Parameters<typeof flatten>[0];
      statusOk = v?.status === "draft";
    } else {
      const i = await prisma.questionnaireInstance.findUnique({
        where: { id: targetId },
        select: { currentSchema: true, status: true },
      });
      finalSchema = i?.currentSchema as Parameters<typeof flatten>[0];
      statusOk = i?.status === "draft";
    }

    // Schema 合法性：能从数据库读出来且结构完整
    const flat = flatten(finalSchema);
    schemaValid = statusOk && Array.isArray(finalSchema.sections);
    checks.push({
      name: "Schema 合法且状态未异常改变",
      passed: schemaValid,
      ...(schemaValid ? {} : { detail: "结构不完整或状态被意外改变" }),
    });

    const sectionTitles = finalSchema.sections.map((s) => s.title);
    const questionTitles = flat.map((q) => q.title);
    const allTitles = [...sectionTitles, ...questionTitles];

    // ---- 断言：数量 ----
    if (evalCase.expect.minSections !== undefined) {
      const passed = finalSchema.sections.length >= evalCase.expect.minSections;
      checks.push({
        name: `分组数 >= ${evalCase.expect.minSections}`,
        passed,
        detail: `实际 ${finalSchema.sections.length}`,
      });
    }
    if (evalCase.expect.minQuestions !== undefined) {
      const passed = flat.length >= evalCase.expect.minQuestions;
      checks.push({
        name: `题目数 >= ${evalCase.expect.minQuestions}`,
        passed,
        detail: `实际 ${flat.length}`,
      });
    }

    // ---- 断言：分组关键词（任一命中） ----
    if (evalCase.expect.sectionKeywords?.length) {
      const hit = evalCase.expect.sectionKeywords.some((k) =>
        contains(sectionTitles, k)
      );
      checks.push({
        name: `分组包含关键词（任一）：${evalCase.expect.sectionKeywords.join("/")}`,
        passed: hit,
        detail: `实际分组：${sectionTitles.join("、") || "（无）"}`,
      });
    }

    // ---- 断言：必须出现的题目关键词（全部命中） ----
    if (evalCase.expect.requiredQuestionKeywords?.length) {
      const missing = evalCase.expect.requiredQuestionKeywords.filter(
        (k) => !contains(questionTitles, k)
      );
      checks.push({
        name: `题目包含关键词：${evalCase.expect.requiredQuestionKeywords.join("/")}`,
        passed: missing.length === 0,
        ...(missing.length ? { detail: `缺少：${missing.join("/")}` } : {}),
      });
    }

    // ---- 断言：必须保留（增量修改不能弄丢原有内容） ----
    if (evalCase.expect.mustPreserveQuestionKeywords?.length) {
      const lost = evalCase.expect.mustPreserveQuestionKeywords.filter(
        (k) => !contains(allTitles, k)
      );
      checks.push({
        name: `原有内容被保留：${evalCase.expect.mustPreserveQuestionKeywords.join("/")}`,
        passed: lost.length === 0,
        ...(lost.length ? { detail: `丢失：${lost.join("/")}` } : {}),
      });
    }

    // ---- 断言：必须删除 ----
    if (evalCase.expect.mustRemoveQuestionKeywords?.length) {
      const still = evalCase.expect.mustRemoveQuestionKeywords.filter((k) =>
        contains(allTitles, k)
      );
      checks.push({
        name: `已删除：${evalCase.expect.mustRemoveQuestionKeywords.join("/")}`,
        passed: still.length === 0,
        ...(still.length ? { detail: `仍存在：${still.join("/")}` } : {}),
      });
    }

    return {
      caseId: evalCase.id,
      description: evalCase.description,
      passed: checks.every((c) => c.passed),
      checks,
      observed: {
        sections: finalSchema.sections.length,
        questions: flat.length,
        sectionTitles,
        questionTitles,
      },
      modelCalls,
      toolCalls,
      failedToolCalls,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      caseId: evalCase.id,
      description: evalCase.description,
      passed: false,
      checks,
      observed: {
        sections: 0,
        questions: 0,
        sectionTitles: [],
        questionTitles: [],
      },
      modelCalls,
      toolCalls,
      failedToolCalls,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    // ---- 清理本用例产生的数据 ----
    if (conversationId) {
      try {
        await prisma.aiToolExecution.deleteMany({
          where: { conversationId },
        });
        await prisma.aiMessage.deleteMany({ where: { conversationId } });
        await prisma.aiConversation.deleteMany({ where: { id: conversationId } });
      } catch {
        // 清理失败不应掩盖用例结果
      }
    }
    if (instanceId) {
      try {
        await prisma.reviewRecord.deleteMany({
          where: { response: { questionnaireInstanceId: instanceId } },
        });
        await prisma.questionnaireAnswer.deleteMany({
          where: { response: { questionnaireInstanceId: instanceId } },
        });
        await prisma.questionnaireResponse.deleteMany({
          where: { questionnaireInstanceId: instanceId },
        });
        await prisma.dispatchTask.deleteMany({
          where: { questionnaireInstanceId: instanceId },
        });
        await prisma.aiToolExecution.deleteMany({
          where: { questionnaireInstanceId: instanceId },
        });
        await prisma.questionnaireRevision.deleteMany({
          where: { questionnaireInstanceId: instanceId },
        });
        await prisma.questionnaireTemplateVersion.updateMany({
          where: { sourceInstanceId: instanceId },
          data: { sourceInstanceId: null },
        });
        await prisma.questionnaireInstance.deleteMany({
          where: { id: instanceId },
        });
      } catch {
        // 清理失败不应掩盖用例结果
      }
    }
    if (templateId) {
      try {
        await prisma.questionnaireTemplate.updateMany({
          where: { id: templateId },
          data: { currentVersionId: null },
        });
        await prisma.questionnaireTemplateVersion.deleteMany({
          where: { templateId },
        });
        await prisma.questionnaireTemplate.deleteMany({
          where: { id: templateId },
        });
        await prisma.aiToolExecution.deleteMany({
          where: { questionnaireInstanceId: null, source: "ai_tool" },
        });
      } catch {
        // 同上
      }
    }

  }
}

/** 跑完整评测，返回量化报告 */
export async function runEval(options: {
  providerFactory: ProviderFactory;
  providerName: string;
  model?: string;
  /** 只跑指定用例（不传则全跑） */
  caseIds?: string[];
}): Promise<EvalReport> {
  const startedAt = Date.now();

  const cases = options.caseIds
    ? EVAL_CASES.filter((c) => options.caseIds!.includes(c.id))
    : EVAL_CASES;

  const results: EvalCaseResult[] = [];
  for (const c of cases) {
    results.push(await runCase(c, options.providerFactory));
  }

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;

  // Schema 合法性
  const schemaChecks = results.flatMap((r) =>
    r.checks.filter((c) => c.name.startsWith("Schema 合法"))
  );
  const schemaValidRate =
    schemaChecks.length === 0
      ? 1
      : schemaChecks.filter((c) => c.passed).length / schemaChecks.length;

  // 关键点覆盖率（题目关键词 + 分组关键词）
  const keywordChecks = results.flatMap((r) =>
    r.checks.filter(
      (c) => c.name.startsWith("题目包含关键词") || c.name.startsWith("分组包含关键词")
    )
  );
  const keywordCoverageRate =
    keywordChecks.length === 0
      ? 1
      : keywordChecks.filter((c) => c.passed).length / keywordChecks.length;

  // 工具调用正确率 = 1 - 失败的工具调用 / 全部工具调用
  const totalToolCalls = results.reduce((n, r) => n + r.toolCalls, 0);
  const totalFailedToolCalls = results.reduce(
    (n, r) => n + r.failedToolCalls,
    0
  );
  const toolSuccessRate =
    totalToolCalls === 0
      ? 1
      : (totalToolCalls - totalFailedToolCalls) / totalToolCalls;

  // 修改类的“原有内容保留率”
  const preserveChecks = results.flatMap((r) =>
    r.checks.filter((c) => c.name.startsWith("原有内容被保留"))
  );
  const preservationRate =
    preserveChecks.length === 0
      ? 1
      : preserveChecks.filter((c) => c.passed).length / preserveChecks.length;

  return {
    provider: options.providerName,
    ...(options.model !== undefined ? { model: options.model } : {}),
    total,
    passed,
    schemaValidRate,
    keywordCoverageRate,
    toolSuccessRate,
    preservationRate,
    passRate: total === 0 ? 0 : passed / total,
    results,
    durationMs: Date.now() - startedAt,
  };
}

/** 把报告格式化成可读文本（便于人工评审与留档） */
export function formatEvalReport(report: EvalReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [];

  lines.push("=== AI 评测报告（决策 D5）===");
  lines.push(`Provider: ${report.provider}${report.model ? ` / ${report.model}` : ""}`);
  lines.push(`用例数: ${report.total}   通过: ${report.passed}   通过率: ${pct(report.passRate)}`);
  lines.push("");
  lines.push("量化指标：");
  lines.push(`  Schema 合法性      ${pct(report.schemaValidRate)}`);
  lines.push(`  关键点覆盖率        ${pct(report.keywordCoverageRate)}`);
  lines.push(`  多轮增量保留率      ${pct(report.preservationRate)}`);
  lines.push(`  整体通过率          ${pct(report.passRate)}`);
  lines.push("");
  lines.push("逐条结果：");

  for (const r of report.results) {
    lines.push(`  [${r.passed ? "通过" : "失败"}] ${r.caseId}  ${r.description}`);
    lines.push(
      `         分组 ${r.observed.sections} / 题目 ${r.observed.questions}，` +
        `模型调用 ${r.modelCalls} 次，工具调用 ${r.toolCalls} 次，耗时 ${r.durationMs}ms`
    );
    if (r.error) lines.push(`         错误：${r.error}`);
    for (const c of r.checks.filter((x) => !x.passed)) {
      lines.push(`         ✗ ${c.name}${c.detail ? `（${c.detail}）` : ""}`);
    }
  }

  return lines.join("\n");
}
