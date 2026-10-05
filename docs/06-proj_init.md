# 智能问卷系统

## TypeScript 项目初始化与目录结构设计 V1.0

---

# 1. 文档概述

## 1.1 文档目的

本文档用于确定智能问卷系统 V1 的 TypeScript 项目初始化方案、工程目录结构、模块划分、依赖方向以及各层职责。

本设计基于前序文档：

```text
《智能问卷系统 RPD V1.0》
《智能问卷系统 系统架构设计说明书 V1.0》
《Questionnaire Schema + AI Tool Calling 设计说明书 V1.0》
《智能问卷系统 数据库设计说明书 V1.0》
《智能问卷系统 API 接口设计说明书 V1.0》
```

项目技术基础（决策 D4 定版）：

```text
TypeScript
Node.js
Express
Prisma
PostgreSQL
Zod
```

V1 的核心业务仍然围绕：

```text
AI生成问卷
AI修改问卷
```

展开。

---

# 2. 项目工程目标

项目初始化阶段不追求一次性搭建复杂企业级框架。

V1 的工程目标是：

> **建立清晰、可扩展、适合个人开发和学习的模块化单体项目。**

重点保证：

```text
Controller
    ↓
Service
    ↓
Repository
    ↓
Database
```

以及：

```text
AI Orchestrator
    ↓
AI Tools
    ↓
Service
    ↓
Repository
```

两条链路都能够清晰运行。

---

# 3. 技术架构

推荐基础技术组合：

```text
Runtime
Node.js

Language
TypeScript

HTTP
Express

Database
PostgreSQL

ORM
Prisma

Validation
Zod

AI
LLM API

Streaming
SSE

Package Manager
pnpm
```

技术栈在决策 D4 中一次性定版，**不再保留备选**：

```text
HTTP            Express
ORM             Prisma
Database        PostgreSQL
Validation      Zod
Package Manager pnpm
```

> **取代原文：** 原文写的是“这里不强制锁定某一个 Web 框架或 ORM”，
> 以及“即使未来把 Express 换成 Fastify，或者把 Prisma 换成 Drizzle，也不会导致业务层整体重写”。
> **这两句已作废（决策 D4）。**
>
> 保留其合理内核：分层与依赖方向依然要求业务层不感知具体 Web 框架与 ORM，
> 但**选型本身已经锁定**，实现阶段不再做框架对比、不保留 Drizzle / 原生 `pg` 方案。

---

# 3A. 版本锁定（决策 D10）

（决策来源：`09-review-and-decisions.md` D10 / 第 12.3 节）

```text
prisma            7.10.0     ← 锁定
@prisma/client    7.10.0     ← 锁定
```

理由：

```text
latest 标签当前指向 8.0.0-rc.x（预发布版本）
生产项目不应依赖预发布版本
```

安装方式（必须带版本号，禁止 `@latest`）：

```bash
pnpm add -D prisma@7.10.0
pnpm add @prisma/client@7.10.0
```

> **取代原文：** 原文第 52 节只写了“PostgreSQL driver / ORM”这类泛指，没有锁定版本。
> 以本节为准：Prisma 相关依赖一律写死 `7.10.0`，`package.json` 中不得出现 `@latest`。
> 该版本**锁定**（决策 D10）：`package.json` 中写精确版本 `7.10.0`，
> 不加 `^`、不用 `~`、不用 `@latest`，避免重新安装时被拉到 8.0 RC。

---

# 3B. pnpm 11 拦截 Prisma 构建脚本（实测结论，必读）

（实测来源：`09-review-and-decisions.md` 第 12.4 节）

这是本机实测踩到的坑，**必须在第一次 `pnpm install` 之前处理**。

## 3B.1 现象

```text
$ pnpm add -D prisma@7.10.0
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @prisma/engines@7.10.0, prisma@7.10.0
```

pnpm 11 默认拦截依赖的构建脚本（preinstall / postinstall）。

一旦被拦截，连查看版本都会失败，因为 `pnpm exec` 会先做依赖状态校验：

```text
$ pnpm exec prisma -v
[ERROR] Command failed with exit code 1: pnpm install
```

## 3B.2 实测：哪些写法无效

| 写法 | 是否生效 |
| --- | --- |
| `package.json` → `pnpm.onlyBuiltDependencies` | ❌ 无效 |
| `pnpm-workspace.yaml` → `onlyBuiltDependencies` | ❌ 无效（能被读出，但不生效） |
| `pnpm-workspace.yaml` → **`allowBuilds` 映射** | ✅ **生效** |

## 3B.3 唯一有效写法

项目根目录 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  prisma: true
  '@prisma/engines': true
```

安装成功后可以看到：

```text
.../node_modules/@prisma/engines postinstall$ node scripts/postinstall.js
.../node_modules/@prisma/engines postinstall: Done
.../node_modules/prisma preinstall$ node scripts/preinstall-entry.js
.../node_modules/prisma preinstall: Done
```

## 3B.4 两条硬性要求

```text
1. 该文件必须在第一次 pnpm install 之前就存在
   → pnpm-workspace.yaml 属于项目初始化第一批创建的文件

2. 若已经 install 过且被拦截，仅加配置不生效
   → 必须删除 node_modules 后重新 pnpm install
   → pnpm rebuild 无效
```

---

# 3C. 本地数据库：prisma dev（决策 D7）

（决策来源：`09-review-and-decisions.md` D7 / 第 12.5 节）

本机**没有安装 PostgreSQL，也没有 Docker**（实测：无 `psql` / `pg_ctl`，5432 端口未监听；无 `docker` 命令）。

因此本地开发数据库由 Prisma 自带：

```text
pnpm exec prisma dev
    ↓
启动一个本地 Prisma Postgres 服务
    ↓
把 DATABASE_URL 指向该本地实例
```

要点：

```text
1. prisma dev 是 Prisma 7 的【正式命令】
   → 不需要 --preview-feature，也不需要管理员权限

2. 零安装
   → 不需要单独安装 PostgreSQL，不需要 Docker

3. 将来部署到服务器时
   → 只需把 DATABASE_URL 换成真实 PostgreSQL，代码与迁移脚本不需要改

4. Prisma 7 使用 WASM 查询编译器（Query Compiler: enabled）
   → 不再依赖下载原生二进制引擎，网络受限环境下更稳
```

`.env.example` 中的 `DATABASE_URL` 仍保留标准 PostgreSQL 连接串格式，便于将来切换：

```text
DATABASE_URL=postgresql://user:password@localhost:5432/questionnaire
```

## 3C.1 prisma dev 的实际用法（已实测）

```text
pnpm exec prisma dev -d          # -d = 后台运行，返回连接串
pnpm exec prisma dev ls          # 查看服务状态与实际 URL
pnpm exec prisma dev stop        # 停止
pnpm exec prisma dev rm          # 删除
```

启动后输出的连接串形如：

```text
postgres://postgres:postgres@localhost:51214/template1?sslmode=disable
```

**重要：迁移必须使用直连 TCP 地址，不要用 `prisma+postgres://` 代理地址。**

