/**
 * AI 会话 Service。
 *
 * 依据 docs/05-api_design.md 第 10 至 12 节与 docs/04-database_design.md 第 19 至 22 节。
 *
 * 这是把 Orchestrator 接到 HTTP 与数据库之间的一层：
 *   创建会话 → 落库会话绑定（scene / target）
 *   发送消息 → 落库 user 消息 → 构建历史 → 驱动 Orchestrator
 *             → 落库 assistant 与 tool 消息 → 返回结果
 *
 * 关键设计：
 *   1. 会话一旦创建，其 scene 与 target 就固定下来；
 *      后续消息不允许改目标 —— 否则模型可能在错误的问卷上操作。
 *   2. 历史消息从数据库读，不依赖前端回传
 *      （05 文档第 12.2 节：前端不需要把整份问卷重复塞进每次请求）。
 *   3. 目标状态在发消息前就校验（决策 D1）。
 *      已下发的实例直接拒绝，**不调用 LLM，不消耗 Token**。
 */
import { newId } from "../../../shared/utils/id.js";
import {
  ErrorCode,
  OperationError,
  validationError,
} from "../../../shared/errors/index.js";
import { runTurn, type ToolTrace } from "../orchestrator/ai.orchestrator.js";
import { summarizeQuestionnaire } from "../prompts/prompt-builder.js";
import {
  aiConversationRepository,
} from "../repository/ai-conversation.repository.js";
import type { AiConversationRow, AiMessageRow } from "../repository/ai.types.js";
import {
  createLLMProvider,
  type ChatMessage,
  type LLMProvider,
} from "../providers/index.js";
import { questionnaireService } from "../../questionnaire/service/questionnaire.service.js";
import { questionnaireRepository } from "../../questionnaire/repository/questionnaire.repository.js";

export const SUPPORTED_SCENES = [
  "create_template",
  "modify_questionnaire",
] as const;

export type SupportedScene = (typeof SUPPORTED_SCENES)[number];

export interface AiServiceContext {
  userId: string;
  roles: string[];
}

export interface CreateConversationResult {
  conversationId: string;
  scene: string;
  targetType: string;
  targetId: string;
}

