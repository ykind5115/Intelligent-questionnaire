# 智能问卷系统

AI 辅助的问卷生成与动态编排系统。用自然语言描述调查需求，AI 把它变成结构化问卷；
案件办理过程中需要临时加字段时，也由 AI 完成，且**不会污染原始模板**。

## 这个项目解决什么问题

传统问卷系统的痛点：问卷在创建时就定死了。但调查办案是动态的 ——
调查张三时发现要问团伙关系，调查李四时要问飞行记录。
如果每个案件都要新建一份模板，模板库很快就会被「张三专用」「李四专用」淹没。

本系统的做法：

- **模板** 提供基线结构；**实例**（案件）复制一份后可自由增删题目
- 增删改都由 **AI 通过工具调用**完成，用户只需说人话
- 每次改动都留下 **Revision 快照**，可追溯、可比对
- 真正有复用价值的个案结构，可以「**扶正**」为新的模板草稿版本
- 一旦问卷**下发**，结构就冻结（决策 D1）；要改必须先撤回，避免已填答案失效

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 语言 | TypeScript 5.9（strict） | ESM + NodeNext，相对导入需带 `.js` |
| 运行时 | Node.js ≥ 22 | |
| Web | Express 5 | |
| 数据库 | PostgreSQL 17 | 本机安装或 Docker 均可 |
| ORM | Prisma 7.10.0（锁定版本） | 经 `@prisma/adapter-pg` 走驱动适配器 |
| 校验 | Zod 4 | 同一套 Schema 复用于 AI 参数、HTTP 请求、结构定义 |
| 测试 | Vitest 3 | 集成测试直连真实数据库 |
| 前端 | 原生 HTML/CSS/JS | 无构建链，内网可直接部署 |

## 当前进度

| 能力 | 状态 |
| --- | --- |
| 设计文档（需求 / 架构 / Schema / 数据库 / API / 项目结构） | ✅ |
| 设计评审与决策固化（D1–D13） | ✅ |
| 工程骨架（依赖、TS 配置、Prisma schema、12 张表迁移） | ✅ |
| 测试数据 seed（4 个账号 + 2 套模板 + 1 个实例） | ✅ |
| Questionnaire Operation 层（6 个纯函数）+ Repository + Service | ✅ |
| 7 个 AI Tool + Tool Registry（含 JSON Schema 生成） | ✅ |
| LLM Provider 抽象 + DeepSeek 实现（决策 D12） | ✅ |
| AI Orchestrator（上下文 + 工具循环 + 轮数上限 + 幂等） | ✅ |
| REST API：模板 / 实例 / 人工编辑器 / AI / 下发 / 填写 / 审核 | ✅ |
| SSE 流式端点 + 工作台前端 | ✅ |
| 人工编辑器（决策 D3 兜底） | ✅ |
| AI 评测用例集（决策 D5，含四类量化指标） | ✅ |
| 测试：242 例全绿（11 个文件，含真实数据库集成测试） | ✅ |
| 真实模型端到端验证（`deepseek-flash`） | ✅ 对话 / 流式 / 工具调用均通过（见「已知限制」） |
| 前端填写界面与审核界面 | ⬜ 目前走 API |

## 快速开始

### 环境要求

- Node.js ≥ 22
- pnpm
- **PostgreSQL**（本机已装 17.x；也可以用 Docker 或远程实例）

> 早期版本用 `prisma dev` 提供的免安装 Postgres，但那个 shim 在高并发下不稳定
> （会出现 `ConnectionClosed` / `ECONNRESET`，集成测试整片失败、跑一遍要 4 分钟）。
> 换成真实 PostgreSQL 后同样的 257 例测试只需约 50 秒，且不再抖动。

### 安装与初始化

```bash
# 1. 安装依赖
pnpm install
```