```text
prisma dev ls 会同时给出两个地址：

  DATABASE_URL : prisma+postgres://localhost:51213/?api_key=...
                 ← Accelerate 代理地址，用于应用运行时

  TCP          : postgres://postgres:postgres@localhost:51214/template1?sslmode=disable
                 ← 直连地址，迁移需要它
```

原因：

```text
prisma migrate dev 需要 shadow database 来做漂移检测，
而 shadow database 无法通过 Accelerate 代理创建，
因此 .env 中的 DATABASE_URL 必须是直连 TCP 地址。
```

端口是**随机分配**的，每次重建本地实例都可能变化，
因此每次换环境后都要重新执行 `prisma dev ls` 更新 `.env`。

---

# 3C2. Prisma 7 的其他重要变化（已实测，必读）

本文档早期版本按 Prisma 6 的习惯书写，Prisma 7 有四处关键变化，
**不知道这些会在第一次跑迁移时卡住**。

## 3C2.1 datasource 不再写 url

```prisma
// ❌ Prisma 6 的写法，Prisma 7 中会报错
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

```prisma
// ✅ Prisma 7 正确写法
datasource db {
  provider = "postgresql"
}
```

连接串改由项目根目录的 `prisma7.config.ts` 提供：

```ts
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  datasource: { url: process.env["DATABASE_URL"] },
});
```

**两个坑：**

```text
1. .env 不会被 Prisma 自动加载
   → 配置文件里必须显式 `import "dotenv/config"`

2. prisma db execute / migrate 不再接受 --url 参数
   → 传了会报 "The datasource URL configuration is read from
      the Prisma config file"，只能通过配置文件提供
```

## 3C2.2 generator 变了

```prisma
// ❌ 旧写法
generator client {
  provider = "prisma-client-js"
}

// ✅ Prisma 7 默认写法
generator client {
  provider = "prisma-client"
  output   = "../generated/prisma"
}
```

影响：

```text
1. 客户端代码生成到 output 指定的目录，
   必须从那里导入，而不是从 "@prisma/client" 导入：

     import { PrismaClient } from "../../generated/prisma/client.js";

2. generated/ 目录应加入 .gitignore，由 pnpm db:generate 重新生成；

3. 生成产物是 ESM（import 路径带 .js 后缀），
   与 package.json 的 "type": "module" 一致。
```

## 3C2.3 运行时需要 driver adapter

Prisma 7 不再内置数据库驱动，需要显式安装并传入 adapter：

```text
pnpm add @prisma/adapter-pg pg
```

```ts
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
export const prisma = new PrismaClient({ adapter });
```

## 3C2.4 pnpm 会自动往 pnpm-workspace.yaml 写占位行

检测到未放行的构建脚本时，pnpm 会自动追加：

```yaml
allowBuilds:
  esbuild: set this to true or false
```

**这不是放行**，必须手动改成 `true`，否则安装持续失败。

本项目实际需要放行三个包：

```yaml
allowBuilds:
  prisma: true
  '@prisma/engines': true
  esbuild: true      # tsx / vitest 依赖它，极易漏掉
```

## 3C2.5 已实测通过的最小链路

```text
pnpm install
    ↓
pnpm exec prisma validate           → schema 合法
    ↓
pnpm exec prisma dev -d             → 本地 Postgres 就绪
    ↓
pnpm exec prisma migrate dev --name init   → 12 张表建立
    ↓
pnpm exec prisma generate           → 客户端生成到 generated/prisma
    ↓
pnpm db:seed                        → 测试数据写入
    ↓
pnpm dev                            → /healthz 返回 db: up
```

## 3C2.6 两个会浪费大量时间的坑（已实测）

### 坑一：本地 Prisma Postgres 忽略连接串里的数据库名

实测：

```text
postgres://postgres:postgres@localhost:51214/template1      → current_database() = template1
postgres://postgres:postgres@localhost:51214/questionnaire  → current_database() = template1
postgres://postgres:postgres@localhost:51214/postgres       → current_database() = template1
postgres://postgres:postgres@localhost:51214/whatever       → current_database() = template1
```

即 `prisma dev` 起的本地实例**只有一个真实数据库 `template1`**，
连接串里的库名被忽略（连不存在的库名也能连上）。

后果：

```text
1. 换库名不会换到「干净的库」——你面对的始终是同一个库；
2. 迁移历史混乱时，必须直接清空 public schema：

   DROP SCHEMA public CASCADE;
   CREATE SCHEMA public;

3. 不要试图靠「新建一个数据库」来重置本地环境，那是无效操作。
```

因此 `.env` 里建议直接写 `template1`，与实际情况一致，避免误解。

迁内网换成真实 PostgreSQL 后，这个行为**不再存在**，
届时库名是真实生效的。

### 坑二：`current_schema` 是 PostgreSQL 保留字

`questionnaire_instances.current_schema` 这个列名与 PostgreSQL 内置函数
`current_schema()` 同名。在原生 SQL 里必须加引号：

```sql
-- ❌ 语法错误：syntax error at or near "current_schema"
UPDATE questionnaire_instances
   SET current_schema = $1::jsonb
 WHERE id = $2;

-- ✅ 正确
UPDATE questionnaire_instances
   SET "current_schema"   = $1::jsonb,
       "current_revision" = "current_revision" + 1
 WHERE id = $2
   AND "current_revision" = $3
RETURNING "current_revision";
```

乐观锁用的是原生 SQL（04 文档第 37 节），因此这条必须记住。

> 是否要改列名以避开保留字？**不改。**
> 理由：Prisma 通过 model 访问时不存在这个问题，
> 只有原生 SQL 需要加引号；而改名会导致 04 文档、迁移与既有数据全部变动，
> 收益远小于成本。

---

# 3D. 依赖清单

（决策来源：`09-review-and-decisions.md` D4 / D10；具体版本在编码时写入 `package.json`）

运行时依赖：

```text
express                    HTTP 框架（决策 D4）
zod                        请求 / Tool 参数 / Schema 校验
@prisma/client@7.10.0      数据库访问（决策 D10）
uuid                       UUID v7 生成
dotenv                     环境变量
（日志库、LLM HTTP 客户端在编码阶段选定）
```

开发依赖：

```text
typescript
tsx                        直接运行 .ts
prisma@7.10.0              CLI（决策 D10）
@types/node
@types/express
eslint + typescript-eslint
prettier
（测试框架：node:test 或 vitest，编码阶段定）
```

关于 `uuid` 与 UUID v7：

```text
1. 项目统一使用 UUID v7（时间有序、索引友好），与 04-database_design.md 一致
2. Node 内置的 crypto.randomUUID() 只生成 v4，因此需要引入 uuid 包
3. 用法：
       import { v7 as uuidv7 } from 'uuid';
       const id = uuidv7();
4. 类型声明以所选大版本为准：
   若该版本不自带 .d.ts，需补 @types/uuid；
   注意 @types/uuid 在较新的 uuid 版本上已被标记为冗余，安装前先确认
5. AI 侧的 operation_id 同样由 UUID v7 生成
   （决策 D9：一次 Tool 调用一个 operation_id）
