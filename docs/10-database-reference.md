# 数据库表格与字段速查

本文档是 [04-database_design.md](04-database_design.md)（设计说明书，2947 行）的**精简速查版**，
内容以**本地实际数据库**为准（PostgreSQL 17，迁移 `20261005034428_init`、
`20261015120000_add_categories_and_instance_no`），
并标出实现与设计文档的差异。

- 用途：改代码、写查询、排查数据问题时快速对照
- 不替代 04：字段的**设计理由**、事务边界、一致性规则仍看 04
- 结构真相以 `prisma/schema.prisma` 为准；本文档由实际库导出核对而成

---

## 0. 总览

14 张业务表（+1 张 Prisma 迁移记录表）。主键基本都是 `uuid`，
**例外是 `instance_no_counters`**（复合主键 `(day, scope)`，纯发号用）。
时间字段为 `timestamptz`。核心思路是**关系型数据与动态结构分离**：
固定的关系（谁、什么状态、属于谁）用列；问卷的题目树用 `jsonb`。

| 分组 | 表 | 作用 |
| --- | --- | --- |
| 账号 | `users` | 用户与角色 |
| 模板 | `questionnaire_templates` | 模板（元信息） |
| 模板 | `questionnaire_template_categories` | 模板分类（业务域） |
| 模板 | `questionnaire_template_versions` | 模板版本（**结构存在这里**） |
| 实例 | `questionnaire_instances` | 问卷实例（案件，**当前结构存在这里**） |
| 实例 | `questionnaire_revisions` | 结构变更的历史快照 |
| 实例 | `instance_no_counters` | 实例编号的按天发号器（**内部表**，无 API） |
| AI | `ai_conversations` | 会话 |
| AI | `ai_messages` | 消息（含 tool 调用/结果） |
| AI | `ai_tool_executions` | 工具执行审计（幂等依据） |
| 流转 | `dispatch_tasks` | 下发任务 |
| 流转 | `questionnaire_responses` | 答卷 |
| 流转 | `questionnaire_answers` | 逐题答案 |
| 流转 | `review_records` | 审核记录 |

### 关系主线

```text
questionnaire_template_categories 1 ── N questionnaire_templates   （可为空）
users ──created_by──> questionnaire_templates
                        │ 1:N
                        └──> questionnaire_template_versions
                                │ 1:N（createInstance 时复制 schema）
                                └──> questionnaire_instances
                                        │ 1:N
                                        ├──> questionnaire_revisions   （历史快照）
                                        ├──> dispatch_tasks            （下发）
                                        └──> questionnaire_responses   （答卷）
                                                │ 1:N
                                                ├──> questionnaire_answers
                                                └──> review_records

questionnaire_template_versions.source_instance_id ──> questionnaire_instances
    （决策 D2「扶正」：记录这个模板版本是从哪个案件提升来的）
```

**两处循环外键**（迁移里必须拆成 `ALTER TABLE`，见 04 第 51.1 节）：

```text
questionnaire_templates.current_version_id      → questionnaire_template_versions.id
questionnaire_template_versions.source_instance_id → questionnaire_instances.id
```

---

## 1. users

4 行。角色用**数组字段**而不是独立 RBAC 表（决策 D8）。

| 字段 | 类型 | 可空 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | uuid | 否 | — | 主键，由 seed 用 UUIDv5 从 username 派生 |
| `username` | varchar(100) | 否 | — | **唯一**；开发态鉴权可用它代替 UUID |
| `display_name` | varchar(100) | 否 | — | 界面显示名 |
| `password_hash` | text | 是 | — | V1 不做登录，恒为空 |
| `status` | varchar(20) | 否 | `active` | `active` / 停用 |
| `roles` | text[] | **是** | `{}` | 取值见下 |
| `created_at` / `updated_at` | timestamptz | 否 | now | |

`roles` 的取值（代码里的常量）：

```text
template_admin   模板治理：建/改/发布/停用/删除模板，可读任意实例
dispatcher       建实例、改自己案件的结构、确认、下发、撤回、扶正
investigator     填写答卷（只能填「被指派给自己」的任务）
reviewer         审核已提交的答卷
```

