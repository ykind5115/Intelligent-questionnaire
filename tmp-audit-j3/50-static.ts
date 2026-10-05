/**
 * 审计脚本 E：静态符合性检查（D3 / D5 / D9 / D10 / D12 / D13 + 接口清单）。
 *
 * 不修改任何文件，只读源码与文档后输出结论。
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  addQuestion,
  addSection,
  moveQuestion,
  removeQuestion,
  updateQuestion,
  updateSection,
  uuidIdFactory,
} from "../src/modules/questionnaire/operations/index.js";
import { questionnaireSchema } from "../src/modules/questionnaire/schema/questionnaire.schema.js";
import { prisma } from "../src/database/client.js";

const ROOT = process.cwd();
const results: Record<string, unknown> = {};
const log = (...a: unknown[]) => console.log(...a);

// ============================================================
// D3：Operation 层是否真的是纯函数
// ============================================================

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function sampleSchema() {
  return questionnaireSchema.parse({
    id: "schema-static-check",
    title: "静态检查问卷",
    version: 1,
    sections: [
      {
        id: "sec_a",
        title: "分组A",
        order: 1,
        questions: [
          { id: "q_a1", type: "text", title: "文本题", required: true, order: 1 },
          {
            id: "q_a2",
            type: "single_choice",
            title: "单选题",
            required: false,
            order: 2,
            options: [
              { id: "o1", label: "甲", value: "甲", order: 1 },
              { id: "o2", label: "乙", value: "乙", order: 2 },
            ],
          },
        ],
      },
      {
        id: "sec_b",
        title: "分组B",
        order: 2,
        questions: [{ id: "q_b1", type: "boolean", title: "布尔题", required: false, order: 1 }],
      },
    ],
  });
}

function testPure() {
  const raw = sampleSchema();
  const frozen = deepFreeze(structuredClone(raw) as object) as ReturnType<typeof sampleSchema>;
  const before = JSON.stringify(raw);

  const cases: { name: string; run: () => { schema: unknown } }[] = [
    {
      name: "addSection",
      run: () => addSection(frozen, { title: "新分组" }, uuidIdFactory),
    },
    {
      name: "addQuestion",
      run: () =>
        addQuestion(
          frozen,
          { sectionId: "sec_a", type: "text", title: "新题" },
          uuidIdFactory
        ),
    },
    {
      name: "updateSection",
      run: () => updateSection(frozen, { sectionId: "sec_a", title: "改名后" }),
    },
    {
      name: "updateQuestion",
      run: () => updateQuestion(frozen, { questionId: "q_a1", title: "改题干" }, uuidIdFactory),
    },
    {
      name: "removeQuestion",
      run: () => removeQuestion(frozen, { questionId: "q_a1" }),
    },
    {
      name: "moveQuestion",
      run: () =>
        moveQuestion(frozen, { questionId: "q_b1", targetSectionId: "sec_a" }),
    },
  ];

  return cases.map((c) => {
    let ok = false;
    let error: string | null = null;
    let returnsNewObject = false;
    try {
      const out = c.run();
      ok = true;
      returnsNewObject = out.schema !== (frozen as unknown);
    } catch (e) {
      error = (e as Error).message;
    }
    return {
      operation: c.name,
      ranWithoutMutatingFrozenInput: ok,
      returnsNewSchemaObject: returnsNewObject,
      inputUnchanged: JSON.stringify(raw) === before,
      error,
    };
  });
}

results["D3_operationPurity_executable"] = testPure();

// 静态依赖检查：Operation 目录不得依赖 HTTP / DB / AI
const opDir = join(ROOT, "src/modules/questionnaire/operations");
const forbidden = [
  { pattern: /express/, label: "express(HTTP)" },
  { pattern: /prisma|Prisma/, label: "Prisma" },
  { pattern: /\/app\//, label: "app 层" },
  { pattern: /fetch\s*\(/, label: "fetch(网络)" },
  { pattern: /ai\//, label: "AI 模块" },
  { pattern: /process\.env/, label: "process.env" },
];
results["D3_operationLayer_dependencyScan"] = readdirSync(opDir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => {
    const src = readFileSync(join(opDir, f), "utf8");
    // 只看真正的 import/export-from 语句，避免把注释里的词当成依赖
    const importLines = src
      .split("\n")
      .filter((l) => /^\s*(import|export)\b/.test(l) || /^\s*\}\s*from\s+"/.test(l))
      .join("\n");
    const hits = forbidden
      .filter((x) => x.pattern.test(importLines))
      .map((x) => x.label);
    return { file: `src/modules/questionnaire/operations/${f}`, forbiddenHits: hits };
  });

// ============================================================
// D5：固定 AI 用例集是否存在
// ============================================================
const fixturesDir = join(ROOT, "tests/fixtures");
results["D5_aiCaseFixtures"] = {
  "tests/fixtures/ai-cases exists": existsSync(join(fixturesDir, "ai-cases")),
  "tests/fixtures contents": existsSync(fixturesDir) ? readdirSync(fixturesDir) : null,
  requiredBy: "docs/09-review-and-decisions.md D5/§7.2；docs/06-proj_init.md 第 57 节",
};

// ============================================================
// D10：prisma / @prisma/client 版本锁定
// ============================================================
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const installed = (p: string) =>
  JSON.parse(readFileSync(join(ROOT, "node_modules", p, "package.json"), "utf8"))
    .version as string;
results["D10_prismaVersionLock"] = {
  "package.json dependencies.@prisma/client": pkg.dependencies["@prisma/client"],
  "package.json devDependencies.prisma": pkg.devDependencies["prisma"],
  "installed @prisma/client": installed("@prisma/client"),
  "installed prisma": installed("prisma"),
  "adapter (不受 D10 约束)": pkg.dependencies["@prisma/adapter-pg"],
};

// ============================================================
// D12 / D13：模型与配置
// ============================================================
const envSrc = readFileSync(join(ROOT, "src/config/env.ts"), "utf8");
const envExample = readFileSync(join(ROOT, ".env.example"), "utf8");
const envFile = readFileSync(join(ROOT, ".env"), "utf8");
results["D12_modelConfig"] = {
  "env.ts AI_MODEL default": /AI_MODEL:\s*z\.string\(\)\.default\("([^"]+)"\)/.exec(envSrc)?.[1],
  ".env.example AI_MODEL": /AI_MODEL=(\S*)/.exec(envExample)?.[1] ?? null,
  ".env AI_MODEL": /AI_MODEL=(\S*)/.exec(envFile)?.[1] ?? null,
  "其他模型名出现处(全仓 grep)": "见下 D13_hardcodedScan",
};

const srcFiles: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".ts") || name.endsWith(".json")) srcFiles.push(p);
  }
})(join(ROOT, "src"));

const scan = srcFiles.map((f) => {
  const rel = f.replace(ROOT + "\\", "").replace(/\\/g, "/");
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  const publicUrls: string[] = [];
  const deepseek: string[] = [];
  const processEnv: string[] = [];
  const fetches: string[] = [];
  lines.forEach((line, i) => {
    if (/https?:\/\/[a-z0-9.-]+/i.test(line)) publicUrls.push(`${i + 1}: ${line.trim()}`);
    if (/deepseek/i.test(line)) deepseek.push(`${i + 1}: ${line.trim()}`);
    if (/process\.env/.test(line)) processEnv.push(`${i + 1}: ${line.trim()}`);
    if (/\bfetch\s*\(/.test(line)) fetches.push(`${i + 1}: ${line.trim()}`);
  });
  return { file: rel, publicUrls, deepseek, processEnv, fetches };
});

results["D13_hardcodedScan"] = scan.filter(
  (s) =>
    s.publicUrls.length ||
    s.deepseek.length ||
    s.processEnv.length ||
    s.fetches.length
);

// ============================================================
// D9：幂等实现（先查后插 + UNIQUE 兜底）
// ============================================================
const svcSrc = readFileSync(
  join(ROOT, "src/modules/questionnaire/service/questionnaire.service.ts"),
  "utf8"
);
const migration = readFileSync(
  join(ROOT, "prisma/migrations/20261005034428_init/migration.sql"),
  "utf8"
);
results["D9_idempotency"] = {
  先查后插: /findExecutedOperation/.test(svcSrc),
  operation_id唯一约束: /ai_tool_executions"[\s\S]*?operation_id/.test(migration) &&
    /ai_tool_executions_operation_id_key/.test(migration),
  一次Tool一个operation_id: /const operationId = newId\(\); \/\/ D9/.test(
    readFileSync(join(ROOT, "src/modules/ai/orchestrator/ai.orchestrator.ts"), "utf8")
  ),
};

// ============================================================
// 接口清单：文档 P0 接口 vs 实际路由
// ============================================================
const routesSrc =
  readFileSync(join(ROOT, "src/modules/ai/controller/ai.controller.ts"), "utf8") +
  readFileSync(join(ROOT, "src/modules/ai/routes.ts"), "utf8") +
  readFileSync(join(ROOT, "src/modules/questionnaire/controller/instance.controller.ts"), "utf8") +
  readFileSync(join(ROOT, "src/modules/questionnaire/controller/template.controller.ts"), "utf8") +
  readFileSync(join(ROOT, "src/modules/dispatch/routes.ts"), "utf8") +
  readFileSync(join(ROOT, "src/modules/response/routes.ts"), "utf8") +
  readFileSync(join(ROOT, "src/modules/review/routes.ts"), "utf8");

results["API_surface"] = {
  "POST /ai/conversations/{id}/commit (P0)": /"\/conversations\/:id\/commit"/.test(routesSrc),
  "SSE 流式消息端点 (05 §10.4)": /event-stream/.test(
    srcFiles.map((f) => readFileSync(f, "utf8")).join("\n")
  ),
  "PATCH /questionnaire-instances/{id} (05 §11)": /router\.patch\(/.test(
    readFileSync(join(ROOT, "src/modules/questionnaire/controller/instance.controller.ts"), "utf8")
  ),
  "PATCH /questionnaire-templates/{t}/versions/{v} (05 §9.7)": /router\.patch\(/.test(
    readFileSync(join(ROOT, "src/modules/questionnaire/controller/template.controller.ts"), "utf8")
  ),
  "withdraw 侧字段(dispatch_tasks.withdrawn_at/by) 是否存在": {
    withdrawn_at: /withdrawn_at/.test(migration),
    withdrawn_by: /withdrawn_by/.test(migration),
  },
  "questionnaire_responses.status 是否可表达 withdrawn": /withdrawn/.test(migration),
};

// ============================================================
// 汇总
// ============================================================
log(JSON.stringify(results, null, 2));
await prisma.$disconnect();