```

> **取代原文：** 原文第 52 节的“Node.js HTTP framework”“PostgreSQL driver / ORM”等泛指表述，
> 以本节为准收敛为 **Express + Prisma**。

---

# 3E. 本机环境实测（初始化前确认）

（实测来源：`09-review-and-decisions.md` 第 12.1 / 12.2 节）

已具备：

| 组件 | 版本 | 状态 |
| --- | --- | --- |
| Node.js | v22.22.1 | ✅ |
| pnpm | 11.0.9 | ✅ |
| npm | 10.9.4 | ✅ |
| Git | 2.53.0 | ✅ |

未安装：

```text
PostgreSQL   ❌ 无 psql / pg_ctl / 服务，5432 端口未监听
Docker       ❌ 无 docker 命令，无安装目录
```

结论：

```text
1. 数据库走 prisma dev（3C），不需要安装 PostgreSQL / Docker
2. pnpm 11 需要 3B 的 allowBuilds 配置，否则 Prisma 装不起来
3. npm registry 指向 https://registry.npmmirror.com/（国内镜像），依赖安装正常
4. 只装 prisma CLI 时 @prisma/client 显示 "Not found" 属正常，需单独安装
```

---

# 4. 推荐工程形态

V1 使用：

> **模块化单体（Modular Monolith）**

而不是微服务。

整体：

```text
┌──────────────────────────────┐
│            API               │
├──────────────────────────────┤
│ Template Module              │
│ Questionnaire Module         │
│ AI Module                    │
│ Dispatch Module              │
│ Response Module              │
│ Review Module                │
└───────────────┬──────────────┘
                │
                ↓
           PostgreSQL
```

所有模块运行在同一个 Node.js 进程中。

---

# 5. 为什么 V1 不采用微服务

当前项目规模并不需要：

```text
AI Service
Template Service
Questionnaire Service
Dispatch Service
Review Service
```

分别部署。

这样反而会增加：

```text
服务发现
网络通信
部署
日志
认证
事务
调试
```

等复杂度。

V1 更适合：

```text
一个后端项目
+
清晰模块边界
```

以后业务规模真正增长，再拆服务。

---

# 6. 顶层目录结构

推荐：

```text
questionnaire-system/
│
├── src/
│   ├── app/
│   ├── config/
│   ├── database/
│   ├── modules/
│   ├── shared/
│   └── main.ts
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/
│       └── ai-cases/          ← 固定 AI 测试用例集（决策 D5）
│
├── scripts/
│
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts                ← 测试数据（决策 D5）
│
├── pnpm-workspace.yaml        ← 必须第一批创建，内含 allowBuilds（见 3B）
├── .env
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
├── eslint.config.js
├── prettier.config.js
├── README.md
└── pnpm-lock.yaml
```

> **取代原文：** 原文的 `prisma/ 或 └── migrations/` 与“如果最终使用 Drizzle / 原生 `pg`，数据库目录可相应调整”
> **已作废（决策 D4）。**
>
> 数据库目录固定为 `prisma/`（含 `schema.prisma` / `migrations/` / `seed.ts`），
> 并新增 `pnpm-workspace.yaml`（见 3B，必须在首次 `pnpm install` 之前存在）。

---

# 7. src/main.ts

`main.ts` 是程序启动入口。

职责：

```text
加载配置
   ↓
初始化数据库
   ↓
创建 App
   ↓
启动 HTTP Server
```

例如逻辑：

```text
main()
 ├── loadConfig()
 ├── createDatabase()
 ├── createApp()
 └── startServer()
```

不应该在 `main.ts` 中写：

```text
业务逻辑
AI逻辑
数据库SQL
```

---

# 8. src/app

负责应用级配置。

目录：

```text
src/app/
├── app.ts
├── routes.ts
├── middleware.ts
└── error-handler.ts
```

---

## 8.1 app.ts

负责创建 HTTP Application。

例如：

```text
createApp()
```

负责注册：

```text
middleware
routes
error handler
```

---

## 8.2 routes.ts

集中注册模块路由：

```text
/api/v1/questionnaire-templates
/api/v1/questionnaire-instances
/api/v1/ai
/api/v1/dispatch-tasks
/api/v1/questionnaire-responses
```

---

## 8.3 middleware.ts

放置：

```text
认证
日志
请求ID
错误处理辅助
```

等全局中间件。

---

# 9. src/config

负责配置读取。

```text
src/config/
├── env.ts
├── database.ts
└── ai.ts
```

---

## 9.1 env.ts

统一读取环境变量。

例如：

```text
NODE_ENV
PORT
DATABASE_URL
AI_BASE_URL
AI_API_KEY
AI_MODEL
```

不要在业务代码里：

```ts
process.env.xxx
```

到处读取。

## 9.1a 环境变量说明（决策 D11 / D12 / D13）

| 变量 | 用途 | 内网迁移时 |
| --- | --- | --- |
| `NODE_ENV` | `development` / `production` | 改为 `production`，同时关闭测试鉴权 |
| `PORT` | 服务端口 | 按内网要求 |
| `DATABASE_URL` | PostgreSQL 连接串 | 指向内网 PG（本机是 `prisma dev` 给出的地址） |
| `AI_BASE_URL` | 模型服务端点 | 改为内网自研服务地址 |
| `AI_API_KEY` | 模型密钥 | 改为内网签发的凭证 |
| `AI_MODEL` | 模型标识 | 改为内网模型名 |

**这三条设计约束必须在 V1 就守住（D13）：**

```text
1. 不得硬编码 base URL / api key / model 名
2. 业务层不得出现 DeepSeek 专有概念，只依赖 LLMProvider 接口
3. 运行时不得调用公网服务
   （依赖安装与 DeepSeek API 属于构建/配置期依赖，不是运行时代码依赖）
```

## 9.1b 鉴权（决策 D11）

V1 不做注册/登录接口，使用固定测试账号。

```text
NODE_ENV=development
    → 启用开发态鉴权中间件：
      读取请求头 x-user-id: <userId> → 查 users 表 → 注入 CurrentUser
      （若缺少该头，使用默认的 dispatcher1 便于调试）

NODE_ENV=production
    → 必须存在真实鉴权中间件
    → 若缺失，服务应拒绝启动，
      绝不能静默降级为「人人可指定身份」
