/**
 * 配置读取统一入口。
 *
 * 依据 docs/06-proj_init.md 第 9 节：
 * 业务代码不得直接到处读 process.env。
 */
import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL 未配置"),

  // 决策 D12 / D13：模型服务三项全部可配，迁内网只改这里
  AI_BASE_URL: z.string().default(""),
  AI_API_KEY: z.string().default(""),
  AI_MODEL: z.string().default("deepseek-v41-flash"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`环境变量校验失败：\n${issues}\n\n请参考 .env.example 配置 .env`);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === "production";
export const isDevelopment = env.NODE_ENV === "development";