> 实现差异：文档第 8.2 节写的是 `roles VARCHAR(30)[] NOT NULL DEFAULT '{}'`，
> 实际列**可空**（Prisma 生成）。代码里始终写入数组，读时按空数组处理。
> 文档第 8.4 节建议的 `CREATE INDEX ... USING GIN (roles)` **没有创建** ——
> 目前按角色过滤是在应用层做（数据量小，无影响）。

---

## 2A. questionnaire_template_categories

0 行起。**模板分类**：按业务域组织模板（无人机核查 / 人员调查 / 设备检查…）。

依据决策 **D16** 与 [11-future-capability-plan.md](11-future-capability-plan.md) 第 5.1 节。

| 字段 | 类型 | 可空 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | uuid | 否 | — | 主键 |
| `code` | varchar(64) | 否 | — | **唯一**；程序侧引用的稳定编码，如 `drone_check` |
| `name` | varchar(100) | 否 | — | 展示名 |
| `description` | text | 是 | — | 描述 |
| `category_id` | uuid | **是** | — | → `questionnaire_template_categories.id`（RESTRICT） |
| `created_at` | timestamptz | 否 | now | |

关键点：

- **`code` 的字符集由应用层强制**：只允许小写字母、数字、下划线，且以字母开头（2–64 位）。
  数据库没有 CHECK 约束 —— 与既有「状态类字段无 CHECK、取值由应用层保证」的做法一致。
- **不做静默小写化**：`Drone_Check` 会被明确拒绝，而不是悄悄存成 `drone_check`。
  编码是被代码/脚本引用的契约，静默改写会让引用方对不上。
- **`code` 不可改**（`PATCH` 不接受该字段）。要换编码就新建分类。
- **删除策略是 RESTRICT**：仍被模板引用时删除会被应用层拦下并说明有几个模板在用
  （`templateCategoryService.deleteCategory`）。
- 读写权限：读任意已鉴权用户；写需要 `template_admin`（分类是全组织共享资产）。

### 与模板的唯一约束关系（容易搞错）

正确约束是 **`UNIQUE (template_id, version_no)`**（在 `questionnaire_template_versions` 上），
**不是** `UNIQUE (category_id, version)`。
后者会导致「同一分类下只能存在一个 v1 模板」，是来源提案（`问卷系统数据库设计文档.md:159`）
里的一处设计错误，D16 明确不采纳。

---

## 2. questionnaire_templates

7 行。只存**元信息**，结构在版本表里。

> `category_id` 可空：存量 7 个模板在加列时都没有分类，强制 NOT NULL 会让迁移失败。
> 界面上：模板管理页有「分类」筛选下拉 + 「管理分类」弹窗（新增/改名/删除）。
> 接口层：创建/更新模板时可传 `categoryId`（传 `null` 表示清空），
> 列表支持 `?categoryId=` 筛选；响应里带 `category` 摘要（id/code/name）。

| 字段 | 类型 | 可空 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | uuid | 否 | — | 主键 |
| `name` | varchar(200) | 否 | — | 模板名（API 层会 trim 后校验非空） |
| `description` | text | 是 | — | 描述 |
| `status` | varchar(20) | 否 | `draft` | `draft` / `published` / `disabled` |
| `current_version_id` | uuid | 是 | — | **唯一**；指向当前生效版本 |
| `created_by` | uuid | 否 | — | → `users.id`（RESTRICT） |
| `created_at` / `updated_at` | timestamptz | 否 | now | |

关键点：

- `current_version_id` 是「当前生效版本」的**唯一权威来源**：
  `publish` 时写入，`disable` 某个版本且不再有已发布版本时**清空并把模板状态降为 `disabled`**
- 该列有 **UNIQUE 约束** —— 一个版本只能是一个模板的当前版本
- 删除模板：先断开 `current_version_id`，再删版本，最后删模板

---

## 3. questionnaire_template_versions

7 行。**问卷结构真正存在这里**（`schema` 列，JSONB）。