```

业务代码只依赖 `CurrentUser`：

```ts
interface CurrentUser {
  id: string;
  username: string;
  roles: string[];
}
```

因此后续接入真实鉴权时，只需替换 `src/shared/auth/auth.middleware.ts`，
权限校验与业务层零改动。测试账号见 `prisma/seed.ts`（第 3D 节 / 第 57 节）。

---

# 10. src/database

负责数据库基础设施。

```text
src/database/
├── client.ts          ← 创建并导出 PrismaClient 实例
├── transaction.ts     ← 包装 prisma.$transaction()
├── migrations/        ← 实际位置是 prisma/migrations/（见第 6 节 / 3C）
└── seeds/             ← 实际位置是 prisma/seed.ts（见第 6 节 / 3C）
```

> **注（按 Prisma 落地修正目录）：** 采用 Prisma 后，数据库基础设施的位置如下：
>
> ```text
> src/database/client.ts        PrismaClient 单例
> src/database/transaction.ts   prisma.$transaction() 封装
> prisma/schema.prisma          Schema 定义
> prisma/migrations/            迁移文件（Prisma Migrate 生成）
> prisma/seed.ts                种子数据（决策 D5）
> ```
>
> 原文把 `migrations/`、`seeds/` 放在 `src/database/` 下，属于框架未定时的一般性描述；
> **以 `prisma/` 为实际位置**（与 3C、第 6 节、第 62 节一致）。

---

## 10.1 client.ts

统一创建数据库连接。

例如：

```ts
export const db = ...
```

业务模块不负责初始化数据库连接。

---

## 10.2 transaction.ts

提供事务能力。

例如：

```ts
await transaction(async (tx) => {
  ...
});
```

用于：

```text
AI Tool
Questionnaire Revision
Template Version
Response Submit
```

等场景。

---

# 11. src/modules

这是整个项目最重要的目录。

采用：

> **按业务领域划分，而不是按技术类型把所有 Controller 放一起。**

推荐：

```text
src/modules/
├── template/
├── questionnaire/
├── ai/
├── dispatch/
├── response/
└── review/
```

---

# 12. Template Module

目录：

```text
src/modules/template/
├── controller/
│   └── template.controller.ts
│
├── service/
│   └── template.service.ts
│
├── repository/
│   └── template.repository.ts
│
├── domain/
│   ├── template.ts
│   ├── template-version.ts
│   └── template-status.ts
│
├── dto/
│   ├── create-template.dto.ts
│   └── create-template-version.dto.ts
│
└── routes.ts
```

---

# 13. Template Module 职责

负责：

```text
模板创建
模板查询
模板版本
模板发布
模板停用
```

不负责：

```text
AI Tool
问卷填写
审核
下发
```

---

# 14. Questionnaire Module

这是核心业务模块。

目录：

```text
src/modules/questionnaire/
├── controller/
│   └── questionnaire.controller.ts
│
├── service/
│   └── questionnaire.service.ts
│
├── repository/
│   └── questionnaire.repository.ts
│
├── domain/
│   ├── questionnaire.ts
│   ├── questionnaire-instance.ts
│   ├── questionnaire-revision.ts
│   └── questionnaire-status.ts
│
├── schema/
│   ├── questionnaire.schema.ts
│   ├── section.schema.ts
│   ├── question.schema.ts
│   └── option.schema.ts
│
├── dto/
│   ├── create-instance.dto.ts
│   ├── update-instance.dto.ts
│   └── confirm-instance.dto.ts
│
├── operations/
│   ├── add-section.ts
│   ├── add-question.ts
│   ├── update-section.ts
│   ├── update-question.ts
│   ├── remove-question.ts
│   └── move-question.ts
│
└── routes.ts
```

---

# 15. Questionnaire Module 为什么最核心

这个模块实际上承载：

```text
QuestionnaireSchema
```

以及：

```text
Instance
Revision
Question Operation
```

AI 只是使用这些能力。

也就是说：

```text
AI
 ↓
Questionnaire Module
```

而不是：

```text
Questionnaire
 ↓
AI
```

AI 是调用者。

问卷领域服务才是业务核心。

---

# 16. Questionnaire Schema 文件

例如：

```text
src/modules/questionnaire/schema/questionnaire.schema.ts
```

定义：

```ts
export const questionnaireSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  sections: z.array(sectionSchema),
  version: z.number(),
});
```

同时导出：

```ts
export type QuestionnaireSchema =
  z.infer<typeof questionnaireSchema>;
```

这样：

```text
Runtime Validation
+
TypeScript Type
```

由同一份定义产生。

---

# 17. Question Schema

例如：

```ts
export const questionTypeSchema = z.enum([
  "text",
  "textarea",
  "number",
  "single_choice",
  "multiple_choice",
  "date",
  "datetime",
  "boolean",
]);
```

再定义：

```ts
export const questionSchema = z.object({
  id: z.string(),
  type: questionTypeSchema,
  title: z.string(),
  description: z.string().optional(),
  required: z.boolean(),
  order: z.number(),
  options: z.array(optionSchema).optional(),
});
```

---

# 18. Questionnaire Operations

建议将问卷结构操作独立出来。

例如：

```text
operations/
├── add-question.ts
├── update-question.ts
├── remove-question.ts
```

每一个 Operation 表示一种明确的业务动作。

例如：

```ts
addQuestion(
  questionnaire,
  input
)
```

返回：

```text
新的 QuestionnaireSchema
```

这样 AI Tool 和人工编辑都可以复用。

---

# 19. 为什么 Operation 单独抽出来

因为：

```text
AI Tool
```

只是入口之一。

未来还有：

```text
人工编辑器
批量修改
导入
问卷复制
```

都会需要修改问卷结构。

如果把修改逻辑写死在：

```text
add-question.tool.ts
```

未来就会产生大量重复代码。

正确：

```text
            ┌── AI Tool
            │
            └── Controller
                    ↓
             QuestionnaireService
                    ↓
              Operation
                    ↓
                 Schema
```

---

# 20. AI Module

这是 V1 第二个核心模块。

目录：

```text
src/modules/ai/
├── controller/
│   └── ai.controller.ts
│
├── service/
│   ├── ai-conversation.service.ts
│   └── ai-generation.service.ts
│
├── orchestrator/
│   ├── ai.orchestrator.ts
│   ├── context-builder.ts
│   └── tool-runner.ts
│
├── providers/
│   ├── llm-provider.ts
│   └── deepseek.provider.ts
│
├── prompts/
│   ├── create-template.prompt.ts
│   └── modify-questionnaire.prompt.ts
│
├── tools/
│   ├── get-questionnaire.tool.ts
│   ├── add-section.tool.ts
│   ├── add-question.tool.ts
│   ├── update-section.tool.ts
│   ├── update-question.tool.ts
│   ├── remove-question.tool.ts
│   └── move-question.tool.ts
│
├── repository/
│   ├── ai-conversation.repository.ts
│   ├── ai-message.repository.ts
│   └── ai-tool-execution.repository.ts
│
├── domain/
│   ├── ai-conversation.ts
│   ├── ai-message.ts
│   └── ai-scene.ts
│
├── dto/
│   ├── create-conversation.dto.ts
│   └── send-message.dto.ts
│
└── routes.ts
```

---

# 21. AI Module 职责

AI Module 负责：

```text
AI会话
对话上下文
Prompt
LLM调用
Tool Calling
Tool执行协调
SSE
```

但它不应该自己负责：

```text
直接修改 questionnaire_instances
直接执行 SQL
直接管理 Revision
```

这些交给 Questionnaire Module。

---

# 22. AI Orchestrator

`ai.orchestrator.ts` 是 AI 模块的核心。

逻辑：

```text
handleMessage()
      ↓
获取 Conversation
      ↓
获取业务上下文
      ↓
构建 Prompt
      ↓
调用 LLM
      ↓
判断是否存在 Tool Call
      ↓
执行 Tool
      ↓
获取 Tool Result
      ↓
再次调用 LLM
      ↓
