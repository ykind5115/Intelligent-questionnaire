/**
 * 下发任务 Controller。
 *
 * 依据 docs/06-proj_init.md 第 40 节：
 *   Controller 只做参数校验、调用 Service、转换 Response；
 *   不写业务逻辑、不碰数据库。
 *
 * 覆盖 docs/05-api_design.md 第 14 节：
 *   POST /dispatch-tasks
 *   POST /dispatch-tasks/:id/dispatch
 *   GET  /dispatch-tasks
 */
import type { Request, Response } from "express";
import { z } from "zod";
import {
  parsePagination,
  sendCreated,
  sendSuccess,
} from "../../../app/api-response.js";
import { asyncHandler } from "../../../app/error-handler.js";
import { serviceContextOf } from "../../../app/request-context.js";
import { validatedQuery } from "../../../app/validate.js";
import {
  DISPATCH_TASK_STATUSES,
  dispatchService,
  type DispatchTaskRecord,
} from "../service/dispatch.service.js";

// ============================================================
// 请求 Schema
// ============================================================

/** 创建下发任务（05 文档第 14.1 节） */
export const createDispatchTaskBody = z.object({
  questionnaireInstanceId: z.uuid(),
  assignedTo: z.uuid(),
  /** ISO 时间字符串，Zod 负责转成 Date */
  dueAt: z.coerce.date().optional(),
});

export const dispatchTaskParams = z.object({ id: z.uuid() });

/** 查询下发任务（05 文档第 14.3 节） */
export const listDispatchTasksQuery = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  status: z.enum(DISPATCH_TASK_STATUSES).optional(),
  assignedTo: z.uuid().optional(),
  questionnaireInstanceId: z.uuid().optional(),
});

// ============================================================
// 序列化
// ============================================================

function toTaskDto(t: DispatchTaskRecord) {
  return {
    id: t.id,
    questionnaireInstanceId: t.questionnaireInstanceId,
    assignedTo: t.assignedTo,
    dispatchedBy: t.dispatchedBy,
    status: t.status,
    dispatchedAt: t.dispatchedAt,
    dueAt: t.dueAt,
    withdrawnAt: t.withdrawnAt,
    withdrawnBy: t.withdrawnBy,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// ============================================================
// Handlers（路径在 routes.ts 中定义）
// ============================================================

export const dispatchController = {
  /** POST /dispatch-tasks */
  createTask: asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof createDispatchTaskBody>;

    const task = await dispatchService.createTask(
      {
        questionnaireInstanceId: body.questionnaireInstanceId,
        assignedTo: body.assignedTo,
        ...(body.dueAt !== undefined ? { dueAt: body.dueAt } : {}),
      },
      serviceContextOf(req)
    );

    sendCreated(req, res, toTaskDto(task));
  }),

  /** POST /dispatch-tasks/:id/dispatch */
  dispatch: asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as z.infer<typeof dispatchTaskParams>;

    const result = await dispatchService.dispatchTask(
      id,
      serviceContextOf(req)
    );

    sendSuccess(req, res, {
      ...toTaskDto(result.task),
      instanceId: result.instanceId,
      instanceStatus: result.instanceStatus,
    });
  }),

  /** GET /dispatch-tasks */
  list: asyncHandler(async (req: Request, res: Response) => {
    const query = validatedQuery<z.infer<typeof listDispatchTasksQuery>>(req);
    const pagination = parsePagination(req.query as Record<string, unknown>);

    const { items, total } = await dispatchService.listTasks(
      {
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.assignedTo !== undefined
          ? { assignedTo: query.assignedTo }
          : {}),
        ...(query.questionnaireInstanceId !== undefined
          ? { questionnaireInstanceId: query.questionnaireInstanceId }
          : {}),
      },
      { skip: pagination.offset, take: pagination.pageSize },
      serviceContextOf(req)
    );

    sendSuccess(req, res, {
      items: items.map(toTaskDto),
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
    });
  }),
};
