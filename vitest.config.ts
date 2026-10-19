import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    /**
     * 全局建 / 删「已发布的基准模板」。
     *
     * 为什么需要：测试原先依赖 `pnpm db:seed` 造出来的种子模板，
     * 去找「任意一个已发布版本」。一旦需求方（合理地）把模板全部停用，
     * 93 个测试会同时失败，而失败原因与它们要验证的行为毫无关系。
     * 现在改为测试自备基准数据、跑完删除，结果只取决于代码。
     */
    globalSetup: ["tests/global-setup.ts"],
    // 集成测试直接使用本地 Prisma Postgres，
    // 顺序执行避免多个测试文件并发写同一份实例数据而互相干扰
    fileParallelism: false,
    testTimeout: 30_000,
    // 清理钩子需要按外键顺序删除多张表的关联数据，
    // 每个实例要多次串行往返；默认 10s 在累积了较多测试数据时会超时。
    hookTimeout: 60_000,
  },
});