输出最终结果
```

---

# 23. Context Builder

`context-builder.ts` 负责准备模型所需上下文。

例如：

```text
create_template
```

上下文：

```text
conversation
current draft
history
tools
```

而：

```text
modify_questionnaire
```

上下文：

```text
conversation
instance
subject_info
current_schema
revision
history
tools
```

---

# 24. LLM Provider

不要让 Orchestrator 直接写：

```ts
fetch("some-llm-api")
```

推荐：

```ts
interface LLMProvider {
  chat(input: ChatInput): Promise<ChatResult>;

  chatStream(input: ChatInput): AsyncIterable<ChatEvent>;
}
```

然后：

```text
DeepSeekProvider
QwenProvider
OpenAIProvider
...
```

分别实现。

---

# 25. 为什么需要 Provider

这样未来更换模型时：

```text
DeepSeek
 ↓
Qwen
```

只需要改变：

```text
LLMProvider
```

而：

```text
AI Orchestrator
Tool
Questionnaire Service
```

不用重写。

---

# 26. Tool Registry

AI Tool 不建议由 Orchestrator 手写一堆：

```ts
if (toolName === "add_question") ...
```

建议：

```text
tools/
```

每个 Tool 独立实现。

再建立：

```text
tool-registry.ts
```

例如：

```ts
const toolRegistry = new Map([
  ["get_questionnaire", getQuestionnaireTool],
  ["add_section", addSectionTool],
  ["add_question", addQuestionTool],
]);
```

模型返回：

```text
toolName
```

之后：

```text
Registry
 ↓
找到 Tool
 ↓
执行
```

---

# 27. Tool 的工程接口

建议统一：

```ts
export interface AITool<
  TInput = unknown,
  TResult = unknown
> {
  name: string;

  description: string;

  inputSchema: unknown;

  execute(
    input: TInput,
    context: ToolContext
  ): Promise<TResult>;
}
```

其中：

```ts
interface ToolContext {
  userId: string;

  conversationId: string;

  operationId: string;

  scene: AiScene;

  targetType?: string;

  targetId?: string;
}
```

> **注（决策 D9）：** `ToolContext.operationId` 的粒度是**一次 Tool 调用一个 `operation_id`**。
> 它由 AI Orchestrator 为每个 Tool Call 生成 UUID v7 并写入日志，用于：
>
> ```text
> 1. 前端 tool_call_start / tool_call_result 事件配对
> 2. ai_tool_executions 的幂等判断（先查后插，不依赖 UNIQUE 冲突）
> ```
>
> 一次用户消息触发多次 Tool 调用时，会产生**多个不同的** `operation_id`，不是一条消息一个。
> 对应实现见 `03-questionnaire_schema_ai_tool_calling .md` 第 32 节。

---

# 28. Tool 不直接操作 Repository

推荐：

```text
Tool
 ↓
Service
 ↓
Repository
```

例如：

```text
add-question.tool.ts
```

内部：

```ts
return questionnaireService.addQuestion(
  input,
  context
);
```

不要：

```ts
db.questionnaire.update(...)
```

直接写在 Tool 内部。

---

# 29. AI 与 Questionnaire 的依赖关系

理想依赖方向：

```text
AI Module
    ↓
Questionnaire Module
```

例如：

```text
AI Tool
 ↓
QuestionnaireService
```

而不要形成：

```text
Questionnaire Module
       ↓
AI Module
       ↓
Questionnaire Module
```

这种循环依赖。

---

# 30. 如果 Questionnaire 需要 AI 怎么办

目前 V1：

> Questionnaire Module 不需要依赖 AI Module。

如果未来出现：

```text
QuestionnaireService
  ↓
AI优化问卷
```

也不要直接：

```text
questionnaire → ai
```

可以通过：

```text
Application Layer
```

或者事件机制进行协调。

V1 暂不需要处理这个复杂场景。

---

# 31. Dispatch Module

目录：

```text
src/modules/dispatch/
├── controller/
├── service/
├── repository/
├── domain/
├── dto/
└── routes.ts
```

职责：

```text
创建下发任务
指定调查人员
执行下发
查询任务
```

---

# 32. Response Module

目录：

```text
src/modules/response/
├── controller/
├── service/
├── repository/
├── domain/
├── dto/
├── validation/
└── routes.ts
```

职责：

```text
获取填写问卷
保存答案
提交问卷
```

---

# 33. Review Module

目录：

```text
src/modules/review/
├── controller/
├── service/
├── repository/
├── domain/
├── dto/
└── routes.ts
```

职责：

```text
审核
通过
退回
审核记录
```

---

# 34. src/shared

`shared` 负责真正跨模块的通用能力。

```text
src/shared/
├── errors/
├── logger/
├── auth/
├── types/
├── utils/
└── constants/
```

---

# 35. shared/errors

统一异常。

例如：

```ts
class AppError extends Error {
  code: string;
  statusCode: number;
}
```

派生：

```text
NotFoundError
PermissionError
ValidationError
ConflictError
```

业务模块统一抛出。

---

# 36. shared/logger

统一日志。

例如：

```ts
logger.info(...)
logger.warn(...)
logger.error(...)
```

需要包含：

```text
requestId
userId
operationId
conversationId
```

等上下文。

---

# 37. shared/auth

负责：

```text
用户认证上下文
权限检查基础能力
CurrentUser
```

例如：

```ts
interface AuthContext {
  userId: string;
  roles: string[];
}
```

具体权限规则由业务 Service 决定。

---

# 38. shared/types

只放真正跨领域的公共类型。

例如：

```text
Pagination
ApiResponse
UUID
Timestamp
```

不要把：

```text
QuestionnaireQuestion
```

放这里。

它属于 Questionnaire Domain。

---

# 39. DTO 与 Domain 分离

例如：

```text
dto/create-instance.dto.ts
```

负责：

```text
HTTP Request
```

而：

```text
domain/questionnaire-instance.ts
```

负责：

```text
业务对象
```

不要让 DTO 直接充当 Domain Model。

---

# 40. Controller 职责

Controller 只做：

```text
接收 Request
 ↓
参数校验
 ↓
调用 Service
 ↓
转换 Response
```

不要在 Controller 中：

```text
写 SQL
拼 Prompt
调用 LLM
修改 Schema
```

---

# 41. Service 职责

Service 是主要业务逻辑层。

例如：

```ts
questionnaireService.createInstance()
```

负责：

```text
权限
业务规则
模板读取
Schema 复制
Revision 创建
事务
```

---

# 42. Repository 职责

Repository 只负责数据持久化。

例如：

```ts
templateRepository.findById()
templateRepository.create()
templateRepository.update()
```

它不应该知道：

```text
AI
HTTP
Prompt
用户界面
```

---

# 43. Domain 层职责

Domain 保存业务规则和核心类型。

例如：

```text
questionnaire-status.ts
questionnaire-instance.ts
```

以及：

```text
canConfirm()
canDispatch()
canModify()
```

等规则。

---

# 44. Repository 与 Service 的依赖关系

固定：

```text
Controller
    ↓
Service
    ↓
Repository
    ↓
Database
```

禁止：

```text
Controller
    ↓
Repository
```

也禁止：

```text
Tool
    ↓
