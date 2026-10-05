/**
 * 探针 8：AI 会话消息序号并发（决策 D9 的 appendMessage）。
 *
 * 现状（读代码得出的怀疑）：appendMessage 在事务里「先取 max(sequence_no) 再插入」，
 * (conversation_id, sequence_no) 有唯一约束，但**没有任何重试**。
 *
 * 用法：pnpm exec tsx tmp-audit-j2/08-append-message-concurrency.ts [并发度] [轮数]
 */
import { prisma } from "../src/database/client.js";
import { aiConversationRepository } from "../src/modules/ai/repository/ai-conversation.repository.js";
import { newId } from "../src/shared/utils/id.js";
import {
  USERS,
  deleteTestConversation,
} from "../tests/integration/questionnaire/helpers.js";

const N = Number(process.argv[2] ?? 5);
const ROUNDS = Number(process.argv[3] ?? 5);

async function oneRound(round: number) {
  const conversationId = newId();
  await prisma.aiConversation.create({
    data: {
      id: conversationId,
      userId: USERS.dispatcher,
      scene: "modify_questionnaire",
      status: "active",
    },
  });

  const settled = await Promise.allSettled(
    Array.from({ length: N }, (_, i) =>
      aiConversationRepository.appendMessage({
        conversationId,
        role: "user",
        content: `并发消息-${round}-${i}`,
      })
    )
  );

  const ok = settled.filter((s) => s.status === "fulfilled").length;
  const errors = settled
    .filter((s) => s.status === "rejected")
    .map((s) => {
      const e = (s as PromiseRejectedResult).reason as {
        code?: string;
        message?: string;
        name?: string;
      };
      return {
        code: e?.code ?? e?.name ?? "UNKNOWN",
        message: (e?.message ?? String(e)).slice(0, 120),
      };
    });

  const rows = await prisma.aiMessage.findMany({
    where: { conversationId },
    orderBy: { sequenceNo: "asc" },
    select: { sequenceNo: true },
  });
  const seqs = rows.map((r) => r.sequenceNo);

  const passed = errors.length === 0 && ok === N && rows.length === N;
  console.log(
    JSON.stringify({
      round,
      passed,
      concurrency: N,
      fulfilled: ok,
      rejected: errors.length,
      errorCodes: [...new Set(errors.map((e) => e.code))],
      firstError: errors[0] ?? null,
      insertedRows: rows.length,
      sequenceNos: seqs,
      hasDuplicateOrGap:
        new Set(seqs).size !== seqs.length ||
        (seqs.length > 0 && seqs[seqs.length - 1] !== seqs.length),
    })
  );

  await deleteTestConversation(conversationId);
  return passed;
}

async function main() {
  let allPassed = true;
  for (let r = 1; r <= ROUNDS; r++) {
    if (!(await oneRound(r))) allPassed = false;
  }
  console.log(
    `\n=== 探针8 结论：${allPassed ? "appendMessage 并发下全部成功" : "appendMessage 并发下出现失败（无重试）"} ===`
  );
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
