/**
 * 审计脚手架（只读审计：不修改 src/ 下任何文件）。
 *
 * 复用 tests/ 下现成的辅助：
 *   - tests/integration/api/helpers.ts        → startTestServer / apiRequest
 *   - tests/integration/questionnaire/helpers.ts → USERS / createTestInstance
 *
 * 所有脚本创建的数据都登记到 tmp-audit-j1/state.json，
 * 结束后由 cleanupAll() 按外键顺序删除（另有 cleanup.ts 可单独兜底）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { prisma } from "../src/database/client.js";
import { newId } from "../src/shared/utils/id.js";
import { createApp } from "../src/app/app.js";
import {
  apiRequest,
  startTestServer,
  type ApiResult,
  type TestHttpClient,
} from "../tests/integration/api/helpers.js";
import {
  USERS,
  createTestInstance,
} from "../tests/integration/questionnaire/helpers.js";

export { prisma, USERS, createTestInstance };
export type { ApiResult, TestHttpClient };

const STATE_FILE = "tmp-audit-j1/state.json";

interface AuditState {
  instances: string[];
  users: string[];
}

function loadState(): AuditState {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as AuditState;
  }
  return { instances: [], users: [] };
}

let state: AuditState = loadState();

function saveState(): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

export function trackInstance(id: string): void {
  if (!state.instances.includes(id)) {
    state.instances.push(id);
    saveState();
  }
}

export function trackUser(id: string): void {
  if (!state.users.includes(id)) {
    state.users.push(id);
    saveState();
  }
}

/** 创建临时用户（仅用于审计越权/多主体场景；结束时删除） */
export async function createTempUser(
  username: string,
  roles: string[]
): Promise<string> {
  const id = newId();
  await prisma.user.create({
    data: {
      id,
      username,
      displayName: `审计临时用户 ${username}`,
      passwordHash: null,
      status: "active",
      roles,
    },
  });
  trackUser(id);
  return id;
}

export async function startServer(): Promise<TestHttpClient> {
  return startTestServer(createApp());
}

export async function call(
  client: TestHttpClient,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  options: { userId?: string; body?: unknown } = {}
): Promise<ApiResult<unknown>> {
  return apiRequest(client, method, path, options);
}

export function fail(res: ApiResult<unknown>): string {
  return `${res.status} ${res.body.error?.code ?? ""} ${res.body.error?.message ?? ""}`;
}

export interface Flow {
  instanceId: string;
  taskId: string;
}

/** confirmed 实例 → 创建下发任务 → 执行下发（返回 instanceId / taskId） */
export async function setupDispatched(
  client: TestHttpClient,
  options: { assignedTo?: string } = {}
): Promise<Flow> {
  const instance = await createTestInstance({ status: "confirmed" });
  trackInstance(instance.id);

  const created = await call(client, "POST", "/api/v1/dispatch-tasks", {
    userId: USERS.dispatcher,
    body: {
      questionnaireInstanceId: instance.id,
      assignedTo: options.assignedTo ?? USERS.investigator,
    },
  });
  if (created.status !== 201) {
    throw new Error(`创建下发任务失败：${fail(created)}`);
  }
  const taskId = (created.body.data as { id: string }).id;

  const dispatched = await call(
    client,
    "POST",
    `/api/v1/dispatch-tasks/${taskId}/dispatch`,
    { userId: USERS.dispatcher }
  );
  if (dispatched.status !== 200) {
    throw new Error(`执行下发失败：${fail(dispatched)}`);
  }

  return { instanceId: instance.id, taskId };
}

export interface QuestionnaireLike {
  iid?: string;
  sections: {
    id: string;
    questions: { id: string; type: string; required: boolean }[];
  }[];
}

export function flatQuestions(q: QuestionnaireLike) {
  return q.sections.flatMap((s) => s.questions);
}

/** GET /questionnaire-instances/:id/response */
export async function getResponse(
  client: TestHttpClient,
  instanceId: string,
  userId: string
): Promise<{
  res: ApiResult<unknown>;
  responseId?: string;
  status?: string;
  questionnaire?: QuestionnaireLike;
}> {
  const res = await call(
    client,
    "GET",
    `/api/v1/questionnaire-instances/${instanceId}/response`,
    { userId }
  );
  if (res.status !== 200) return { res };
  const data = res.body.data as {
    responseId: string;
    status: string;
    questionnaire: QuestionnaireLike;
  };
  return {
    res,
    responseId: data.responseId,
    status: data.status,
    questionnaire: data.questionnaire,
  };
}

export function sampleAnswer(question: { id: string; type: string }): unknown {
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
      return ["选项A"];
    case "single_choice":
      return "选项A";
    default:
      return `答案-${question.id}`;
  }
}

/** 保存全部必填项（可对指定题目覆盖答案） */
export async function saveRequired(
  client: TestHttpClient,
  responseId: string,
  questionnaire: QuestionnaireLike,
  userId: string,
  override: Record<string, unknown> = {}
): Promise<ApiResult<unknown>> {
  const answers = flatQuestions(questionnaire)
    .filter((q) => q.required)
    .map((q) => ({
      questionId: q.id,
      answer: q.id in override ? override[q.id] : sampleAnswer(q),
    }));

  return call(client, "PUT", `/api/v1/questionnaire-responses/${responseId}/answers`, {
    userId,
    body: { answers },
  });
}