Repository
```

---

# 45. 模块依赖关系

V1 建议：

```text
               ┌──────────────┐
               │     AI       │
               └──────┬───────┘
                      │
                      ↓
             ┌─────────────────┐
             │  Questionnaire  │
             └───────┬─────────┘
                     │
          ┌──────────┼──────────┐
          ↓          ↓          ↓
      Dispatch    Response    Review
```

Template：

```text
Template
   ↓
Questionnaire
```

主要用于：

```text
Template Version
      ↓
Instance
```

---

# 46. 模块依赖原则

定义一个简单原则：

> **上层业务模块可以调用下层领域能力，但被调用模块不能反向依赖调用方。**

尤其是：

```text
AI
 ↓
Questionnaire
```

但：

```text
Questionnaire
 ↓
AI
```

不允许。

---

# 47. 数据库访问边界

只有：

```text
Repository
```

可以直接访问：

```text
Database
```

因此整个项目的数据流：

```text
HTTP
 ↓
Controller
 ↓
Service
 ↓
Repository
 ↓
DB
```

AI：

```text
LLM
 ↓
Tool
 ↓
Service
 ↓
Repository
 ↓
DB
```

---

# 48. AI 请求完整代码结构

例如：

```text
POST /ai/conversations/:id/messages
```

最终进入：

```text
ai.controller.ts
       ↓
ai-conversation.service.ts
       ↓
ai.orchestrator.ts
       ↓
LLMProvider
       ↓
ToolRegistry
       ↓
add-question.tool.ts
       ↓
questionnaire.service.ts
       ↓
questionnaire.repository.ts
       ↓
PostgreSQL
```

这是 V1 最重要的一条代码调用链。

---

# 49. AI 创建模板完整链路

```text
Browser
   ↓
POST /ai/conversations
   ↓
AI Controller
   ↓
AI Conversation Service
   ↓
创建 Draft Template
   ↓
Database
```

第二步：

```text
Browser
   ↓
POST /ai/conversations/:id/messages
   ↓
AI Orchestrator
   ↓
LLM
   ↓
add_section
   ↓
Questionnaire Service
   ↓
Draft Schema
   ↓
Database
```

最终：

```text
commit
 ↓
Template Version
```

---

# 50. AI 修改实例完整链路

```text
Browser
   ↓
POST /ai/conversations
scene=modify_questionnaire
   ↓
AI Conversation
   ↓
绑定 Instance
```

然后：

```text
Browser
   ↓
send message
   ↓
AI Orchestrator
   ↓
Context Builder
   ↓
读取 Instance
   ↓
LLM
   ↓
update_question
   ↓
QuestionnaireService
   ↓
Revision + 1
   ↓
Database
```

---

# 51. TypeScript 编译配置

推荐：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",

    "strict": true,

    "esModuleInterop": true,

    "skipLibCheck": true,

    "sourceMap": true,

    "outDir": "dist",
    "rootDir": "src"
  }
}
```

V1 强烈建议：

```text
strict = true
```

因为这个项目的数据结构很多：

```text
Schema
Tool Input
Tool Result
DTO
Domain Model
```

严格类型检查会非常有帮助。

---

# 52. package.json 基础依赖

技术栈已定版（决策 D4 / D10），完整依赖清单见 **3D 节**。这里只列出与原文的差异：

```text
typescript
tsx

express                    ← 取代原文的 “Node.js HTTP framework”
@types/express

zod

@prisma/client@7.10.0      ← 取代原文的 “PostgreSQL driver / ORM”
prisma@7.10.0              （devDependency，版本锁定，见 3A）

uuid                       ← UUID v7 生成

dotenv

logging library

LLM SDK / HTTP client
```

开发依赖：

```text
eslint
prettier
typescript
prisma@7.10.0
@types/node
test framework
```

> **取代原文：** 原文的“最终依赖可以根据具体框架选择”**已作废（决策 D4）**。
> 依赖按 3D 节与本节列出的具体包安装，**不保留 Drizzle / 原生 `pg` 备选**。

---

# 53. 环境变量

`.env.example`：

```text
NODE_ENV=development

PORT=3000

DATABASE_URL=postgresql://user:password@localhost:5432/questionnaire

# 决策 D12：V1 使用 DeepSeek（OpenAI 兼容协议）
AI_BASE_URL=
AI_API_KEY=
AI_MODEL=deepseek-v41-flash
```

说明：

```text
1. AI_MODEL 的确切拼写若与上游不一致，只改本行即可，代码不动。
2. 决策 D13：后期迁内网时，只需把上述三项改为内网自研服务的
   地址 / 凭证 / 模型名，无需修改业务代码。
3. DATABASE_URL 在本机开发时由 `prisma dev` 输出（决策 D7）；
   迁内网时改为内网 PostgreSQL 地址。
```

真实 `.env`：

```text
不提交 Git
```

---

# 54. ESLint

项目使用 ESLint。

重点规则：

```text
no-any
no-unused-vars
consistent-type-imports
no-floating-promises
```

具体规则可以根据项目实践逐步增加。

---

# 55. Prettier

统一：

```text
缩进
单引号 / 双引号
分号
行宽
尾逗号
```

避免多人或 AI 生成代码产生大量格式差异。

---

# 56. 测试目录

推荐：

```text
tests/
├── unit/
│   ├── questionnaire/
│   └── ai/
│
├── integration/
│   ├── questionnaire/
│   └── ai/
│
└── e2e/
```

---

# 57. V1 测试重点

最应该测试的不是：

```text
Controller 是否调用成功
```

而是：

### Questionnaire Operation

```text
add_question
update_question
remove_question
move_question
```

---

### Schema Validation

```text
合法问卷
非法问卷
非法题型
缺失 options
```

---

### AI Tool

```text
合法参数
非法参数
不存在问题
Revision Conflict
Permission Denied
```

---

### AI 核心流程

```text
自然语言
 ↓
Tool Call
 ↓
问卷发生变化
```

### 固定测试用例集与 AI 成功率评测（决策 D5）

（决策来源：`09-review-and-decisions.md` D5 / 第 7 节；用例形态与指标以此为准）

上面讲的是“测哪些东西”，本小节补上“**用什么测、怎么算通过**”。

```text
tests/fixtures/ai-cases/          ← 固定用例集
    case-001.create_template.json
    case-002.add_question.json
    case-003.modify_instance.json
    ...
```

每个用例的形态：

```json
{
  "id": "case-001",
  "scene": "create_template",
  "messages": [
    "我要做一个无人机黑飞核查问卷，主要调查有没有购买无人机、有没有飞过、在哪里飞过，还需要了解无人机的型号。"
  ],
  "expect": {
    "sections_min": 1,
    "must_contain_question_keywords": ["型号", "飞行"],
    "question_types_valid": true,
    "schema_valid": true
  }
}
```

测评指标（把“AI 生成 / 修改成功率”变成可量化指标）：

```text
1. Schema 合法性       必须 100%（生成结果必须通过 Zod 校验）
2. 关键点覆盖率        用户提到的要点是否都出现在问卷中
3. 工具调用正确率      是否使用最小必要 Tool，而不是整份重写
4. 多轮增量正确性      第二轮修改后，第一轮内容是否仍在
```

