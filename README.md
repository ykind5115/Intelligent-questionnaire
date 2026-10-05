# 智能问卷系统

> **面向调查业务的 AI 辅助问卷生成与动态编排系统**
>
> V1 核心：把「自然语言 → 结构化问卷」这条链路做可靠，
> 并支持针对具体案件临时调整问卷而不污染正式模板。

---

## 1. 这个项目解决什么问题

标准问卷模板只能覆盖某类业务的通用内容，但具体案件常有额外的重点调查需求。

例如做「无人机黑飞核查」时，某个调查对象需要重点关注：

- 是否存在团伙
- 与哪些人员存在关联
- 最近半年去过哪些地方

而这些字段标准模板里没有。为此单独建一个正式模板成本高，还会让模板库塞满只用过一次的模板。

本系统的做法是：

```text
标准模板
   ↓
创建问卷实例（克隆出独立结构）
   ↓
AI 按本次案件的特殊需求修改【实例】
   ↓
下发 → 填写 → 提交 → 审核
```

**核心原则：AI 只改实例，永不污染正式模板。**

同时，「创建问卷」和「临时修改问卷」都改为 NL2RESULT：
用户用自然语言描述需求，AI 通过**受控的结构化工具**修改问卷。

---

## 2. 当前进度

| 阶段 | 状态 |
| --- | --- |
| 需求 / 架构 / Schema / 数据库 / API / 项目结构 设计文档 | ✅ 完成 |
| 设计评审与决策固化（D1~D13） | ✅ 完成 |
| 工程骨架（依赖、TS 配置、Prisma schema、12 张表迁移） | ✅ 完成 |
| 测试数据 seed（4 个账号 + 2 套模板 + 1 个实例） | ✅ 完成 |
| 最小 HTTP 服务 + 开发态鉴权链路 | ✅ 完成 |
| Questionnaire Operation 层（add/update/remove/move，纯函数） | ✅ 完成 |
| Questionnaire Repository（乐观锁 + Revision + 审计） | ✅ 完成 |
| Questionnaire Service（权限 D8 + 状态校验 D1 + 事务 + 幂等 D9） | ✅ 完成 |
| 7 个 AI Tool + Tool Registry（含 JSON Schema 生成） | ✅ 完成 |
| LLM Provider 抽象 + DeepSeek 实现（决策 D12） | ✅ 完成 |
| AI Orchestrator（上下文 + Tool 循环 + 轮数上限 + 幂等） | ✅ 完成 |
| AI 会话落库（ai_conversations / ai_messages 读写与历史回放） | ✅ 完成 |
| REST API：模板 / 实例 / AI 会话 / 下发 / 填写 / 审核 | ✅ 完成 |
| 统一响应结构、错误码 → HTTP 状态码映射 | ✅ 完成 |
| 测试：44 单元 + 146 集成，共 190 例全绿 | ✅ 完成 |
| AI 评测用例集（决策 D5：量化「AI 生成/修改成功率」） | ⬜ 下一步 |
| 前端简要实现（结构树 + 对话 + 确认/下发） | ⬜ |
| 真实模型端到端验证（需 `AI_API_KEY`） | ⬜ |
| 人工编辑器（上线前兜底，决策 D3） | ⬜ 最后 |

---

## 3. 技术栈

```text
Runtime    Node.js 22
Language   TypeScript（strict）
HTTP       Express 5
ORM        Prisma 7.10.0（锁定版本，决策 D10）
Database   PostgreSQL（本机由 prisma dev 提供，决策 D7）
Validation Zod
Model      DeepSeek deepseek-v41-flash（决策 D12）
```

> **模型接口调用需要 `AI_API_KEY`。** 未配置时不会崩溃，
> 而是在真正调用模型时返回明确的 `AI_API_KEY_MISSING` 错误。
> Tool 层、Service 层与全部 110 个测试都不需要真实 Key
> （Orchestrator 测试用假 Provider 驱动）。

**已预留的迁移能力（决策 D13）**：后期整体迁到内网、模型接口换成自研服务时，
只需改 `.env` 里的 `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` 与 `DATABASE_URL`，
业务代码不动。

