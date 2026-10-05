// Prisma 7 配置
//
// Prisma 7 起，datasource 的 url 不再写在 schema.prisma 里，
// 而是在本文件中通过 defineConfig 提供。
// 且 .env 不会被 Prisma 自动加载，必须显式 import "dotenv/config"。
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