> ⚠️ **`pnpm-workspace.yaml` 里的 `allowBuilds` 必须先包含
> `prisma` / `@prisma/engines` / `esbuild`**，否则 pnpm 会跳过这些包的构建脚本，
> 导致 `pnpm exec` 完全不可用（连 `tsx`、`vitest` 都跑不了）。
> 这一项只有写在 `pnpm-workspace.yaml` 才生效，
> 写在 `package.json` 的 `onlyBuiltDependencies` 会被忽略。
> 若已经装坏了：删掉 `node_modules` 重新 `pnpm install`。

```bash
# 2. 准备环境变量
cp .env.example .env
```

把数据库连接串填进 `.env` 的 `DATABASE_URL`（本机 PostgreSQL 示例）：

```text
postgresql://postgres:123456@localhost:5432/postgres
```

```bash
# 3. 建表（按 prisma/migrations 里的迁移历史建，不会重置已有数据）
pnpm db:deploy

# 4. 生成 Prisma 客户端
pnpm db:generate

# 5. 写入测试数据（会打印 4 个账号的 UUID）
pnpm db:seed

# 6. 启动服务
pnpm dev            # → http://127.0.0.1:3000
```

打开 **http://127.0.0.1:3000** 就是工作台页面。

> **首次建表用 `pnpm db:deploy` 而不是 `db:migrate`**：前者严格按已有迁移历史执行，
> 适合「库是空的、迁移文件已存在」的场景；后者会在检测到 drift 时要求重置数据库。

### 常用命令

```bash
pnpm dev            # 开发模式（tsx watch）
pnpm build          # 编译到 dist/
pnpm start          # 跑编译产物
pnpm typecheck      # 类型检查
pnpm test           # 全量测试（约 50 秒）
pnpm test:watch
pnpm db:deploy      # 应用迁移（生产/首次建表）
pnpm db:migrate     # 开发时改完 schema 生成新迁移
pnpm db:studio      # 图形化查看数据
pnpm db:reset       # 清空并重新迁移（会丢数据）
pnpm lint / pnpm format
```

### 确认数据库回到了干净基线

正常情况下应当只有 seed 的 2 个模板 / 2 个版本 / 1 个实例，其余表为空。
若有残留：

```bash
pnpm exec prisma migrate reset --force   # 清空重建
pnpm db:seed
```

## 开发态鉴权（决策 D11）

请求头 `x-user-id: <用户UUID>` 指定以谁的身份操作（不带则回退到 `dispatcher1`）。
四个测试账号的 UUID 由 `pnpm db:seed` 打印，也可以用
`GET /api/v1/dev/users` 取（**仅非生产环境提供**）。

生产环境没有真实鉴权时服务**拒绝启动**。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `NODE_ENV` | `development` | `production` 时强制要求真实鉴权与 `AI_BASE_URL` |
| `PORT` | `3000` | |
| `DATABASE_URL` | 无（必填） | PostgreSQL 连接串，例如 `postgresql://postgres:123456@localhost:5432/postgres` |
| `AI_BASE_URL` | 空 | **生产环境必填**（决策 D13）。必须是 **OpenAI 兼容**根地址，见下方注意事项 |
| `AI_API_KEY` | 空 | 没有它就只能用假 Provider 跑测试 |
| `AI_MODEL` | `deepseek-flash` | 决策 D12；也可用 `deepseek-v4-pro` |

> ⚠️ **`AI_BASE_URL` 不要填 Anthropic 兼容端点。**
> DeepSeek 同时提供两套协议：
>
> ```text
> OpenAI    兼容：https://api.deepseek.com              ← 本项目用这个
> Anthropic 兼容：https://api.deepseek.com/anthropic     （路径是 /v1/messages）
> ```
>
> 填成 Anthropic 端点会请求 `/anthropic/chat/completions`，
> 该路径不存在 → **404 且响应体为空**，非常难排查。
> Provider 现在会在启动时对这种配置发出明确警告。
> 另外 `/v1` 前缀写不写都可以（会自动归一化）。

迁内网只需改这三项 AI 配置，代码无需改动（Provider 层是厂商中立的）。

## 目录结构

