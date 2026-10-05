/**
 * 探针 6：调度两个独立进程，各开一个事务并保持，用文件栅栏检测重叠。
 * 若 overlap=true → 服务端支持并发连接，可以做真实并发实验。
 * 若 overlap=false → 服务端只允许 1 条并发连接，本机环境无法制造数据库层并发。
 *
 * 用法：pnpm exec tsx tmp-audit-j2/06-two-proc-hold.ts
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, ".sync");
const tsxCli = path.join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");

function run(tag: string) {
  return new Promise<string>((resolve) => {
    const child = spawn(
      process.execPath,
      [tsxCli, path.join(here, "06-hold-worker.ts"), tag, dir, "3000"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("close", () =>
      resolve(out.trim() || `FAILED: ${err.trim().split("\n").slice(-2).join(" | ")}`)
    );
  });
}

async function main() {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const [a, b] = await Promise.all([run("A"), run("B")]);
  console.log("A:", a);
  console.log("B:", b);

  let pa: Record<string, unknown> = {};
  let pb: Record<string, unknown> = {};
  try {
    pa = JSON.parse(a);
  } catch { /* ignore */ }
  try {
    pb = JSON.parse(b);
  } catch { /* ignore */ }

  const overlap =
    pa["txOpened"] === true &&
    pb["txOpened"] === true &&
    pa["otherReady"] === true &&
    pb["otherReady"] === true;

  console.log(
    JSON.stringify(
      {
        两个进程同时打开事务: overlap,
        结论: overlap
          ? "服务端允许 ≥2 条并发连接 → 本机可做真实数据库并发实验"
          : "服务端/客户端只允许 1 条并发连接 → 本机无法制造数据库层并发",
      },
      null,
      2
    )
  );

  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