export interface SendMessageInput {
  conversationId: string;
  content: string;
  ctx: AiServiceContext;
  /** 便于测试注入假 Provider；不传则用配置创建真实 Provider */
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface SendMessageResult {
  conversationId: string;
  /** 给用户看的回复文本 */
  content: string;
  /** 本轮的工具调用轨迹，供前端展示进度与排查 */
  traces: ToolTrace[];
  /** 是否因触达轮数上限而中断 */
  truncated: boolean;
  /** 若本轮改动了问卷结构，返回新的 revision，前端据此刷新 */
  revision?: number;
  model: string;
}

/** 历史消息最多带回多少条（避免上下文无限增长） */
const HISTORY_LIMIT = 40;

/**
 * 把数据库里的消息还原成模型可读的对话历史。
 *
 * 只回放 user / assistant / tool 三种角色：
 *   - user：用户原话
 *   - assistant：模型回复（若有工具请求，还原成 toolCalls）
 *   - tool：工具执行结果（带 toolCallId，保证模型能把结果对上请求）
 */
export function toChatHistory(rows: AiMessageRow[]): ChatMessage[] {
  const history: ChatMessage[] = [];

  for (const row of rows) {
    switch (row.role) {
      case "user":
        history.push({ role: "user", content: row.content ?? "" });
        break;

      case "assistant": {
        const toolCalls = row.toolArguments as
          | { id: string; name: string; arguments: string }[]
          | null
          | undefined;

        history.push({
          role: "assistant",
          content: row.content ?? null,
          ...(Array.isArray(toolCalls) && toolCalls.length > 0
            ? { toolCalls }
            : {}),
        });
        break;
      }

      case "tool":
        history.push({
          role: "tool",
          content: row.content ?? "",
          ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
          ...(row.toolName ? { name: row.toolName } : {}),
        });
        break;

      case "system":
        // 系统提示在每轮由 Prompt 构建器重新生成，不重复回放
        break;

      default:
        break;
    }
  }

  return history;
}

export const aiConversationService = {
  // ----------------------------------------------------------
  // 创建会话
  // ----------------------------------------------------------

  /**
   * 创建 AI 会话。
   *
   * create_template：
   *   需要提供一个 draft 模板版本作为写入目标（由模板 API 或
   *   AI 生成流程预先创建），会话绑定它。
   *
   * modify_questionnaire：
   *   targetId 指向问卷实例；此处即校验其存在性与所有权。
   */
  async createConversation(
    input: {
      scene: string;
      targetType?: string;
      targetId?: string;
    },
    ctx: AiServiceContext
  ): Promise<CreateConversationResult> {
    if (!SUPPORTED_SCENES.includes(input.scene as SupportedScene)) {
      throw validationError(
        `不支持的场景：${input.scene}。可用：${SUPPORTED_SCENES.join(", ")}`,
        { path: "scene", scene: input.scene }
      );
    }

    if (input.scene === "create_template") {
      if (!input.targetId) {
        throw validationError(
          "create_template 场景必须提供 targetId（草稿模板版本 id）",
          { path: "targetId" }
        );
      }

      const version = await questionnaireRepository.findTemplateVersionById(
        input.targetId
      );
      if (!version) {
        throw new OperationError(
          ErrorCode.TEMPLATE_VERSION_NOT_FOUND,
          `模板版本不存在：${input.targetId}`
        );
      }
      if (version.status !== "draft") {
        throw new OperationError(
          ErrorCode.PERMISSION_DENIED,
          `模板版本状态为 ${version.status}，只有 draft 版本允许 AI 对话修改`
        );
      }

      const conversation = await aiConversationRepository.create({
        userId: ctx.userId,
        scene: "create_template",
        targetType: "template",
        targetId: version.id,
      });

      return {
        conversationId: conversation.id,
        scene: conversation.scene,
        targetType: conversation.targetType ?? "template",
        targetId: conversation.targetId ?? version.id,
      };
    }

    // modify_questionnaire
    if (!input.targetId) {
      throw validationError(
        "modify_questionnaire 场景必须提供 targetId（问卷实例 id）",
        { path: "targetId" }
      );
    }

    // 复用实例读取，顺带完成权限校验
    const instance = await questionnaireService.getInstance(input.targetId, {
      userId: ctx.userId,
      roles: ctx.roles,
    });

    // 决策 D1：已下发的实例不允许进入 AI 修改流程
    if (instance.status !== "draft" && instance.status !== "confirmed") {
      throw new OperationError(
        ErrorCode.QUESTIONNAIRE_LOCKED,
        "问卷已下发，请先撤回后再修改",
        { path: "status", status: instance.status }
      );
    }

    const conversation = await aiConversationRepository.create({
      userId: ctx.userId,
      scene: "modify_questionnaire",
      targetType: "questionnaire_instance",
      targetId: instance.id,
    });

    return {
      conversationId: conversation.id,
      scene: conversation.scene,
      targetType: conversation.targetType ?? "questionnaire_instance",
      targetId: conversation.targetId ?? instance.id,
    };
  },

  // ----------------------------------------------------------
  // 读取
  // ----------------------------------------------------------

  async getConversation(
    conversationId: string,
    ctx: AiServiceContext
  ): Promise<AiConversationRow> {
    const conversation = await aiConversationRepository.requireById(
      conversationId
    );

    // 会话只能由创建者访问（V1 不开放跨用户查看）
    if (conversation.userId !== ctx.userId) {
      throw new OperationError(
        ErrorCode.PERMISSION_DENIED,
        "无权访问他人的 AI 会话"
      );
    }

    return conversation;
  },

  async listMessages(
    conversationId: string,
    ctx: AiServiceContext,
    options: { skip: number; take: number }
  ): Promise<{ items: AiMessageRow[]; total: number }> {
    await this.getConversation(conversationId, ctx);
    return aiConversationRepository.listMessages(conversationId, options);
  },

  async listConversations(
    ctx: AiServiceContext,
    options: { skip: number; take: number }
  ): Promise<{ items: AiConversationRow[]; total: number }> {
    return aiConversationRepository.listByUser(ctx.userId, options);
  },

  // ----------------------------------------------------------
  // 发送消息（核心链路）
  // ----------------------------------------------------------

  /**
   * 处理一条用户消息。
   *
   * 完整链路：
   *   校验会话与权限
   *   → 重新校验目标状态（决策 D1，在调用 LLM 之前）
   *   → 落库 user 消息
   *   → 读取历史 + 当前问卷摘要，构建上下文
   *   → 驱动 Orchestrator（内部执行 Tool → Service → 数据库）
   *   → 落库 assistant 消息与每条 tool 消息
   *   → 返回结果
   */
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const content = input.content?.trim();
    if (!content) {
      throw validationError("消息内容不能为空", { path: "content" });
    }

    const conversation = await this.getConversation(
      input.conversationId,
      input.ctx
    );

    if (!conversation.targetId || !conversation.targetType) {
      throw new OperationError(
        ErrorCode.INVALID_OPERATION,
        "该会话没有绑定操作目标，无法执行修改"
      );
    }

    // ---- 目标状态与内容再校验 ----
    let questionnaireContext: string | undefined;
    let revisionBefore: number | undefined;

    if (conversation.targetType === "questionnaire_instance") {
      // 决策 D1：已下发直接拒绝，不调用 LLM（省 Token，也不给模型犯错机会）
      const instance = await questionnaireService.getInstance(
        conversation.targetId,
        { userId: input.ctx.userId, roles: input.ctx.roles }
      );

      if (instance.status !== "draft" && instance.status !== "confirmed") {
        throw new OperationError(
          ErrorCode.QUESTIONNAIRE_LOCKED,
          "问卷已下发，请先撤回后再修改",
          { path: "status", status: instance.status }
        );
      }

      questionnaireContext = summarizeQuestionnaire(instance.currentSchema);
      revisionBefore = instance.currentRevision;
    } else {
      const version = await questionnaireRepository.findTemplateVersionById(
        conversation.targetId
      );
      if (!version) {
        throw new OperationError(
          ErrorCode.TEMPLATE_VERSION_NOT_FOUND,
          `模板版本不存在：${conversation.targetId}`
        );
      }
      questionnaireContext = summarizeQuestionnaire(version.schema);
    }

    // ---- 落库用户消息 ----
    await aiConversationRepository.appendMessage({
      conversationId: conversation.id,
      role: "user",
      content,
    });

    // ---- 构建历史（含刚写入的这条 user 消息） ----
    const allMessages = await aiConversationRepository.listMessages(
      conversation.id
    );
    const historyRows = allMessages.items.slice(-HISTORY_LIMIT);
    // 最后一条就是本轮 user 消息，Orchestrator 会单独接收它
    const historyForModel = toChatHistory(historyRows.slice(0, -1));

    // ---- 驱动 Orchestrator ----
    const provider = input.provider ?? createLLMProvider();

    const turnResult = await runTurn({
      provider,
      conversationId: conversation.id,
      targetType:
        conversation.targetType === "template"
          ? "template"
          : "questionnaire_instance",
      targetId: conversation.targetId,
      scene: conversation.scene,
      userId: input.ctx.userId,
      roles: input.ctx.roles,
      userMessage: content,
      history: historyForModel,
      ...(questionnaireContext !== undefined ? { questionnaireContext } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.temperature !== undefined
        ? { temperature: input.temperature }
        : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    });

    // ---- 落库 assistant 消息与 tool 消息 ----
    // 注意：Orchestrator 内部可能有多轮工具循环，
    // 这里按 traces 把每次调用的请求与结果成对落库，
    // 保证 ai_messages 能完整还原交互链路（04 文档第 22 节）。
    if (turnResult.traces.length > 0) {
      for (const trace of turnResult.traces) {
        await aiConversationRepository.appendMessage({
          conversationId: conversation.id,
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: trace.operationId,
              name: trace.toolName,
              arguments: JSON.stringify(trace.arguments),
            },
          ],
        });

        await aiConversationRepository.appendMessage({
          conversationId: conversation.id,
          role: "tool",
          content: JSON.stringify(trace.result),
          toolName: trace.toolName,
          toolCallId: trace.operationId,
          toolResult: trace.result,
        });
      }
    }

