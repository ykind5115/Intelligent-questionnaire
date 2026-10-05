/**
 * 审计脚本 H：若干「看起来实现了」的点是否真的实现。
 *
 *  (a) D9 幂等：同一 operation_id 重放是否真的不产生第二次修改（真实数据库）
 *  (b) 05 §35：confirm 的 revision 参数是否真的被校验（乐观确认）
 *  (c) 05 §12.3a：已下发实例发消息时是否在调用 LLM 之前就拒绝（不消耗 Token）
 *  (d) 模板版本号是否后端自增（版本更迭）
 */
import { createApp } from "../src/app/app.js";
import {
  startTestServer,
  apiRequest,
  expectData,
} from "../tests/integration/api/helpers.js";
import { USERS } from "../tests/integration/questionnaire/helpers.js";
import { runTool } from "../src/modules/ai/tools/index.js";
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  LLMProvider,
} from "../src/modules/ai/providers/index.js";
import { newId } from "../src/shared/utils/id.js";
import { prisma } from "../src/database/client.js";

class CountingProvider implements LLMProvider {
  readonly name = "counting";
  calls = 0;
  async chat(_m: ChatMessage[], _o?: ChatOptions): Promise<ChatResult> {
    this.calls += 1;
    return { content: "不该被调用", toolCalls: [], model: "counting" };
  }
  // eslint-disable-next-line require-yield
  async *chatStream(): AsyncIterable<never> {
    throw new Error("不使用流式");
  }
}

const results: Record<string, unknown> = {};
const created = { instances: [] as string[], templates: [] as string[], conversations: [] as string[] };

