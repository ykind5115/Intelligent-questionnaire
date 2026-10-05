/**
 * 探针 1c：最小化诊断。
 *
 * A. 直接更新一个不存在的 revision，看乐观锁的 WHERE 是否生效（应抛 REVISION_CONFLICT）；
 * B. 用 prisma.$transaction 包住两段【人为拉开时间】的读改写，看是否会丢失更新；
 * C. 打印每次读到的 revision 与落库后的 revision，判断是否真的并发。
 *
 * 用法：pnpm exec tsx tmp-audit-j2/01c-diagnose.ts
 */
import { prisma } from "../src/database/client.js";
import { questionnaireRepository } from "../src/modules/questionnaire/repository/questionnaire.repository.js";
import { isOperationError } from "../src/shared/errors/index.js";
import {
  CTX,
  createTestInstance,
  deleteTestInstance,
} from "../tests/integration/questionnaire/helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---------- A. 乐观锁 WHERE 是否生效 ----------
  {
    const inst = await createTestInstance();
    const schema = (await prisma.questionnaireInstance.findUnique({
      where: { id: inst.id },
      select: { currentSchema: true },
    }))!.currentSchema as never;

    let aResult = "NO ERROR (affected rows > 0)";
    try {
      await questionnaireRepository.updateInstanceSchema({
        instanceId: inst.id,
        expectedRevision: 999, // 故意错误
        schema,
      });
    } catch (e) {
      aResult = isOperationError(e)
        ? `OperationError ${e.code}: ${e.message}`
        : `OTHER: ${e instanceof Error ? e.message : String(e)}`;
    }
    console.log("A) updateInstanceSchema(expectedRevision=999) =>", aResult);

    const after = await prisma.questionnaireInstance.findUnique({
      where: { id: inst.id },
      select: { currentRevision: true },
    });
    console.log("A) revision after wrong-expected update =", after?.currentRevision, "(期望 1)");
    await deleteTestInstance(inst.id);
  }

  // ---------- B. 事务里「读 → 睡 → 写」是否丢失更新 ----------
  {
    const inst = await createTestInstance();
    console.log("\nB) instance", inst.id, "rev", inst.initialRevision);

    const worker = async (tag: string) => {
      try {
        return await prisma.$transaction(async (tx) => {
          const seen = await tx.questionnaireInstance.findUnique({
            where: { id: inst.id },
            select: { currentRevision: true },
          });
          console.log(`  [${tag}] read rev =`, seen?.currentRevision);
          await sleep(150); // 人为制造窗口
          const upd = await tx.$queryRaw<{ current_revision: number }[]>`
            UPDATE questionnaire_instances
               SET "current_revision" = "current_revision" + 1
             WHERE id = ${inst.id}::uuid
               AND "current_revision" = ${seen!.currentRevision}
            RETURNING "current_revision"
          `;
          console.log(`  [${tag}] updated rows =`, upd.length);
          if (upd.length === 0) throw new Error(`[${tag}] CONFLICT`);
          return { tag, newRev: upd[0]!.current_revision };
        });
      } catch (e) {
        return { tag, error: e instanceof Error ? e.message : String(e) };
      }
    };

    const res = await Promise.all([worker("w1"), worker("w2")]);
    console.log("B) results:", JSON.stringify(res));
    const finalB = await prisma.questionnaireInstance.findUnique({
      where: { id: inst.id },
      select: { currentRevision: true },
    });
    console.log("B) final revision =", finalB?.currentRevision, "(期望 2，即一方冲突)");
    await deleteTestInstance(inst.id);
    void CTX;
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("FAILED", e);
    await prisma.$disconnect();
    process.exit(1);
  });