```text
src/
  app/                      Express 装配：路由、中间件、统一响应与错误处理
  config/env.ts             配置读取唯一入口（业务代码不得直接读 process.env）
  database/                 Prisma 客户端与事务封装（连接池参数在此调整）
  shared/
    auth/                   开发态鉴权中间件（x-user-id）
    errors/                 错误码 → HTTP 状态映射
    utils/                  UUID v7 生成、JSON 工具
  modules/
    questionnaire/          ★ 核心：结构语言、Operation、Repository、Service
      schema/               Zod 结构定义（AI/后端/前端共用的唯一结构语言）
      operations/           6 个纯函数：加/改/删/移分组与问题
      repository/           唯一接触数据库的层
      service/              唯一业务入口（权限、状态、事务、幂等）
      controller/           HTTP 门面（含人工编辑器）
    ai/
      providers/            LLMProvider 抽象 + DeepSeek 实现
      orchestrator/         工具调用回合循环（含流式版本）
      tools/                7 个增量 Tool + 注册表
      prompts/              System Prompt 与结构摘要
      service/              会话编排与落库
    dispatch/ response/ review/   下发、填写、审核
public/                     工作台前端（无构建链）
tests/
  unit/                     纯函数单元测试
  integration/              直连真实数据库的集成测试
  fixtures/ai-cases/        D5 AI 评测用例集
docs/                       设计文档与决策记录
prisma/schema.prisma        12 张表
```

## 架构要点

### 分层与依赖方向

```text
Controller → Service → Operation（纯函数）
                    ↘ Repository → 数据库
```

三条硬性约束：

1. **只有 Repository 能碰数据库**。Service 里不出现 `prisma.xxx`。
2. **Operation 是纯函数**：入参 `(schema, input)` → 新 schema，不访问数据库、
   不读时钟、不生成随机数（id 由注入的 factory 提供）。因此「AI 改问卷」与
   「人改问卷」天然共用同一套实现 —— 人工编辑器只用了很少代码就做出来了。
3. **Service 是唯一业务入口**。权限、状态校验、事务、审计都在这一层，
   Controller 与 Tool 都只是它的调用方。

### 一次改动的完整链路

```text
用户说话
  → Orchestrator 把结构摘要 + 历史 + 用户消息发给模型
  → 模型返回 tool_calls（如 add_section）
  → Tool 层把 snake_case 参数转成 camelCase，校验 scene/targetType 是否匹配
  → Service：校验权限（纵向角色 + 横向归属）与状态（是否已冻结）
  → Operation：纯函数算出新 schema
  → Repository：在**一个事务**里写 current_schema、插入 Revision、
    写审计记录（乐观锁保证并发安全）
  → 结果回灌给模型，模型继续或收尾
```

### 四个关键机制

**乐观锁**：`UPDATE ... WHERE current_revision = ?`。并发修改时只有一个成功，
其余返回 `REVISION_CONFLICT`（409）。已验证：5 个并发请求打到同一 revision，
结果是 1 成功 + 4 冲突，无丢失更新。

**Revision 快照**：每次结构变更插入一条不可变快照，`revision_no` 连续递增。
可回看任意一版结构，也是「答案绑定填写时修订号」的基础。

**幂等**：一次 Tool 调用生成一个 `operation_id`，写库前先按它查询是否已执行过。
已验证：6 个并发请求带同一 `operation_id`，最终只产生 1 个节点、1 条审计、
revision 只 +1，其余返回幂等重放。唯一约束只作兜底，不依赖它来触发异常。

**横向授权**：不仅校验「你的角色能不能做这类操作」，还校验
「**这一份数据是不是你的**」。规则见下方权限表。

### 几条关键业务规则

**下发后结构冻结（决策 D1）**

```text
draft / confirmed       → 允许修改结构
已下发（dispatched 之后）→ 禁止修改，必须先撤回
```

调查员负责上门核查，具体核查哪些内容由下发人员决定，
因此「下发」代表核查内容已布置完毕。需要改动时走
**撤回 → 修改 → 二次下发**。撤回会把既有答卷与下发任务一并置为
`withdrawn`，二次下发时调查员拿到的是**新的**可写答卷。