| 字段 | 类型 | 可空 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | uuid | 否 | — | 主键 |
| `template_id` | uuid | 否 | — | → `questionnaire_templates.id`（RESTRICT） |
| `version_no` | int4 | 否 | — | 同一模板内从 1 递增，**由后端计算** |
| `schema` | jsonb | 否 | — | `QuestionnaireSchema`（见 03 文档） |
| `change_note` | text | 是 | — | 变更说明 |
| `status` | varchar(20) | 否 | `draft` | `draft` / `published` / `disabled` |
| `source_type` | varchar(30) | 否 | `manual` | `manual` / `ai_generated` / `promoted_from_instance` |
| `source_instance_id` | uuid | 是 | — | → `questionnaire_instances.id`（SET NULL）；决策 D2 扶正来源 |
| `created_by` | uuid | 否 | — | → `users.id`（RESTRICT） |
| `created_at` | timestamptz | 否 | now | |

唯一约束：`(template_id, version_no)`。

关键点：

- **只有 `draft` 版本可以被修改**（AI 与人工编辑器都受此限制）
- **发布后不可改**：要改只能新建版本（04 第 11.1 节）
- 发布前会跑一次 `questionnaireSchema.parse` 做结构校验，挡住非法问卷
- 这张表**没有 `published_at`**，需要「发布时间」时用 `created_at` 近似

---

## 4. questionnaire_instances

14 行。一个案件一份。

> **`instance_no` 可空**（历史遗留）：加列时存量实例没有编号，
> 但**已在 2026-10-15 用 `scripts/backfill-instance-no.ts` 全部回填**，
> 因此现在库里每个实例都有编号。
> 列仍保持可空是为了让「加列 -> 回填」这条路径在新环境上可重放，
> 也为了容忍手工直插数据；接口返回 `instanceNo`（可能为 `null`）。
> 生成规则与并发取舍见下方 `instance_no_counters` 一节。

| 字段 | 类型 | 可空 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | uuid | 否 | — | 主键 |
| `template_version_id` | uuid | 否 | — | 从哪个模板版本创建（→ RESTRICT） |
| `title` | varchar(200) | 否 | — | 案件标题 |
| `instance_no` | varchar(64) | **是** | — | **唯一**；可读编号，如 `INS-20261015-0001` |
| `subject_info` | jsonb | 是 | — | 调查对象基础信息，结构随业务可变 |
| `current_schema` | jsonb | 否 | — | **当前结构**；AI/人工的改动都写这里 |
| `current_revision` | int4 | 否 | 1 | 当前修订号；乐观锁用它 |
| `status` | varchar(30) | 否 | `draft` | 见下方状态机 |
| `created_by` | uuid | 否 | — | → `users.id`（RESTRICT）；**横向授权依据** |
| `created_at` / `updated_at` | timestamptz | 否 | now | |

为什么实例要自己存一份 `current_schema`（04 第 14 节）：
模板是基线，个案允许临时增删题目；存副本后案子之间互不影响，
也不会污染模板。**扶正**（个人改动沉淀为模板）是另一条显式路径。

### 实例状态机

```text
draft ──confirm──> confirmed ──dispatch──> dispatched ──submit──> submitted
  ▲                                          ▲                       │
  │                                          │                       ├─ approve ─> completed（终态）
  │                                          │                       └─ reject  ─> returned
  │                                          │                                     │
  │                                          └──────（继续填写并提交）──────────────┘
  │
  └──── withdraw（实例先置 withdrawn，随后回到 draft）────┘
        可撤回：dispatched / in_progress / submitted / under_review
```

配置项（代码常量，非数据库 CHECK 约束）：

| 常量 | 取值 | 用途 |
| --- | --- | --- |
| `STRUCTURE_WRITABLE_STATUSES` | `draft`、`confirmed` | 允许改结构 |
| `DISPATCHABLE_INSTANCE_STATUS` | `confirmed` | 允许建下发任务（单数常量） |
| `FILLABLE_INSTANCE_STATUSES` | `dispatched`、`in_progress`、`returned` | 允许填写 |
| `WITHDRAWABLE` | `dispatched`、`in_progress`、`submitted`、`under_review` | 允许撤回 |
| `WRITABLE_INSTANCE_STATUSES` | `draft` | 乐观锁更新 `current_schema` 的前置条件 |

