/**
 * 审计脚本 A：V1 主线业务链路是否真的可用（原始需求 00-Requirements 第 2 节）。
 *
 * 链路：选模板 → 建实例 → 用自然语言让 AI 加字段 → 扶正为模板草稿(D2)
 *       → 确认 → 下发 → 调查员填写 → 提交 → 审核
 *
 * AI 部分用 ScriptedProvider（假 Provider）驱动，不访问真实模型。
 * 全部走真实 HTTP + 真实数据库。
 *
 * 本脚本只创建自己的数据，结束时全部清理。
 */
import { createApp } from "../src/app/app.js";
import {
  startTestServer,
  apiRequest,
  expectData,
} from "../tests/integration/api/helpers.js";
import { USERS } from "../tests/integration/questionnaire/helpers.js";
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  LLMProvider,
} from "../src/modules/ai/providers/index.js";
import { prisma } from "../src/database/client.js";

class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  constructor(private readonly script: ChatResult[]) {}
  private next(): ChatResult {
    return (
      this.script.shift() ?? {
        content: "（脚本已用尽）",
        toolCalls: [],
        model: "scripted",
      }
    );
  }
  async chat(_m: ChatMessage[], _o?: ChatOptions): Promise<ChatResult> {
    return this.next();
  }
  // eslint-disable-next-line require-yield
  async *chatStream(): AsyncIterable<never> {
    throw new Error("不使用流式");
  }
}

function toolCallReply(
  calls: { id: string; name: string; args: unknown }[],
  content: string | null = null
): ChatResult {
  return {
    content,
    toolCalls: calls.map((c) => ({
      id: c.id,
      name: c.name,
      arguments: JSON.stringify(c.args),
    })),
    model: "scripted",
    finishReason: "tool_calls",
  };
}

const log = (...a: unknown[]) => console.log(...a);
const results: Record<string, unknown> = {};

const created = {
  instances: [] as string[],
  templateVersions: [] as string[],
  templates: [] as string[],
  conversations: [] as string[],
  responses: [] as string[],
};

async function cleanup(): Promise<void> {
  for (const id of created.instances) {
    await prisma.questionnaireAnswer.deleteMany({
      where: { response: { questionnaireInstanceId: id } },
    });
    await prisma.reviewRecord.deleteMany({
      where: { response: { questionnaireInstanceId: id } },
    });
    await prisma.questionnaireResponse.deleteMany({
      where: { questionnaireInstanceId: id },
    });
    await prisma.dispatchTask.deleteMany({
      where: { questionnaireInstanceId: id },
    });
    await prisma.aiToolExecution.deleteMany({
      where: { questionnaireInstanceId: id },
    });
    await prisma.questionnaireRevision.deleteMany({
      where: { questionnaireInstanceId: id },
    });
    await prisma.questionnaireInstance.deleteMany({ where: { id } });
  }
  for (const id of created.conversations) {
    await prisma.aiToolExecution.deleteMany({ where: { conversationId: id } });
    await prisma.aiMessage.deleteMany({ where: { conversationId: id } });
    await prisma.aiConversation.deleteMany({ where: { id } });
  }
  for (const id of created.templateVersions) {
    await prisma.questionnaireTemplateVersion.deleteMany({ where: { id } });
  }
  for (const id of created.templates) {
    await prisma.questionnaireTemplate.deleteMany({ where: { id } });
  }
}

