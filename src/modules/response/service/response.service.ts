/**
 * Response Service（填写模块）。
 *
 * 依据 docs/05-api_design.md 第 15 节、docs/04-database_design.md 第 26 / 27 / 29 节
 * 与 docs/09-review-and-decisions.md 的决策 D1 / D8：
 *
 *   1. 「获取待填写问卷」时若还没有 response，则创建一条 draft（05 文档第 15.1 节）；
 *   2. 答案写入 questionnaire_answers，**必须带 revision_no**（= 实例当前
 *      current_revision）。这样题目日后被改名/改选项，历史答案仍可解释（04 文档第 27.3 节）；
 *   3. (response_id, question_id) 有唯一约束（04 文档第 27.2 节），所以保存一律 upsert；
 *   4. question_id 必须存在于实例的 current_schema 中 —— 答案与题目之间没有外键，
 *      只能在应用层校验（04 文档第 29 节）；
 *   5. 只有 response.status = draft 才允许改答案；提交时校验全部必填项；
 *   6. 填写/保存/提交需要 investigator 角色（D8）。
 *
 * 说明：本模块没有独立的 repository 文件（任务约束），
 * 因此数据访问直接走 Prisma 客户端。
 */
import { prisma } from "../../../database/client.js";
import { transaction, type Tx } from "../../../database/transaction.js";
import { Prisma } from "../../../../generated/prisma/client.js";
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
  type QuestionType,
} from "../../questionnaire/schema/questionnaire.schema.js";
import type { ServiceContext } from "../../questionnaire/service/questionnaire.service.js";

// ============================================================
// 角色与状态常量
// ============================================================

/** 填写类写操作的角色（决策 D8） */
export const RESPONSE_WRITE_ROLES = ["investigator"] as const;

/**
 * 可以继续填写的答卷状态。
 *
 * - draft：正常填写中
 * 已提交（submitted）与撤回失效（withdrawn）都不在其中：
 *   前者不允许再改；后者属于上一轮下发，二次下发时应新建一条 draft 答卷，
 *   否则调查员会被困在一条不可写的旧答卷上（审计发现的高危缺陷）。
 */
export const RESPONSE_FILLABLE_STATUSES = ["draft"] as const;
/** 填写结果的读操作角色 */
export const RESPONSE_READ_ROLES = [
  "investigator",
  "reviewer",
  "dispatcher",
] as const;

/** questionnaire_responses.status（04 文档第 27.3 节） */
export const RESPONSE_STATUSES = ["draft", "submitted", "withdrawn"] as const;

/**
 * 允许「开始填写」（即创建 response）的实例状态。
 *
 * draft / confirmed 说明还没下发（调查人员拿不到问卷）；
 * completed 说明已经审完，只能查看历史，不能新开一份填写。
 */
export const FILLABLE_INSTANCE_STATUSES = [
  "dispatched",
  "in_progress",
  "returned",
] as const;

// ============================================================
// 类型
// ============================================================