> `status` 列**没有 CHECK 约束**，取值由应用层保证。
>
> 撤回的实际顺序：先写 `withdrawn` 状态的审计记录 → 把实例置回 `draft`
> （同时把既有答卷与下发任务一并置为 `withdrawn`，决策 D1）。
>
> 有两个「常量承认、但当前没有代码写入」的**保留状态**：
> - `in_progress`（调查中）：出现在可填写与可撤回列表里
> - `under_review`（审核中）：只出现在可撤回列表里
>
> 若将来引入中间态，这些常量已经就位；现在就当作未使用。

---

## 4A. instance_no_counters

**内部表**，不对应任何 API。`instance_no` 的按天发号器。

| 字段 | 类型 | 可空 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `day` | varchar(8) | 否 | — | 当地日期 `YYYYMMDD`（复合主键之一） |
| `scope` | varchar(32) | 否 | `instance` | 号段名（复合主键之一），预留按业务线分号段 |
| `current` | int4 | 否 | 0 | 当天已发出的最大序号 |

编号格式：`INS-<day>-<序号补零 4 位>`，例如 `INS-20261015-0001`。

关键点（**不要改成 count(*)+1**）：

- 发号走 `INSERT ... ON CONFLICT (day, scope) DO UPDATE SET current = current + 1`，
  同一天的行会被行锁**串行化**。用 `count(*) + 1` 在并发下必然撞号。
- **编号允许有空洞**：被回滚的事务会消耗掉一个号。这是「宁可跳号也不重号」的有意取舍 ——
  重号会被唯一索引拦下并让建案失败。
- 序号超过 9999 时不再补零（变成 5 位），编号仍然唯一。
- `day` 用**本地**日期，不用 UTC（与模板占位名同理，否则东八区夜里会差一天）。
- 测试会在整套用例结束前把本表**还原**到运行前的状态（见
  `tests/integration/api/template-category-and-instance-no.test.ts`）。

### 存量数据回填

加列时存量实例没有编号，用一次性脚本补齐（幂等，可重复执行）：

```bash
pnpm exec tsx scripts/backfill-instance-no.ts --dry-run   # 先看方案，不改任何数据
pnpm exec tsx scripts/backfill-instance-no.ts             # 执行
```

规则：按**本地日**分组、组内按 `created_at` 升序从 1 编号；
**已有编号会被计入组内序号**（否则回填值会与它们撞号）；
回填完把本表 `current` 校准到每组最大序号，否则下一次建案会从 1 重新发号而撞号。

编号规则由 `operations/backfill-instance-no.ts` 的纯函数 `planInstanceNoBackfill` 决定，
有单元测试覆盖（11 个用例）。**脚本本身是全局扫描，不适合在测试里真跑** ——
那会连带改动真实数据（包括开发期间手工建的案件）。

---

## 5. questionnaire_revisions

13 行。每次结构变更写一条**不可变快照**。

| 字段 | 类型 | 可空 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | uuid | 否 | — | 主键 |
| `questionnaire_instance_id` | uuid | 否 | — | → `questionnaire_instances.id`（RESTRICT） |
| `revision_no` | int4 | 否 | — | 从 1 连续递增 |
| `schema_snapshot` | jsonb | 否 | — | 该次变更**之后**的完整结构 |
| `operation_type` | varchar(30) | 是 | — | 如 `add_section` / `update_question` |
| `operation_id` | uuid | 是 | — | 与 `ai_tool_executions.operation_id` 对应 |
| `created_by` | uuid | 是 | — | → `users.id`（**SET NULL**，保留历史） |
| `created_at` | timestamptz | 否 | now | |

唯一约束：`(questionnaire_instance_id, revision_no)`。

关键点：

- **一次 Tool 调用 = 一个 `operation_id` = 一次 Revision**（决策 D9）。
  一条用户消息可能产生多次 Revision，这是设计目标
- `revision_no` 与 `current_revision` 必须连续一致（04 第 56 节规则七）
- 这张表的 `operation_id` **故意不加唯一约束** —— 一次操作可能写多条审计，
  但 Revision 与 Tool 调用是一对一，唯一性由 `ai_tool_executions` 保证