---

## 4. 快速开始

### 4.1 环境要求

```text
Node.js >= 22
pnpm    >= 11
```

不需要单独安装 PostgreSQL，也不需要 Docker —— 本地数据库由 `prisma dev` 提供。

### 4.2 安装与初始化

```bash
# 1. 安装依赖
pnpm install

# 2. 确认 pnpm-workspace.yaml 中的 allowBuilds 已包含
#    prisma / @prisma/engines / esbuild
#    （pnpm 11 默认拦截构建脚本，漏掉会导致安装失败）

# 3. 准备环境变量
cp .env.example .env

# 4. 启动本地数据库（后台运行）
pnpm exec prisma dev -d

# 5. 把上一步输出的【直连 TCP 地址】填进 .env 的 DATABASE_URL
#    形如 postgres://postgres:postgres@localhost:51214/template1?sslmode=disable
#    注意：不要用 prisma+postgres:// 代理地址，迁移需要 shadow database
#    可随时用 pnpm exec prisma dev ls 查看当前地址

# 6. 建表
pnpm exec prisma migrate dev

# 7. 生成客户端
pnpm exec prisma generate

# 8. 写入测试数据
pnpm db:seed

# 9. 启动服务
pnpm dev
```

服务启动后：

```bash
curl http://127.0.0.1:3000/healthz
```

### 4.3 常用命令

```bash
pnpm dev            # 开发模式（热重载）
pnpm build          # 编译
pnpm typecheck      # 类型检查
pnpm test           # 全部测试（44 单元 + 146 集成）

pnpm db:dev         # 启动本地数据库
pnpm db:migrate     # 执行迁移
pnpm db:seed        # 写入测试数据
pnpm db:studio      # 可视化查看数据
pnpm db:reset       # 重置数据库（会清空数据）
```

### 4.4 关于集成测试与数据库

集成测试跑在**真实的本地数据库**上，`beforeAll/afterEach` 会自行清理它创建的数据。

但有一个例外情况需要注意：

```text
如果某个测试文件在运行中整体崩溃（例如数据库进程意外退出、
连接被中断），afterEach 就没有机会执行，会残留：
  - ai_conversations / ai_messages
  - questionnaire_templates / questionnaire_template_versions
  - questionnaire_instances 及其 revisions
```

判断与恢复：

```bash
# 看是否有残留：正常情况下只应有 seed 的 2 个模板 + 1 个实例
pnpm exec prisma studio

# 彻底恢复干净基线（会清空所有数据并重新 seed）
pnpm db:reset
```

**另外注意**：本地数据库由 `prisma dev` 提供服务，
如果你用作业/进程管理器启动它，**终止该作业可能一并带走数据库进程**。
表现为 `prisma dev ls` 显示 `not_running`，测试报
`Connection terminated unexpectedly`。此时重新执行：

```bash
pnpm exec prisma dev -d
```

---

## 5. 开发态鉴权（决策 D11）

V1 **不做注册/登录接口**，使用固定测试账号。

请求时通过请求头指定当前用户：

```bash
curl http://127.0.0.1:3000/api/v1/me \
  -H "x-user-id: <用户ID>"
```

不带该请求头时，回退到 `dispatcher1`，方便直接调试。

测试账号（ID 由用户名确定性派生，重跑 seed 不变；实际值见 `pnpm db:seed` 输出）：

| 用户名 | 角色 | 说明 |
| --- | --- | --- |
| `admin` | `template_admin` | 模板管理 |
| `dispatcher1` | `dispatcher` | 问卷创建 / 下发 / 撤回 |
| `investigator1` | `investigator` | 问卷填写 |
| `reviewer1` | `reviewer` | 问卷审核 |

> **接入真实鉴权时**：只需替换 `src/shared/auth/auth.middleware.ts`，
> 业务层与权限校验代码零改动。
>
> 生产环境若没有真实鉴权实现，服务会**拒绝启动**，而不是静默放行任何人。

---

## 6. 目录结构

