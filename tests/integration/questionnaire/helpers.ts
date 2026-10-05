/**
 * 集成测试辅助。
 *
 * 这些测试直接使用本地 Prisma Postgres（不是 mock），
 * 因为本层的关键行为（乐观锁、Revision 递增、审计落库、状态拦截）
 * 只有在真实数据库上才有意义。
 */
import { v5 as uuidv5 } from "uuid";
import { prisma } from "../../../src/database/client.js";
import { newId } from "../../../src/shared/utils/id.js";
import type { ServiceContext } from "../../../src/modules/questionnaire/service/questionnaire.service.js";

const NS = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";

/** 与 seed.ts 保持一致的确定性用户 ID */
export function seedUserId(username: string): string {
  return uuidv5(`user:${username}`, NS);
}

export const USERS = {
  admin: seedUserId("admin"),
  dispatcher: seedUserId("dispatcher1"),
  investigator: seedUserId("investigator1"),
  reviewer: seedUserId("reviewer1"),
};

/** 常用上下文 */
export const CTX = {
  dispatcher: (extra: Partial<ServiceContext> = {}): ServiceContext => ({
    userId: USERS.dispatcher,
    roles: ["dispatcher"],
    source: "rest",
    ...extra,
  }),
  admin: (extra: Partial<ServiceContext> = {}): ServiceContext => ({
    userId: USERS.admin,
    roles: ["template_admin"],
    source: "rest",
    ...extra,
  }),
  investigator: (extra: Partial<ServiceContext> = {}): ServiceContext => ({
    userId: USERS.investigator,
    roles: ["investigator"],
    source: "rest",
    ...extra,
  }),
};

export interface TestInstance {
  id: string;
  /** 初始 revision（seed 时为 1） */
  initialRevision: number;
  /** 每次测试开始时实例应有的 status */
  status: string;
}

/**
 * 创建（或重置）一个用于测试的问卷实例。
 *
 * 每次都新建实例，避免测试之间互相污染；
 * 同时把实例状态重置为 draft，保证可重复运行。
 */
export async function createTestInstance(
  options: { status?: string } = {}
): Promise<TestInstance> {
  const templateVersion =
    await prisma.questionnaireTemplateVersion.findFirst({
      where: { status: "published" },
      orderBy: { createdAt: "asc" },
    });

  if (!templateVersion) {
    throw new Error("找不到已发布的模板版本，请先执行 pnpm db:seed");
  }

  const instanceId = newId();
  const status = options.status ?? "draft";

  await prisma.questionnaireInstance.create({
    data: {
      id: instanceId,
      templateVersionId: templateVersion.id,
      title: `集成测试实例 - ${instanceId.slice(0, 8)}`,
      subjectInfo: { name: "测试对象" },
      currentSchema: templateVersion.schema as object,
      currentRevision: 1,
      status,
      createdBy: USERS.dispatcher,
    },
  });

  await prisma.questionnaireRevision.create({
    data: {
      id: newId(),
      questionnaireInstanceId: instanceId,
      revisionNo: 1,
      schemaSnapshot: templateVersion.schema as object,
      operationType: "create_instance",
      createdBy: USERS.dispatcher,
    },
  });

  return { id: instanceId, initialRevision: 1, status };
}

/** 清理测试实例及其关联数据 */
export async function deleteTestInstance(instanceId: string): Promise<void> {
  await prisma.aiToolExecution.deleteMany({
    where: { questionnaireInstanceId: instanceId },
  });
  await prisma.questionnaireRevision.deleteMany({
    where: { questionnaireInstanceId: instanceId },
  });
  await prisma.questionnaireInstance.deleteMany({ where: { id: instanceId } });
}

/** 读取实例的当前 revision 与状态 */
export async function readInstanceState(instanceId: string) {
  const row = await prisma.questionnaireInstance.findUnique({
    where: { id: instanceId },
    select: { currentRevision: true, status: true, currentSchema: true },
  });
  return row;
}

/** 统计某实例的 Revision 与审计条数 */
export async function countArtifacts(instanceId: string) {
  const [revisions, audits] = await Promise.all([
    prisma.questionnaireRevision.count({
      where: { questionnaireInstanceId: instanceId },
    }),
    prisma.aiToolExecution.count({
      where: { questionnaireInstanceId: instanceId },
    }),
  ]);
  return { revisions, audits };
}

/**
 * 创建一条真实的 AI 会话记录。
 *
 * 为什么测试要用真实 conversation：
 *   ai_tool_executions.conversation_id 是 uuid 且有外键约束，
 *   随意编一个字符串会在写审计时失败。
 *   这正说明「ID 字段必须在入口校验格式」是必要的。
 */
export async function createTestConversation(
  instanceId: string,
  options: { scene?: string } = {}
): Promise<string> {
  const id = newId();
  await prisma.aiConversation.create({
    data: {
      id,
      userId: USERS.dispatcher,
      scene: options.scene ?? "modify_questionnaire",
      targetType: "questionnaire_instance",
      targetId: instanceId,
      status: "active",
    },
  });
  return id;
}

export async function deleteTestConversation(id: string): Promise<void> {
  // 删除顺序必须遵守外键依赖：
  // ai_tool_executions 与 ai_messages 都引用 ai_conversations，
  // 且都没有级联删除，因此必须先删子表再删会话。
  await prisma.aiToolExecution.deleteMany({ where: { conversationId: id } });
  await prisma.aiMessage.deleteMany({ where: { conversationId: id } });
  await prisma.aiConversation.deleteMany({ where: { id } });
}
