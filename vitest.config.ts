import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 集成测试直接使用本地 Prisma Postgres，
    // 顺序执行避免多个测试文件并发写同一份实例数据而互相干扰
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