```text
├── docs/                    设计文档集（权威依据）
│   ├── 00-Requirements.md   原始需求
│   ├── 01-rpd.md           产品需求
│   ├── 02-architecture.md   系统架构
│   ├── 03-...tool_calling   问卷 Schema + 7 个增量 Tool 契约
│   ├── 04-database_design.md 数据库设计
│   ├── 05-api_design.md     API 设计
│   ├── 06-proj_init.md      项目初始化
│   ├── 08-ai_agent...       AI Agent / Prompt / Tool Calling
│   └── 09-review-and-decisions.md  评审结论与决策记录（D1~D13）
│
├── prisma/
│   ├── schema.prisma        12 张表的模型定义
│   ├── migrations/          迁移历史
│   └── seed.ts              测试数据
│
├── src/
│   ├── main.ts              启动入口
│   ├── app/app.ts           Express 装配
│   ├── config/env.ts        环境变量统一读取
│   ├── database/
│   │   ├── client.ts        Prisma 客户端（含 pg adapter）
│   │   └── transaction.ts   事务辅助
│   ├── modules/
│   │   ├── questionnaire/                    业务核心
│   │   │   ├── schema/questionnaire.schema.ts   问卷结构权威定义（Zod）
│   │   │   ├── operations/  纯函数式结构变换（AI 与人工编辑共用）
│   │   │   │   ├── add-section.ts / add-question.ts
│   │   │   │   ├── update-section.ts / update-question.ts
│   │   │   │   ├── remove-question.ts / move-question.ts
│   │   │   │   ├── helpers.ts（order 重算、选项构造、最终校验）
│   │   │   │   └── id-factory.ts（ID 由后端生成，测试可注入）
│   │   │   ├── repository/questionnaire.repository.ts
│   │   │   │   （乐观锁更新、Revision 快照、审计日志、幂等查询）
│   │   │   └── service/questionnaire.service.ts
│   │   │       （权限 + 状态校验 + 事务 + 幂等，REST 与 AI Tool 共用）
│   │   │
│   │   └── ai/                               智能能力入口
│   │       ├── tools/                        7 个增量 Tool
│   │       │   ├── questionnaire.tools.ts    6 个写入 + 1 个读取
│   │       │   ├── tool-registry.ts          注册表、runTool、JSON Schema 生成
│   │       │   ├── shared.ts                 参数片段与 target_id 一致性校验
│   │       │   └── types.ts                  ToolContext / ToolResult 契约
│   │       ├── providers/                    LLM 抽象与实现（决策 D13）
│   │       │   ├── llm-provider.ts           中立接口，无厂商概念
│   │       │   └── deepseek.provider.ts      DeepSeek（OpenAI 兼容）
│   │       ├── prompts/prompt-builder.ts     分层 Prompt 构建
│   │       └── orchestrator/ai.orchestrator.ts  Tool 调用循环
│   └── shared/
│       ├── errors/          业务错误类型与错误码（含 D1 锁定码）
│       ├── auth/            鉴权与当前用户上下文
│       └── utils/           id（UUID v7）、json 等
│
├── tests/
│   ├── fixtures/            测试夹具
│   ├── unit/                44 个单元测试（Operation 层，无数据库）
│   └── integration/         146 个集成测试（真实数据库）
│       ├── questionnaire/   Service：冻结、幂等、乐观锁、撤回
│       ├── ai/              Tool、Orchestrator（假 Provider）、Provider 线格式
│       └── api/             HTTP 端点：模板/实例/AI/下发/填写/审核
│       ├── questionnaire/   Service：冻结、幂等、乐观锁、撤回
│       └── ai/              Tool 与 Orchestrator（假 Provider 驱动）
│
├── prisma7.config.ts        Prisma 7 配置（datasource URL 在这里）
└── pnpm-workspace.yaml      pnpm 11 构建脚本放行（关键，勿删）
```

---

## 6.1 代码分层与依赖方向

```text
                  HTTP                        AI Tool
                   │                             │
                   ▼                             ▼
              Controller                    Tool 适配层
                   │                             │
                   └──────────┬──────────────────┘
                              ▼
                   QuestionnaireService        ← 唯一业务入口
                              │
                   ┌──────────┴──────────┐
                   ▼                     ▼
              Operation 层           Repository
            （纯函数，可单测）      （乐观锁 / Revision / 审计）
                   │                     │
                   ▼                     ▼
            QuestionnaireSchema      PostgreSQL
```