**临时改动可以扶正（决策 D2）**

同类案件反复出现同样的临时改动，说明标准模板缺失。实例上提供
「扶正为模板版本」，生成模板**草稿版本**，仍需走正常发布流程
（不能绕过发布治理）。

**一次 Tool 调用 = 一个 `operation_id` = 一次 Revision（决策 D9）**

因此一条用户消息可能产生多次 Revision，这是设计目标而不是异常。

**AI 创建问卷走 `create_template` 场景**

目标是模板的**草稿版本**（允许写入）；已发布的正式版本拒绝修改。
`POST /ai/conversations/{id}/commit` 是这类会话的唯一保存路径，
它只把草稿定稿，**不会自动发布**。

## 权限模型（决策 D8）

| 角色 | 可做什么 |
|---|---|
| `template_admin` | 模板治理；可读任意实例 |
| `dispatcher` | 建实例、改结构、确认、下发、撤回、扶正；**只能操作自己创建的实例** |
| `investigator` | 填写答卷；**只能看到/填写被指派给自己的实例** |
| `reviewer` | 审核提交；审核通过后问卷进入终态 |

实例状态与可编辑性（决策 D1）：

```text
draft / confirmed  → 结构可改
dispatched 及以后  → 结构冻结，需先撤回
completed          → 终态，不可再审、不可回退
```

## API 一览

所有响应统一为 `{ success, data | error, requestId }`。
开发态鉴权：请求头 `x-user-id: <用户UUID>`（不带则回退到 `dispatcher1`）。

### 模板

```text
POST   /api/v1/questionnaire-templates
GET    /api/v1/questionnaire-templates
GET    /api/v1/questionnaire-templates/:templateId
GET    /api/v1/questionnaire-templates/:templateId/versions
POST   /api/v1/questionnaire-templates/:templateId/versions
GET    /api/v1/questionnaire-templates/:templateId/versions/:versionId
POST   /api/v1/questionnaire-templates/:templateId/versions/:versionId/publish
POST   /api/v1/questionnaire-templates/:templateId/versions/:versionId/disable
```

### 问卷实例（案件）

```text
POST   /api/v1/questionnaire-instances
GET    /api/v1/questionnaire-instances/:instanceId
GET    /api/v1/questionnaire-instances/:instanceId/revisions
GET    /api/v1/questionnaire-instances/:instanceId/revisions/:revisionNo
POST   /api/v1/questionnaire-instances/:instanceId/confirm
POST   /api/v1/questionnaire-instances/:instanceId/withdraw
POST   /api/v1/questionnaire-instances/:instanceId/promote
```

### 人工编辑器（决策 D3 的兜底能力）

与 AI 走完全相同的一套 Service，因此规则一致。写操作都支持
`expectedRevision` 做乐观锁。

```text
POST   /api/v1/questionnaire-instances/:id/sections
PATCH  /api/v1/questionnaire-instances/:id/sections/:sectionId
POST   /api/v1/questionnaire-instances/:id/questions
PATCH  /api/v1/questionnaire-instances/:id/questions/:questionId
PATCH  /api/v1/questionnaire-instances/:id/questions/:questionId/move
DELETE /api/v1/questionnaire-instances/:id/questions/:questionId
```

### AI 会话

```text
POST   /api/v1/ai/conversations
GET    /api/v1/ai/conversations
GET    /api/v1/ai/conversations/:id
GET    /api/v1/ai/conversations/:id/messages
POST   /api/v1/ai/conversations/:id/messages
POST   /api/v1/ai/conversations/:id/messages/stream    # SSE 流式
POST   /api/v1/ai/conversations/:id/commit             # create_template 的唯一保存路径
POST   /api/v1/ai/conversations/:id/close
```

SSE 事件协议：

```text
text_delta            模型文本增量
tool_call_start       工具开始执行（含 operationId 与参数）
tool_call_result      工具结果（success / errorCode / 新 revision）
questionnaire_updated 结构已变更（含新 revision，前端据此重新 GET 结构）
done                  回合结束（含 truncated 标记）
error                 流中途失败（调用前就能判定的错误走正常 HTTP 状态码）
```