    await aiConversationRepository.appendMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: turnResult.content,
    });

    // ---- 若结构真的变了，取出新的 revision 供前端刷新 ----
    let revisionAfter: number | undefined;
    if (conversation.targetType === "questionnaire_instance") {
      const after = await questionnaireRepository.findInstanceById(
        conversation.targetId
      );
      revisionAfter = after?.currentRevision;
    }

    const changed =
      revisionBefore !== undefined &&
      revisionAfter !== undefined &&
      revisionAfter !== revisionBefore;

    return {
      conversationId: conversation.id,
      content: turnResult.content,
      traces: turnResult.traces,
      truncated: turnResult.truncated,
      ...(changed && revisionAfter !== undefined
        ? { revision: revisionAfter }
        : {}),
      model: turnResult.model,
    };
  },

  /** 关闭会话（保留历史，仅标记状态） */
  async closeConversation(
    conversationId: string,
    ctx: AiServiceContext
  ): Promise<{ id: string; status: string }> {
    await this.getConversation(conversationId, ctx);
    await aiConversationRepository.updateStatus(conversationId, "closed");
    return { id: conversationId, status: "closed" };
  },

  /** 供测试与内部使用：直接产出一个 operationId */
  newOperationId(): string {
    return newId();
  },
};

export type AiConversationService = typeof aiConversationService;