async function main(): Promise<void> {
  const app = createApp();
  const server = await startTestServer(app);
  const base = "/api/v1";

  try {
    const version = await prisma.questionnaireTemplateVersion.findFirst({
      where: { status: "published" },
      orderBy: { createdAt: "asc" },
    });
    if (!version) throw new Error("缺少已发布模板版本，请先 pnpm db:seed");
    results.seedTemplateVersionId = version.id;

    // ---------- 1. 选模板 + 填被调查人信息 → 建实例 ----------
    const createRes = await apiRequest<{ id: string }>(
      server,
      "POST",
      `${base}/questionnaire-instances`,
      {
        userId: USERS.dispatcher,
        body: {
          templateVersionId: version.id,
          title: "审计A - 无人机黑飞核查",
          subjectInfo: { name: "审计对象甲", idCard: "3301**********0001" },
        },
      }
    );
    const instanceId = expectData<{ id: string; status: string; currentRevision: number }>(
      createRes
    ).id;
    created.instances.push(instanceId);
    results["1_createInstance"] = {
      http: createRes.status,
      id: instanceId,
      status: expectData<{ status: string }>(createRes).status,
    };

    // ---------- 2. 自然语言让 AI 加字段（假 Provider） ----------
    const convRes = await apiRequest<{ conversationId: string }>(
      server,
      "POST",
      `${base}/ai/conversations`,
      {
        userId: USERS.dispatcher,
        body: { scene: "modify_questionnaire", targetId: instanceId },
      }
    );
    const conversationId = expectData<{ conversationId: string }>(convRes)
      .conversationId;
    created.conversations.push(conversationId);

    app.locals["aiProvider"] = new ScriptedProvider([
      toolCallReply([
        { id: "c1", name: "add_section", args: { title: "团伙关系调查" } },
        {
          id: "c2",
          name: "add_question",
          args: {
            section_id: "sec_drone_device",
            type: "single_choice",
            title: "是否存在团伙？",
            required: true,
            options: [{ label: "是" }, { label: "否" }, { label: "不清楚" }],
          },
        },
      ]),
      { content: "已增加团伙关系调查与是否存在团伙的问题。", toolCalls: [], model: "scripted" },
    ]);

    const msgRes = await apiRequest<{
      traces: { toolName: string; result: { success: boolean; error?: { code: string } } }[];
      revision?: number;
      content: string;
    }>(server, "POST", `${base}/ai/conversations/${conversationId}/messages`, {
      userId: USERS.dispatcher,
      body: {
        content: "这个对象要重点关注是否有团伙，帮我加一个团伙关系调查模块，并加一题问是否存在团伙。",
      },
    });
    const msg = expectData<{
      traces: { toolName: string; result: { success: boolean; error?: { code: string } } }[];
      revision?: number;
    }>(msgRes);
    results["2_aiModifyInstance"] = {
      http: msgRes.status,
      toolCalls: msg.traces.map((t) => ({
        tool: t.toolName,
        success: t.result.success,
        error: t.result.error?.code ?? null,
      })),
      revision: msg.revision,
    };

    const afterAi = await apiRequest<{
      currentRevision: number;
      currentSchema: {
        sections: { title: string; questions: { title: string }[] }[];
      };
    }>(server, "GET", `${base}/questionnaire-instances/${instanceId}`, {
      userId: USERS.dispatcher,
    });
    const aiSchema = expectData<{
      currentRevision: number;
      currentSchema: { sections: { title: string; questions: { title: string }[] }[] };
    }>(afterAi);
    results["2b_schemaAfterAi"] = {
      revision: aiSchema.currentRevision,
      sections: aiSchema.currentSchema.sections.map((s) => s.title),
      newQuestionPresent: aiSchema.currentSchema.sections.some((s) =>
        s.questions.some((q) => q.title === "是否存在团伙？")
      ),
    };

    // ---------- 3. D2：扶正为模板草稿版本 ----------
    const promoteRes = await apiRequest<{
      templateVersionId: string;
      versionNo: number;
      status: string;
    }>(server, "POST", `${base}/questionnaire-instances/${instanceId}/promote`, {
      userId: USERS.dispatcher,
      body: { changeNote: "由案件实例扶正：增加团伙关系调查" },
    });
    const promoted = expectData<{
      templateId: string;
      templateVersionId: string;
      versionNo: number;
      status: string;
    }>(promoteRes);
    created.templateVersions.push(promoted.templateVersionId);
    const promotedRow = await prisma.questionnaireTemplateVersion.findUnique({
      where: { id: promoted.templateVersionId },
    });
    results["3_promoteD2"] = {
      http: promoteRes.status,
      status: promoted.status,
      dbStatus: promotedRow?.status,
      dbSourceType: promotedRow?.sourceType,
      dbSourceInstanceId: promotedRow?.sourceInstanceId,
      versionNo: promoted.versionNo,
      templateStatusUnchanged: (
        await prisma.questionnaireTemplate.findUnique({
          where: { id: promoted.templateId },
          select: { status: true, currentVersionId: true },
        })
      ),
    };

    // ---------- 4. 确认 → 下发 ----------
    const confirmRes = await apiRequest(server, "POST", `${base}/questionnaire-instances/${instanceId}/confirm`, {
      userId: USERS.dispatcher,
      body: {},
    });
    results["4a_confirm"] = { http: confirmRes.status, body: confirmRes.body.data };

    const taskRes = await apiRequest<{ id: string }>(server, "POST", `${base}/dispatch-tasks`, {
      userId: USERS.dispatcher,
      body: { questionnaireInstanceId: instanceId, assignedTo: USERS.investigator },
    });
    const taskId = expectData<{ id: string }>(taskRes).id;
    const dispatchRes = await apiRequest(server, "POST", `${base}/dispatch-tasks/${taskId}/dispatch`, {
      userId: USERS.dispatcher,
    });
    results["4b_dispatch"] = {
      createHttp: taskRes.status,
      dispatchHttp: dispatchRes.status,
      body: dispatchRes.body.data,
    };

    // 下发后 AI 通道被拒绝（D1，且不调用 LLM）
    app.locals["aiProvider"] = new ScriptedProvider([
      { content: "不该走到这里", toolCalls: [], model: "scripted" },
    ]);
    const lockedConv = await apiRequest(server, "POST", `${base}/ai/conversations`, {
      userId: USERS.dispatcher,
      body: { scene: "modify_questionnaire", targetId: instanceId },
    });
    results["4c_aiAfterDispatchBlocked"] = {
      http: lockedConv.status,
      error: lockedConv.body.error,
    };

    // ---------- 5. 调查员填写 → 提交 ----------
    const respRes = await apiRequest<{
      responseId: string;
      status: string;
      questionnaire: { sections: { questions: { id: string; required: boolean }[] }[] };
    }>(server, "GET", `${base}/questionnaire-instances/${instanceId}/response`, {
      userId: USERS.investigator,
    });
    const filling = expectData<{
      responseId: string;
      status: string;
      questionnaire: { sections: { questions: { id: string; required: boolean }[] }[] };
    }>(respRes);
    created.responses.push(filling.responseId);

    const requiredIds = filling.questionnaire.sections
      .flatMap((s) => s.questions)
      .filter((q) => q.required)
      .map((q) => q.id);
    results["5a_getResponse"] = {
      http: respRes.status,
      responseId: filling.responseId,
      status: filling.status,
      requiredIds,
    };

    const saveRes = await apiRequest(server, "PUT", `${base}/questionnaire-responses/${filling.responseId}/answers`, {
      userId: USERS.investigator,
      body: { answers: requiredIds.map((id) => ({ questionId: id, answer: "已核查-是" })) },
    });
    results["5b_saveAnswers"] = { http: saveRes.status, body: saveRes.body.data };

    const submitRes = await apiRequest(server, "POST", `${base}/questionnaire-responses/${filling.responseId}/submit`, {
      userId: USERS.investigator,
    });
    results["5c_submit"] = { http: submitRes.status, body: submitRes.body.data };

    // ---------- 6. 审核通过 ----------
    const pending = await apiRequest<{ items: { responseId: string }[]; total: number }>(
      server,
      "GET",
      `${base}/questionnaire-responses/review/pending`,
      { userId: USERS.reviewer }
    );
    results["6a_pendingList"] = {
      http: pending.status,
      total: expectData<{ total: number }>(pending).total,
    };

    const reviewRes = await apiRequest(server, "POST", `${base}/questionnaire-responses/${filling.responseId}/review`, {
      userId: USERS.reviewer,
      body: { result: "approved", comment: "通过" },
    });
    results["6b_reviewApproved"] = { http: reviewRes.status, body: reviewRes.body.data };

    // ---------- 7. 角色越界尝试（D8 边界） ----------
    const investigatorPromote = await apiRequest(server, "POST", `${base}/questionnaire-instances/${instanceId}/promote`, {
      userId: USERS.investigator,
      body: {},
    });
    results["7a_investigatorPromote"] = {
      http: investigatorPromote.status,
      error: investigatorPromote.body.error?.code,
    };
    const reviewerCreateTemplate = await apiRequest(server, "POST", `${base}/questionnaire-templates`, {
      userId: USERS.reviewer,
      body: { name: "审核员不该能建的模板" },
    });
    results["7b_reviewerCreateTemplate"] = {
      http: reviewerCreateTemplate.status,
      error: reviewerCreateTemplate.body.error?.code,
    };
    const investigatorListTemplates = await apiRequest(server, "GET", `${base}/questionnaire-templates`, {
      userId: USERS.investigator,
    });
    results["7c_investigatorListTemplates"] = {
      http: investigatorListTemplates.status,
      ok: investigatorListTemplates.body.success,
    };
  } finally {
    log(JSON.stringify(results, null, 2));
    await cleanup();
    await server.close();
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error("脚本失败：", e);
  try {
    await cleanup();
  } catch {
    /* ignore */
  }
  await prisma.$disconnect();
  process.exit(1);
});