---

## 6. ai_conversations

0 行。会话的 `scene` 与 `target` 一旦创建就固定。

| 字段 | 类型 | 可空 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | uuid | 否 | — | 主键 |
| `user_id` | uuid | 否 | — | → `users.id`（RESTRICT）；会话归属 |
| `scene` | varchar(50) | 否 | — | `create_template` / `modify_questionnaire` |
| `target_type` | varchar(50) | 是 | — | `template` / `questionnaire_instance` |
| `target_id` | uuid | 是 | — | 模板版本 id 或实例 id |
| `status` | varchar(20) | 否 | `active` | `active` / `closed` / `committed` |
| `created_at` / `updated_at` | timestamptz | 否 | now | |

场景与目标必须匹配（后端强制，不靠 Prompt）：

```text
create_template      + template（草稿版本）    ← 允许（AI 从零建模板）
modify_questionnaire + questionnaire_instance  ← 允许
其他组合                                        ← 拒绝
```

---

## 7. ai_messages

0 行。会话内的消息序列。

| 字段 | 类型 | 可空 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | uuid | 否 | — | 主键 |
| `conversation_id` | uuid | 否 | — | → `ai_conversations.id`（RESTRICT） |
| `role` | varchar(20) | 否 | — | `system` / `user` / `assistant` / `tool` |
| `content` | text | 是 | — | 文本内容 |
| `tool_name` | varchar(100) | 是 | — | 工具名（role=tool 时） |
| `tool_call_id` | varchar(100) | 是 | — | 与模型的 tool_call id 对应 |
| `tool_arguments` | jsonb | 是 | — | 工具入参 |
| `tool_result` | jsonb | 是 | — | 工具返回 |
| `sequence_no` | int4 | 否 | — | 会话内序号 |
| `created_at` | timestamptz | 否 | now | |

唯一约束：`(conversation_id, sequence_no)`。

---

## 8. ai_tool_executions

14 行。**审计 + 幂等**的核心表。

| 字段 | 类型 | 可空 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | uuid | 否 | — | 主键 |
| `conversation_id` | uuid | **是** | — | → `ai_conversations.id`（**SET NULL**） |
| `questionnaire_instance_id` | uuid | 是 | — | → `questionnaire_instances.id`（SET NULL） |
| `message_id` | uuid | 是 | — | → `ai_messages.id`（SET NULL） |
| `operation_id` | uuid | 否 | — | **唯一**；幂等键 |
| `source` | varchar(20) | 否 | `ai_tool` | `ai_tool` / `manual_editor` |
| `tool_name` | varchar(100) | 否 | — | 操作名（如 `add_section`） |
| `arguments` | jsonb | 否 | — | 入参 |
| `result` | jsonb | 是 | — | 执行结果 |
| `success` | bool | 否 | — | 是否成功 |
| `error_code` | varchar(100) | 是 | — | 失败时的错误码 |
| `model` | varchar(100) | 是 | — | 模型标识（人工编辑为空） |
| `created_at` | timestamptz | 否 | now | |

幂等的实现方式（**先查后插，不依赖 UNIQUE 报错**，决策 D9）：

```text
1. 按 operation_id 查这张表
2. 查到 → 直接返回上次的结果（不重复写结构）
3. 查不到 → 执行业务 + 写审计（同一事务）
4. UNIQUE 只作最后一道防线
```

> 实现差异（重要，属实现改进）：
> - 文档第 23.2 节写 `conversation_id UUID NOT NULL`，实际**可空** ——
>   人工编辑器（决策 D3）没有会话，若强制 NOT NULL 就没法记录人工编辑审计
> - 实际比文档多 `source` 与 `model` 两列：前者区分 AI 与人工编辑，
>   后者记录用的模型

---

## 9. dispatch_tasks

0 行。下发任务。

