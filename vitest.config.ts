import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 集成测试直接使用本地 Prisma Postgres，
    // 顺序执行避免多个测试文件并发写同一份实例数据而互相干扰
    fileParallelism: false,
    testTimeout: 30_000,
    // 清理钩子需要按外键顺序删除多张表的关联数据，
    // 每个实例要多次串行往返；默认 10s 在累积了较多测试数据时会超时。
    hookTimeout: 60_000,
  },
});
