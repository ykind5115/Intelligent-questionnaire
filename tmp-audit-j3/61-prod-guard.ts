/**
 * 审计脚本 G：D11「生产环境若缺少真实鉴权中间件必须拒绝启动」。
 * 用法：NODE_ENV=production pnpm exec tsx tmp-audit-j3/61-prod-guard.ts
 */
import { createApp } from "../src/app/app.js";

console.log("NODE_ENV =", process.env["NODE_ENV"]);
try {
  createApp();
  console.log("结果：createApp() 成功 —— 生产环境没有拒绝启动（不符合 D11）");
} catch (e) {
  console.log("结果：createApp() 抛出异常 ——", (e as Error).message);
}