export interface ResponseRecord {
  id: string;
  questionnaireInstanceId: string;
  respondentId: string;
  status: string;
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AnswerRecord {
  questionId: string;
  answer: unknown;
  revisionNo: number;
  updatedAt: Date;
}

export interface AnswerInput {
  questionId: string;
  answer: unknown;
}

export interface SaveAnswersResult {
  response: ResponseRecord;
  instance: { id: string; title: string; currentRevision: number };
  /** 本批答案落库时使用的修订号 */
  revisionNo: number;
  saved: { questionId: string; answer: unknown; revisionNo: number }[];
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
 * JSONB 里的 schema 读出来后必须校验，不能盲目信任数据库内容（04 文档第 44 节）。
 * 与 questionnaire.repository 的处理保持一致：这里是数据损坏，属于系统错误。
 */
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

/**
 * 展平出所有题目。
 *
 * V1 不支持 section 嵌套（03 文档第 5A 节），
 * 但结构里保留了 children，因此这里递归处理，
 * 避免将来打开嵌套时漏掉子分组的题目。
 */
/**
 * 拍平问卷里所有问题。
 *
 * 返回 type 是必需的：保存答案时要按题型校验答案形状
 * （05 文档第 15.4 节）。
 */
function collectQuestions(
  schema: QuestionnaireSchema
): { id: string; required: boolean; title: string; type: QuestionType }[] {
  const out: {
    id: string;
    required: boolean;
    title: string;
    type: QuestionType;
  }[] = [];

  const walk = (
    sections: QuestionnaireSchema["sections"]
  ): void => {
    for (const section of sections) {
      for (const question of section.questions) {
        out.push({
          id: question.id,
          required: question.required,
          title: question.title,
          type: question.type,
        });
      }
      if (section.children && section.children.length > 0) {
        walk(section.children);
      }
    }
  };

  walk(schema.sections);
  return out;
}

/**
 * 题型与答案形状的一致性校验（05 文档第 15.4 节）。
 *
 * 早期实现完全不校验：text 题可以写入对象、boolean 题可以写入字符串，
 * 脏数据进 JSONB 后要到审核或统计阶段才暴露。
 *
 * 注意：这里**不做业务语义校验**（例如选项是否在 options 内），
 * 只做「形状」校验，避免对前端过于苛刻（例如后端改了选项后旧答案仍应可保存）。
 */
function assertAnswerShape(
  question: { id: string; type: QuestionType },
  answer: unknown,
  questionId: string
): void {
  const fail = (expected: string): never => {
    throw validationError(
      `问题 ${questionId} 的题型为 ${question.type}，答案应为 ${expected}`,
      { path: "answer", questionId, questionType: question.type }
    );
  };

  switch (question.type) {
    case "text":
    case "textarea":
      if (typeof answer !== "string") fail("字符串");
      return;

    case "number":
      if (typeof answer !== "number" || Number.isNaN(answer)) fail("数字");
      return;

    case "boolean":
      if (typeof answer !== "boolean") fail("布尔值（true/false）");
      return;

    case "date":
    case "datetime":
      // 用字符串承载（ISO 格式），不在此处严格校验日期格式
      if (typeof answer !== "string") fail("日期字符串");
      return;

    case "single_choice":
      if (typeof answer !== "string") fail("单个选项值（字符串）");
      return;

    case "multiple_choice":
      if (
        !Array.isArray(answer) ||
        answer.some((v) => typeof v !== "string")
      ) {
        fail("选项值数组（字符串数组）");
      }
      return;

    default: {
      // 穷尽性检查：新增题型时这里会编译报错
      const never: never = question.type;
      throw validationError(`未知题型：${String(never)}`, {
        path: "questionType",
        questionId,
      });
    }
  }
}

/** 「没填」的判定。
 *
 * 覆盖：缺行、null、undefined、空串/纯空白串、空数组、
 *       **空对象**、以及**数组里全是空值**（例如 [null]、[""]）。
 *
 * 为什么要把后两种也算作未填：
 *   早期实现只判到空数组，于是 `{}` 与 `[null]` 会被当成「已填」，
 *   必填校验形同虚设，脏数据一路流到审核环节。
 */
function isBlankAnswer(answer: unknown): boolean {
  if (answer === null || answer === undefined) return true;
  if (typeof answer === "string") return answer.trim() === "";

  if (Array.isArray(answer)) {
    if (answer.length === 0) return true;
    // 数组里所有元素都是空值 → 视为未填（例如 [null]、[""]、[[],{}]）
    return answer.every((item) => isBlankAnswer(item));
  }

  if (typeof answer === "object") {
    const values = Object.values(answer as Record<string, unknown>);
    if (values.length === 0) return true;
    return values.every((v) => isBlankAnswer(v));
  }

  return false;
}

/** JSONB 字段赋值：显式区分「JSON null」与「不更新」 */
function answerToJson(answer: unknown) {
  return answer === null ? Prisma.JsonNull : toJsonValue(answer);
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

/**
 * 横向授权：答卷只能由「填写人本人」操作。
 *
 * 为什么需要它（审计发现的重大缺陷）：
 *   早期实现只做纵向校验（角色能不能填写），
 *   于是任何 investigator 只要拿到 responseId
 *   就能改写、提交**别人**的答卷。
 *
 * 依据：决策 D8 + 04 文档第 26 节
 *   （questionnaire_responses.respondent_id 是实际填写人）。
 */
function assertResponseOwnership(
  response: { respondentId: string },
  ctx: ServiceContext
): void {
  // 模板管理员是系统治理角色，允许查看与协助
  if (ctx.roles.includes("template_admin")) return;

  if (response.respondentId !== ctx.userId) {
    throw permissionDenied("该答卷的填写人不是你，无权修改或提交");
  }
}

/** 读取 response + 其所属实例与结构；response 不存在时抛 RESPONSE_NOT_FOUND */
async function loadResponseContext(
  tx: Tx,
  responseId: string,
  ctx: ServiceContext
): Promise<{
  response: ResponseRecord;
  instance: {
    id: string;
    title: string;
    status: string;
    currentRevision: number;
  };
  schema: QuestionnaireSchema;
}> {
  const response = await tx.questionnaireResponse.findUnique({
    where: { id: responseId },
  });
  if (!response) {
    throw new OperationError(
      ErrorCode.RESPONSE_NOT_FOUND,
      `填写结果不存在：${responseId}`
    );
  }

  // 横向授权：只能操作自己的答卷
  assertResponseOwnership(response, ctx);

  const instance = await tx.questionnaireInstance.findUnique({
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

  return {
    response,
    instance: {
      id: instance.id,
      title: instance.title,
      status: instance.status,
      currentRevision: instance.currentRevision,
    },
    schema: parseSchema(instance.currentSchema, `实例 ${instance.id}`),
  };
}

// ============================================================
// 实现（模块级函数，避免依赖 this）
// ============================================================

/**
 * 获取待填写问卷（05 文档第 15.1 节）。
 *
 * 同一实例 + 同一调查人员只保持一条 response：
 * 复核退回后 response 会回到 draft，因此不需要新建第二条。
 */
async function getOrCreateResponse(
  instanceId: string,
  ctx: ServiceContext
): Promise<{
  response: ResponseRecord;
  instance: {
    id: string;
    title: string;
    status: string;
    currentRevision: number;
  };
  schema: QuestionnaireSchema;
  answers: AnswerRecord[];
}> {
  assertRole(ctx, RESPONSE_WRITE_ROLES, "填写问卷");

  return transaction(async (tx: Tx) => {
    const instance = await tx.questionnaireInstance.findUnique({
      where: { id: instanceId },
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
        `问卷实例不存在：${instanceId}`
      );
    }

    const schema = parseSchema(instance.currentSchema, `实例 ${instanceId}`);

    // ---- 横向授权：必须是「指派给自己」或「自己已填写过」的任务 ----
    // 依据决策 D8 与 04 文档第 25 节（dispatch_tasks.assigned_to 决定谁能上门核查）。
    // 早期实现在这里完全缺失校验，任何 investigator 拿到 uuid 就能填写他人任务。
    const assigned = await tx.dispatchTask.findFirst({
      where: { questionnaireInstanceId: instanceId, assignedTo: ctx.userId },
      select: { id: true },
    });
    const alreadyResponded = await tx.questionnaireResponse.findFirst({
      where: { questionnaireInstanceId: instanceId, respondentId: ctx.userId },
      select: { id: true },
    });

    if (!assigned && !alreadyResponded) {
      throw permissionDenied("该问卷任务未指派给你，无法填写");
    }

    let response = await tx.questionnaireResponse.findFirst({
      where: {
        questionnaireInstanceId: instanceId,
        respondentId: ctx.userId,
        // 只复用「还能填」的答卷：已提交的、以及撤回时置为 withdrawn 的，
        // 都不应该被二次下发后的新一轮填写复用
        status: { in: [...RESPONSE_FILLABLE_STATUSES] },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!response) {
      if (
        !(FILLABLE_INSTANCE_STATUSES as readonly string[]).includes(
          instance.status
        )
      ) {
        throw new OperationError(
          ErrorCode.INVALID_STATUS_TRANSITION,
          `实例状态为 ${instance.status}，尚未下发（或已完成），无法填写`,
          {
            path: "status",
            status: instance.status,
            expected: FILLABLE_INSTANCE_STATUSES,
          }
        );
      }

      response = await tx.questionnaireResponse.create({
        data: {
          id: newId(),
          questionnaireInstanceId: instanceId,
          respondentId: ctx.userId,
          status: "draft",
        },
      });

      await writeAudit(tx, {
        ctx,
        toolName: "start_response",
        instanceId,
        args: { questionnaireInstanceId: instanceId },
        result: { responseId: response.id, status: response.status },
      });
    }

    const rows = await tx.questionnaireAnswer.findMany({
      where: { responseId: response.id },
      orderBy: { questionId: "asc" },
    });

    return {
      response,
      instance: {
        id: instance.id,
        title: instance.title,
        status: instance.status,
        currentRevision: instance.currentRevision,
      },
      schema,
      answers: rows.map((r) => ({
        questionId: r.questionId,
        answer: r.answer,
        revisionNo: r.revisionNo,
        updatedAt: r.updatedAt,
      })),
    };
  });
}

/**
 * 批量保存答案（05 文档第 15.2 / 15.3 节）。
 *
 * 单题保存与批量保存走同一段实现，避免两条路径出现行为差异。
 */
async function saveAnswers(
  responseId: string,
  answers: AnswerInput[],
  ctx: ServiceContext
): Promise<SaveAnswersResult> {
  assertRole(ctx, RESPONSE_WRITE_ROLES, "保存答案");

  if (answers.length === 0) {
    throw validationError("answers 不能为空", { path: "answers" });
  }

  // 同一请求里重复提交同一个问题，说明调用方状态错乱；
  // 静默「后写覆盖先写」会让前端难以发现自己的 bug，因此显式拒绝。
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const a of answers) {
    if (seen.has(a.questionId)) duplicated.add(a.questionId);
    seen.add(a.questionId);
  }
  if (duplicated.size > 0) {
    throw validationError("同一个问题不能在一批里重复提交", {
      path: "answers",
      duplicatedQuestionIds: [...duplicated],
    });
  }

  return transaction(async (tx: Tx) => {
    const { response, instance, schema } = await loadResponseContext(
      tx,
      responseId,
      ctx
    );

    if (response.status !== "draft") {
      throw new OperationError(
        ErrorCode.INVALID_STATUS_TRANSITION,
        `填写结果状态为 ${response.status}，只有 draft 可以保存答案`,
        { path: "status", status: response.status, expected: "draft" }
      );
    }

    // question_id 只能对着「当时的 current_schema」校验（04 文档第 29 节）
    const questions = collectQuestions(schema);
    const known = new Set(questions.map((q) => q.id));
    const unknown = answers
      .map((a) => a.questionId)
      .filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new OperationError(
        ErrorCode.QUESTION_NOT_FOUND,
        `问题不存在于该问卷结构：${unknown.join(", ")}`,
        { path: "questionId", questionIds: unknown }
      );
    }

    // ---- 题型格式校验（05 文档第 15.4 节要求「答案格式」检查）----
    // 只校验「已填写」的答案：空值由必填校验在提交阶段处理，
    // 这里不拦空值，避免调查员保存半成品时被卡住。
    const byId = new Map(questions.map((q) => [q.id, q]));
    for (const a of answers) {
      if (isBlankAnswer(a.answer)) continue;
      const question = byId.get(a.questionId);
      if (!question) continue;
      assertAnswerShape(question, a.answer, a.questionId);
    }

    // 决策 D1 的前提：答案绑定「填写时」的实例修订号
    const revisionNo = instance.currentRevision;

    const saved: SaveAnswersResult["saved"] = [];
    for (const a of answers) {
      const row = await tx.questionnaireAnswer.upsert({
        where: {
          responseId_questionId: {
            responseId,
            questionId: a.questionId,
          },
        },
        create: {
          id: newId(),
          responseId,
          questionId: a.questionId,
          revisionNo,
          answer: answerToJson(a.answer),
        },
        update: {
          revisionNo,
          answer: answerToJson(a.answer),
        },
      });

      saved.push({
        questionId: row.questionId,
        answer: row.answer,
        revisionNo: row.revisionNo,
      });
    }

    await writeAudit(tx, {
      ctx,
      toolName: "save_answers",
      instanceId: instance.id,
      args: { responseId, questionIds: answers.map((a) => a.questionId) },
      result: { revisionNo, savedCount: saved.length },
    });

    return { response, instance, revisionNo, saved };
  });
}

/** 提交（05 文档第 15.4 节） */
async function submitResponse(
  responseId: string,
  ctx: ServiceContext
): Promise<{
  response: ResponseRecord;
  instanceId: string;
  instanceStatus: string;
}> {
  assertRole(ctx, RESPONSE_WRITE_ROLES, "提交问卷");

  return transaction(async (tx: Tx) => {
    const { response, instance, schema } = await loadResponseContext(
      tx,
      responseId,
      ctx
    );

    if (response.status !== "draft") {
      throw new OperationError(
        ErrorCode.INVALID_STATUS_TRANSITION,
        `填写结果状态为 ${response.status}，只有 draft 可以提交`,
        { path: "status", status: response.status, expected: "draft" }
      );
    }

    // 实例状态必须仍在「可填写」范围内：
    // 否则「已完成(completed)」会被另一条 draft 答卷拉回 submitted，
    // 让审核结论被无声作废（审计发现的缺陷）。
    if (
      !(FILLABLE_INSTANCE_STATUSES as readonly string[]).includes(
        instance.status
      )
    ) {
      throw new OperationError(
        ErrorCode.INVALID_STATUS_TRANSITION,
        `实例状态为 ${instance.status}，不能提交答卷`,
        {
          path: "status",
          status: instance.status,
          expected: FILLABLE_INSTANCE_STATUSES,
        }
      );
    }

    // 必填校验：遍历 current_schema 中 required = true 的题目
    const requiredIds = collectQuestions(schema)
      .filter((q) => q.required)
      .map((q) => q.id);

    const rows = await tx.questionnaireAnswer.findMany({
      where: { responseId },
      select: { questionId: true, answer: true },
    });
    const answered = new Map(rows.map((r) => [r.questionId, r.answer]));

    const missing = requiredIds.filter((id) => {
      if (!answered.has(id)) return true;
      return isBlankAnswer(answered.get(id));
    });

    if (missing.length > 0) {
      throw validationError("存在未填写的必填项，无法提交", {
        path: "answers",
        missingQuestionIds: missing,
      });
    }

    const submittedAt = new Date();

    const updated = await tx.questionnaireResponse.update({
      where: { id: responseId },
      data: { status: "submitted", submittedAt },
    });

    const updatedInstance = await tx.questionnaireInstance.update({
      where: { id: instance.id },
      data: { status: "submitted" },
      select: { id: true, status: true },
    });

    await writeAudit(tx, {
      ctx,
      toolName: "submit_response",
      instanceId: instance.id,
      args: { responseId },
      result: {
        from: "draft",
        to: "submitted",
        submittedAt: submittedAt.toISOString(),
        instanceStatus: updatedInstance.status,
      },
    });

    return {
      response: updated,
      instanceId: updatedInstance.id,
      instanceStatus: updatedInstance.status,
    };
  });
}

// ============================================================
// Service
// ============================================================

export const responseService = {
  getOrCreateResponse,

  saveAnswers,

  /** 单题保存：复用批量保存，保证两条路径行为一致 */
  saveAnswer(
    responseId: string,
    questionId: string,
    answer: unknown,
    ctx: ServiceContext
  ): Promise<SaveAnswersResult> {
    return saveAnswers(responseId, [{ questionId, answer }], ctx);
  },

  submitResponse,

  /** 供审核模块读取答案（不含权限校验，由调用方决定可见性） */
  async listAnswers(
    responseId: string,
    client: Tx | typeof prisma = prisma
  ): Promise<AnswerRecord[]> {
    const rows = await client.questionnaireAnswer.findMany({
      where: { responseId },
      orderBy: { questionId: "asc" },
    });
    return rows.map((r) => ({
      questionId: r.questionId,
      answer: r.answer,
      revisionNo: r.revisionNo,
      updatedAt: r.updatedAt,
    }));
  },
};

export type ResponseService = typeof responseService;
