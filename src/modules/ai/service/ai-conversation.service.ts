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
import { runTurn, runTurnStream, type ToolTrace } from "../orchestrator/ai.orchestrator.js";
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
import { templateService } from "../../questionnaire/service/template.service.js";
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

/**
 * 流式发送的准备结果（prepareStreamMessage 的返回值）。
 *
 * 单独定义是为了让「准备」与「跑回合」两段职责有清晰的交接面：
 *   准备阶段可以被正常 HTTP 错误中断；
 *   跑回合阶段只推事件，不再抛业务错误。
 */
export interface PreparedStreamMessage {
  conversationId: string;
  content: string;
  targetId: string;
  targetType: string;
  scene: string;
  history: ChatMessage[];
  questionnaireContext: string;
  revisionBefore: number | undefined;
}

/**
 * 流式回合事件（SSE 推送出去的内容）。
 *
 * 依据 05 文档第 10.4 节与 08 文档第 52 节：
 *   前端要能看到「AI 正在做什么」，但不应看到原始 JSON。
 * 事件类型：text_delta / tool_call_start / tool_call_result /
 *          questionnaire_updated / done / error（error 由 Controller 补）
 */
export type StreamTurnEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "tool_call_start";
      toolName: string;
      operationId: string;
      arguments: unknown;
    }
  | {
      type: "tool_call_result";
      toolName: string;
      operationId: string;
      success: boolean;
      errorCode?: string;
      /** 结构类操作返回的新 revision，前端据此决定是否刷新结构树 */
      revision?: number;
    }
  | {
      type: "questionnaire_updated";
      questionnaireId: string;
      revision: number;
    }
  | {
      type: "done";
      content: string;
      truncated: boolean;
      model: string;
      revision?: number;
    };

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
      // ---- 从零创建：没给目标就自动建一个草稿模板版本 ----
      //
      // 这一步是「对话式创建问卷」的关键便利：
      // 原本要求调用方先建模板、再建版本、再建会话（三个来回），
      // 前端很容易只实现「改实例」那条路，于是功能其实存在却没人用得上。
      // 现在一条请求即可从零开始。
      let targetVersionId = input.targetId;

      if (!targetVersionId) {
        // 建模板需要 template_admin：AI 创建问卷属于模板治理动作。
        // 若当前用户不是模板管理员，这里会抛出清晰的 PERMISSION_DENIED。
        const template = await templateService.createTemplate(
          { name: `AI 新建问卷 ${new Date().toISOString().slice(0, 16).replace("T", " ")}` },
          ctx
        );

        const version = await templateService.createVersion(template.id, {}, ctx);
        targetVersionId = version.id;
      }

      const version = await questionnaireRepository.findTemplateVersionById(
        targetVersionId
      );
      if (!version) {
        throw new OperationError(
          ErrorCode.TEMPLATE_VERSION_NOT_FOUND,
          `模板版本不存在：${targetVersionId}`
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

      // 把模板与版本的 id 一并回传：前端 commit 后需要它们来展示结果，
      // 也便于用户知道「这次对话最终落到哪个模板」。
      const created = !input.targetId;

      return {
        conversationId: conversation.id,
        scene: conversation.scene,
        targetType: conversation.targetType ?? "template",
        targetId: conversation.targetId ?? version.id,
        // 只有本次新建时才额外返回模板 id（避免让调用方以为是既有模板）
        ...(created
          ? {
              templateId: version.templateId,
              templateVersionId: version.id,
              createdTemplate: true,
            }
          : {}),
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

  /**
   * 流式发送前的准备（**必须在写 SSE 响应头之前调用**）。
   *
   * 为什么单独拆出来：
   *   SSE 一旦写下响应头，HTTP 状态码就固定在 200，
   *   此后再校验失败只能靠 error 事件表达，前端拿不到 422/403/404。
   *   而「内容为空」「会话不存在」「无权访问」这些恰恰是**调用前就能判定**的错误，
   *   应该走正常 HTTP 状态码。
   *   因此校验与「落库用户消息」都在这里完成，
   *   之后 runStreamTurn 只负责跑模型与推事件。
   */
  async prepareStreamMessage(input: SendMessageInput): Promise<PreparedStreamMessage> {
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

    let questionnaireContext: string;
    let revisionBefore: number | undefined;

    if (conversation.targetType === "questionnaire_instance") {
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

    // ---- 落库用户消息（校验已全部通过，不会再失败）----
    await aiConversationRepository.appendMessage({
      conversationId: conversation.id,
      role: "user",
      content,
    });

    const allMessages = await aiConversationRepository.listMessages(
      conversation.id
    );
    const historyRows = allMessages.items.slice(-HISTORY_LIMIT);
    const historyForModel = toChatHistory(historyRows.slice(0, -1));

    return {
      conversationId: conversation.id,
      content,
      targetId: conversation.targetId,
      targetType: conversation.targetType,
      scene: conversation.scene,
      history: historyForModel,
      questionnaireContext,
      revisionBefore,
    };
  },

  /**
   * 流式跑一个已准备好的回合（prepareStreamMessage 之后调用）。
   *
   * 落库策略（08 文档第 52 节）：
   *   文本增量即产即发（前端要看到打字效果）；
   *   工具与 assistant 消息在流结束时统一落库，
   *   避免「半条消息」进入数据库 —— 文档原先未定义，属于本次明确的取舍。
   */
  async *runStreamTurn(input: {
    prepared: PreparedStreamMessage;
    ctx: AiServiceContext;
    provider?: LLMProvider;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }): AsyncGenerator<StreamTurnEvent, void, undefined> {
    const p = input.prepared;
    const provider = input.provider ?? createLLMProvider();

    // 本回合的工具调用，供结束后成对落库。
    // 不能靠「按会话查最近 N 条审计」——那会把历史回合的记录重复写一遍。
    const turnToolCalls: {
      operationId: string;
      toolName: string;
      arguments: unknown;
      success: boolean;
    }[] = [];

    let finalContent = "";
    let truncated = false;
    let model = input.model ?? "unknown";
    let lastEmittedRevision: number | undefined;

    for await (const event of runTurnStream({
      provider,
      conversationId: p.conversationId,
      targetType:
        p.targetType === "template" ? "template" : "questionnaire_instance",
      targetId: p.targetId,
      scene: p.scene,
      userId: input.ctx.userId,
      roles: input.ctx.roles,
      userMessage: p.content,
      history: p.history,
      questionnaireContext: p.questionnaireContext,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.temperature !== undefined
        ? { temperature: input.temperature }
        : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    })) {
      switch (event.type) {
        case "text_delta":
          yield { type: "text_delta", text: event.text };
          break;

        case "tool_call_start":
          turnToolCalls.push({
            operationId: event.operationId,
            toolName: event.toolName,
            arguments: event.arguments,
            success: false,
          });
          yield {
            type: "tool_call_start",
            toolName: event.toolName,
            operationId: event.operationId,
            arguments: event.arguments,
          };
          break;

        case "tool_call_result": {
          const entry = turnToolCalls.find(
            (t) => t.operationId === event.operationId
          );
          if (entry) entry.success = event.success;

          yield {
            type: "tool_call_result",
            toolName: event.toolName,
            operationId: event.operationId,
            success: event.success,
            ...(event.errorCode !== undefined
              ? { errorCode: event.errorCode }
              : {}),
            ...(event.revision !== undefined
              ? { revision: event.revision }
              : {}),
          };

          // 结构变化时通知前端刷新。
          // 不推全量结构：一轮内可能改多次，推全量会让 SSE 体积成倍增长；
          // 且前端拿到的结构必须与数据库一致，重新 GET 最可靠。
          if (
            p.targetType === "questionnaire_instance" &&
            event.success &&
            event.revision !== undefined &&
            event.revision !== lastEmittedRevision
          ) {
            lastEmittedRevision = event.revision;
            yield {
              type: "questionnaire_updated",
              questionnaireId: p.targetId,
              revision: event.revision,
            };
          }
          break;
        }

        case "done":
          finalContent = event.content;
          truncated = event.truncated;
          model = event.model;
          break;

        default:
          break;
      }
    }

    // ---- 统一落库：工具调用成对的 assistant + tool 消息，最后是回复文本 ----
    for (const tc of turnToolCalls) {
      await aiConversationRepository.appendMessage({
        conversationId: p.conversationId,
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: tc.operationId,
            name: tc.toolName,
            arguments: JSON.stringify(tc.arguments),
          },
        ],
      });

      await aiConversationRepository.appendMessage({
        conversationId: p.conversationId,
        role: "tool",
        content: JSON.stringify({ success: tc.success }),
        toolName: tc.toolName,
        toolCallId: tc.operationId,
      });
    }

    await aiConversationRepository.appendMessage({
      conversationId: p.conversationId,
      role: "assistant",
      content: finalContent,
    });

    // 结构真的变了才回传 revision
    let revisionAfter: number | undefined;
    if (p.targetType === "questionnaire_instance") {
      const after = await questionnaireRepository.findInstanceById(p.targetId);
      revisionAfter = after?.currentRevision;
    }

    const changed =
      p.revisionBefore !== undefined &&
      revisionAfter !== undefined &&
      revisionAfter !== p.revisionBefore;

    yield {
      type: "done",
      content: finalContent,
      truncated,
      model,
      ...(changed && revisionAfter !== undefined
        ? { revision: revisionAfter }
        : {}),
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

  /**
   * 提交 AI 生成的问卷（05 文档第 33 节：AI 生成模板的**唯一保存路径**）。
   *
   * 依据 05 文档第 33.1 与 34 节：
   *   AI 对话过程中写的是 Draft Template；
   *   用户确认后由本方法把它定格为模板版本，并可与名称/说明一起保存。
   *
   * 实现说明（重要）：
   *   对话的写入目标**本身就是**一个 questionnaire_template_versions 记录
   *   （status = draft），所以「提交」不是新建版本，而是：
   *     校验结构非空且合法 → 落定版本信息（名称/说明/changeNote）→ 返回该版本。
   *   之后再由 template_admin 走 POST .../publish 发布为正式版本。
   *   这样不会因为一次 commit 就凭空多出一个空版本。
   */
  async commitConversation(
    conversationId: string,
    input: {
      name?: string;
      description?: string;
      changeNote?: string;
    },
    ctx: AiServiceContext
  ): Promise<{
    templateId: string;
    templateVersionId: string;
    versionNo: number;
    status: string;
  }> {
    const conversation = await this.getConversation(conversationId, ctx);

    if (conversation.scene !== "create_template") {
      throw new OperationError(
        ErrorCode.INVALID_OPERATION,
        `只有 create_template 会话可以 commit，当前 scene=${conversation.scene}`
      );
    }
    if (conversation.targetType !== "template" || !conversation.targetId) {
      throw new OperationError(
        ErrorCode.INVALID_OPERATION,
        "该会话没有绑定模板草稿版本，无法提交"
      );
    }

    // 复用模板服务：它负责「只有 draft 可写」「version_no 由后端计算」等规则
    const committed = await templateService.commitDraftVersion(
      conversation.targetId,
      input,
      {
        userId: ctx.userId,
        roles: ctx.roles,
        source: "ai_tool",
        auditToolName: "commit_conversation",
      }
    );

    await aiConversationRepository.updateStatus(conversationId, "committed");

    return committed;
  },

  /** 供测试与内部使用：直接产出一个 operationId */
  newOperationId(): string {
    return newId();
  },
};

export type AiConversationService = typeof aiConversationService;