### 下发 / 填写 / 审核

```text
POST   /api/v1/dispatch-tasks
POST   /api/v1/dispatch-tasks/:id/dispatch
GET    /api/v1/dispatch-tasks
GET    /api/v1/questionnaire-instances/:instanceId/response
PUT    /api/v1/questionnaire-responses/:id/answers
PUT    /api/v1/questionnaire-responses/:id/answers/:questionId
POST   /api/v1/questionnaire-responses/:id/submit
GET    /api/v1/questionnaire-responses/review/pending
GET    /api/v1/questionnaire-responses/:id/review
POST   /api/v1/questionnaire-responses/:id/review
```

### 其他

```text
GET    /healthz                 健康检查（含数据库连通性）
GET    /api/v1/me               当前鉴权用户
GET    /api/v1/dev/users        可用账号列表（**仅非生产环境**）
GET    /                        工作台前端
```

## AI 工具集（7 个，全部是增量操作）

| 工具 | 作用 |
|---|---|
| `get_questionnaire` | 读取当前结构 |
| `add_section` | 新增分组 |
| `add_question` | 新增题目 |
| `update_section` | 修改分组 |
| `update_question` | 修改题目 |
| `remove_question` | 删除题目 |
| `move_question` | 移动题目（可跨分组） |

**刻意不提供宏工具**（如「生成整份问卷」）。原因：整份重写会让模型每次都重新
生成所有内容，既慢又容易丢掉用户已有的改动。增量操作配合 `MAX_TOOL_ROUNDS = 8`
的回合上限，达到上限时返回收尾消息而不是抛错。

场景与目标的匹配由后端强制校验，不依赖 Prompt 约束：

```text
create_template      + template（草稿版本）    → 允许
modify_questionnaire + questionnaire_instance → 允许
其他组合                                       → 拒绝
```

## 测试

```bash
pnpm typecheck    # 类型检查
pnpm test         # 全量测试（需要数据库在跑）
pnpm test:watch
```

当前规模：**242 例测试全部通过**（11 个文件），其中集成测试直连真实数据库。

测试分层的意图：

- `tests/unit/` —— Operation 层纯函数。不碰数据库，跑得极快，覆盖边界条件。
- `tests/integration/` —— 真实数据库，覆盖事务、乐观锁、幂等、权限、
  状态机、SSE 事件协议。**不用 mock 数据库**：本项目最容易出问题的恰恰是
  并发与事务边界，mock 掉就测不出来了。

### 数据库选型的一段教训

早期用 `prisma dev` 提供的免安装 Postgres 做本地开发，那是个**开发用 shim**，
在高并发下不稳定，会出现 `ConnectionClosed` / `ECONNRESET` /
`bind message supplies N parameters` 之类的报错，导致集成测试整片失败。
当时的应对是反复重启它：

```bash
pnpm exec prisma dev stop default
pnpm exec prisma dev start default
```

**现在已改为真实 PostgreSQL**（本机安装或 Docker 均可）。
换成真实 PG 后：

```text
全量 257 例测试      248 秒（shim，且经常崩）  →  约 50 秒（真实 PG，稳定）
集成测试通过率        经常整片失败              →  连续全绿
```

这印证了一件事：**不要用近似实现去跑并发与事务相关的测试** ——
被 shim 掩盖或伪造出来的失败，会浪费大量时间去排查并不存在的问题。

如果仍然想用 `prisma dev`，请注意它忽略数据库名（所有数据都落在 `template1`），
且端口是随机的。

## AI 评测（决策 D5）

把「AI 生成/修改问卷的成功率」变成可量化、可回归的指标，
取代人工主观验收。用例集在 `tests/fixtures/ai-cases/`（8 条，覆盖生成类与修改类，
含多轮补充、隐含分组、改措辞、删题、分步增量）。

```bash
pnpm exec vitest run tests/integration/ai/eval-cases.test.ts
```

