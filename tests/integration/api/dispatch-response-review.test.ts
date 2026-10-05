/**
 * 下发 / 填写 / 审核 三个模块的 HTTP 集成测试。
 *
 * 依据 docs/05-api_design.md 第 14 / 15 / 16 节。
 *
 * 为什么走真实 HTTP 而不是直接调 Service：
 *   本层的契约是「HTTP 状态码 + 统一响应结构 + 路由匹配顺序」，
 *   只有真的起一个服务（中间件顺序、错误映射、Express 路由优先级）
 *   才会暴露问题。项目没有装 supertest，因此用 app.listen(0) + 内置 fetch。
 *
 * 需要的真实数据：
 *   - 用户来自 seed（USERS，决策 D11：请求头 x-user-id）；
 *   - 问卷实例由 tests/integration/questionnaire/helpers.ts 的 createTestInstance 造；
 *   - 本文件自己按外键顺序清理 dispatch_tasks / responses / answers / review_records。
 */
import express, { type Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../../src/app/app.js";
import {
  errorHandler,
  notFoundHandler,
} from "../../../src/app/error-handler.js";
import { devAuthMiddleware } from "../../../src/shared/auth/auth.middleware.js";
import { newId } from "../../../src/shared/utils/id.js";
import { createDispatchRouter } from "../../../src/modules/dispatch/routes.js";
import { createResponseRouter } from "../../../src/modules/response/routes.js";
import { createReviewRouter } from "../../../src/modules/review/routes.js";
import {
  createTestInstance,
  deleteTestInstance,
  readInstanceState,
  USERS,
} from "../questionnaire/helpers.js";
import {
  apiRequest,
  expectData,
  prisma,
  startTestServer,
  type ApiResult,
  type TestHttpClient,
} from "./helpers.js";

// ============================================================
// 测试用 app 装配
// ============================================================

/**
 * 手工装配的兜底 app。
 *
 * 只在 createApp() 尚未挂载本模块路由（或未接统一错误处理）时使用；
 * 中间件顺序与 src/app/app.ts 保持一致：json → requestId → 鉴权 → 路由 → 404 → 错误处理。
 */
function buildFallbackApp(): Express {
  const app = express();

  app.use(express.json({ limit: "2mb" }));

  app.use((req, _res, next) => {
    if (!req.header("x-request-id")) {
      req.headers["x-request-id"] = crypto.randomUUID();
    }
    next();
  });

  app.use(devAuthMiddleware());

  app.use("/api/v1", createDispatchRouter());
  app.use("/api/v1", createResponseRouter());
  app.use("/api/v1", createReviewRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * 探测 createApp() 是否已经能承载本模块的接口。
 *
 * 判据：用空请求体 POST /api/v1/dispatch-tasks。
 *   - 422 → 路由已挂载 **且** 统一错误处理（OperationError → 状态码）已生效；
 *   - 404 → 路由未挂载；其他 → 装配方式与预期不符。
 * 空请求体不会写任何数据，因此这个探测是只读的。
 */
async function isCreateAppUsable(): Promise<boolean> {
  let app: Express;
  try {
    app = createApp();
  } catch {
    return false;
  }

  let probe: TestHttpClient;
  try {
    probe = await startTestServer(app);
  } catch {
    return false;
  }

  try {
    const res = await apiRequest(probe, "POST", "/api/v1/dispatch-tasks", {
      userId: USERS.dispatcher,
      body: {},
    });
    return res.status === 422;
  } catch {
    return false;
  } finally {
    await probe.close();
  }
}

// ============================================================
// 全局状态
// ============================================================

let client: TestHttpClient | undefined;
/** 记录本次测试实际使用的装配方式（供报告与排障） */
let appSource = "";

function http(): TestHttpClient {
  if (!client) throw new Error("测试服务尚未启动");
  return client;
}

/** 统一请求入口 */
function call(
  method: "GET" | "POST" | "PUT",
  path: string,
  options: { userId?: string; body?: unknown } = {}
): Promise<ApiResult<unknown>> {
  return apiRequest(http(), method, path, {
    ...(options.userId !== undefined ? { userId: options.userId } : {}),
    ...(options.body !== undefined ? { body: options.body } : {}),
  });
}

/** 取失败响应里的 error（带类型收窄，避免每处都写断言） */
function failureOf(res: ApiResult<unknown>): {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
} {
  const error = res.body.error;
  if (!error) {
    throw new Error(
      `期望失败响应，实际 HTTP ${res.status}：${JSON.stringify(res.body)}`
    );
  }
  return error;
}

/** 清理顺序必须遵守外键：review_records → answers → responses → dispatch_tasks → 实例 */
async function cleanupInstance(instanceId: string): Promise<void> {
  const responses = await prisma.questionnaireResponse.findMany({
    where: { questionnaireInstanceId: instanceId },
    select: { id: true },
  });
  const responseIds = responses.map((r) => r.id);

  if (responseIds.length > 0) {
    await prisma.reviewRecord.deleteMany({
      where: { questionnaireResponseId: { in: responseIds } },
    });
    await prisma.questionnaireAnswer.deleteMany({
      where: { responseId: { in: responseIds } },
    });
    await prisma.questionnaireResponse.deleteMany({
      where: { id: { in: responseIds } },
    });
  }

  await prisma.dispatchTask.deleteMany({
    where: { questionnaireInstanceId: instanceId },
  });

  // 复用既有 helper：删除 ai_tool_executions / questionnaire_revisions / 实例
  await deleteTestInstance(instanceId);
}

const createdInstanceIds = new Set<string>();

async function newTestInstance(status: string): Promise<string> {
  const instance = await createTestInstance({ status });
  createdInstanceIds.add(instance.id);
  return instance.id;
}

// ============================================================
// 业务流程辅助
// ============================================================

interface QuestionLike {
  id: string;
  type: string;
  required: boolean;
}

interface QuestionnaireLike {
  id: string;
  title: string;
  sections: { id: string; title: string; questions: QuestionLike[] }[];
}

interface Flow {
  instanceId: string;
  dispatchTaskId: string;
  responseId: string;
  questionnaire: QuestionnaireLike;
  allQuestionIds: string[];
  requiredQuestionIds: string[];
  firstQuestionId: string;
  /** 执行下发的响应体 */
  dispatchData: Record<string, unknown>;
  /** 获取待填写问卷的响应体 */
  fillData: Record<string, unknown>;
}

function flatQuestions(questionnaire: QuestionnaireLike): QuestionLike[] {
  return questionnaire.sections.flatMap((s) => s.questions);
}

/** 按题型造一个合理的答案（JSONB：不同题型结构不同） */
function sampleAnswer(question: QuestionLike): unknown {
  switch (question.type) {
    case "number":
      return 1;
    case "boolean":
      return true;
    case "date":
      return "2026-01-01";
    case "datetime":
      return "2026-01-01T10:00:00Z";
    case "multiple_choice":
      return ["选项A", "选项B"];
    case "single_choice":
      return "选项A";
    default:
      return `答案-${question.id}`;
  }
}

/**
 * 走完「创建实例（confirmed）→ 创建下发任务 → 执行下发 → 获取待填写问卷」。
 */
async function startFlow(): Promise<Flow> {
  const instanceId = await newTestInstance("confirmed");

  const created = await call("POST", "/api/v1/dispatch-tasks", {
    userId: USERS.dispatcher,
    body: {
      questionnaireInstanceId: instanceId,
      assignedTo: USERS.investigator,
      dueAt: "2026-10-02T18:00:00Z",
    },
  });
  expect(created.status).toBe(201);
  const dispatchTaskId = (expectData(created) as { id: string }).id;

  const dispatched = await call(
    "POST",
    `/api/v1/dispatch-tasks/${dispatchTaskId}/dispatch`,
    { userId: USERS.dispatcher }
  );
  expect(dispatched.status).toBe(200);

  const fill = await call(
    "GET",
    `/api/v1/questionnaire-instances/${instanceId}/response`,
    { userId: USERS.investigator }
  );
  expect(fill.status).toBe(200);

  const fillData = expectData(fill) as {
    responseId: string;
    questionnaire: QuestionnaireLike;
  };
  const questionnaire = fillData.questionnaire;
  const all = flatQuestions(questionnaire);

  return {
    instanceId,
    dispatchTaskId,
    responseId: fillData.responseId,
    questionnaire,
    allQuestionIds: all.map((q) => q.id),
    requiredQuestionIds: all.filter((q) => q.required).map((q) => q.id),
    firstQuestionId: all[0]?.id ?? "",
    dispatchData: expectData(dispatched) as Record<string, unknown>,
    fillData: fillData as unknown as Record<string, unknown>,
  };
}

/** 保存全部必填项 */
async function saveAllRequired(flow: Flow): Promise<ApiResult<unknown>> {
  const answers = flatQuestions(flow.questionnaire)
    .filter((q) => q.required)
    .map((q) => ({ questionId: q.id, answer: sampleAnswer(q) }));

  return call(
    "PUT",
    `/api/v1/questionnaire-responses/${flow.responseId}/answers`,
    { userId: USERS.investigator, body: { answers } }
  );
}

/** 补齐必填项并提交 */
async function submitFlow(flow: Flow): Promise<ApiResult<unknown>> {
  const saved = await saveAllRequired(flow);
  expect(saved.status).toBe(200);

  return call(
    "POST",
    `/api/v1/questionnaire-responses/${flow.responseId}/submit`,
    { userId: USERS.investigator }
  );
}

// ============================================================
// 生命周期
// ============================================================

beforeAll(async () => {
  if (await isCreateAppUsable()) {
    appSource = "createApp()";
    client = await startTestServer();
  } else {
    appSource = "手工装配（express + json/requestId/devAuth + 本模块 router + errorHandler）";
    client = await startTestServer(buildFallbackApp());
  }
  // eslint-disable-next-line no-console
  console.log(`[dispatch-response-review] 测试用 app 来源：${appSource}`);
}, 60_000);

afterAll(async () => {
  for (const instanceId of createdInstanceIds) {
    await cleanupInstance(instanceId);
  }
  createdInstanceIds.clear();

  if (client) {
    await client.close();
    client = undefined;
  }
});

// ============================================================
// 14. 下发 API
// ============================================================

describe("下发 API（05 文档第 14 节）", () => {
  it("创建下发任务：confirmed 实例 → 201，任务为 pending", async () => {
    const instanceId = await newTestInstance("confirmed");

    const res = await call("POST", "/api/v1/dispatch-tasks", {
      userId: USERS.dispatcher,
      body: {
        questionnaireInstanceId: instanceId,
        assignedTo: USERS.investigator,
        dueAt: "2026-10-02T18:00:00Z",
      },
    });

    expect(res.status).toBe(201);
    const data = expectData(res) as Record<string, unknown>;
    expect(data["status"]).toBe("pending");
    expect(data["questionnaireInstanceId"]).toBe(instanceId);
    expect(data["assignedTo"]).toBe(USERS.investigator);
    expect(data["dispatchedBy"]).toBe(USERS.dispatcher);
    expect(data["dispatchedAt"]).toBeNull();
    expect(new Date(data["dueAt"] as string).toISOString()).toBe(
      "2026-10-02T18:00:00.000Z"
    );

    // 创建任务不等于下发：实例状态保持 confirmed（05 文档第 14.1 节）
    const state = await readInstanceState(instanceId);
    expect(state?.status).toBe("confirmed");

    // 审计留痕（决策 D9：一次业务动作一个 operation_id）
    const audits = await prisma.aiToolExecution.findMany({
      where: { questionnaireInstanceId: instanceId },
    });
    expect(
      audits.some((a) => a.toolName === "create_dispatch_task")
    ).toBe(true);
  });

  it("创建下发任务：draft 实例 → 409 INVALID_STATUS_TRANSITION", async () => {
    const instanceId = await newTestInstance("draft");

    const res = await call("POST", "/api/v1/dispatch-tasks", {
      userId: USERS.dispatcher,
      body: {
        questionnaireInstanceId: instanceId,
        assignedTo: USERS.investigator,
      },
    });

    expect(res.status).toBe(409);
    expect(failureOf(res).code).toBe("INVALID_STATUS_TRANSITION");

    // 失败不应留下脏数据
    expect(
      await prisma.dispatchTask.count({
        where: { questionnaireInstanceId: instanceId },
      })
    ).toBe(0);
  });

  it("执行下发：任务 → dispatched，实例 → dispatched，并记录 dispatched_at", async () => {
    const flow = await startFlow();

    expect(flow.dispatchData["status"]).toBe("dispatched");
    expect(flow.dispatchData["instanceStatus"]).toBe("dispatched");
    expect(flow.dispatchData["dispatchedAt"]).toBeTruthy();

    const task = await prisma.dispatchTask.findUnique({
      where: { id: flow.dispatchTaskId },
    });
    expect(task?.status).toBe("dispatched");
    expect(task?.dispatchedAt).toBeInstanceOf(Date);

    const state = await readInstanceState(flow.instanceId);
    expect(state?.status).toBe("dispatched");

    const audits = await prisma.aiToolExecution.findMany({
      where: { questionnaireInstanceId: flow.instanceId },
    });
    expect(audits.some((a) => a.toolName === "dispatch_task")).toBe(true);
  });

  it("执行下发：任务不是 pending → 409", async () => {
    const flow = await startFlow();

    const again = await call(
      "POST",
      `/api/v1/dispatch-tasks/${flow.dispatchTaskId}/dispatch`,
      { userId: USERS.dispatcher }
    );

    expect(again.status).toBe(409);
    expect(failureOf(again).code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("查询下发任务：支持 status / assignedTo 筛选与分页", async () => {
    const flow = await startFlow();

    const res = await call(
      "GET",
      `/api/v1/dispatch-tasks?status=dispatched&assignedTo=${USERS.investigator}&page=1&pageSize=5`,
      { userId: USERS.dispatcher }
    );

    expect(res.status).toBe(200);
    const data = expectData(res) as {
      items: { id: string; status: string; assignedTo: string }[];
      page: number;
      pageSize: number;
      total: number;
    };

    expect(data.page).toBe(1);
    expect(data.pageSize).toBe(5);
    expect(data.total).toBeGreaterThanOrEqual(1);
    expect(data.items.some((i) => i.id === flow.dispatchTaskId)).toBe(true);
    expect(data.items.every((i) => i.status === "dispatched")).toBe(true);
    expect(data.items.every((i) => i.assignedTo === USERS.investigator)).toBe(
      true
    );
  });

  it("权限：investigator 创建下发任务 → 403（决策 D8）", async () => {
    const instanceId = await newTestInstance("confirmed");

    const res = await call("POST", "/api/v1/dispatch-tasks", {
      userId: USERS.investigator,
      body: {
        questionnaireInstanceId: instanceId,
        assignedTo: USERS.investigator,
      },
    });

    expect(res.status).toBe(403);
    expect(failureOf(res).code).toBe("PERMISSION_DENIED");
    expect(
      await prisma.dispatchTask.count({
        where: { questionnaireInstanceId: instanceId },
      })
    ).toBe(0);
  });
});

// ============================================================
// 15. 填写 API
// ============================================================

describe("填写 API（05 文档第 15 节）", () => {
  it("获取待填写问卷：不存在则创建 response，重复获取复用同一条", async () => {
    const flow = await startFlow();

    expect(flow.responseId).toBeTruthy();
    expect(flow.fillData["status"]).toBe("draft");
    expect(flow.fillData["answers"]).toEqual([]);
    expect(flow.fillData["instanceStatus"]).toBe("dispatched");
    expect(flow.questionnaire.sections.length).toBeGreaterThan(0);

    const second = await call(
      "GET",
      `/api/v1/questionnaire-instances/${flow.instanceId}/response`,
      { userId: USERS.investigator }
    );
    expect(second.status).toBe(200);
    expect((expectData(second) as { responseId: string }).responseId).toBe(
      flow.responseId
    );

    expect(
      await prisma.questionnaireResponse.count({
        where: { questionnaireInstanceId: flow.instanceId },
      })
    ).toBe(1);
  });

  it("获取待填写问卷：已指派但实例未下发 → 409", async () => {
    const instanceId = await newTestInstance("confirmed");

    // 新规则要求「必须被指派」才能填写（横向授权），
    // 因此这里先建一条指派给 investigator1 的下发任务但不执行下发，
    // 这样才能验证到「实例未下发 → 409」这一层。
    const created = await call("POST", "/api/v1/dispatch-tasks", {
      userId: USERS.dispatcher,
      body: {
        questionnaireInstanceId: instanceId,
        assignedTo: USERS.investigator,
      },
    });
    expect(created.status).toBe(201);

    const res = await call(
      "GET",
      `/api/v1/questionnaire-instances/${instanceId}/response`,
      { userId: USERS.investigator }
    );

    expect(res.status).toBe(409);
    expect(failureOf(res).code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("获取待填写问卷：未指派给该调查员 → 403（横向授权）", async () => {
    const instanceId = await newTestInstance("confirmed");

    // 故意不建任何下发任务
    const res = await call(
      "GET",
      `/api/v1/questionnaire-instances/${instanceId}/response`,
      { userId: USERS.investigator }
    );

    expect(res.status).toBe(403);
    expect(failureOf(res).code).toBe("PERMISSION_DENIED");
  });

  it("保存单题答案：写入 answer 与正确的 revision_no", async () => {
    const flow = await startFlow();
    const before = await readInstanceState(flow.instanceId);

    const res = await call(
      "PUT",
      `/api/v1/questionnaire-responses/${flow.responseId}/answers/${flow.firstQuestionId}`,
      { userId: USERS.investigator, body: { answer: "张三" } }
    );

    expect(res.status).toBe(200);
    const data = expectData(res) as { revisionNo: number };
    expect(data.revisionNo).toBe(before?.currentRevision);

    const row = await prisma.questionnaireAnswer.findUnique({
      where: {
        responseId_questionId: {
          responseId: flow.responseId,
          questionId: flow.firstQuestionId,
        },
      },
    });
    expect(row?.answer).toBe("张三");
    // 04 文档第 27.3 节：答案必须绑定填写时的实例修订号
    expect(row?.revisionNo).toBe(before?.currentRevision);

    expect(
      await prisma.questionnaireAnswer.count({
        where: { responseId: flow.responseId },
      })
    ).toBe(1);
  });

  it("批量保存答案：重复保存同一题是更新而不是新增", async () => {
    const flow = await startFlow();
    const first = flow.firstQuestionId;
    const second = flow.allQuestionIds[1] ?? "";

    const batch = await call(
      "PUT",
      `/api/v1/questionnaire-responses/${flow.responseId}/answers`,
      {
        userId: USERS.investigator,
        body: {
          answers: [
            { questionId: first, answer: "第一版" },
            { questionId: second, answer: [1, 2, 3] },
          ],
        },
      }
    );
    expect(batch.status).toBe(200);
    expect((expectData(batch) as { savedCount: number }).savedCount).toBe(2);
    expect(
      await prisma.questionnaireAnswer.count({
        where: { responseId: flow.responseId },
      })
    ).toBe(2);

    // 同一题再存一次：(response_id, question_id) 唯一约束下必须是 upsert
    const again = await call(
      "PUT",
      `/api/v1/questionnaire-responses/${flow.responseId}/answers`,
      {
        userId: USERS.investigator,
        body: { answers: [{ questionId: first, answer: "第二版" }] },
      }
    );
    expect(again.status).toBe(200);
    expect(
      await prisma.questionnaireAnswer.count({
        where: { responseId: flow.responseId },
      })
    ).toBe(2);

    const row = await prisma.questionnaireAnswer.findUnique({
      where: {
        responseId_questionId: {
          responseId: flow.responseId,
          questionId: first,
        },
      },
    });
    expect(row?.answer).toBe("第二版");
  });

  it("批量保存答案：同一批里重复提交同一个问题 → 422", async () => {
    const flow = await startFlow();

    const res = await call(
      "PUT",
      `/api/v1/questionnaire-responses/${flow.responseId}/answers`,
      {
        userId: USERS.investigator,
        body: {
          answers: [
            { questionId: flow.firstQuestionId, answer: "A" },
            { questionId: flow.firstQuestionId, answer: "B" },
          ],
        },
      }
    );

    expect(res.status).toBe(422);
    expect(failureOf(res).code).toBe("VALIDATION_ERROR");
  });

  it("保存答案：question_id 不在 current_schema 中 → 4xx", async () => {
    const flow = await startFlow();

    const res = await call(
      "PUT",
      `/api/v1/questionnaire-responses/${flow.responseId}/answers/q_not_in_schema`,
      { userId: USERS.investigator, body: { answer: "x" } }
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const error = failureOf(res);
    expect(error.code).toBe("QUESTION_NOT_FOUND");
    expect(error.detail?.["questionIds"]).toEqual(["q_not_in_schema"]);
    expect(
      await prisma.questionnaireAnswer.count({
        where: { responseId: flow.responseId },
      })
    ).toBe(0);
  });

  it("保存答案：已提交的 response 不能改 → 409", async () => {
    const flow = await startFlow();
    const submitted = await submitFlow(flow);
    expect(submitted.status).toBe(200);

    const res = await call(
      "PUT",
      `/api/v1/questionnaire-responses/${flow.responseId}/answers/${flow.firstQuestionId}`,
      { userId: USERS.investigator, body: { answer: "提交后再改" } }
    );

    expect(res.status).toBe(409);
    expect(failureOf(res).code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("提交：缺必填 → 422，且 detail 列出缺失的 question id", async () => {
    const flow = await startFlow();
    expect(flow.requiredQuestionIds.length).toBeGreaterThan(0);

    // 只填第一题，必然缺其它必填
    const partial = await call(
      "PUT",
      `/api/v1/questionnaire-responses/${flow.responseId}/answers/${flow.firstQuestionId}`,
      { userId: USERS.investigator, body: { answer: "只填了这一题" } }
    );
    expect(partial.status).toBe(200);

    const res = await call(
      "POST",
      `/api/v1/questionnaire-responses/${flow.responseId}/submit`,
      { userId: USERS.investigator }
    );

    expect(res.status).toBe(422);
    const error = failureOf(res);
    expect(error.code).toBe("VALIDATION_ERROR");

    const missing = (error.detail?.["missingQuestionIds"] ?? []) as string[];
    const expected = flow.requiredQuestionIds
      .filter((id) => id !== flow.firstQuestionId)
      .sort();
    expect([...missing].sort()).toEqual(expected);

    // 未通过校验不应改变任何状态
    const state = await readInstanceState(flow.instanceId);
    expect(state?.status).toBe("dispatched");
    const response = await prisma.questionnaireResponse.findUnique({
      where: { id: flow.responseId },
    });
    expect(response?.status).toBe("draft");
    expect(response?.submittedAt).toBeNull();
  });

  it("提交：补齐必填后成功，instance → submitted 且写入 submitted_at", async () => {
    const flow = await startFlow();

    const res = await submitFlow(flow);

    expect(res.status).toBe(200);
    const data = expectData(res) as Record<string, unknown>;
    expect(data["status"]).toBe("submitted");
    expect(data["submittedAt"]).toBeTruthy();
    expect(data["instanceStatus"]).toBe("submitted");

    const state = await readInstanceState(flow.instanceId);
    expect(state?.status).toBe("submitted");

    const response = await prisma.questionnaireResponse.findUnique({
      where: { id: flow.responseId },
    });
    expect(response?.status).toBe("submitted");
    expect(response?.submittedAt).toBeInstanceOf(Date);

    // 不能重复提交
    const again = await call(
      "POST",
      `/api/v1/questionnaire-responses/${flow.responseId}/submit`,
      { userId: USERS.investigator }
    );
    expect(again.status).toBe(409);
    expect(failureOf(again).code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("权限：reviewer 保存答案 → 403（只有 investigator 能填，决策 D8）", async () => {
    const flow = await startFlow();

    const res = await call(
      "PUT",
      `/api/v1/questionnaire-responses/${flow.responseId}/answers/${flow.firstQuestionId}`,
      { userId: USERS.reviewer, body: { answer: "审核人越权填写" } }
    );

    expect(res.status).toBe(403);
    expect(failureOf(res).code).toBe("PERMISSION_DENIED");
  });

  it("填写：response 不存在 → 404", async () => {
    const res = await call(
      "PUT",
      `/api/v1/questionnaire-responses/${newId()}/answers`,
      { userId: USERS.investigator, body: { answers: [{ questionId: "q", answer: "x" }] } }
    );

    expect(res.status).toBe(404);
    expect(failureOf(res).code).toBe("RESPONSE_NOT_FOUND");
  });
});

// ============================================================
// 16. 审核 API
// ============================================================

describe("审核 API（05 文档第 16 节）", () => {
  it("待审核列表：分页返回已提交的 response", async () => {
    const flow = await startFlow();
    const submitted = await submitFlow(flow);
    expect(submitted.status).toBe(200);

    const res = await call(
      "GET",
      "/api/v1/questionnaire-responses/review/pending?page=1&pageSize=10",
      { userId: USERS.reviewer }
    );

    expect(res.status).toBe(200);
    const data = expectData(res) as {
      items: {
        responseId: string;
        instanceTitle: string;
        status: string;
        submittedAt: string | null;
      }[];
      page: number;
      pageSize: number;
      total: number;
    };

    expect(data.page).toBe(1);
    expect(data.pageSize).toBe(10);
    expect(data.total).toBeGreaterThanOrEqual(1);
    expect(data.items.every((i) => i.status === "submitted")).toBe(true);

    const mine = data.items.find((i) => i.responseId === flow.responseId);
    expect(mine).toBeDefined();
    expect(mine?.instanceTitle).toBeTruthy();
    expect(mine?.submittedAt).toBeTruthy();
  });

  it("审核详情：返回问卷结构、答案与审核记录", async () => {
    const flow = await startFlow();
    await submitFlow(flow);

    const before = await call(
      "GET",
      `/api/v1/questionnaire-responses/${flow.responseId}/review`,
      { userId: USERS.reviewer }
    );

    expect(before.status).toBe(200);
    const beforeData = expectData(before) as {
      responseId: string;
      status: string;
      answers: { questionId: string; revisionNo: number }[];
      reviews: unknown[];
      questionnaire: QuestionnaireLike;
    };
    expect(beforeData.responseId).toBe(flow.responseId);
    expect(beforeData.status).toBe("submitted");
    expect(beforeData.answers).toHaveLength(flow.requiredQuestionIds.length);
    expect(beforeData.reviews).toEqual([]);
    expect(beforeData.questionnaire.sections.length).toBeGreaterThan(0);

    // 审核一次后再看，历史记录应在
    const reviewed = await call(
      "POST",
      `/api/v1/questionnaire-responses/${flow.responseId}/review`,
      { userId: USERS.reviewer, body: { result: "approved", comment: "信息完整" } }
    );
    expect(reviewed.status).toBe(200);

    const after = await call(
      "GET",
      `/api/v1/questionnaire-responses/${flow.responseId}/review`,
      { userId: USERS.reviewer }
    );
    const afterData = expectData(after) as {
      reviews: { result: string; comment: string | null }[];
    };
    expect(afterData.reviews).toHaveLength(1);
    expect(afterData.reviews[0]?.result).toBe("approved");
    expect(afterData.reviews[0]?.comment).toBe("信息完整");
  });

  it("审核通过：写 review_records，实例 → completed", async () => {
    const flow = await startFlow();
    await submitFlow(flow);

    const res = await call(
      "POST",
      `/api/v1/questionnaire-responses/${flow.responseId}/review`,
      {
        userId: USERS.reviewer,
        body: { result: "approved", comment: "调查信息完整" },
      }
    );

    expect(res.status).toBe(200);
    const data = expectData(res) as Record<string, unknown>;
    expect(data["result"]).toBe("approved");
    // 审核通过后答卷置为 reviewed（不再是 submitted）——
    // 否则它会永远留在「待审核列表」里，审核人无法分辨真正待审项。
    expect(data["responseStatus"]).toBe("reviewed");
    expect(data["instanceStatus"]).toBe("completed");

    const state = await readInstanceState(flow.instanceId);
    expect(state?.status).toBe("completed");

    const records = await prisma.reviewRecord.findMany({
      where: { questionnaireResponseId: flow.responseId },
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.reviewerId).toBe(USERS.reviewer);
    expect(records[0]?.result).toBe("approved");
    expect(records[0]?.comment).toBe("调查信息完整");

    const audits = await prisma.aiToolExecution.findMany({
      where: { questionnaireInstanceId: flow.instanceId },
    });
    expect(audits.some((a) => a.toolName === "review_response")).toBe(true);
  });

  it("已通过的提交不再出现在待审核列表（回归：曾永远停留）", async () => {
    const flow = await startFlow();
    await submitFlow(flow);

    const before = await call(
      "GET",
      "/api/v1/questionnaire-responses/review/pending?page=1&pageSize=100",
      { userId: USERS.reviewer }
    );
    expect(before.status).toBe(200);
    const beforeIds = (
      expectData(before) as { items: { responseId: string }[] }
    ).items.map((i) => i.responseId);
    expect(beforeIds).toContain(flow.responseId);

    await call(
      "POST",
      `/api/v1/questionnaire-responses/${flow.responseId}/review`,
      { userId: USERS.reviewer, body: { result: "approved" } }
    );

    const after = await call(
      "GET",
      "/api/v1/questionnaire-responses/review/pending?page=1&pageSize=100",
      { userId: USERS.reviewer }
    );
    const afterIds = (
      expectData(after) as { items: { responseId: string }[] }
    ).items.map((i) => i.responseId);
    expect(afterIds).not.toContain(flow.responseId);
  });

  it("同一提交不能被重复审核（回归：曾可先 approved 再 rejected）", async () => {
    const flow = await startFlow();
    await submitFlow(flow);

    const first = await call(
      "POST",
      `/api/v1/questionnaire-responses/${flow.responseId}/review`,
      { userId: USERS.reviewer, body: { result: "approved" } }
    );
    expect(first.status).toBe(200);

    // 第二次审核必须被拒，且不能把终态 completed 打回 returned
    const second = await call(
      "POST",
      `/api/v1/questionnaire-responses/${flow.responseId}/review`,
      { userId: USERS.reviewer, body: { result: "rejected" } }
    );
    expect(second.status).toBe(409);
    expect(failureOf(second).code).toBe("INVALID_STATUS_TRANSITION");

    const state = await readInstanceState(flow.instanceId);
    expect(state?.status).toBe("completed");

    // 审核记录只能有一条（不能出现 approved + rejected 互相矛盾）
    const records = await prisma.reviewRecord.findMany({
      where: { questionnaireResponseId: flow.responseId },
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.result).toBe("approved");
  });

  it("审核退回：response 回到 draft，实例 → returned，且允许重新填写", async () => {
    const flow = await startFlow();
    await submitFlow(flow);

    const res = await call(
      "POST",
      `/api/v1/questionnaire-responses/${flow.responseId}/review`,
      {
        userId: USERS.reviewer,
        body: { result: "rejected", comment: "缺少飞行地点调查结果" },
      }
    );

    expect(res.status).toBe(200);
    const data = expectData(res) as Record<string, unknown>;
    expect(data["result"]).toBe("rejected");
    expect(data["responseStatus"]).toBe("draft");
    expect(data["instanceStatus"]).toBe("returned");

    const state = await readInstanceState(flow.instanceId);
    expect(state?.status).toBe("returned");

    const response = await prisma.questionnaireResponse.findUnique({
      where: { id: flow.responseId },
    });
    expect(response?.status).toBe("draft");
    expect(response?.submittedAt).toBeNull();

    expect(
      await prisma.reviewRecord.count({
        where: { questionnaireResponseId: flow.responseId },
      })
    ).toBe(1);

    // 退回的意义就是能继续补填
    const save = await call(
      "PUT",
      `/api/v1/questionnaire-responses/${flow.responseId}/answers/${flow.firstQuestionId}`,
      { userId: USERS.investigator, body: { answer: "按审核意见补充" } }
    );
    expect(save.status).toBe(200);

    // 再次提交后还能再审
    const resubmit = await call(
      "POST",
      `/api/v1/questionnaire-responses/${flow.responseId}/submit`,
      { userId: USERS.investigator }
    );
    expect(resubmit.status).toBe(200);
  });

  it("审核：response 不存在 → 404", async () => {
    const res = await call(
      "POST",
      `/api/v1/questionnaire-responses/${newId()}/review`,
      { userId: USERS.reviewer, body: { result: "approved" } }
    );

    expect(res.status).toBe(404);
    expect(failureOf(res).code).toBe("RESPONSE_NOT_FOUND");
  });

  it("审核：response 未提交（draft）→ 4xx", async () => {
    const flow = await startFlow();

    const res = await call(
      "POST",
      `/api/v1/questionnaire-responses/${flow.responseId}/review`,
      { userId: USERS.reviewer, body: { result: "approved" } }
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(failureOf(res).code).toBe("INVALID_STATUS_TRANSITION");
    expect(
      await prisma.reviewRecord.count({
        where: { questionnaireResponseId: flow.responseId },
      })
    ).toBe(0);
  });

  it("审核：result 只允许 approved / rejected → 其它值 422", async () => {
    const flow = await startFlow();
    await submitFlow(flow);

    const res = await call(
      "POST",
      `/api/v1/questionnaire-responses/${flow.responseId}/review`,
      { userId: USERS.reviewer, body: { result: "maybe" } }
    );

    expect(res.status).toBe(422);
    expect(failureOf(res).code).toBe("VALIDATION_ERROR");
  });

  it("权限：investigator 审核 / 查看待审核列表 → 403（决策 D8）", async () => {
    const flow = await startFlow();
    await submitFlow(flow);

    const review = await call(
      "POST",
      `/api/v1/questionnaire-responses/${flow.responseId}/review`,
      { userId: USERS.investigator, body: { result: "approved" } }
    );
    expect(review.status).toBe(403);
    expect(failureOf(review).code).toBe("PERMISSION_DENIED");

    const list = await call(
      "GET",
      "/api/v1/questionnaire-responses/review/pending",
      { userId: USERS.investigator }
    );
    expect(list.status).toBe(403);
    expect(failureOf(list).code).toBe("PERMISSION_DENIED");

    expect(
      await prisma.reviewRecord.count({
        where: { questionnaireResponseId: flow.responseId },
      })
    ).toBe(0);
  });
});