| 字段 | 类型 | 可空 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | uuid | 否 | — | 主键 |
| `questionnaire_instance_id` | uuid | 否 | — | → `questionnaire_instances.id`（RESTRICT） |
| `assigned_to` | uuid | 否 | — | 被指派人；**必须是 investigator 角色**（应用层校验） |
| `dispatched_by` | uuid | 否 | — | 下发人 |
| `status` | varchar(30) | 否 | `pending` | `pending` / `dispatched` / `withdrawn` / `completed` |
| `dispatched_at` | timestamptz | 是 | — | 实际下发时间 |
| `due_at` | timestamptz | 是 | — | 截止时间 |
| `withdrawn_at` | timestamptz | 是 | — | 撤回时间（决策 D1） |
| `withdrawn_by` | uuid | 是 | — | 撤回人（SET NULL） |
| `created_at` / `updated_at` | timestamptz | 否 | now | |

**这张表是 investigator 横向授权的依据**：
「能不能看/填这个实例」= 「`assigned_to` 是不是我」。

撤回时（决策 D1）会把 `pending` / `dispatched` 的任务置为 `withdrawn`
并写 `withdrawn_at` / `withdrawn_by`；审核通过时置为 `completed`。

---

## 10. questionnaire_responses

0 行。答卷（一位调查员对一个实例一份可填的答卷）。

| 字段 | 类型 | 可空 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | uuid | 否 | — | 主键 |
| `questionnaire_instance_id` | uuid | 否 | — | → 实例（RESTRICT） |
| `respondent_id` | uuid | 否 | — | 填写人（→ `users.id`）；**横向授权依据** |
| `status` | varchar(30) | 否 | `draft` | 见下 |
| `submitted_at` | timestamptz | 是 | — | 提交时间（退回时清空） |
| `created_at` / `updated_at` | timestamptz | 否 | now | |

`status` 取值（与代码常量 `RESPONSE_STATUSES` 一致）：

```text
draft      填写中（可保存答案）
submitted  已提交，等待审核
reviewed   审核通过（由 review 写入；不再出现在待审核列表）
withdrawn  因撤回而作废（二次下发会新建一份 draft，不复用旧的）
```

> 别把 `RESPONSE_STATUSES` 与 `RESPONSE_FILLABLE_STATUSES` 混用：
> 前者是「库里可能出现哪些值」，后者只有 `draft`，用于判断「能不能继续写」。
> 前者曾漏掉 `reviewed`（导致按 `reviewed` 过滤被 422 拒），现已补齐并有测试约束。
>
> 另：04 第 2708 行（规则八）提到 `under_review`，那是**实例**状态，
> 出现在「禁止写入 `current_schema`」的列表里 —— 与实例的
> `WITHDRAWABLE` 常量一致（见第 4 节）。
> 响应表**没有**该取值：审核是原子的，不需要「审核中」中间态。

---

## 11. questionnaire_answers

0 行。逐题答案。

| 字段 | 类型 | 可空 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | uuid | 否 | — | 主键 |
| `response_id` | uuid | 否 | — | → `questionnaire_responses.id`（RESTRICT） |
| `question_id` | varchar(100) | 否 | — | **不是 UUID**：结构内自造的短 id（`q_xxx`） |
| `revision_no` | int4 | 否 | — | 答案绑定**填写时**的实例修订号 |
| `answer` | jsonb | 是 | — | 答案值；不同题型结构不同 |
| `created_at` / `updated_at` | timestamptz | 否 | now | |

唯一约束：`(response_id, question_id)` —— 保存是 upsert。

关键点：

- `question_id` **不建外键**（04 第 29 节）：题目存在 `jsonb` 里，
  没有独立的题目表，无法建外键；有效性由「对照当时的 `current_schema` 校验」保证
- `revision_no` 记录填写时的修订号（04 第 27.3 节），
  让「当时问的是什么」可追溯
- 每轮撤回的答卷会置为 `withdrawn`，**不会复用**给二次下发

---

## 12. review_records

0 行。审核记录。

| 字段 | 类型 | 可空 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | uuid | 否 | — | 主键 |
| `questionnaire_response_id` | uuid | 否 | — | → `questionnaire_responses.id`（RESTRICT） |
| `reviewer_id` | uuid | 否 | — | 审核人 |
| `result` | varchar(30) | 否 | — | `approved` / `rejected` |
| `comment` | text | 是 | — | 审核意见 |
| `created_at` | timestamptz | 否 | now | |

