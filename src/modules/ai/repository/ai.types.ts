/**
 * AI 模块的持久化类型别名。
 *
 * 用 Prisma 生成的模型类型做别名，避免各处重复写长类型名。
 */
import type {
  AiConversation,
  AiMessage,
} from "../../../../generated/prisma/client.js";

export type AiConversationRow = AiConversation;
export type AiMessageRow = AiMessage;