export async function submit(
  client: TestHttpClient,
  responseId: string,
  userId: string
): Promise<ApiResult<unknown>> {
  return call(
    client,
    "POST",
    `/api/v1/questionnaire-responses/${responseId}/submit`,
    { userId }
  );
}

export async function review(
  client: TestHttpClient,
  responseId: string,
  userId: string,
  result: "approved" | "rejected",
  comment?: string
): Promise<ApiResult<unknown>> {
  return call(
    client,
    "POST",
    `/api/v1/questionnaire-responses/${responseId}/review`,
    { userId, body: comment === undefined ? { result } : { result, comment } }
  );
}

export async function instanceState(instanceId: string) {
  return prisma.questionnaireInstance.findUnique({
    where: { id: instanceId },
    select: { id: true, status: true, currentRevision: true },
  });
}

export async function responseState(responseId: string) {
  return prisma.questionnaireResponse.findUnique({
    where: { id: responseId },
    select: {
      id: true,
      status: true,
      submittedAt: true,
      respondentId: true,
      questionnaireInstanceId: true,
    },
  });
}

/** 瞬时数据库错误重试（本机 prisma dev 连接池偶发 ConnectionClosed / 08P01） */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label = "db",
  times = 5
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < times; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  console.error(`[${label}] 重试 ${times} 次仍失败：`, lastErr);
  throw lastErr;
}

/** 按外键顺序清理一个实例的全部关联数据 */
export async function cleanupInstance(instanceId: string): Promise<void> {
  const responses = await withRetry(
    () =>
      prisma.questionnaireResponse.findMany({
        where: { questionnaireInstanceId: instanceId },
        select: { id: true },
      }),
    "find responses"
  );
  const responseIds = responses.map((r) => r.id);

  if (responseIds.length > 0) {
    await withRetry(
      () =>
        prisma.reviewRecord.deleteMany({
          where: { questionnaireResponseId: { in: responseIds } },
        }),
      "delete reviews"
    );
    await withRetry(
      () =>
        prisma.questionnaireAnswer.deleteMany({
          where: { responseId: { in: responseIds } },
        }),
      "delete answers"
    );
    await withRetry(
      () =>
        prisma.questionnaireResponse.deleteMany({
          where: { id: { in: responseIds } },
        }),
      "delete responses"
    );
  }

  await withRetry(
    () =>
      prisma.dispatchTask.deleteMany({
        where: { questionnaireInstanceId: instanceId },
      }),
    "delete dispatch tasks"
  );
  await withRetry(
    () =>
      prisma.aiToolExecution.deleteMany({
        where: { questionnaireInstanceId: instanceId },
      }),
    "delete audits"
  );
  await withRetry(
    () =>
      prisma.questionnaireRevision.deleteMany({
        where: { questionnaireInstanceId: instanceId },
      }),
    "delete revisions"
  );
  await withRetry(
    () => prisma.questionnaireInstance.deleteMany({ where: { id: instanceId } }),
    "delete instance"
  );

  state.instances = state.instances.filter((id) => id !== instanceId);
  saveState();
}

export async function cleanupUser(userId: string): Promise<void> {
  await withRetry(
    () => prisma.reviewRecord.deleteMany({ where: { reviewerId: userId } }),
    "del reviews by reviewer"
  );
  const responses = await withRetry(
    () =>
      prisma.questionnaireResponse.findMany({
        where: { respondentId: userId },
        select: { id: true },
      }),
    "find responses by user"
  );
  const ids = responses.map((r) => r.id);
  if (ids.length > 0) {
    await withRetry(
      () =>
        prisma.reviewRecord.deleteMany({
          where: { questionnaireResponseId: { in: ids } },
        }),
      "del reviews"
    );
    await withRetry(
      () => prisma.questionnaireAnswer.deleteMany({ where: { responseId: { in: ids } } }),
      "del answers"
    );
    await withRetry(
      () => prisma.questionnaireResponse.deleteMany({ where: { id: { in: ids } } }),
      "del responses"
    );
  }
  await withRetry(
    () => prisma.dispatchTask.deleteMany({ where: { assignedTo: userId } }),
    "del tasks assignee"
  );
  await withRetry(
    () => prisma.dispatchTask.deleteMany({ where: { dispatchedBy: userId } }),
    "del tasks dispatcher"
  );
  await withRetry(
    () => prisma.dispatchTask.deleteMany({ where: { withdrawnBy: userId } }),
    "del tasks withdrawer"
  );
  await withRetry(() => prisma.user.deleteMany({ where: { id: userId } }), "del user");

  state.users = state.users.filter((id) => id !== userId);
  saveState();
}

/** 清理本次审计登记的全部数据（幂等） */
export async function cleanupAll(): Promise<void> {
  const snapshot = loadState();
  for (const id of [...snapshot.instances]) {
    await cleanupInstance(id);
  }
  for (const id of [...snapshot.users]) {
    await cleanupUser(id);
  }
  state = { instances: [], users: [] };
  saveState();
}

/** 打印一个场景的结论 */
export function verdict(confirmed: boolean, title: string, detail: string): void {
  const tag = confirmed ? "【已确认复现】" : "【未复现】";
  console.log(`\n${tag} ${title}\n  ${detail}`);
}