用例集的两个用途：

```text
训练环节
    用固定用例集反复跑 → 调整 Prompt / Tool 描述 → 再跑 → 对比成功率

验收环节
    用同一套用例集跑 → 记录成功率 → 作为 V1 验收证据
```

测试数据由 `prisma/seed.ts` 提供：

```text
用户：模板管理员 / 下发人员 / 调查人员 / 审核人员（roles 对应决策 D8）
模板：无人机黑飞核查问卷 V1（基本信息 / 无人机情况 / 飞行情况）
     宠物饲养规范核查问卷 V1
实例：张三 - 无人机黑飞核查（draft）
```

> 说明：本小节把“AI 生成 / 修改成功率”从人工主观判断变成可回归、可对比的指标
> （对应 `01-rpd.md` 第 18 / 25 节的验收要求）。

---

# 58. V1 开发建议

不要一开始同时创建：

```text
Template
AI
Dispatch
Response
Review
```

所有文件。

更适合你的实现方式是：

```text
第一步
Questionnaire Schema

↓

第二步
Questionnaire Operation

↓

第三步
Questionnaire Service

↓

第四步
Database

↓

第五步
AI Tool

↓

第六步
AI Orchestrator

↓

第七步
AI API

↓

第八步
完整业务流程
```

---

# 59. 推荐第一条开发闭环

真正开始写代码时，我建议第一个目标只做：

```text
用户：
“创建一个无人机黑飞核查问卷，
需要调查型号和飞行地点。”

↓

LLM

↓

add_section

↓

add_question

↓

add_question

↓

Database

↓

返回 QuestionnaireSchema

↓

前端显示问卷
```

先不要做：

```text
审核
权限
统计
复杂版本管理
复杂题型
附件
```

把第一条 AI → Tool → DB 链路打通。

---

# 60. 推荐第二条闭环

第一条跑通之后，再做：

```text
Template V1
    ↓
Instance
    ↓
AI
    ↓
“增加团伙关系调查”
    ↓
add_section
    ↓
add_question
    ↓
Revision + 1
```

然后验证：

```text
Template V1
没有变化

Instance
发生变化
```

这一步跑通，系统真正的核心设计就被验证了。

---

# 61. 不建议在 V1 加入的工程复杂度

暂时不要加入：

```text
微服务
事件总线
消息队列
DDD 大量抽象层
复杂 CQRS
Event Sourcing
插件市场
复杂 Agent Framework
```

原因不是这些东西不好，而是：

> 当前项目最大的未知数不是“系统能不能承受千万级请求”，而是“AI 能不能可靠地把自然语言转换成正确的问卷结构”。

先解决真正的未知问题。

---

# 62. V1 最终目录结构

综合前面所有设计，推荐最终结构：

```text
questionnaire-system/
│
├── src/
│   │
│   ├── main.ts
│   │
│   ├── app/
│   │   ├── app.ts
│   │   ├── routes.ts
│   │   ├── middleware.ts
│   │   └── error-handler.ts
│   │
│   ├── config/
│   │   ├── env.ts
│   │   ├── database.ts
│   │   └── ai.ts
│   │
│   ├── database/
│   │   ├── client.ts
│   │   ├── transaction.ts
│   │   ├── migrations/
│   │   └── seeds/
│   │
│   ├── modules/
│   │   │
│   │   ├── template/
│   │   │   ├── controller/
│   │   │   ├── service/
│   │   │   ├── repository/
│   │   │   ├── domain/
│   │   │   ├── dto/
│   │   │   └── routes.ts
│   │   │
│   │   ├── questionnaire/
│   │   │   ├── controller/
│   │   │   ├── service/
│   │   │   ├── repository/
│   │   │   ├── domain/
│   │   │   ├── schema/
│   │   │   ├── operations/
│   │   │   ├── dto/
│   │   │   └── routes.ts
│   │   │
│   │   ├── ai/
│   │   │   ├── controller/
│   │   │   ├── service/
│   │   │   ├── orchestrator/
│   │   │   ├── providers/
│   │   │   ├── prompts/
│   │   │   ├── tools/
│   │   │   ├── repository/
│   │   │   ├── domain/
│   │   │   ├── dto/
│   │   │   └── routes.ts
│   │   │
│   │   ├── dispatch/
│   │   │   ├── controller/
│   │   │   ├── service/
│   │   │   ├── repository/
│   │   │   ├── domain/
│   │   │   ├── dto/
│   │   │   └── routes.ts
│   │   │
│   │   ├── response/
│   │   │   ├── controller/
│   │   │   ├── service/
│   │   │   ├── repository/
│   │   │   ├── domain/
│   │   │   ├── validation/
│   │   │   ├── dto/
│   │   │   └── routes.ts
│   │   │
│   │   └── review/
│   │       ├── controller/
│   │       ├── service/
│   │       ├── repository/
│   │       ├── domain/
│   │       ├── dto/
│   │       └── routes.ts
│   │
│   └── shared/
│       ├── errors/
│       ├── logger/
│       ├── auth/
│       ├── types/
│       ├── constants/
│       └── utils/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/
│       └── ai-cases/          ← 固定 AI 测试用例集（决策 D5）
│
├── scripts/
│
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
│
├── pnpm-workspace.yaml
├── .env
├── .env.example
├── .gitignore
├── eslint.config.js
├── prettier.config.js
├── package.json
├── tsconfig.json
├── README.md
└── pnpm-lock.yaml
```

---

# 63. 模块依赖最终示意

```text
                         ┌──────────────┐
                         │   Frontend   │
                         └──────┬───────┘
                                │
                                ↓
                         ┌──────────────┐
                         │ Controllers  │
                         └──────┬───────┘
                                │
             ┌──────────────────┼──────────────────┐
             ↓                  ↓                  ↓
        Template            AI Module        Questionnaire
             │                  │                  │
             │                  ↓                  │
             │            AI Orchestrator          │
             │                  │                  │
             │             Tool Registry           │
             │                  │                  │
             │                  └──────────┬───────┘
             │                             ↓
             │                    QuestionnaireService
             │                             │
             └─────────────────────────────┤
                                           ↓
                                      Repository
                                           │
                                           ↓
                                       PostgreSQL
```

---

# 64. V1 核心代码边界

整个项目可以记住这句话：

> **Controller 负责接请求，Service 负责做业务，Repository 负责存数据，AI Orchestrator 负责组织模型调用，Tool 负责把 AI 的意图转换成业务操作，Questionnaire Domain 负责定义“问卷是什么以及怎样合法地修改它”。**

---

# 65. 最核心的依赖链

AI：

```text
User
 ↓
AI Controller
 ↓
AI Orchestrator
 ↓
LLM Provider
 ↓
Tool Registry
 ↓
Questionnaire Tool
 ↓
Questionnaire Service
 ↓
Repository
 ↓
PostgreSQL
```

普通接口：

```text
User
 ↓
Controller
 ↓
Questionnaire Service
 ↓
Repository
 ↓
PostgreSQL
```

两条链最终汇聚到：

```text
Questionnaire Service
```

这就是整个项目 V1 的核心业务层。

