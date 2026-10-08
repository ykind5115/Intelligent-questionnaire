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
| 数据库 | PostgreSQL | 本地开发用 `prisma dev` 提供的实例 |
| ORM | Prisma 7.10.0（锁定版本） | 经 `@prisma/adapter-pg` 走驱动适配器 |
| 校验 | Zod 4 | 同一套 Schema 复用于 AI 参数、HTTP 请求、结构定义 |
| 测试 | Vitest 3 | 集成测试直连真实数据库 |
| 前端 | 原生 HTML/CSS/JS | 无构建链，内网可直接部署 |

## 快速开始

```bash
# 1. 安装依赖
#    注意：必须先确认 pnpm-workspace.yaml 里的 allowBuilds 已包含
#    prisma / @prisma/engines / esbuild，否则 pnpm 会跳过这些包的构建脚本，
#    导致 pnpm exec 完全不可用（详见 docs/06 第 3B 节）
pnpm install

# 2. 准备环境变量
cp .env.example .env

# 3. 启动本地数据库（Prisma 提供的免安装 Postgres）
pnpm exec prisma dev -d

# 4. 建表 + 灌入种子数据
pnpm db:push
pnpm db:seed        # 会打印 4 个测试账号的 UUID

# 5. 启动服务
pnpm dev            # http://127.0.0.1:3000
```

然后打开 **http://127.0.0.1:3000** 就是工作台页面。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `NODE_ENV` | `development` | `production` 时强制要求真实鉴权与 `AI_BASE_URL` |
| `PORT` | `3000` | |
| `DATABASE_URL` | 无（必填） | `prisma dev` 会打印这个值 |
| `AI_BASE_URL` | 空 | **生产环境必填**（决策 D13） |
| `AI_API_KEY` | 空 | 没有它就只能用假 Provider 跑测试 |
| `AI_MODEL` | `deepseek-v41-flash` | 决策 D12 |

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

### 关于本地数据库的坑

`prisma dev` 提供的 Postgres 是个**开发用 shim**，在高并发下不稳定，
会出现 `ConnectionClosed` / `ECONNRESET` / `bind message supplies N parameters`
之类的报错，导致集成测试整片失败。此时按顺序恢复：

```bash
pnpm exec prisma dev stop default
pnpm exec prisma dev start default
```

注意 `prisma dev -d` 有时不足以恢复。另外这个 shim 忽略数据库名
（所有数据都落在 `template1`），因此**不适合多套环境并存**，
迁内网时请优先换成真实 PostgreSQL。

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

- **未接真实模型做端到端验证**。链路每一段都独立验证过，
  但「真实 DeepSeek 返回的 `tool_calls` 能被正确解析并驱动业务」
  只有配上有效 `AI_API_KEY` 才能最终确认。
- **`AI_MODEL` 默认值未与上游核对过**（没有 Key），拼写若有误改 `.env` 即可。
- **本地数据库不适合压测**，见上文 `prisma dev` 的坑。
- 前端是**最小可用**版本，没有回答填写界面与审核界面，
  这两步目前只能走 API。
- 前端不做乐观更新：写操作失败后会重新拉取结构，
  因此界面始终与数据库一致，但代价是多一次请求。
- `conversationId` 目前每次载入实例都新建，未复用未关闭的历史会话。

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
