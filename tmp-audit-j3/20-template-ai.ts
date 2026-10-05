/**
 * 审计脚本 B：「创建问卷（模板）」这条链路到底能不能用（原始需求 1 + D5 case-001 + D2 发布治理）。
 *
 * 结论导向：
 *  1. create_template 场景下 AI 工具是否真的能写入模板草稿版本？
 *  2. Service 层是否支持？（用于区分「能力缺失」与「没有接线」）
 *  3. 扶正/D2 生成的 draft 版本是否真的必须走发布流程、有无绕过路径？
 */
import { createApp } from "../src/app/app.js";
import {
  startTestServer,
  apiRequest,
  expectData,
} from "../tests/integration/api/helpers.js";
import { USERS, CTX } from "../tests/integration/questionnaire/helpers.js";
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  LLMProvider,
} from "../src/modules/ai/providers/index.js";
import { questionnaireService } from "../src/modules/questionnaire/service/questionnaire.service.js";
import { prisma } from "../src/database/client.js";

class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  constructor(private readonly script: ChatResult[]) {}
  private next(): ChatResult {
    return (
      this.script.shift() ?? { content: "（脚本用尽）", toolCalls: [], model: "scripted" }
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

const results: Record<string, unknown> = {};
const created = { templates: [] as string[], conversations: [] as string[] };

async function cleanup(): Promise<void> {
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
    // ---------- 准备：管理员建模板 + 空草稿版本 ----------
    const tplRes = await apiRequest<{ id: string }>(server, "POST", `${base}/questionnaire-templates`, {
      userId: USERS.admin,
      body: { name: "审计B-AI建模板" },
    });
    const templateId = expectData<{ id: string }>(tplRes).id;
    created.templates.push(templateId);

    const verRes = await apiRequest<{ id: string; status: string; versionNo: number }>(
      server,
      "POST",
      `${base}/questionnaire-templates/${templateId}/versions`,
      { userId: USERS.admin, body: {} }
    );
    const version = expectData<{ id: string; status: string }>(verRes);
    results["prep"] = {
      templateId,
      versionId: version.id,
      versionStatus: version.status,
      createTemplateHttp: tplRes.status,
      createVersionHttp: verRes.status,
    };

    // ---------- 1. create_template 场景：让 AI 往模板草稿里加分组 ----------
    const convRes = await apiRequest<{ conversationId: string }>(
      server,
      "POST",
      `${base}/ai/conversations`,
      {
        userId: USERS.admin,
        body: { scene: "create_template", targetId: version.id },
      }
    );
    const conversationId = expectData<{ conversationId: string }>(convRes).conversationId;
    created.conversations.push(conversationId);

    app.locals["aiProvider"] = new ScriptedProvider([
      {
        content: null,
        toolCalls: [
          { id: "t1", name: "get_questionnaire", arguments: "{}" },
          {
            id: "t2",
            name: "add_section",
            arguments: JSON.stringify({ title: "基本信息" }),
          },
        ],
        model: "scripted",
        finishReason: "tool_calls",
      },
      { content: "模板已经建好了。", toolCalls: [], model: "scripted" },
    ]);

    const msgRes = await apiRequest<{
      traces: { toolName: string; result: { success: boolean; error?: { code: string; message: string } } }[];
      revision?: number;
      content: string;
    }>(server, "POST", `${base}/ai/conversations/${conversationId}/messages`, {
      userId: USERS.admin,
      body: { content: "帮我建一个无人机黑飞核查问卷，先建「基本信息」分组。" },
    });
    const msg = expectData<{
      traces: { toolName: string; result: { success: boolean; error?: { code: string; message: string } } }[];
    }>(msgRes);
    const versionAfterAi = await prisma.questionnaireTemplateVersion.findUnique({
      where: { id: version.id },
      select: { schema: true },
    });
    results["1_aiCreateTemplate"] = {
      http: msgRes.status,
      toolTraces: msg.traces.map((t) => ({
        tool: t.toolName,
        success: t.result.success,
        errorCode: t.result.error?.code ?? null,
        errorMessage: t.result.error?.message ?? null,
      })),
      sectionsInTemplateVersion: (
        versionAfterAi?.schema as { sections: unknown[] }
      ).sections.length,
      revisionReturned: msg.revision ?? null,
    };

    // ---------- 2. Service 层直接改模板草稿版本（证明能力存在，只是没接线） ----------
    let serviceDirect: Record<string, unknown>;
    try {
      const r = await questionnaireService.applyToTemplateVersion(
        version.id,
        { name: "add_section", input: { title: "只有 Service 层能改" } },
        CTX.admin()
      );
      serviceDirect = {
        ok: true,
        sections: (r.schema as { sections: unknown[] }).sections.length,
        revision: r.revision,
      };
    } catch (e) {
      serviceDirect = { ok: false, error: String(e) };
    }
    results["2_serviceApplyToTemplateVersion"] = serviceDirect;

    // 谁调用过 applyToTemplateVersion？（静态证据：src 内引用点）
    results["2b_applyToTemplateVersionCallers"] =
      "见 grep：src 内除定义处(questionnaire.service.ts:716)外无任何引用";

    // ---------- 3. D2 发布治理：draft 必须经 publish，且发布后不可再改 ----------
    const draftVerRes = await apiRequest<{ id: string }>(
      server,
      "POST",
      `${base}/questionnaire-templates/${templateId}/versions`,
      { userId: USERS.admin, body: {} }
    );
    const draftVersionId = expectData<{ id: string }>(draftVerRes).id;

    const dispatcherPublish = await apiRequest(
      server,
      "POST",
      `${base}/questionnaire-templates/${templateId}/versions/${draftVersionId}/publish`,
      { userId: USERS.dispatcher }
    );
    const publishRes = await apiRequest<{ status: string }>(
      server,
      "POST",
      `${base}/questionnaire-templates/${templateId}/versions/${draftVersionId}/publish`,
      { userId: USERS.admin }
    );
    const convOnPublished = await apiRequest(
      server,
      "POST",
      `${base}/ai/conversations`,
      {
        userId: USERS.admin,
        body: { scene: "create_template", targetId: draftVersionId },
      }
    );
    let applyOnPublished: Record<string, unknown>;
    try {
      await questionnaireService.applyToTemplateVersion(
        draftVersionId,
        { name: "add_section", input: { title: "发布后不该能改" } },
        CTX.admin()
      );
      applyOnPublished = { ok: true };
    } catch (e) {
      applyOnPublished = { ok: false, error: (e as Error).message };
    }
    results["3_publishGovernance"] = {
      dispatcherPublishHttp: dispatcherPublish.status,
      dispatcherPublishError: dispatcherPublish.body.error?.code ?? null,
      adminPublishHttp: publishRes.status,
      publishedStatus: expectData<{ status: string }>(publishRes).status,
      conversationOnPublishedVersion: {
        http: convOnPublished.status,
        error: convOnPublished.body.error?.code ?? null,
      },
      applyOnPublishedVersion: applyOnPublished,
    };

    // ---------- 4. draft 版本不能派生实例 ----------
    const draftVer2 = await apiRequest<{ id: string }>(
      server,
      "POST",
      `${base}/questionnaire-templates/${templateId}/versions`,
      { userId: USERS.admin, body: {} }
    );
    const draftVersion2Id = expectData<{ id: string }>(draftVer2).id;
    const createFromDraft = await apiRequest(
      server,
      "POST",
      `${base}/questionnaire-instances`,
      {
        userId: USERS.dispatcher,
        body: { templateVersionId: draftVersion2Id, title: "不该能建" },
      }
    );
    results["4_instanceFromDraftVersion"] = {
      http: createFromDraft.status,
      error: createFromDraft.body.error?.code ?? null,
    };

    // ---------- 5. 扶正产物是否可被直接消费（promote → 未发布 → 不能被选模板） ----------
    const promotedLikeDraft = await apiRequest(
      server,
      "POST",
      `${base}/questionnaire-instances`,
      {
        userId: USERS.dispatcher,
        body: { templateVersionId: version.id, title: "用未发布版本建实例" },
      }
    );
    results["5_instanceFromUnpublishedVersion"] = {
      http: promotedLikeDraft.status,
      error: promotedLikeDraft.body.error?.code ?? null,
    };
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