**一张答卷只能审一次**：审核前会查这张表，已存在则返回 409。
这道检查是必要的 —— 否则同一提交能被反复审核，留下互相矛盾的记录，
并把终态 `completed` 打回 `returned`。

---

## 13. 索引一览

主键索引（每张表 `id`）与唯一约束索引之外，业务索引如下：

| 表 | 索引 | 用途 |
| --- | --- | --- |
| `ai_conversations` | `user_id` | 按用户列会话 |
| `ai_messages` | `conversation_id` | 取会话消息 |
| `ai_messages` | `(conversation_id, sequence_no)` **UNIQUE** | 消息顺序唯一 |
| `ai_tool_executions` | `operation_id` **UNIQUE** | 幂等键 |
| `ai_tool_executions` | `conversation_id`、`questionnaire_instance_id` | 按会话/实例查审计 |
| `dispatch_tasks` | `assigned_to`、`status` | 「我的任务」、按状态筛 |
| `questionnaire_answers` | `(response_id, question_id)` **UNIQUE** | upsert 依据 |
| `questionnaire_instances` | `created_by`、`status`、`template_version_id` | 横向授权、筛选、溯源 |
| `questionnaire_responses` | `questionnaire_instance_id`、`respondent_id` | 按实例/人查 |
| `questionnaire_revisions` | `questionnaire_instance_id` | 列修订历史 |
| `questionnaire_revisions` | `(instance_id, revision_no)` **UNIQUE** | 修订号唯一 |
| `questionnaire_template_versions` | `template_id` | 列版本 |
| `questionnaire_template_versions` | `(template_id, version_no)` **UNIQUE** | 版本号唯一 |
| `questionnaire_templates` | `created_by`、`status` | 筛选 |
| `questionnaire_templates` | `current_version_id` **UNIQUE** | 一个版本只能是一个模板的当前版本 |
| `questionnaire_templates` | `category_id` | 按分类筛选模板 |
| `questionnaire_template_categories` | `code` **UNIQUE** | 编码唯一（程序侧引用依据） |
| `questionnaire_instances` | `instance_no` **UNIQUE** | 可读编号唯一 |
| `instance_no_counters` | `(day, scope)` **PK** | 发号器复合主键 |
| `users` | `username` **UNIQUE** | 登录/鉴权查找 |

---

## 14. JSONB 用在哪、为什么

| 列 | 内容 | 为什么不拆表 |
| --- | --- | --- |
| `questionnaire_templates` 无 | — | — |
| `questionnaire_template_versions.schema` | 完整题目树 | 结构随业务变化，拆表会导致题目表频繁加列 |
| `questionnaire_instances.current_schema` | 该案当前结构 | 同上，且每案独立 |
| `questionnaire_revisions.schema_snapshot` | 历史结构 | 快照必须自包含，才能独立回看 |
| `questionnaire_instances.subject_info` | 调查对象信息 | 不同案件字段不同 |
| `questionnaire_answers.answer` | 单题答案 | 不同题型结构不同（字符串/数字/数组） |
| `ai_*.arguments / result / tool_*` | 工具入参出参 | 每类工具形状不同 |

**不 JSONB 化**（04 第 40 节）：ID、状态、时间、归属关系、可统计/可索引的字段。
判断标准是「需不需要按它查询、排序、加约束」。

`jsonb` 里的内容由 Zod（`QuestionnaireSchema`）在写入前校验，
数据库层不做 JSON Schema 约束 —— 这是有意的双重校验分工。

---

## 15. 改代码时要注意

1. **改 `schema.prisma` 后必须生成迁移**，不能只改代码：
   `pnpm db:migrate`（会生成迁移文件）。生产/首次建表用 `pnpm db:deploy`
2. **两处循环外键**：新建库时 `templates` 与 `template_versions` 谁先建都冲突，
   必须建表后用 `ALTER TABLE` 补 FK（04 第 51.1 节）