四类指标：`Schema 合法性`、`关键点覆盖率`、`工具调用正确率`、`多轮增量保留率`。

CI 里用假 Provider 驱动，得到全绿只能证明**评测器与业务链路正确**；
要得到真实模型的能力指标，需要配置 `AI_API_KEY`，
把 `tests/integration/ai/harness.ts` 里的 Provider 换成 `DeepSeekProvider` 再跑同一套用例。

## 工作台前端

打开 http://127.0.0.1:3000 即可。三个区域：

- **顶栏**：切换用户（4 个种子账号）、载入或新建实例
- **左侧**：与 AI 对话。工具调用会显示成进度条（执行中 / 完成 / 失败），
  结构一变右侧树自动刷新
- **右侧**：结构树。标题可直接点开改，题目支持上移 / 下移 / 换组 / 删除，
  顶部可确认、扶正、撤回

之所以用原生 JS 而不是框架：内网环境常常没有外网，
既不能装依赖也不能用 CDN；服务端直接托管静态文件即可。

## 已知限制

诚实列出，避免误判完成度：

- 数据库现在是真实 PostgreSQL，可以正常压测；但连接池上限是 5（`POOL_MAX`），
  高并发压测前需要先调大。
- 前端是**最小可用**版本，没有回答填写界面与审核界面，
  这两步目前只能走 API。
- 前端不做乐观更新：写操作失败后会重新拉取结构，
  因此界面始终与数据库一致，但代价是多一次请求。
- `conversationId` 目前每次载入实例都新建，未复用未关闭的历史会话。
- 真实模型只用少量请求做过验证（见下方「已验证」），
  **没有跑完整的 8 条 D5 评测用例**，因此还没有量化的成功率数字。

### 真实模型验证情况

已用真实 DeepSeek 服务验证（`deepseek-flash`）：

```text
非流式对话    ✅ 正常返回
流式对话      ✅ 收到 text_delta 与 done，文本正确拼接
工具调用      ✅ 模型返回 add_section，参数合法
               执行后结构真的落库，revision 1 → 2
```

也就是说「模型 → Tool → Service → 数据库」这条链路已经打通。
若要得到 D5 定义的量化指标，把 `tests/integration/ai/harness.ts`
里的 Provider 换成 `DeepSeekProvider` 跑那 8 条用例即可。

### 几条容易踩的环境注意事项

1. **`pnpm-workspace.yaml` 不能删**：pnpm 11 默认拦截 Prisma / esbuild 的构建脚本，
   删掉它安装会直接失败。
2. **`DATABASE_URL` 必须用直连 TCP 地址**：`prisma+postgres://` 代理地址无法用于迁移
   （shadow database 不支持）。
3. **`DATABASE_URL` 必须指向真实可用的 PostgreSQL**；若换机器/换库，
   记得重新 `pnpm db:deploy` 建表与 `pnpm db:seed` 灌数据。
4. **`.env` 与 `generated/` 都不提交 Git**：真实密钥不入库；
   Prisma 客户端由 `pnpm db:generate` 生成，模板见 `.env.example`。

## 文档

`docs/` 下是设计与决策记录，**出现冲突时以 `docs/09-review-and-decisions.md`
（决策日志 D1–D13）为准**：

| 文件 | 内容 |
|---|---|
| `00-Requirements.md` | 原始需求 |
| `01-rpd.md` | 需求与产品定义 |
| `02-architecture.md` | 架构与分层 |
| `03-questionnaire_schema_ai_tool_calling .md` | 结构语言与 AI 工具调用契约（含第 36.0 节的场景矩阵） |
| `04-database_design.md` | 数据模型 |
| `05-api_design.md` | API 设计（含状态机与撤回的数据处理） |
| `06-proj_init.md` | 初始化与实施进度（含环境踩坑记录） |
| `08-ai_agent_prompt_tool_calling.md` | AI 编排、Prompt 与流式协议 |
| `09-review-and-decisions.md` | **决策日志 D1–D13，冲突时以它为准** |
