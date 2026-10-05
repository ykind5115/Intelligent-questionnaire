/**
 * AI 会话 Controller。
 *
 * 依据 docs/06-proj_init.md 第 40 节与 docs/05-api_design.md 第 10 / 12 节：
 *   Controller 只做「接收 Request → 参数校验 → 调用 Service → 转换 Response」。
 *   不写业务逻辑、不碰数据库、不拼 Prompt。
 *
 * 因此本文件里的每个 handler 都只有三件事：
 *   1. 从请求里取出已校验的参数与当前用户上下文（aiContextOf）
 *   2. 调用 aiConversationService
 *   3. 用 sendSuccess / sendCreated 输出统一的响应结构
 *
 * 错误处理：
 *   一律不写 try/catch，而是用 asyncHandler 包装，
 *   让 OperationError 冒泡到全局 errorHandler，
 *   由它根据错误码自动映射 HTTP 状态码（404 / 403 / 409 / 422 等）。
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";

import {
  parsePagination,
  sendCreated,
  sendSuccess,
} from "../../../app/api-response.js";
import { asyncHandler } from "../../../app/error-handler.js";
import { validate } from "../../../app/validate.js";
import { aiContextOf } from "../../../app/request-context.js";
import type { LLMProvider } from "../providers/index.js";
import {
  SUPPORTED_SCENES,
  aiConversationService,
  type AiServiceContext,
  type CreateConversationResult,
  type SendMessageResult,
} from "../service/ai-conversation.service.js";
import type {
  AiConversationRow,
  AiMessageRow,
} from "../repository/ai.types.js";

// ============================================================
// 请求 Schema
// ============================================================

/**
 * 创建会话。
 *
 * scene 用 z.enum 收口到 AI 服务支持的场景：
 * 传别的值在 API 边界就变成 422，而不是进到 Service 才失败。
 * 注意：这里**不**校验 targetId 是否为 UUID 格式 ——
 * 那是业务层的判断（不存在 → 404，格式错 → 同样按不存在处理），
 * Controller 只要求它是非空字符串。
 */
const createConversationBody = z.object({
  scene: z.enum(SUPPORTED_SCENES),
  targetType: z.enum(["template", "questionnaire_instance"]).optional(),
  targetId: z.string().min(1).optional(),
});

/** 发送消息 */
const sendMessageBody = z.object({
  content: z.string().min(1),
});

/** 分页查询（pageSize 上限由 parsePagination 统一收敛到 100） */
const paginationQuery = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});

const conversationParams = z.object({
  id: z.string().min(1),
});

/**
 * 提交 AI 生成的问卷（05 文档第 34 节）。
 *
 * 名称/说明/变更说明都可选：对话过程中模板已带着一个占位名称，
 * 用户确认时可以在这里改成正式名称。
 */
const commitBody = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  changeNote: z.string().max(2000).optional(),
});

type CreateConversationBody = z.infer<typeof createConversationBody>;
type SendMessageBody = z.infer<typeof sendMessageBody>;
type CommitBody = z.infer<typeof commitBody>;

// ============================================================
// 假 Provider 注入点（仅供测试与本地联调）
// ============================================================

/**
 * 测试注入点。
 *
 * 生产路径下 app.locals 里没有 aiProvider，
 * Service 会走 createLLMProvider() 用配置创建真实 Provider；
 * 测试里设置 app.locals.aiProvider = fakeProvider，
 * 即可在不访问真实模型的前提下跑完整 HTTP → Service → Orchestrator → 数据库 链路。
 */
function providerOf(req: Request): LLMProvider | undefined {
  const locals = (req.app as { locals?: Record<string, unknown> }).locals;
  const injected = locals?.["aiProvider"];
  return injected ? (injected as LLMProvider) : undefined;
}

// ============================================================
// 序列化（数据库行 → API DTO）
// ============================================================

function toConversationDto(c: AiConversationRow) {
  return {
    id: c.id,
    scene: c.scene,
    targetType: c.targetType,
    targetId: c.targetId,
    status: c.status,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function toMessageDto(m: AiMessageRow) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    toolName: m.toolName,
    toolCallId: m.toolCallId,
    toolArguments: m.toolArguments,
    toolResult: m.toolResult,
    sequenceNo: m.sequenceNo,
    createdAt: m.createdAt,
  };
}

// ============================================================
// 业务调用
// ============================================================

