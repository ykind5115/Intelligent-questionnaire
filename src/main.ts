/**
 * 程序启动入口。
 *
 * 依据 docs/06-proj_init.md 第 7 节：
 *   main.ts 只负责 加载配置 → 初始化数据库 → 创建 App → 启动 HTTP Server，
 *   不写业务逻辑、AI 逻辑、SQL。
 */
import { createApp } from "./app/app.js";
import { env } from "./config/env.js";
import { prisma } from "./database/client.js";

async function main(): Promise<void> {
  // 启动前验一次数据库连通性，避免服务起来了但一用就报错
  await prisma.$queryRawUnsafe("select 1");

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "智能问卷系统 已启动",
        `  环境      : ${env.NODE_ENV}`,
        `  地址      : http://127.0.0.1:${env.PORT}`,
        `  健康检查  : http://127.0.0.1:${env.PORT}/healthz`,
        `  模型      : ${env.AI_MODEL}`,
        "",
        "  开发态鉴权：请求头 x-user-id 指定用户（决策 D11）",
        "  未带该头时回退到 dispatcher1",
        "  账号 id 见 pnpm db:seed 输出",
        "",
      ].join("\n")
    );
  });

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`\n收到 ${signal}，正在关闭...`);
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(async (err) => {
  console.error("启动失败：", err);
  await prisma.$disconnect();
  process.exit(1);
});
