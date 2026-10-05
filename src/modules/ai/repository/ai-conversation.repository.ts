/**
 * AI 会话与消息 Repository。
 *
 * 依据 docs/04-database_design.md 第 19 至 22 节：
 *   ai_conversations 保存会话（scene + target_type + target_id）
 *   ai_messages 保存完整交互链路：user → assistant(tool_calls) → tool → assistant
 *
 * 设计约束（决策 D9 的一致性要求）：
 *   消息的 sequence_no 必须严格递增且无空洞，
 *   因为 (conversation_id, sequence_no) 有唯一约束，
 *   而「一次工具调用一个 operation_id」要求交互链路可精确回放。
 */
import { prisma } from "../../../database/client.js";
import { newId } from "../../../shared/utils/id.js";
import { toJsonValue } from "../../../shared/utils/json.js";
import { OperationError, ErrorCode } from "../../../shared/errors/index.js";
import type { DbClient } from "../../../database/transaction.js";
import type { AiMessageRow, AiConversationRow } from "./ai.types.js";

export interface CreateConversationInput {
  userId: string;
  scene: string;
  targetType?: "template" | "questionnaire_instance";
  targetId?: string;
}

export interface AppendMessageInput {
  conversationId: string;
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  toolName?: string;
  toolCallId?: string;
  /**
   * assistant 消息：模型请求的全部工具调用。
   *
   * 为什么存进 tool_arguments 列而不是新增一列：
   *   04 文档第 21.2 节的意图是「ai_messages 能描述整个 LLM 交互链路」。
   *   assistant 的 tool_calls 是这条链路的请求侧，
   *   tool 消息的 tool_result 是响应侧，两者都归在 tool_arguments/tool_result。
   *   为它单独加列会让 12 张表的既定结构偏离文档。
   */
  toolCalls?: unknown;
  /** tool 消息：对应哪次调用（配合 toolCallId 回放链路） */
  toolResult?: unknown;
}

export const aiConversationRepository = {
  async create(
    input: CreateConversationInput,
    client: DbClient = prisma
  ): Promise<AiConversationRow> {
    return client.aiConversation.create({
      data: {
        id: newId(),
        userId: input.userId,
        scene: input.scene,
        ...(input.targetType !== undefined
          ? { targetType: input.targetType }
          : {}),
        ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
        status: "active",
      },
    });
  },

  async findById(
    id: string,
    client: DbClient = prisma
  ): Promise<AiConversationRow | null> {
    return client.aiConversation.findUnique({ where: { id } });
  },

  async listByUser(
    userId: string,
    options: { skip: number; take: number },
    client: DbClient = prisma
  ): Promise<{ items: AiConversationRow[]; total: number }> {
    const [items, total] = await Promise.all([
      client.aiConversation.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        skip: options.skip,
        take: options.take,
      }),
      client.aiConversation.count({ where: { userId } }),
    ]);
    return { items, total };
  },

  async updateStatus(
    id: string,
    status: string,
    client: DbClient = prisma
  ): Promise<void> {
    await client.aiConversation.update({ where: { id }, data: { status } });
  },

  /**
   * 追加一条消息，自动分配 sequence_no。
   *
   * 为什么在一个事务里「先取最大值再插入」：
   *   (conversation_id, sequence_no) 是唯一约束，
   *   并发写入时若各自算出的序号相同，一方会失败。
   *   放在同一事务内可让冲突串行化，失败时由调用方重试。
   */
  async appendMessage(
    input: AppendMessageInput,
    client: DbClient = prisma
  ): Promise<AiMessageRow> {
    return prisma.$transaction(async (tx) => {
      const last = await tx.aiMessage.findFirst({
        where: { conversationId: input.conversationId },
        orderBy: { sequenceNo: "desc" },
        select: { sequenceNo: true },
      });

      const sequenceNo = (last?.sequenceNo ?? 0) + 1;

      return tx.aiMessage.create({
        data: {
          id: newId(),
          conversationId: input.conversationId,
          role: input.role,
          content: input.content ?? null,
          sequenceNo,
          ...(input.toolName !== undefined
            ? { toolName: input.toolName }
            : {}),
          ...(input.toolCallId !== undefined
            ? { toolCallId: input.toolCallId }
            : {}),
          ...(input.toolCalls !== undefined
            ? { toolArguments: toJsonValue(input.toolCalls) }
            : {}),
          ...(input.toolResult !== undefined
            ? { toolResult: toJsonValue(input.toolResult) }
            : {}),
        },
      });
    });
  },

  /** 按序号读取消息（构建模型上下文用） */
  async listMessages(
    conversationId: string,
    options: { skip?: number; take?: number } = {},
    client: DbClient = prisma
  ): Promise<{ items: AiMessageRow[]; total: number }> {
    const [items, total] = await Promise.all([
      client.aiMessage.findMany({
        where: { conversationId },
        orderBy: { sequenceNo: "asc" },
        ...(options.skip !== undefined ? { skip: options.skip } : {}),
        ...(options.take !== undefined ? { take: options.take } : {}),
      }),
      client.aiMessage.count({ where: { conversationId } }),
    ]);
    return { items, total };
  },

  /** 确保会话存在，否则抛出 404 语义的错误 */
  async requireById(
    id: string,
    client: DbClient = prisma
  ): Promise<AiConversationRow> {
    const found = await this.findById(id, client);
    if (!found) {
      throw new OperationError(
        ErrorCode.AI_CONVERSATION_NOT_FOUND,
        `AI 会话不存在：${id}`
      );
    }
    return found;
  },
};
