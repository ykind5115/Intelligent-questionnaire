/**
 * Dispatch Service（下发模块）。
 *
 * 依据 docs/05-api_design.md 第 14 节、docs/04-database_design.md 第 25 节
 * 与 docs/09-review-and-decisions.md 的决策 D1 / D8：
 *
 *   1. 只有 confirmed 的实例可以创建下发任务（任务初始 status = pending）；
 *   2. 创建下发任务需要 dispatcher 角色（D8：问卷下发权）；
 *   3. 执行下发后：dispatch_tasks.status → dispatched，
 *      questionnaire_instances.status → dispatched，并记录 dispatched_at；
 *   4. 下发即冻结结构（D1），因此状态流转必须留审计痕迹。
 *
 * 与 questionnaire 模块的分工：
 *   结构（current_schema / revision）归 questionnaire 模块；
 *   本模块只负责「把已确认的问卷交给调查人员」这一状态流转，
 *   不修改 current_schema，也不产生新的 Revision。
 *
 * 说明：本模块没有独立的 repository 文件（任务约束），
 * 因此数据访问直接走 Prisma 客户端；等这些模块稳定后，
 * 可以把三个模块共用的审计写入抽成统一的 audit repository。
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
import type { ServiceContext } from "../../questionnaire/service/questionnaire.service.js";

// ============================================================
// 角色与状态常量
// ============================================================

/** 下发写操作的角色（决策 D8） */
export const DISPATCH_WRITE_ROLES = ["dispatcher"] as const;
/**
 * 下发任务读操作的角色。
 *
 * 调查人员查看「自己待办」走的是 questionnaire-instances/{id}/response，
 * 不需要读全部下发任务，因此这里不放开 investigator。
 */
export const DISPATCH_READ_ROLES = ["dispatcher", "template_admin"] as const;

/** dispatch_tasks.status 取值（04 文档第 25.3 节） */
export const DISPATCH_TASK_STATUSES = [
  "pending",
  "dispatched",
  "withdrawn",
  "completed",
] as const;

/** 允许创建下发任务的实例状态（05 文档第 14.1 节） */
export const DISPATCHABLE_INSTANCE_STATUS = "confirmed";

/** 执行下发后的实例状态 */
export const DISPATCHED_INSTANCE_STATUS = "dispatched";

// ============================================================
// 类型
// ============================================================