3. **加状态取值时必须同步这些地方**（否则会出现「只有 DB 知道」的状态）：
   - 对应的 `*_STATUSES` 常量
   - 允许流转的 `*_WRITABLE_*` / `*_FILLABLE_*` 常量
   - 状态机校验与测试
4. **删数据注意外键顺序**（RESTRICT 多，无级联删除）：

   ```text
   review_records → questionnaire_answers → questionnaire_responses
   → dispatch_tasks → ai_tool_executions → questionnaire_revisions
   → questionnaire_instances

   删模板前要先：断开 questionnaire_templates.current_version_id
   （若版本被实例引用，删模板会被应用层拒绝）

   删分类前要先：把引用它的模板 category_id 清空（外键 RESTRICT，
   应用层会拒绝并告诉你还有几个模板在用）
   ```
5. **`status` 类字段没有 CHECK 约束**，非法值不会被数据库拦住 ——
   全靠应用层。写测试时不要假设「数据库会拒绝」
6. **审计表是 append-only**：`ai_tool_executions` 与 `questionnaire_revisions`
   都不应被更新或删除（`created_by` 用 SET NULL 而非 RESTRICT 也是为此）

---

## 16. 与设计文档的差异汇总

本节记录「文档写的」与「库/代码实际是的」不一致之处，以及各自的处理方式。

**处理原则**（沿用本项目的既有约定）：设计文档作为 **V1.0 基线保持可追溯**，
不改写原始结论；实现阶段的**设计扩展**记入
[09-review-and-decisions.md](09-review-and-decisions.md) 的决策日志（D1–D15）；
**笔误**则原地订正。

| # | 位置 | 文档 | 实际 | 性质 | 处理 |
| --- | --- | --- | --- | --- | --- |
| 1 | `ai_tool_executions.conversation_id` | `NOT NULL` | 可空 | 实现时的**设计扩展** | ✅ 记入 **D14**（实测 13 条人工审计全部无会话；04 第 23.2 节保留原文，以 D14 为准） |
| 2 | `ai_tool_executions` | 无 `source` / `model` | 有这两列 | 实现扩展 | ✅ 同 **D14**（区分 AI 与人工编辑、记录模型） |
| 3 | `users.roles` | `NOT NULL` | 可空 | **文档笔误** | ✅ 已订正 04 第 8.2 节并加注 |
| 4 | `users` GIN 索引 | 建议创建 | 未创建 | **遗留建议** | ✅ 已在 04 第 8.4 节标注「V1 未创建」 |
| 5 | 04 第 51.2 节 | 「`operation_id` 不加唯一约束」 | `ai_tool_executions.operation_id` **有** UNIQUE | **表述歧义** | ✅ 已限定为「仅指本表」，并记入 **D15** 说明两表的不同取舍 |
| 7 | 本表新增（2026-10-15） | — | 新增 `questionnaire_template_categories`、
`instance_no_counters`、`questionnaire_templates.category_id`、
`questionnaire_instances.instance_no` | **能力扩展**（决策 D16，计划 §5.1/§5.3） |
| 6 | `RESPONSE_STATUSES` 常量 | — | 曾漏 `reviewed` | **代码不一致** | ✅ 已补齐，并加测试约束「常量必须覆盖会被写入的取值」 |

另外 04 第 2708 行（规则八）的 `under_review` 是**实例**状态，
与实例的 `WITHDRAWABLE` 常量一致；响应表没有该取值 —— 这**不是**差异。

> 想知道「现在是什么样」看本文档；想知道「当初为什么这样设计」看 04；
> 想知道「后来为什么改了」看 09 的决策日志。

---

## 附：快速核对真实结构

想知道**当前库到底是什么样**（而不是文档说是什么样），直接查：

```sql
-- 表清单
select table_name from information_schema.tables
where table_schema = 'public' order by table_name;

-- 某张表的字段
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name='questionnaire_instances'
order by ordinal_position;

-- 外键
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'questionnaire_instances'::regclass and contype='f';

-- 索引
select indexname, indexdef from pg_indexes
where schemaname='public' and tablename='questionnaire_templates';
```

或直接看 `prisma/schema.prisma`（ORM 层的真相，与上述查询一致）。