---

# 66. 初始化阶段的最终目标

当项目第一次启动时，不要求所有功能都已经完成。

第一阶段只要求：

```text
Node.js
 ↓
TypeScript
 ↓
HTTP Server
 ↓
PostgreSQL
 ↓
Questionnaire Schema
 ↓
QuestionnaireService
```

能够正常工作。

然后逐步加入：

```text
AI Provider
 ↓
AI Orchestrator
 ↓
Tool
```

最终形成完整 V1。

---

# 67. 项目开发顺序

推荐严格按照：

```text
01. 初始化 TypeScript 项目

02. 建立 PostgreSQL 连接

03. 建立 Migration

04. 实现 Questionnaire Schema

05. 实现 Questionnaire Operation

06. 实现 Questionnaire Repository

07. 实现 Questionnaire Service

08. 实现基础 REST API

09. 实现 LLM Provider

10. 实现 AI Conversation

11. 实现 Tool Registry

12. 实现第一个 Tool

13. 完成 AI → Tool → DB

14. 实现全部 V1 Tool

15. 实现 AI 创建问卷

16. 实现 Template → Instance

17. 实现 AI 修改 Instance

18. 接入下发 / 填写 / 审核

19. 实现撤回（withdraw）             ← 决策 D1
20. 实现扶正（promote）              ← 决策 D2：实例结构 → 模板草稿版本
21. 建立固定测试用例集与 seed 测试数据 ← 决策 D5
22. 实现人工编辑器（模板 / 实例）     ← 决策 D3：上线前兜底
```

> **补充说明（相对原文的顺序调整）：** 原文只排到第 18 步“接入下发 / 填写 / 审核”，
> 没有给撤回、扶正、测试用例集和人工编辑器留位置。以本节为准，在其后新增 19 ~ 22 步
> （决策 D1 / D2 / D5 / D3）。
>
> 其中：
>
> - 第 19 / 20 步紧跟第 18 步：撤回会改变实例状态机（`02-architecture.md` 第 21.3 / 21.4 节），
>   扶正依赖 Revision 的 diff 能力（决策 D2）；
> - 第 21 步（固定用例集 + seed 测试数据）既是测试资产，也是 Prompt 调优的输入，应尽早建立；
> - 第 22 步（人工编辑器）**不进入 V1 主线**，只在正式上线前作为兜底补齐（决策 D3），
>   它复用已有的 Operation 层与 REST API，不新增业务逻辑。

---

# 68. V1 工程验收标准

当以下流程可以完整运行时，项目工程骨架即基本成立：

```text
TypeScript
    ↓
HTTP API
    ↓
AI Conversation
    ↓
LLM
    ↓
Tool Calling
    ↓
QuestionnaireService
    ↓
Questionnaire Operation
    ↓
Repository
    ↓
PostgreSQL
```

同时能够验证：

```text
Template
不会被 Instance 修改污染

Instance
每次修改产生 Revision

AI
不能直接操作数据库

Tool
不能绕过业务 Service

Schema
能够被 TypeScript 和 Runtime Validation 同时约束
```

---

# 69. 设计总结

V1 采用：

```text
TypeScript
+
Node.js
+
Express                    ← 决策 D4
+
Prisma                     ← 决策 D4 / D10
+
模块化单体
+
PostgreSQL
+
JSONB Questionnaire Schema
+
Service / Repository
+
AI Orchestrator
+
Tool Calling
```

工程结构围绕：

```text
Template
Questionnaire
AI
Dispatch
Response
Review
```

六个主要业务模块展开。

其中最核心的两个模块：

```text
Questionnaire
AI
```

Questionnaire 是业务核心。

AI 是智能能力入口。

最终形成：

```text
自然语言
    ↓
AI
    ↓
Tool
    ↓
Questionnaire Service
    ↓
Questionnaire Schema
    ↓
Revision
    ↓
Database
```

这就是 V1 的核心技术闭环。

---

# 70. 下一阶段

经过前面的：

```text
RPD
 ↓
系统架构
 ↓
Schema / Tool
 ↓
数据库
 ↓
API
 ↓
TypeScript 项目结构
```

整个项目已经从产品层进入工程层。

下一阶段可以正式进入代码实现前最后一个非常关键的设计：

> **《AI Agent / Prompt / Tool Calling 详细设计说明书 V1.0》**

重点确定：

```text
System Prompt
+
create_template Agent
+
modify_questionnaire Agent
+
Tool Definitions
+
Tool Calling 循环
+
Context 构建
+
SSE 流式输出
+
模型异常处理
```

## 70.1 实际进展（相对原文的修正）

（修订来源：`09-review-and-decisions.md`）

原文把《AI Agent / Prompt / Tool Calling 详细设计说明书 V1.0》列为“下一阶段”。

实际情况是：该文档**已经完成**，编号为 `08-ai_agent_prompt_tool_calling.md`；
同时本轮评审产出了 `09-review-and-decisions.md`，记录决策 D1 ~ D10、设计缺口与修订动作。

```text
已完成：00 需求 / 01 RPD / 02 架构 / 03 Schema + Tool Calling
        04 数据库 / 05 API / 06 项目初始化 / 08 AI Agent + Prompt
评审产出：09 评审结论与决策记录（与 00 ~ 06 冲突时以其中的决策为准）
```

## 70.2 编码进展（按第 67 节编号对照）

```text
01. 初始化 TypeScript 项目                    ✅
02. 建立 PostgreSQL 连接                      ✅（prisma dev 本地实例）
03. 建立 Migration                            ✅（12 张表，含两处循环外键的 ALTER 处理）
04. 实现 Questionnaire Schema                 ✅（Zod，含 V1 不嵌套 section 的校验）
05. 实现 Questionnaire Operation              ✅（6 个纯函数 + 单元测试 44 例）
06. 实现 Questionnaire Repository             ✅（乐观锁 / Revision / 审计 / 幂等查询）
07. 实现 Questionnaire Service                ✅（权限 D8 + 状态校验 D1 + 事务 + 幂等 D9）
08. 实现基础 REST API                         ⬜ 待做（目前只有 /healthz 与 /api/v1/me）
09. 实现 LLM Provider                         ⬜
10. 实现 AI Conversation                      ⬜
11. 实现 Tool Registry                        ⬜
12. 实现第一个 Tool                           ⬜
13. 完成 AI → Tool → DB                       ⬜
14. 实现全部 V1 Tool                          ⬜
15. 实现 AI 创建问卷                          ⬜
16. 实现 Template → Instance                  ⬜（seed 中已手工演示该结构）
17. 实现 AI 修改 Instance                     ⬜
18. 接入下发 / 填写 / 审核                    ⬜
19. 撤回                                      ✅（Service 已实现并测试）
20. 扶正为模板版本                            ⬜（Service 待补 promote）
21. 固定用例集 + seed 测试数据                🟡 seed 已完成；AI 评测用例集待做
22. 人工编辑器（上线前兜底，决策 D3）         ⬜
```

**当前质量门禁：**

```text
pnpm typecheck   → 通过
pnpm test        → 68 个测试通过（44 单元 + 24 集成，真实数据库）
```