export interface DispatchTaskRecord {
  id: string;
  questionnaireInstanceId: string;
  assignedTo: string;
  dispatchedBy: string;
  status: string;
  dispatchedAt: Date | null;
  dueAt: Date | null;
  withdrawnAt: Date | null;
  withdrawnBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DispatchTaskListQuery {
  status?: string;
  assignedTo?: string;
  questionnaireInstanceId?: string;
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

/**
 * 写一条审计记录（ai_tool_executions）。
 *
 * 决策 D9：一次业务动作对应一个 operation_id；
 * 这里与 questionnaire.service.ts 的写法保持一致 ——
 * 调用方给了 operationId 就用它，否则新生成一个合法 UUID。
 *
 * operation_id 是 uuid 列且有 UNIQUE 约束，
 * 因此**绝不能**把 HTTP 路径或自造字符串塞进来。
 */
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

export const dispatchService = {
  /**
   * 创建下发任务（05 文档第 14.1 节）。
   *
   * 后端检查：实例存在 → 状态为 confirmed → 被指派人存在 → 有下发权限。
   * 注意：本方法**不改变**实例状态，只是排一条待下发的任务。
   */
  async createTask(
    input: {
      questionnaireInstanceId: string;
      assignedTo: string;
      dueAt?: Date;
    },
    ctx: ServiceContext
  ): Promise<DispatchTaskRecord> {
    assertRole(ctx, DISPATCH_WRITE_ROLES, "创建下发任务");

    return transaction(async (tx: Tx) => {
      const instance = await tx.questionnaireInstance.findUnique({
        where: { id: input.questionnaireInstanceId },
        select: { id: true, status: true },
      });
      if (!instance) {
        throw new OperationError(
          ErrorCode.QUESTIONNAIRE_NOT_FOUND,
          `问卷实例不存在：${input.questionnaireInstanceId}`
        );
      }

      if (instance.status !== DISPATCHABLE_INSTANCE_STATUS) {
        throw new OperationError(
          ErrorCode.INVALID_STATUS_TRANSITION,
          `实例状态为 ${instance.status}，只有 ${DISPATCHABLE_INSTANCE_STATUS} ` +
            "的实例可以创建下发任务",
          {
            path: "status",
            status: instance.status,
            expected: DISPATCHABLE_INSTANCE_STATUS,
          }
        );
      }

      const assignee = await tx.user.findUnique({
        where: { id: input.assignedTo },
        select: { id: true, status: true, roles: true },
      });
      if (!assignee) {
        throw validationError(
          `被指派的用户不存在：${input.assignedTo}`,
          { path: "assignedTo", assignedTo: input.assignedTo }
        );
      }
      if (assignee.status !== "active") {
        throw validationError(
          `被指派的用户已停用：${input.assignedTo}`,
          { path: "assignedTo", status: assignee.status }
        );
      }

      // 只能指派给调查人员（决策 D8）：
      // 否则会出现「指派给审核人/模板管理员」这种业务上不成立的待办，
      // 而 investigator 的横向授权规则又是围绕 dispatch_tasks 建立的，
      // 一旦指派对象不是 investigator，权限模型就会出现无意义的中间态。
      if (!assignee.roles.includes("investigator")) {
        throw validationError(
          `只能指派给 investigator 角色的用户，` +
            `用户 ${input.assignedTo} 的角色为 [${assignee.roles.join(", ")}]`,
          {
            path: "assignedTo",
            roles: assignee.roles,
          }
        );
      }

      const created = await tx.dispatchTask.create({
        data: {
          id: newId(),
          questionnaireInstanceId: input.questionnaireInstanceId,
          assignedTo: input.assignedTo,
          dispatchedBy: ctx.userId,
          status: "pending",
          ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
        },
      });

      await writeAudit(tx, {
        ctx,
        toolName: "create_dispatch_task",
        instanceId: input.questionnaireInstanceId,
        args: {
          questionnaireInstanceId: input.questionnaireInstanceId,
          assignedTo: input.assignedTo,
          dueAt: input.dueAt?.toISOString() ?? null,
        },
        result: {
          dispatchTaskId: created.id,
          status: created.status,
        },
      });

      return created;
    });
  },

  /**
   * 执行下发（05 文档第 14.2 节）。
   *
   * pending → dispatched，同时把实例推进到 dispatched。
   *
   * 为什么这里要重新校验实例状态：
   *   任务创建与执行是两个时刻，中间实例可能被撤回或已被别处下发；
   *   只校验任务状态会出现「实例是 draft，任务却是 dispatched」的脏组合。
   */
  async dispatchTask(
    dispatchTaskId: string,
    ctx: ServiceContext
  ): Promise<{
    task: DispatchTaskRecord;
    instanceId: string;
    instanceStatus: string;
  }> {
    assertRole(ctx, DISPATCH_WRITE_ROLES, "执行下发");

    return transaction(async (tx: Tx) => {
      const task = await tx.dispatchTask.findUnique({
        where: { id: dispatchTaskId },
      });
      if (!task) {
        throw new OperationError(
          ErrorCode.DISPATCH_NOT_FOUND,
          `下发任务不存在：${dispatchTaskId}`
        );
      }

      if (task.status !== "pending") {
        throw new OperationError(
          ErrorCode.INVALID_STATUS_TRANSITION,
          `下发任务状态为 ${task.status}，只有 pending 的任务可以执行下发`,
          { path: "status", status: task.status, expected: "pending" }
        );
      }

      const instance = await tx.questionnaireInstance.findUnique({
        where: { id: task.questionnaireInstanceId },
        select: { id: true, status: true },
      });
      if (!instance) {
        throw new OperationError(
          ErrorCode.QUESTIONNAIRE_NOT_FOUND,
          `问卷实例不存在：${task.questionnaireInstanceId}`
        );
      }

      if (instance.status !== DISPATCHABLE_INSTANCE_STATUS) {
        throw new OperationError(
          ErrorCode.INVALID_STATUS_TRANSITION,
          `实例状态为 ${instance.status}，只有 ${DISPATCHABLE_INSTANCE_STATUS} ` +
            "的实例可以下发",
          {
            path: "status",
            status: instance.status,
            expected: DISPATCHABLE_INSTANCE_STATUS,
          }
        );
      }

      const dispatchedAt = new Date();

      const updatedTask = await tx.dispatchTask.update({
        where: { id: dispatchTaskId },
        data: { status: "dispatched", dispatchedAt },
      });

      const updatedInstance = await tx.questionnaireInstance.update({
        where: { id: instance.id },
        data: { status: DISPATCHED_INSTANCE_STATUS },
        select: { id: true, status: true },
      });

      await writeAudit(tx, {
        ctx,
        toolName: "dispatch_task",
        instanceId: instance.id,
        args: { dispatchTaskId, assignedTo: task.assignedTo },
        result: {
          from: "pending",
          to: "dispatched",
          dispatchedAt: dispatchedAt.toISOString(),
          instanceStatus: updatedInstance.status,
        },
      });

      return {
        task: updatedTask,
        instanceId: updatedInstance.id,
        instanceStatus: updatedInstance.status,
      };
    });
  },

  /** 查询下发任务（05 文档第 14.3 节：status / assignedTo / page / pageSize） */
  async listTasks(
    query: DispatchTaskListQuery,
    options: { skip: number; take: number },
    ctx: ServiceContext
  ): Promise<{ items: DispatchTaskRecord[]; total: number }> {
    assertRole(ctx, DISPATCH_READ_ROLES, "查询下发任务");

    const where = {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.assignedTo !== undefined
        ? { assignedTo: query.assignedTo }
        : {}),
      ...(query.questionnaireInstanceId !== undefined
        ? { questionnaireInstanceId: query.questionnaireInstanceId }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.dispatchTask.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: options.skip,
        take: options.take,
      }),
      prisma.dispatchTask.count({ where }),
    ]);

    return { items, total };
  },
};

export type DispatchService = typeof dispatchService;
