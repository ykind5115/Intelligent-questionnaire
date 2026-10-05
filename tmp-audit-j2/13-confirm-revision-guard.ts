/**
 * 探针 13：confirmInstance 是否遵守调用方传入的 revision 期望值。
 *
 * 文档 05 第 35 节与 controller 注释都承诺：
 *   POST /instances/:id/confirm { revision } 用来「避免确认到已被改动的版本」。
 * 控制器 confirmBody 接收 revision，但 Service 的 confirmInstance 签名里没有这个参数。
 *
 * 验证：先改一次结构（revision 1→2），再用过期 revision=1 调 confirm，
 *       看是否被拒绝。
 *
 * 用法：pnpm exec tsx tmp-audit-j2/13-confirm-revision-guard.ts
 */
import { prisma } from "../src/database/client.js";
import { questionnaireService } from "../src/modules/questionnaire/service/questionnaire.service.js";
import { isOperationError } from "../src/shared/errors/index.js";
import { newId } from "../src/shared/utils/id.js";
import {
  CTX,
  createTestInstance,
  deleteTestInstance,
} from "../tests/integration/questionnaire/helpers.js";

function errInfo(e: unknown) {
  if (isOperationError(e)) return { kind: "OperationError", code: e.code, message: e.message };
  return { kind: "RAW", message: String(e).slice(0, 140) };
}

async function main() {
  const inst = await createTestInstance({ status: "draft" });

  // revision 1 → 2
  const applied = await questionnaireService.applyToInstance(
    inst.id,
    { name: "add_section", input: { title: "审计：确认前修改" } },
    CTX.dispatcher({ operationId: newId() })
  );

  // 用「过期的」revision=1 调 confirm
  const confirmAttempt = await questionnaireService
    .confirmInstance(inst.id, {
      ...CTX.dispatcher(),
      // 即使把 revision 塞进 ctx 也不该被当作期望值；此处主要验证 Service 是否读取它
      ...( { revision: 1 } as Record<string, unknown>),
    } as never)
    .then((r) => ({ ok: true, ...r }))
    .catch((e) => errInfo(e));

  const row = await prisma.questionnaireInstance.findUnique({
    where: { id: inst.id },
    select: { status: true, currentRevision: true },
  });

  // 直接检查 Service 方法签名接受的参数个数（arity 不可靠，改为读源码行由报告说明）
  console.log(
    JSON.stringify(
      {
        修改后revision: applied.revision,
        用过期revision调confirm的结果: confirmAttempt,
        最终状态: row?.status,
        最终revision: row?.currentRevision,
        期望: "应返回 REVISION_CONFLICT（文档 05 第 35 节承诺 revision 守卫）",
        实际: confirmAttempt,
        结论:
          typeof confirmAttempt === "object" && confirmAttempt !== null && "status" in confirmAttempt
            ? "confirm 忽略了调用方传入的 revision：过期版本也能确认成功"
            : "confirm 拒绝了过期 revision",
      },
      null,
      2
    )
  );

  await deleteTestInstance(inst.id);
  await prisma.aiToolExecution.deleteMany({ where: { questionnaireInstanceId: inst.id } });
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
