/**
 * 探针 14：submitResponse 是否校验「实例状态」？
 *
 * 场景：
 *   实例已是 completed（终态）→ 调查员把一份 draft response 提交
 *   期望：被拒绝（completed 是终态）
 *   现状（读代码推断）：submitResponse 只看 response.status，不看 instance.status，
 *                     会把实例从 completed 硬改成 submitted（终态被覆盖）
 *
 * 用法：pnpm exec tsx tmp-audit-j2/14-submit-terminal-instance.ts
 */
import { prisma } from "../src/database/client.js";
import { responseService } from "../src/modules/response/service/response.service.js";
import { isOperationError } from "../src/shared/errors/index.js";
import {
  CTX,
  createTestInstance,
  deleteTestInstance,
} from "../tests/integration/questionnaire/helpers.js";

function errInfo(e: unknown) {
  if (isOperationError(e)) return { kind: "OperationError", code: e.code, message: e.message };
  const anyE = e as { code?: string; message?: string };
  return { kind: "RAW", code: anyE?.code ?? "UNKNOWN", message: (anyE?.message ?? String(e)).slice(0, 160) };
}

async function cleanup(instanceId: string) {
  const responses = await prisma.questionnaireResponse.findMany({
    where: { questionnaireInstanceId: instanceId },
    select: { id: true },
  });
  const ids = responses.map((r) => r.id);
  await prisma.reviewRecord.deleteMany({ where: { questionnaireResponseId: { in: ids } } });
  await prisma.questionnaireAnswer.deleteMany({ where: { responseId: { in: ids } } });
  await prisma.questionnaireResponse.deleteMany({ where: { id: { in: ids } } });
  await prisma.dispatchTask.deleteMany({ where: { questionnaireInstanceId: instanceId } });
  await prisma.aiToolExecution.deleteMany({ where: { questionnaireInstanceId: instanceId } });
  await deleteTestInstance(instanceId);
}

async function main() {
  // 实例处于终态 completed
  const inst = await createTestInstance({ status: "completed" });

  // 造一份 draft response + 填满所有必填项，绕过必填校验
  const created = await responseService.getOrCreateResponse(inst.id, CTX.investigator()).catch(
    (e) => ({ error: errInfo(e) }) as never
  );

  let setupNote = "";
  let responseId: string;
  if ("error" in created) {
    // getOrCreateResponse 会因实例非可填写状态而拒绝 —— 这本身是正确的
    const row = await prisma.questionnaireResponse.create({
      data: {
        id: (await import("../src/shared/utils/id.js")).newId(),
        questionnaireInstanceId: inst.id,
        respondentId: CTX.investigator().userId,
        status: "draft",
      },
    });
    responseId = row.id;
    setupNote = "getOrCreateResponse 已正确拒绝 completed 实例，改用直接插入 draft response 继续验证 submit";
  } else {
    responseId = created.response.id;
    setupNote = "getOrCreateResponse 竟然允许在 completed 实例上创建 draft response";
  }

  // 填满必填项
  const schema = (await prisma.questionnaireInstance.findUnique({
    where: { id: inst.id },
    select: { currentSchema: true, currentRevision: true },
  }))!;
  const s = schema.currentSchema as { sections: { questions: { id: string; required: boolean }[] }[] };
  const required = s.sections.flatMap((sec) => sec.questions).filter((q) => q.required);
  for (const q of required) {
    await prisma.questionnaireAnswer.upsert({
      where: { responseId_questionId: { responseId, questionId: q.id } },
      create: {
        id: (await import("../src/shared/utils/id.js")).newId(),
        responseId,
        questionId: q.id,
        revisionNo: schema.currentRevision,
        answer: "审计填充",
      },
      update: { answer: "审计填充" },
    });
  }

  const before = await prisma.questionnaireInstance.findUnique({
    where: { id: inst.id },
    select: { status: true },
  });

  let submitResult: unknown;
  try {
    const r = await responseService.submitResponse(responseId, CTX.investigator());
    submitResult = { ok: true, instanceStatus: r.instanceStatus, responseStatus: r.response.status };
  } catch (e) {
    submitResult = errInfo(e);
  }

  const after = await prisma.questionnaireInstance.findUnique({
    where: { id: inst.id },
    select: { status: true },
  });

  console.log(
    JSON.stringify(
      {
        必填项数量: required.length,
        准备说明: setupNote,
        提交前实例状态: before?.status,
        提交结果: submitResult,
        提交后实例状态: after?.status,
        终态被覆盖: before?.status === "completed" && after?.status === "submitted",
        结论:
          before?.status === "completed" && after?.status === "submitted"
            ? "严重：completed 终态被 submitResponse 覆盖为 submitted"
            : "submitResponse 未覆盖终态",
      },
      null,
      2
    )
  );

  await cleanup(inst.id);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("FAILED", JSON.stringify(errInfo(e)));
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
