/**
 * Review Service（审核模块）。
 *
 * 依据 docs/05-api_design.md 第 16 节、docs/04-database_design.md 第 30 节
 * 与 docs/09-review-and-decisions.md 的决策 D8：
 *
 *   1. 待审核列表 = questionnaire_responses.status = submitted（05 文档第 16.1 节）；
 *   2. result 只允许 approved / rejected（04 文档第 30.2 节）；
 *   3. 通过 → 写 review_records，实例状态 → completed；
 *      退回 → 写 review_records，response 回到 draft（允许重新填写），
 *             实例状态 → returned；
 *   4. 只有 status = submitted 的 response 可以审核；
 *   5. 审核需要 reviewer 角色（D8）。
 *
 * 为什么退回要把 response 打回 draft：
 *   04 文档第 27.3 节把 draft 定义为「填写中」。
 *   退回后调查人员需要继续补填，若仍停留在 submitted，
 *   保存答案会被「已提交不可修改」拦住，退回就没有意义了。
 */
import { prisma } from "../../../database/client.js";
import { transaction, type Tx } from "../../../database/transaction.js";
import { newId } from "../../../shared/utils/id.js";
import { toJsonValue } from "../../../shared/utils/json.js";
import {
  ErrorCode,
  OperationError,
  permissionDenied,
  validationError,
} from "../../../shared/errors/index.js";
import {
  questionnaireSchema,
  type QuestionnaireSchema,
} from "../../questionnaire/schema/questionnaire.schema.js";
import type { ServiceContext } from "../../questionnaire/service/questionnaire.service.js";

// ============================================================
// 角色与常量
// ============================================================

/** 审核角色（决策 D8：reviewer 查看已提交问卷、审核通过、退回） */
export const REVIEW_ROLES = ["reviewer"] as const;

/** review_records.result 取值（04 文档第 30.2 节） */
export const REVIEW_RESULTS = ["approved", "rejected"] as const;

/** 允许审核的 response 状态 */
export const REVIEWABLE_RESPONSE_STATUS = "submitted";

// ============================================================
// 类型
// ============================================================

export interface ReviewRecordDto {
  id: string;
  questionnaireResponseId: string;
  reviewerId: string;
  result: string;
  comment: string | null;
  createdAt: Date;
}

export interface PendingReviewItem {
  responseId: string;
  questionnaireInstanceId: string;
  instanceTitle: string;
  instanceStatus: string;
  respondentId: string;
  status: string;
  submittedAt: Date | null;
  createdAt: Date;
}

// ============================================================
// 内部辅助
// ============================================================

function assertRole(
  ctx: ServiceContext,
  allowed: readonly string[],
  action: string
): void {
  if (!ctx.roles.some((r) => allowed.includes(r))) {
    throw permissionDenied(
      `当前用户角色 [${ctx.roles.join(", ")}] 无权${action}，` +
        `需要 ${allowed.join(" 或 ")}`
    );
  }
}