async function cleanup(): Promise<void> {
  for (const id of created.instances) {
    await prisma.questionnaireAnswer.deleteMany({
      where: { response: { questionnaireInstanceId: id } },
    });
    await prisma.questionnaireResponse.deleteMany({
      where: { questionnaireInstanceId: id },
    });
    await prisma.dispatchTask.deleteMany({ where: { questionnaireInstanceId: id } });
    await prisma.aiToolExecution.deleteMany({ where: { questionnaireInstanceId: id } });
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
  for (const id of created.templates) {
    await prisma.questionnaireTemplateVersion.deleteMany({ where: { templateId: id } });
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
    if (!version) throw new Error("缺少已发布模板版本");

    const mkInstance = async (title: string) => {
      const r = await apiRequest<{ id: string }>(server, "POST", `${base}/questionnaire-instances`, {
        userId: USERS.dispatcher,
        body: { templateVersionId: version.id, title },
      });
      const id = expectData<{ id: string }>(r).id;
      created.instances.push(id);
      return id;
    };

    // ---------- (a) D9 幂等 ----------
    const instA = await mkInstance("审计H-幂等");
    const fixedOperationId = newId();
    const ctx = {
      userId: USERS.dispatcher,
      roles: ["dispatcher"],
      operationId: fixedOperationId,
      scene: "modify_questionnaire",
      targetType: "questionnaire_instance" as const,
      targetId: instA,
    };
    const first = await runTool("add_section", { title: "幂等分组" }, ctx);
    const second = await runTool("add_section", { title: "幂等分组" }, ctx);
    const instARow = await prisma.questionnaireInstance.findUnique({
      where: { id: instA },
      select: { currentRevision: true, currentSchema: true },
    });
    results["a_D9_idempotency"] = {
      firstSuccess: first.success,
      firstRevision: first.metadata?.revision,
      secondSuccess: second.success,
      secondRevision: second.metadata?.revision,
      secondDetails: second.data,
      revisionInDb: instARow?.currentRevision,
      sectionCount: (instARow?.currentSchema as { sections: unknown[] }).sections.length,
      auditRows: await prisma.aiToolExecution.count({
        where: { questionnaireInstanceId: instA, operationId: fixedOperationId },
      }),
    };

    // ---------- (b) confirm 的 revision 参数 ----------
    const instB = await mkInstance("审计H-乐观确认");
    // 改一次结构，让 currentRevision 变成 2
    const bump = await apiRequest(server, "POST", `${base}/ai/conversations`, {
      userId: USERS.dispatcher,
      body: { scene: "modify_questionnaire", targetId: instB },
    });
    const bumpConv = expectData<{ conversationId: string }>(bump).conversationId;
    created.conversations.push(bumpConv);
    app.locals["aiProvider"] = {
      name: "static",
      async chat() {
        return {
          content: null,
          toolCalls: [
            {
              id: "c1",
              name: "add_section",
              arguments: JSON.stringify({ title: "第2个分组" }),
            },
          ],
          model: "static",
        } as ChatResult;
      },
      // eslint-disable-next-line require-yield
      async *chatStream(): AsyncIterable<never> {
        throw new Error("no");
      },
    } satisfies LLMProvider;
    await apiRequest(server, "POST", `${base}/ai/conversations/${bumpConv}/messages`, {
      userId: USERS.dispatcher,
      body: { content: "加一个分组" },
    });
    const beforeConfirm = await prisma.questionnaireInstance.findUnique({
      where: { id: instB },
      select: { currentRevision: true, status: true },
    });
    const confirmWithStaleRevision = await apiRequest(
      server,
      "POST",
      `${base}/questionnaire-instances/${instB}/confirm`,
      { userId: USERS.dispatcher, body: { revision: 1 } } // 故意给一个过期的 revision
    );
    const afterConfirm = await prisma.questionnaireInstance.findUnique({
      where: { id: instB },
      select: { currentRevision: true, status: true },
    });
    results["b_confirmRevisionCheck"] = {
      revisionBeforeConfirm: beforeConfirm?.currentRevision,
      confirmBodySentRevision: 1,
      httpStatus: confirmWithStaleRevision.status,
      confirmedAnyway: confirmWithStaleRevision.body.success,
      statusAfter: afterConfirm?.status,
      expectationFromDoc05_35: "revision 与 currentRevision 不一致时应拒绝",
    };

    // ---------- (c) 已下发实例发消息：是否在调 LLM 之前拒绝 ----------
    const instC = await mkInstance("审计H-下发后不发LLM");
    const convC = await apiRequest<{ conversationId: string }>(
      server,
      "POST",
      `${base}/ai/conversations`,
      { userId: USERS.dispatcher, body: { scene: "modify_questionnaire", targetId: instC } }
    );
    const convCId = expectData<{ conversationId: string }>(convC).conversationId;
    created.conversations.push(convCId);
    // 直接改库把实例推到 dispatched，模拟会话建立后才下发
    await prisma.questionnaireInstance.update({
      where: { id: instC },
      data: { status: "dispatched" },
    });
    const counting = new CountingProvider();
    app.locals["aiProvider"] = counting;
    const sendAfterDispatch = await apiRequest(
      server,
      "POST",
      `${base}/ai/conversations/${convCId}/messages`,
      { userId: USERS.dispatcher, body: { content: "再加一题" } }
    );
    results["c_noLlmCallWhenLocked"] = {
      http: sendAfterDispatch.status,
      error: sendAfterDispatch.body.error?.code,
      providerCallCount: counting.calls,
    };

    // ---------- (d) 模板版本号自增 ----------
    const tpl = await apiRequest<{ id: string }>(server, "POST", `${base}/questionnaire-templates`, {
      userId: USERS.admin,
      body: { name: "审计H-版本更迭" },
    });
    const tplId = expectData<{ id: string }>(tpl).id;
    created.templates.push(tplId);
    const versionNos: number[] = [];
    for (let i = 0; i < 3; i++) {
      const v = await apiRequest<{ versionNo: number; status: string }>(
        server,
        "POST",
        `${base}/questionnaire-templates/${tplId}/versions`,
        { userId: USERS.admin, body: {} }
      );
      versionNos.push(expectData<{ versionNo: number }>(v).versionNo);
    }
    results["d_templateVersionNo"] = versionNos;
  } finally {
    console.log(JSON.stringify(results, null, 2));
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