function createConversation(
  body: CreateConversationBody,
  ctx: AiServiceContext
): Promise<CreateConversationResult> {
  return aiConversationService.createConversation(
    {
      scene: body.scene,
      ...(body.targetType !== undefined
        ? { targetType: body.targetType }
        : {}),
      ...(body.targetId !== undefined ? { targetId: body.targetId } : {}),
    },
    ctx
  );
}

function sendMessage(
  conversationId: string,
  content: string,
  ctx: AiServiceContext,
  provider: LLMProvider | undefined
): Promise<SendMessageResult> {
  return aiConversationService.sendMessage({
    conversationId,
    content,
    ctx,
    ...(provider !== undefined ? { provider } : {}),
  });
}

// ============================================================
// Router
// ============================================================

/**
 * AI 会话路由。
 *
 * 相对路径（挂载点由 app/routes.ts 决定，05 文档里是 /api/v1/ai）：
 *   POST   /conversations                  创建会话        → 201
 *   POST   /conversations/:id/messages     发送消息        → 200
 *   GET    /conversations                  我的会话列表    → 200
 *   GET    /conversations/:id              会话详情        → 200
 *   GET    /conversations/:id/messages     消息列表        → 200
 *   POST   /conversations/:id/close        关闭会话        → 200
 */
export function createAiRouter(): Router {
  const router = Router();

  // ---- 创建会话 ----
  router.post(
    "/conversations",
    validate({ body: createConversationBody }),
    asyncHandler(async (req: Request, res: Response) => {
      const result = await createConversation(
        req.body as CreateConversationBody,
        aiContextOf(req)
      );
      sendCreated(req, res, result);
    })
  );

  // ---- 我的会话列表（分页） ----
  router.get(
    "/conversations",
    validate({ query: paginationQuery }),
    asyncHandler(async (req: Request, res: Response) => {
      const pagination = parsePagination(req.query as Record<string, unknown>);
      const { items, total } = await aiConversationService.listConversations(
        aiContextOf(req),
        { skip: pagination.offset, take: pagination.pageSize }
      );

      sendSuccess(req, res, {
        items: items.map(toConversationDto),
        page: pagination.page,
        pageSize: pagination.pageSize,
        total,
      });
    })
  );

  // ---- 会话详情 ----
  router.get(
    "/conversations/:id",
    validate({ params: conversationParams }),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params as z.infer<typeof conversationParams>;
      const conversation = await aiConversationService.getConversation(
        id,
        aiContextOf(req)
      );
      sendSuccess(req, res, toConversationDto(conversation));
    })
  );

  // ---- 消息列表（分页） ----
  router.get(
    "/conversations/:id/messages",
    validate({ params: conversationParams, query: paginationQuery }),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params as z.infer<typeof conversationParams>;
      const pagination = parsePagination(req.query as Record<string, unknown>);

      const { items, total } = await aiConversationService.listMessages(
        id,
        aiContextOf(req),
        { skip: pagination.offset, take: pagination.pageSize }
      );

      sendSuccess(req, res, {
        items: items.map(toMessageDto),
        page: pagination.page,
        pageSize: pagination.pageSize,
        total,
      });
    })
  );

  // ---- 发送消息（驱动 Orchestrator） ----
  router.post(
    "/conversations/:id/messages",
    validate({ params: conversationParams, body: sendMessageBody }),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params as z.infer<typeof conversationParams>;
      const { content } = req.body as SendMessageBody;

      const result = await sendMessage(
        id,
        content,
        aiContextOf(req),
        providerOf(req)
      );

      sendSuccess(req, res, result);
    })
  );

  // ---- 提交 AI 生成的问卷（create_template 会话的唯一保存路径） ----
  router.post(
    "/conversations/:id/commit",
    validate({ params: conversationParams, body: commitBody.optional() }),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params as z.infer<typeof conversationParams>;
      const body = (req.body ?? {}) as CommitBody;

      const result = await aiConversationService.commitConversation(
        id,
        {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
          ...(body.changeNote !== undefined
            ? { changeNote: body.changeNote }
            : {}),
        },
        aiContextOf(req)
      );

      sendCreated(req, res, result);
    })
  );

  // ---- 关闭会话 ----
  router.post(
    "/conversations/:id/close",
    validate({ params: conversationParams }),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params as z.infer<typeof conversationParams>;
      const result = await aiConversationService.closeConversation(
        id,
        aiContextOf(req)
      );
      sendSuccess(req, res, result);
    })
  );

  return router;
}
