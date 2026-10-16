# 一次性运维脚本

这里放**不参与运行时**的一次性脚本（数据回填、修复、导出）。

与 `prisma/seed.ts` 的区别：seed 是可反复执行的基础数据，这些脚本通常是
「某个版本升级时跑一次」的迁移辅助，因此各自都带 `--dry-run`。

```bash
# 存量实例的可读编号回填（幂等，可重复执行）
pnpm exec tsx scripts/backfill-instance-no.ts --dry-run   # 先看方案
pnpm exec tsx scripts/backfill-instance-no.ts             # 真正执行
```

`backfill-instance-no.ts` 的编号规则由
`src/modules/questionnaire/operations/backfill-instance-no.ts` 里的纯函数决定
（`planInstanceNoBackfill`），并有单元测试覆盖 ——
因为脚本本身是**全库扫描**，不适合在测试里真跑。
