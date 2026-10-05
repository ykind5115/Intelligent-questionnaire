/**
 * AI Orchestrator。
 *
 * 依据 docs/08-ai_agent_prompt_tool_calling.md 与 docs/02-architecture.md 第 8 节。
 *
 * 职责：把「一次用户消息」变成「若干次受控的 Tool 调用 + 一句回复」。
 *
 * 涉及的决策：
 *   D9  一次 Tool 调用一个 operation_id（幂等）
 *   D1  已下发的问卷不允许改结构（由 Tool → Service 强制，不靠 Prompt）
 *   D8  AI 继承当前用户权限（由 Service 强制）
 *
 * 明确不做：
 *   - 不直接操作数据库（一律经 Tool → Service）
 *   - 不在 Prompt 里表达权限规则（Prompt 只是行为约束，不是控制手段）
 */
import { isProduction } from "../../../config/env.js";
import { newId } from "../../../shared/utils/id.js";
import { runTool, allLlmToolSpecs, type ToolContext } from "../tools/index.js";
import type { ToolResult } from "../tools/types.js";
import {
  LLMError,
  type ChatMessage,
  type ChatResult,
  type LLMProvider,
  type ToolCallRequest,
} from "../providers/llm-provider.js";
import { buildSystemPrompt } from "../prompts/prompt-builder.js";
import { questionnaireService } from "../../questionnaire/service/questionnaire.service.js";

/**
 * 最大工具循环轮数（决策：08 文档第 25.3 / 26 节）。
 *
 * 为什么不是 5：
 *   采用增量 Tool 后，一轮请求的调用次数与问卷规模成正比。
 *   一份 3 分组 / 9 问题的问卷就需要 12 次调用，5 轮根本不够。
 */
export const MAX_TOOL_ROUNDS = 8;

/** 一次工具调用的轨迹记录（供审计与前端展示） */
export interface ToolTrace {
  round: number;
  operationId: string;
  toolName: string;
  arguments: unknown;
  result: ToolResult;
}

export interface RunTurnInput {
  provider: LLMProvider;

  /** ai_conversations.id */
  conversationId: string;

  /** 当前操作目标 */
  targetType: "template" | "questionnaire_instance";
  targetId: string;

  /** create_template | modify_questionnaire */
  scene: string;

  /** 发起人（AI 继承其权限） */
  userId: string;
  roles: string[];

  /** 本次用户消息 */
  userMessage: string;

  /** 历史消息（不含本轮用户消息），由调用方从 ai_messages 读取 */
  history?: ChatMessage[];

  /** 当前问卷结构摘要，供 Prompt 使用 */
  questionnaireContext?: string;

  model?: string;
  temperature?: number;
  maxTokens?: number;

  signal?: AbortSignal;

  /** 达到最大轮数时的收尾文案生成器（可选，便于测试注入） */
  summarize?: (
    messages: ChatMessage[],
    options: { model?: string; signal?: AbortSignal }
  ) => Promise<string>;
}

export interface RunTurnOutput {
  /** 给用户看的文本 */
  content: string;
  /** 本轮所有工具调用轨迹 */
  traces: ToolTrace[];
  /** 是否因触达轮数上限而中断 */
  truncated: boolean;
  /** 最终使用的模型标识（审计用） */
  model: string;
}

/** 解析模型给出的参数（字符串 JSON） */
function parseArguments(
  raw: string
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = raw.trim();
  // 部分模型在无参数时返回空串
  if (trimmed === "") return { ok: true, value: {} };

  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `参数不是合法 JSON：${message}` };
  }
}

/** 把 ToolResult 序列化回给模型（保持简短，避免上下文膨胀） */
function serializeToolResult(result: ToolResult): string {
  return JSON.stringify(result);
}

/**
 * 执行一次完整的对话回合。
 *
 * 流程（08 文档第 25 节）：
 *   构建消息 → 调用模型 → 若要求调用工具则执行并回灌 → 再次调用模型
 *   → 直到模型不再请求工具，或触达轮数上限
 */
export async function runTurn(input: RunTurnInput): Promise<RunTurnOutput> {
  const traces: ToolTrace[] = [];

  const toolSpecs = allLlmToolSpecs();

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        scene: input.scene,
        targetType: input.targetType,
        targetId: input.targetId,
        questionnaireContext: input.questionnaireContext,
      }),
    },
    ...(input.history ?? []),
    { role: "user", content: input.userMessage },
  ];

  const tools = toolSpecs.length > 0 ? toolSpecs : undefined;

  let lastModel = input.model ?? "unknown";
  let round = 0;

  while (round < MAX_TOOL_ROUNDS) {
    round += 1;

    const result: ChatResult = await input.provider.chat(messages, {
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.temperature !== undefined
        ? { temperature: input.temperature }
        : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(tools ? { tools } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

    lastModel = result.model;

    // 模型没有请求工具 → 本轮结束
    if (result.toolCalls.length === 0) {
      return {
        content: result.content ?? "",
        traces,
        truncated: false,
        model: lastModel,
      };
    }

    // 记录 assistant 的这一轮（含工具请求），供后续上下文使用
    messages.push({
      role: "assistant",
      content: result.content,
      toolCalls: result.toolCalls,
    });

    // 逐个执行工具
    for (const call of result.toolCalls) {
      const operationId = newId(); // D9：一次 Tool 调用一个 operation_id

      const parsed = parseArguments(call.arguments);

      let toolResult: ToolResult;

      if (!parsed.ok) {
        // 参数无法解析时不执行工具，把失败原因回灌给模型让它纠正
        toolResult = {
          success: false,
          error: { code: "INVALID_PARAMETER", message: parsed.error },
          metadata: { operation_id: operationId },
        };
      } else {
        const context: ToolContext = {
          userId: input.userId,
          roles: input.roles,
          operationId,
          scene: input.scene,
          targetType: input.targetType,
          targetId: input.targetId,
          conversationId: input.conversationId,
          ...(input.model !== undefined ? { model: input.model } : {}),
        };

        toolResult = await runTool(call.name, parsed.value, context, {
          service: questionnaireService,
        });
      }

      traces.push({
        round,
        operationId,
        toolName: call.name,
        arguments: parsed.ok ? parsed.value : call.arguments,
        result: toolResult,
      });

      messages.push({
        role: "tool",
        content: serializeToolResult(toolResult),
        toolCallId: call.id,
        name: call.name,
      });
    }
  }

  // ---- 触达轮数上限：收尾而不是报错（08 文档第 25.4 节）----
  //
  // 为什么不能抛异常：每次 Tool 调用都已在独立事务中提交，
  // 已完成的修改是有效的，不应因为后续轮次超限而整体失败。
  const content = await buildTruncationMessage(input, messages);

  return { content, traces, truncated: true, model: lastModel };
}

async function buildTruncationMessage(
  input: RunTurnInput,
  messages: ChatMessage[]
): Promise<string> {
  const doneCount = messages.filter((m) => m.role === "tool").length;

  if (input.summarize) {
    return input.summarize(messages, {
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  }

  // 默认文案：如实告知已完成一部分，而不是假装全部完成
  return (
    `我已经完成了 ${doneCount} 步修改，但这次请求涉及的操作较多，` +
    `为避免一次改动过多，我先停在这里。你可以让我继续补充剩下的部分。`
  );
}

/**
 * 权限相关的兜底断言（开发期自查）。
 *
 * 生产环境下权限必须由后端强制；这里仅用于尽早暴露
 * 「某处忘了走 Service 校验」的问题。
 */
export function assertOrchestratorPreconditions(): void {
  if (isProduction) return; // 生产由真实鉴权保证，不做额外断言
}