function parseSchema(raw: unknown, subject: string): QuestionnaireSchema {
  const parsed = questionnaireSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${subject} 中的问卷结构不合法（数据库内容与 Schema 定义不一致）：` +
        parsed.error.issues.map((i) => i.message).join("; ")
    );
  }
  return parsed.data;
}

async function writeAudit(
  tx: Tx,
  params: {
    ctx: ServiceContext;
    toolName: string;
    instanceId?: string;
    args: unknown;
    result: unknown;
  }
): Promise<void> {
  await tx.aiToolExecution.create({
    data: {
      id: newId(),
      operationId: params.ctx.operationId ?? newId(),
      source: params.ctx.source ?? "rest",
      toolName: params.toolName,
      arguments: toJsonValue(params.args),
      result: toJsonValue(params.result),
      success: true,
      ...(params.instanceId !== undefined
        ? { questionnaireInstanceId: params.instanceId }
        : {}),
      ...(params.ctx.conversationId !== undefined
        ? { conversationId: params.ctx.conversationId }
        : {}),
      ...(params.ctx.messageId !== undefined
        ? { messageId: params.ctx.messageId }
        : {}),
      ...(params.ctx.model !== undefined ? { model: params.ctx.model } : {}),
    },
  });
}

// ============================================================
// Service
// ============================================================

export const reviewService = {
  /** 待审核列表（05 文档第 16.1 节） */
  async listPending(
    query: { status?: string; questionnaireInstanceId?: string },
    options: { skip: number; take: number },
    ctx: ServiceContext
  ): Promise<{ items: PendingReviewItem[]; total: number }> {
    assertRole(ctx, REVIEW_ROLES, "查看待审核列表");

    const where = {
      // 默认只看已提交的（这才是「待审核」的语义）
      status: query.status ?? REVIEWABLE_RESPONSE_STATUS,
      ...(query.questionnaireInstanceId !== undefined
        ? { questionnaireInstanceId: query.questionnaireInstanceId }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.questionnaireResponse.findMany({
        where,
        orderBy: { submittedAt: "desc" },
        skip: options.skip,
        take: options.take,
        include: {
          instance: {
            select: { id: true, title: true, status: true },
          },
        },
      }),
      prisma.questionnaireResponse.count({ where }),
    ]);

    return {
      items: rows.map((r) => ({
        responseId: r.id,
        questionnaireInstanceId: r.questionnaireInstanceId,
        instanceTitle: r.instance.title,
        instanceStatus: r.instance.status,
        respondentId: r.respondentId,
        status: r.status,
        submittedAt: r.submittedAt,
        createdAt: r.createdAt,
      })),
      total,
    };
  },

  /**
   * 审核详情（05 文档第 16.2 节）。
   *
   * 不再限制 response.status：审核人需要看到「退回过、改了再提交」的完整过程，
   * 因此已审过的（completed）与退回中的（draft）同样允许查看。
   */
  async getDetail(
    responseId: string,
    ctx: ServiceContext
  ): Promise<{
    response: {
      id: string;
      questionnaireInstanceId: string;
      respondentId: string;
      status: string;
      submittedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    };
    instance: {
      id: string;
      title: string;
      status: string;
      currentRevision: number;
    };
    schema: QuestionnaireSchema;
    answers: { questionId: string; answer: unknown; revisionNo: number }[];
    reviews: ReviewRecordDto[];
  }> {
    assertRole(ctx, REVIEW_ROLES, "查看审核详情");

    const response = await prisma.questionnaireResponse.findUnique({
      where: { id: responseId },
    });
    if (!response) {
      throw new OperationError(
        ErrorCode.RESPONSE_NOT_FOUND,
        `填写结果不存在：${responseId}`
      );
    }

    const instance = await prisma.questionnaireInstance.findUnique({
      where: { id: response.questionnaireInstanceId },
      select: {
        id: true,
        title: true,
        status: true,
        currentRevision: true,
        currentSchema: true,
      },
    });
    if (!instance) {
      throw new OperationError(
        ErrorCode.QUESTIONNAIRE_NOT_FOUND,
        `问卷实例不存在：${response.questionnaireInstanceId}`
      );
    }

    const [answers, reviews] = await Promise.all([
      prisma.questionnaireAnswer.findMany({
        where: { responseId },
        orderBy: { questionId: "asc" },
      }),
      prisma.reviewRecord.findMany({
        where: { questionnaireResponseId: responseId },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    return {
      response: {
        id: response.id,
        questionnaireInstanceId: response.questionnaireInstanceId,
        respondentId: response.respondentId,
        status: response.status,
        submittedAt: response.submittedAt,
        createdAt: response.createdAt,
        updatedAt: response.updatedAt,
      },
      instance: {
        id: instance.id,
        title: instance.title,
        status: instance.status,
        currentRevision: instance.currentRevision,
      },
      schema: parseSchema(instance.currentSchema, `实例 ${instance.id}`),
      answers: answers.map((a) => ({
        questionId: a.questionId,
        answer: a.answer,
        revisionNo: a.revisionNo,
      })),
      reviews: reviews.map((r) => ({
        id: r.id,
        questionnaireResponseId: r.questionnaireResponseId,
        reviewerId: r.reviewerId,
        result: r.result,
        comment: r.comment,
        createdAt: r.createdAt,
      })),
    };
  },

  /**
   * 审核（05 文档第 16.3 / 16.4 节）。
   *
   * approved → 实例 completed（终态，只能新建实例）
   * rejected → response 回 draft 允许重新填写，实例 returned
   */
  async reviewResponse(
    responseId: string,
    input: { result: string; comment?: string },
    ctx: ServiceContext
  ): Promise<{
    review: ReviewRecordDto;
    response: {
      id: string;
      status: string;
      submittedAt: Date | null;
    };
    instanceId: string;
    instanceStatus: string;
  }> {
    assertRole(ctx, REVIEW_ROLES, "审核问卷");

    if (!(REVIEW_RESULTS as readonly string[]).includes(input.result)) {
      throw validationError(
        `审核结果只能是 ${REVIEW_RESULTS.join(" / ")}，收到：${input.result}`,
        { path: "result", result: input.result }
      );
    }

    return transaction(async (tx: Tx) => {
      const response = await tx.questionnaireResponse.findUnique({
        where: { id: responseId },
      });
      if (!response) {
        throw new OperationError(
          ErrorCode.RESPONSE_NOT_FOUND,
          `填写结果不存在：${responseId}`
        );
      }

      if (response.status !== REVIEWABLE_RESPONSE_STATUS) {
        throw new OperationError(
          ErrorCode.INVALID_STATUS_TRANSITION,
          `填写结果状态为 ${response.status}，只有 ` +
            `${REVIEWABLE_RESPONSE_STATUS} 可以审核`,
          {
            path: "status",
            status: response.status,
            expected: REVIEWABLE_RESPONSE_STATUS,
          }
        );
      }

      // ---- 幂等：同一份提交只能审一次 ----
      // 早期实现只看 response.status，而 approved 分支不改 response.status，
      // 于是同一提交可以被反复审核（甚至先 approved 再 rejected），
      // 留下互相矛盾的审核记录并把终态 completed 打回 returned。
      const existingReview = await tx.reviewRecord.findFirst({
        where: { questionnaireResponseId: responseId },
        orderBy: { createdAt: "desc" },
        select: { id: true, result: true, createdAt: true },
      });
      if (existingReview) {
        throw new OperationError(
          ErrorCode.INVALID_STATUS_TRANSITION,
          `该提交已于 ${existingReview.createdAt.toISOString()} 审核过` +
            `（结果：${existingReview.result}），不能重复审核`,
          {
            path: "responseId",
            previousResult: existingReview.result,
            previousReviewId: existingReview.id,
          }
        );
      }

      const instance = await tx.questionnaireInstance.findUnique({
        where: { id: response.questionnaireInstanceId },
        select: { id: true, status: true },
      });
      if (!instance) {
        throw new OperationError(
          ErrorCode.QUESTIONNAIRE_NOT_FOUND,
          `问卷实例不存在：${response.questionnaireInstanceId}`
        );
      }

      // ---- 终态保护：已完成的问卷不能再被审核改变状态 ----
      if (instance.status === "completed") {
        throw new OperationError(
          ErrorCode.INVALID_STATUS_TRANSITION,
          "该问卷已完成审核（终态），不能再改变其状态",
          { path: "status", status: instance.status }
        );
      }

      const review = await tx.reviewRecord.create({
        data: {
          id: newId(),
          questionnaireResponseId: responseId,
          reviewerId: ctx.userId,
          result: input.result,
          ...(input.comment !== undefined ? { comment: input.comment } : {}),
        },
      });

      const approved = input.result === "approved";

      // 审核通过后把答卷置为 reviewed：
      //   若仍停在 submitted，它会永远出现在「待审核列表」里，
      //   审核人无法分辨真正待审项（审计发现的缺陷）。
      // 退回时置回 draft 并清空 submitted_at：
      //   status 已回到 draft，继续保留提交时间会出现「未提交却有提交时间」
      //   的自相矛盾状态；审核历史本身留在 review_records 里，不会丢。
      const updatedResponse = await tx.questionnaireResponse.update({
        where: { id: responseId },
        data: approved
          ? { status: "reviewed" }
          : { status: "draft", submittedAt: null },
      });

      const updatedInstance = await tx.questionnaireInstance.update({
        where: { id: instance.id },
        data: { status: approved ? "completed" : "returned" },
        select: { id: true, status: true },
      });

      await writeAudit(tx, {
        ctx,
        toolName: "review_response",
        instanceId: instance.id,
        args: {
          responseId,
          result: input.result,
          comment: input.comment ?? null,
        },
        result: {
          reviewId: review.id,
          responseStatus: updatedResponse.status,
          instanceStatus: updatedInstance.status,
        },
      });

      return {
        review: {
          id: review.id,
          questionnaireResponseId: review.questionnaireResponseId,
          reviewerId: review.reviewerId,
          result: review.result,
          comment: review.comment,
          createdAt: review.createdAt,
        },
        response: {
          id: updatedResponse.id,
          status: updatedResponse.status,
          submittedAt: updatedResponse.submittedAt,
        },
        instanceId: updatedInstance.id,
        instanceStatus: updatedInstance.status,
      };
    });
  },
};

export type ReviewService = typeof reviewService;