**AI 侧的额外一层：**

```text
用户自然语言
     │
     ▼
AI Orchestrator  ── 构建分层 Prompt + 维护消息历史
     │                 （MAX_TOOL_ROUNDS = 8，触顶收尾不报错）
     ▼
LLMProvider 抽象 ── DeepSeek（OpenAI 兼容）；迁内网只需换实现
     │  Tool Call
     ▼
runTool  ── 查表 → Zod 校验参数 → Tool.execute
     │        每次调用生成独立 operation_id（决策 D9）
     ▼
Tool 适配层  ── snake_case 参数 → camelCase Operation
     │         + target_id 与会话一致性校验
     ▼
QuestionnaireService（同上，权限与状态由后端强制）
```

**关键约束：**

- `Operation` 层是纯函数：入参 `(schema, input)`，返回新 schema，
  不碰数据库、不碰 HTTP、不依赖 AI —— 因此可被单元测试完整覆盖。
- `Service` 是唯一业务入口：REST 与 AI Tool 都调用它，不存在两套逻辑。
- 只有 `Repository` 能碰数据库。
- `LLMProvider` 接口中立，不含任何厂商专有概念（决策 D13）。
- 所有结构修改在返回前都会经过 `questionnaireSchema.parse()`，
  因此**不可能有非法结构落库**。
- **Prompt 只承担行为约束，权限与状态校验一律在代码层** ——
  模型没有绕过权限的可能。

---

## 7. 设计文档的阅读顺序

```text
01 RPD（要做什么）
  ↓
02 架构（怎么分层）
  ↓
03 Schema + Tool（问卷长什么样、AI 能怎么改）
  ↓
04 数据库（怎么存）
  ↓
05 API（怎么调）
  ↓
06 项目初始化（怎么落地）
  ↓
08 AI Agent（模型侧怎么工作）
  ↓
09 评审结论与决策记录（所有已拍板的决策，冲突时以它为准）
```

**文档冲突时以 `09-review-and-decisions.md` 为准。**

---

## 8. 几条关键业务规则

### 8.1 下发后结构冻结（决策 D1）

```text
draft / confirmed      → 允许修改结构
已下发（dispatched 之后）→ 禁止修改，必须先撤回
```

调查员负责上门核查，具体核查哪些内容由下发人员决定，
因此「下发」代表核查内容已布置完毕。

需要改动时走：**撤回 → 修改 → 二次下发**。

### 8.2 临时改动可以扶正（决策 D2）

同类案件反复出现同样的临时改动，说明标准模板缺失。
实例上提供「保存为新版本」，生成模板**草稿版本**，需走正常发布流程。

### 8.3 AI 只通过 7 个增量工具改问卷

```text
get_questionnaire   add_section    add_question
update_section      update_question
remove_question     move_question
```

不存在「一次生成整份问卷」的宏工具 ——
那会导致模型遗漏内容、无法精确审计、破坏幂等。
「生成整份问卷」在 Prompt 层由模型拆解为多次增量调用实现。

### 8.4 一次 Tool 调用 = 一个 operation_id = 一次 Revision（决策 D9）

因此一条用户消息可能产生多次 Revision，这是设计目标，不是异常。

---

## 9. 已知注意事项

1. **`pnpm-workspace.yaml` 不能删**：pnpm 11 默认拦截 Prisma / esbuild 的构建脚本，
   删掉它安装会直接失败。
2. **`DATABASE_URL` 必须用直连 TCP 地址**：`prisma+postgres://` 代理地址无法用于迁移。
3. **`prisma dev` 的端口是随机的**：换环境后需重新 `pnpm exec prisma dev ls` 更新 `.env`。
4. **`.env` 不提交 Git**：真实密钥不入库，模板见 `.env.example`。
5. **`generated/` 不提交 Git**：由 `pnpm exec prisma generate` 生成。
