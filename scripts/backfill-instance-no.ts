// 一次性回填存量实例的 instance_no。
//
// 规则（与运行时发号一致）：
//   - 按**本地日**分组，组内按 created_at 升序，每组从 1 开始编号；
//   - 已有编号的实例一律跳过（幂等，可重复执行）；
//   - 回填后把 instance_no_counters 校准到「每组最大序号」，
//     否则下一次建案会从 1 重新发号而撞上刚回填的值。
//
// 编号逻辑本身在 operations/backfill-instance-no.ts 的纯函数里，
// 并有单元测试覆盖 —— 本脚本只负责读库、落库。
//
// 用法：
//   pnpm exec tsx scripts/backfill-instance-no.ts --dry-run
//   pnpm exec tsx scripts/backfill-instance-no.ts
import "dotenv/config";
import { prisma } from "../src/database/client.js";
import { planInstanceNoBackfill } from "../src/modules/questionnaire/operations/backfill-instance-no.js";

const DRY_RUN = process.argv.includes("--dry-run");
const SCOPE = "instance";

const instances = await prisma.questionnaireInstance.findMany({
  orderBy: { createdAt: "asc" },
  select: { id: true, title: true, instanceNo: true, createdAt: true },
});

const plan = planInstanceNoBackfill(instances);

console.log(
  `${DRY_RUN ? "[试运行] " : ""}待回填 ${plan.assignments.length} 条 / 共 ${instances.length} 个实例\n`
);
for (const a of plan.assignments) {
  console.log(`  ${a.no}  「${a.title}」`);
}

if (plan.unparsable.length > 0) {
  console.warn("\n以下实例的编号格式无法解析，已跳过（不会被改动）：");
  for (const u of plan.unparsable) {
    console.warn(`  ${u.instanceNo}  (${u.id})`);
  }
}

console.log("\n发号器校准（取每组最大序号）：");
const counters = await prisma.instanceNoCounter.findMany();
const targets: { day: string; target: number }[] = [];
for (const [day, maxSeq] of [...plan.counterTargets.entries()].sort()) {
  const existing = counters.find((c) => c.day === day);
  const target = Math.max(maxSeq, existing?.current ?? 0);
  targets.push({ day, target });
  console.log(
    `  ${day}  ${existing?.current ?? "(无行)"} → ${target}` +
      (existing && existing.current >= maxSeq ? "（无需改动）" : "")
  );
}

if (DRY_RUN) {
  console.log("\n试运行结束，未做任何修改。");
  await prisma.$disconnect();
  process.exit(0);
}

if (plan.assignments.length === 0) {
  console.log("\n没有需要回填的实例。");
} else {
  // 编号与发号器校准放在同一事务：避免中途失败留下「有编号但发号器没跟上」
  // 的状态，那会让下一次建案撞号。
  await prisma.$transaction(async (tx) => {
    for (const a of plan.assignments) {
      await tx.questionnaireInstance.update({
        where: { id: a.id },
        data: { instanceNo: a.no },
      });
    }
    for (const { day, target } of targets) {
      await tx.instanceNoCounter.upsert({
        where: { day_scope: { day, scope: SCOPE } },
        create: { day, scope: SCOPE, current: target },
        update: { current: target },
      });
    }
  });
  console.log(`\n已回填 ${plan.assignments.length} 条，并校准发号器。`);
}

const remaining = await prisma.questionnaireInstance.count({
  where: { instanceNo: null },
});
console.log(`剩余无编号实例: ${remaining} 个`);

await prisma.$disconnect();
