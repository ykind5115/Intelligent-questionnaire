# 智能问卷系统

## 数据库设计说明书 V1.0

---

# 1. 文档概述

## 1.1 文档目的

本文档用于定义智能问卷系统 V1 的数据库结构，为 TypeScript + Node.js 后端开发提供数据库层设计依据。

数据库设计以《系统 RPD V1.0》和《系统架构设计说明书 V1.0》为基础，重点支撑以下核心能力：

```text
AI生成问卷
AI修改问卷
模板管理
模板版本
问卷实例
问卷实例版本
问卷下发
调查填写
审核
AI操作记录
```

---

# 2. 技术选型

## 2.1 数据库

采用：

```text
PostgreSQL
```

原因：

1. 关系型数据建模能力成熟。
2. 支持事务和完整约束。
3. 支持 JSONB，适合存储动态问卷结构。
4. 支持 UUID。
5. 便于 TypeScript 后端通过 ORM / Query Builder 访问。

---

## 2.2 后端语言

```text
TypeScript
```

建议后端采用 Node.js 运行环境。

数据库访问层**已定版为 Prisma**（决策 D4，见 `09-review-and-decisions.md`）：

```text
Prisma 7.10.0 + @prisma/client 7.10.0
```

本文档早期版本写的是「可以后续选择 Prisma / Drizzle / TypeORM / 原生 pg，
本数据库设计不强绑定具体 ORM」。

**该表述已作废**：

```text
1. D4 已定版 Express + Prisma，不再保留 ORM 候选；
2. 本文档的 JSONB 字段、乐观锁 UPDATE ... WHERE current_revision = $3、
   多表循环外键的 ALTER TABLE 顺序，都按 Prisma Schema + Migration 描述；
3. 版本锁定为 7.10.0（D10），因为 npm latest 当前指向 8.0 RC。
```

Prisma 相关的实操注意（版本锁定、pnpm 构建脚本、本地数据库）见
`06-proj_init.md` 第 3A 至 3E 节。

---

# 3. 数据库设计原则

## 3.1 关系型数据与动态结构分离

系统采用：

```text
关系型表
    +
JSONB
```

的混合设计。

关系型数据负责：

```text
模板
版本
实例
任务
用户
审核
AI会话
AI日志
```

JSONB 负责：

```text
QuestionnaireSchema
```

即真正的问卷树结构。

---

# 4. 核心实体

V1 核心数据实体如下：

```text
user
 │
 ├── questionnaire_template
 │       │
 │       └── questionnaire_template_version
 │
 ├── ai_conversation
 │       └── ai_message
 │              └── ai_tool_execution
 │
 └── questionnaire_instance
        │
        ├── questionnaire_revision
        ├── questionnaire_response
        │       └── questionnaire_answer
        │
        ├── dispatch_task
        │
        └── review_record
```

---

# 5. ER 关系概览

```text
                         ┌──────────────┐
                         │     user     │
                         └──────┬───────┘
                                │
                 ┌──────────────┼───────────────┐
                 │              │               │
                 ↓              ↓               ↓
      questionnaire_       ai_conversation   questionnaire_
         template                │              instance
             │                   │                  │
             ↓                   ↓                  ├───────┐
 questionnaire_template      ai_message             │       │
      _version                   │                  ↓       ↓
             │                   ↓          questionnaire  dispatch
             │              ai_tool_execution    _revision    _task
             │                                      │
             ↓                                      ↓
      questionnaire_                           response
          schema                                  │
                                                 ↓
                                               answer
                                                 │
                                                 ↓
                                              review
```

---

# 6. UUID 设计

## 6.1 主键统一使用 UUID

所有核心业务实体统一使用：

```sql
UUID
```

而不是数据库自增整数。

---

## 6.2 V1 推荐使用 UUID v7

本项目建议：

> **业务层生成 UUID v7，数据库字段使用 PostgreSQL `uuid` 类型。**

例如：

```text
01995...
01995...
01995...
```

UUID v7 本身具有时间有序特性，更适合本系统这种：

```text
高频创建问卷实例
大量 AI 操作记录
大量消息记录
版本记录
```

的业务。

需要注意：

> UUID v7 的生成放在 TypeScript 应用层，不依赖 PostgreSQL 自己生成。

这样数据库只负责保存 UUID，不承担 UUID 版本生成逻辑。

---

## 6.3 为什么不是全部使用 `gen_random_uuid()`

PostgreSQL 中：

```sql
DEFAULT gen_random_uuid()
```

可以很方便地生成 UUID v4。

V1 如果追求最简单的数据库实现，也完全可以使用 UUID v4。

但是本项目有大量：

```text
message
tool_execution
revision
```

这类持续写入的数据。

因此本设计优先采用：

```text
TypeScript
    ↓
UUID v7
    ↓
PostgreSQL uuid
```

---

# 7. 时间字段

所有核心表统一：

```sql
created_at TIMESTAMPTZ NOT NULL
updated_at TIMESTAMPTZ NOT NULL
```

时间统一使用：

```text
UTC
```

应用层根据用户时区进行展示。

---

# 8. user 用户表

## 8.1 用途

保存系统用户基础信息。

---

## 8.2 表结构

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    display_name VARCHAR(100) NOT NULL,
    password_hash TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'active',

    roles VARCHAR(30)[] NOT NULL DEFAULT '{}',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 8.3 字段说明

| 字段            | 类型          | 说明    |
| ------------- | ----------- | ----- |
| id            | UUID        | 用户 ID |
| username      | VARCHAR     | 登录账号  |
| display_name  | VARCHAR     | 显示名称  |
| password_hash | TEXT        | 密码哈希  |
| status        | VARCHAR     | 用户状态  |
| roles         | VARCHAR[]   | 角色数组  |
| created_at    | TIMESTAMPTZ | 创建时间  |
| updated_at    | TIMESTAMPTZ | 更新时间  |

## 8.4 角色模型（决策 D8）

V1 采用最简方案：**在 `users` 表上直接放一个 `roles` 数组字段**，
不建独立的 RBAC 表。

四类角色：

```text
template_admin      模板管理
dispatcher          问卷创建 / 下发 / 撤回
investigator        问卷填写
reviewer            问卷审核
```

设计说明：

```text
1. 使用数组而非单值，允许一人多角色
   （例如管理员同时是审核人）。

2. 默认值 '{}' 表示无任何角色，只能登录不能操作，
   避免新用户默认获得权限。

3. 不用 ENUM 类型而用 VARCHAR(30)[]：
   新增角色时不需要 ALTER TYPE，迁移成本更低。

4. 需要按角色查询用户时，可加 GIN 索引：
   CREATE INDEX idx_users_roles ON users USING GIN (roles);
```

本文档早期版本写的是「V1 的角色权限可以暂时简化，
如果后续需要完整 RBAC，再独立增加 roles / permissions / user_roles /
role_permissions」。

**该表述已作废**：V1 直接使用 `users.roles` 字段。
未来需要细粒度权限时，`roles` 可平滑迁移为 `user_roles` 关联表，
不影响调用方（因为调用方看到的一直是「用户拥有哪些角色」）。

---

# 9. questionnaire_templates

## 9.1 用途

表示一个正式的问卷模板。

例如：

```text
无人机黑飞核查问卷
宠物饲养规范核查问卷
```

---

## 9.2 表结构

```sql
CREATE TABLE questionnaire_templates (
    id UUID PRIMARY KEY,

    name VARCHAR(200) NOT NULL,
    description TEXT,

    status VARCHAR(20) NOT NULL DEFAULT 'draft',

    current_version_id UUID,

    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_template_creator
        FOREIGN KEY (created_by)
        REFERENCES users(id)
);
```

---

# 10. questionnaire_template_versions

## 10.1 用途

保存正式模板的具体版本。

例如：

```text
无人机黑飞核查问卷
    ├── V1.0
    ├── V1.1
    └── V2.0
```

---

## 10.2 表结构

```sql
CREATE TABLE questionnaire_template_versions (
    id UUID PRIMARY KEY,

    template_id UUID NOT NULL,

    version_no INTEGER NOT NULL,

    schema JSONB NOT NULL,

    change_note TEXT,

    status VARCHAR(20) NOT NULL DEFAULT 'draft',

    source_type VARCHAR(30) NOT NULL DEFAULT 'manual',
    -- 'manual' | 'ai_generated' | 'promoted_from_instance'

    source_instance_id UUID,
    -- 当 source_type = 'promoted_from_instance' 时，
    -- 记录该版本来自哪个问卷实例（决策 D2）

    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_template_version_template
        FOREIGN KEY (template_id)
        REFERENCES questionnaire_templates(id),

    CONSTRAINT fk_template_version_creator
        FOREIGN KEY (created_by)
        REFERENCES users(id),

    CONSTRAINT fk_template_version_source_instance
        FOREIGN KEY (source_instance_id)
        REFERENCES questionnaire_instances(id),

    CONSTRAINT uq_template_version
        UNIQUE (template_id, version_no)
);
```

## 10.3 版本来源（决策 D2）

三个字段共同回答「这个版本是怎么来的」：

```text
source_type = 'ai_generated'
    → 由 AI 对话生成，经 POST /ai/conversations/{id}/commit 落库

source_type = 'promoted_from_instance'
    → 由某个问卷实例扶正而来，见 POST /questionnaire-instances/{id}/promote
    → source_instance_id 指向来源实例

source_type = 'manual'
    → 人工创建或人工编辑器保存
```

**注意外键方向**：`questionnaire_template_versions.source_instance_id`
指向 `questionnaire_instances`，而 `questionnaire_instances.template_version_id`
又指向本表。

```text
questionnaire_template_versions ──┐
        │                         │ source_instance_id
        │ template_version_id     │
        ↓                         │
questionnaire_instances ──────────┘
```

这是一个**循环引用**，因此：

```text
1. source_instance_id 必须可空（NULL 表示非扶正来源）；
2. 两张表的建表语句不能同时带这个 FK，
   必须先建表，再 ALTER TABLE 添加约束；
3. 实例被删除（V1 不物理删除）时该 FK 不会触发问题。
```

Migration 顺序因此需要调整为：

```text
1. 建 questionnaire_template_versions（不含 source_instance_id 的 FK）
2. 建 questionnaire_instances
3. ALTER TABLE questionnaire_template_versions
     ADD CONSTRAINT fk_template_version_source_instance
     FOREIGN KEY (source_instance_id) REFERENCES questionnaire_instances(id)
```

---

# 11. 模板版本设计规则

一个模板：

```text
template
```

拥有多个：

```text
template_version
```

例如：

```text
template_id = T001

V1
V2
V3
```

---

## 11.1 发布后的版本不可直接修改

例如：

```text
V2.0 PUBLISHED
```

之后如果需要修改：

```text
V2.0
    ↓
复制
    ↓
V2.1 / V3
```

而不是：

```text
V2.0
    ↓
直接修改
```

这样历史数据才能稳定。

---

# 12. Template current_version_id

`questionnaire_templates.current_version_id` 指向当前正在使用的正式版本。

例如：

```text
template
    │
    └── current_version_id → V2
```

这样查询模板时不需要每次重新计算最新版本。

---

# 13. questionnaire_instances

## 13.1 用途

代表一次实际调查任务中的问卷。

例如：

```text
模板：
无人机黑飞核查问卷 V2

调查对象：
张三

→

问卷实例 #001
```

---

## 13.2 表结构

```sql
CREATE TABLE questionnaire_instances (
    id UUID PRIMARY KEY,

    template_version_id UUID NOT NULL,

    title VARCHAR(200) NOT NULL,

    subject_info JSONB,

    current_schema JSONB NOT NULL,

    current_revision INTEGER NOT NULL DEFAULT 1,

    status VARCHAR(30) NOT NULL DEFAULT 'draft',

    created_by UUID NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_instance_template_version
        FOREIGN KEY (template_version_id)
        REFERENCES questionnaire_template_versions(id),

    CONSTRAINT fk_instance_creator
        FOREIGN KEY (created_by)
        REFERENCES users(id)
);
```

---

# 14. 为什么 Instance 要保存 `current_schema`

这是数据库设计中的一个重要决定。

模板版本：

```text
template_version.schema
```

实例：

```text
questionnaire_instance.current_schema
```

例如：

```text
Template V2.0
      │
      │ clone
      ↓
Instance #001
```

实例生成时：

```text
current_schema
=
template_version.schema
```

之后 AI 修改：

```text
Instance #001
      ↓
修改 current_schema
```

而：

```text
Template V2.0
```

完全不变。

---

# 15. subject_info

V1 不建议一开始把调查对象拆成大量固定字段。

使用：

```sql
subject_info JSONB
```

例如：

```json
{
  "name": "张三",
  "id_card": "********",
  "address": "xxx",
  "phone": "********"
}
```

这样不同业务可以拥有不同调查对象信息。

后续如果某些字段需要：

```text
查询
索引
统计
关联
```

再单独结构化。

---

# 16. questionnaire_revisions

## 16.1 用途

记录一次具体问卷实例的结构修改历史。

例如：

```text
Instance #001

Revision 1
    ↓
增加团伙调查
    ↓
Revision 2
    ↓
增加活动地点
    ↓
Revision 3
```

---

## 16.2 表结构

```sql
CREATE TABLE questionnaire_revisions (
    id UUID PRIMARY KEY,

    questionnaire_instance_id UUID NOT NULL,

    revision_no INTEGER NOT NULL,

    schema_snapshot JSONB NOT NULL,

    operation_type VARCHAR(30),
    operation_id UUID,

    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_revision_instance
        FOREIGN KEY (questionnaire_instance_id)
        REFERENCES questionnaire_instances(id),

    CONSTRAINT fk_revision_creator
        FOREIGN KEY (created_by)
        REFERENCES users(id),

    CONSTRAINT uq_instance_revision
        UNIQUE (questionnaire_instance_id, revision_no)
);
```

## 16.3 Revision 的粒度（决策 D9）

> **一次 Tool 调用 = 一个 operation_id = 一次 Revision 递增。**

```text
一条用户消息
  → 可能触发多次增量 Tool 调用
  → 因此一次对话可能产生多个 Revision
```

例如「增加团伙调查模块，里面要调查有没有团伙以及团伙成员」：

```text
Revision 1（实例创建时的克隆快照）
   ↓ add_section      → Revision 2
   ↓ add_question     → Revision 3
   ↓ add_question     → Revision 4
```

这是**设计目标**而非缺陷：

```text
1. 每次 Tool 调用的效果都可独立还原；
2. D2 扶正时需要「这次改了什么」的精确 diff；
3. operation_id 与 revision 一一对应，重试时不会重复产生一批 Revision。
```

## 16.4 `operation_id` 是否需要唯一约束

**不加 UNIQUE 约束。**

原设计考虑过给 `operation_id` 加唯一性以保证幂等，
但幂等的判定依据是 `ai_tool_executions` 表（见第 24 节），
不需要在 `questionnaire_revisions` 上重复约束：

```text
1. 幂等判断在 ai_tool_executions 层完成（先查后插）；
2. 若此处也加 UNIQUE，两处约束语义重叠，
   未来某一处变更容易造成不一致；
3. revision 表是历史记录，应当只追加，不做唯一性拦截。
```

## 16.5 `created_by` 的补充说明

本文档早期版本的 `created_by` 无外键。
**现已补充 `fk_revision_creator`**，理由：

```text
审计需求要求能回答「这个问题是谁什么时候加进去的」
（见本文档第 341 节与第 35 节），
没有外键就无法可靠关联到用户。
```

该字段可空的原因：系统自动产生的 Revision（如实例初始化时的
Revision 1）可能没有明确的操作用户。

---

# 17. 为什么需要 Revision

假设 AI 修改问卷后出现异常：

```text
原来：
5个问题

AI修改后：
8个问题
```

我们需要知道：

```text
什么时候改的？
是谁触发的？
修改之前是什么？
修改之后是什么？
```

Revision 可以提供：

```text
Revision 1 → Revision 2
```

之间的明确边界。

---

# 18. Revision 与 AI Tool Log 的关系

两者解决的问题不同。

### Revision

回答：

> **问卷最终变成什么样？**

### AI Tool Execution

回答：

> **AI具体执行了什么操作？**

因此：

```text
Revision
+
AI Tool Execution
```

应该同时存在。

---

# 19. ai_conversations

## 19.1 用途

保存 AI 对话会话。

---

## 19.2 表结构

```sql
CREATE TABLE ai_conversations (
    id UUID PRIMARY KEY,

    user_id UUID NOT NULL,

    scene VARCHAR(50) NOT NULL,

    target_type VARCHAR(50),
    target_id UUID,

    status VARCHAR(20) NOT NULL DEFAULT 'active',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_ai_conversation_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
);
```

---

# 20. AI Scene

V1：

```text
create_template
modify_questionnaire
```

例如：

```text
conversation #001
scene = create_template
target_type = template
target_id = xxx
```

或者：

```text
conversation #002
scene = modify_questionnaire
target_type = questionnaire_instance
target_id = xxx
```

---

# 21. ai_messages

## 21.1 用途

记录 AI 对话消息。

---

## 21.2 表结构

```sql
CREATE TABLE ai_messages (
    id UUID PRIMARY KEY,

    conversation_id UUID NOT NULL,

    role VARCHAR(20) NOT NULL,

    content TEXT,

    tool_name VARCHAR(100),

    tool_call_id VARCHAR(100),

    tool_arguments JSONB,

    tool_result JSONB,

    sequence_no INTEGER NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_ai_message_conversation
        FOREIGN KEY (conversation_id)
        REFERENCES ai_conversations(id),

    CONSTRAINT uq_ai_message_sequence
        UNIQUE (conversation_id, sequence_no)
);
```

---

# 22. 为什么 Tool Call 也可以记录在 Message

LLM 对话本身可能产生：

```text
user
assistant
tool
assistant
```

例如：

```text
User：
增加一个团伙问题

Assistant：
调用 add_question

Tool：
执行成功

Assistant：
已增加该问题
```

因此 `ai_messages` 最好能够描述整个 LLM 交互链路。

---

# 23. ai_tool_executions

## 23.1 用途

专门保存 Tool 的业务执行记录。

相比 `ai_messages`，这个表更关注：

> **一次工具操作本身。**

---

## 23.2 表结构

```sql
CREATE TABLE ai_tool_executions (
    id UUID PRIMARY KEY,

    conversation_id UUID NOT NULL,

    questionnaire_instance_id UUID,

    message_id UUID,

    operation_id UUID NOT NULL,

    tool_name VARCHAR(100) NOT NULL,

    arguments JSONB NOT NULL,

    result JSONB,

    success BOOLEAN NOT NULL,

    error_code VARCHAR(100),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_tool_execution_conversation
        FOREIGN KEY (conversation_id)
        REFERENCES ai_conversations(id),

    CONSTRAINT fk_tool_execution_instance
        FOREIGN KEY (questionnaire_instance_id)
        REFERENCES questionnaire_instances(id),

    CONSTRAINT fk_tool_execution_message
        FOREIGN KEY (message_id)
        REFERENCES ai_messages(id),

    CONSTRAINT uq_tool_operation
        UNIQUE (operation_id)
);
```

---

# 24. operation_id

`operation_id` 用于保证 Tool 的幂等性。

例如：

```text
operation_id = O001
```

第一次：

```text
O001
→ 执行
→ SUCCESS
```

第二次因为网络重试：

```text
O001
→ 查询已经存在
→ 返回第一次执行结果
```

而不是再次修改问卷。

## 24.1 幂等粒度（决策 D9）

> **一次 Tool 调用 = 一个 `operation_id`。**

```text
一条用户消息
  └── LLM 回合
        ├── Tool Call #1 → op_001
        ├── Tool Call #2 → op_002
        └── Tool Call #3 → op_003
```

这与 `03-questionnaire_schema_ai_tool_calling .md` 第 32 节、
`08-ai_agent_prompt_tool_calling.md` 第 25.2 节一致。

## 24.2 实现方式：先查后插，不要依赖 UNIQUE 报错

`ai_tool_executions.operation_id` 上有 `UNIQUE` 约束（见第 23 节 DDL）。

**但幂等判断不能实现为「INSERT 失败即视为重复」**：

```text
那样做的话，第二次重试会在数据库层抛出唯一约束冲突，
而不是干净地返回第一次的执行结果——
模型收到的是一个数据库异常，而不是「你刚才已经做过了」。
```

**正确实现：**

```text
BEGIN

  SELECT * FROM ai_tool_executions
   WHERE operation_id = $1

  查到且 success = true
    → 直接返回已记录的 result，不修改问卷，COMMIT

  查到且 success = false
    → 说明上次执行失败；允许重试，或返回同一失败结果

  查不到
    → 执行 Tool
    → INSERT ai_tool_executions
    → 下一次 Tool 调用使用新的 operation_id
    → COMMIT

END
```

## 24.3 为什么表结构上仍保留 UNIQUE

```text
1. 它是数据库层的最后一道防线：即使应用层有 bug，
   也不会写出两条相同 operation_id 的记录；
2. 它让「一次 Tool 调用 = 一条执行记录」这个不变量
   由数据库而非仅由代码保证；
3. 应用层的先查后插负责给出友好的返回结果，
   数据库约束负责兜底。
```

两者的分工与第 44 节「JSONB 数据校验」的双重校验思路一致。

---

# 25. dispatch_tasks

## 25.1 用途

表示具体问卷下发任务。

---

## 25.2 表结构

```sql
CREATE TABLE dispatch_tasks (
    id UUID PRIMARY KEY,

    questionnaire_instance_id UUID NOT NULL,

    assigned_to UUID NOT NULL,

    dispatched_by UUID NOT NULL,

    status VARCHAR(30) NOT NULL DEFAULT 'pending',

    dispatched_at TIMESTAMPTZ,

    due_at TIMESTAMPTZ,

    withdrawn_at TIMESTAMPTZ,
    withdrawn_by UUID,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_dispatch_instance
        FOREIGN KEY (questionnaire_instance_id)
        REFERENCES questionnaire_instances(id),

    CONSTRAINT fk_dispatch_assignee
        FOREIGN KEY (assigned_to)
        REFERENCES users(id),

    CONSTRAINT fk_dispatch_creator
        FOREIGN KEY (dispatched_by)
        REFERENCES users(id),

    CONSTRAINT fk_dispatch_withdrawer
        FOREIGN KEY (withdrawn_by)
        REFERENCES users(id)
);
```

## 25.3 撤回支持（决策 D1）

因为「下发后结构冻结」，必须提供撤回路径（见 `05-api_design.md`
第 13A 节），`dispatch_tasks` 需要记录撤回信息：

```text
status       'pending' | 'dispatched' | 'withdrawn' | 'completed'
withdrawn_at 撤回时间
withdrawn_by 撤回操作人（dispatcher 角色）
```

撤回时同一事务内还需要：

```text
1. questionnaire_instances.status  → 'draft'
2. questionnaire_responses.status  → 'withdrawn'
3. 本表 status                     → 'withdrawn'
```

**注意：** 不物理删除任何记录，撤回只是状态变更。
理由见第 45 节的删除策略。

---

# 26. questionnaire_responses

## 26.1 用途

表示调查人员对问卷实例进行的一次填写结果。

---

## 26.2 表结构

```sql
CREATE TABLE questionnaire_responses (
    id UUID PRIMARY KEY,

    questionnaire_instance_id UUID NOT NULL,

    respondent_id UUID NOT NULL,

    status VARCHAR(30) NOT NULL DEFAULT 'draft',

    submitted_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_response_instance
        FOREIGN KEY (questionnaire_instance_id)
        REFERENCES questionnaire_instances(id),

    CONSTRAINT fk_response_respondent
        FOREIGN KEY (respondent_id)
        REFERENCES users(id)
);
```

这里的 `respondent_id` 指的是：

> 实际填写这份问卷的调查人员。

而不是被调查对象。

---

# 27. questionnaire_answers

## 27.1 用途

保存每道题的答案。

---

## 27.2 表结构

```sql
CREATE TABLE questionnaire_answers (
    id UUID PRIMARY KEY,

    response_id UUID NOT NULL,

    question_id VARCHAR(100) NOT NULL,

    revision_no INTEGER NOT NULL,
    -- 记录该答案是在哪个实例修订版本下填写的（见第 29 节说明）

    answer JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_answer_response
        FOREIGN KEY (response_id)
        REFERENCES questionnaire_responses(id),

    CONSTRAINT uq_response_question
        UNIQUE (response_id, question_id)
);
```

## 27.3 为什么答案要记录 `revision_no`

本文档第 29 节说明：`question_id` 无法建立外键，
答案与题目之间只能靠「当时的 Questionnaire Schema」进行逻辑关联。

因此必须记录填写时的版本：

```text
questionnaire_answers.revision_no
        ↓
对应 questionnaire_revisions.revision_no
        ↓
拿到当时的 schema_snapshot
        ↓
还原「这道题当时长什么样、有哪些选项」
```

**这一字段是 D1（下发后冻结）能够安全成立的前提之一：**

```text
若未来允许撤回后修改结构，已填写的旧答案不会因为
题目被改名或选项被调整而变得无法解释——
因为它绑定的是当时的 revision。
```

另外 `questionnaire_responses.status` 需要支持以下取值：

```text
draft       填写中
submitted   已提交
withdrawn   因实例被撤回而失效（决策 D1）
```

---

# 28. 为什么答案也使用 JSONB

不同题型的数据结构不同：

```text
text
number
single_choice
multiple_choice
date
boolean
```

如果全部强制拆成：

```text
text_value
number_value
date_value
boolean_value
...
```

会产生大量字段。

V1 可以统一：

```text
answer JSONB
```

例如：

文本：

```json
"张三"
```

单选：

```json
"yes"
```

多选：

```json
["drone", "camera"]
```

数字：

```json
3
```

日期：

```json
"2026-09-30"
```

---

# 29. 为什么 `question_id` 不建立外键

这里有一个很重要的设计。

答案关联的是：

```text
question_id
```

但是这个问题属于：

```text
QuestionnaireSchema
```

而不是独立的 `questions` 数据库表。

因此无法直接：

```sql
FOREIGN KEY → questions(id)
```

V1 采用：

```text
response
    ↓
question_id
    ↓
对应当时的 questionnaire revision/schema
```

进行逻辑关联。

这也是为什么：

> **问卷 Revision 必须保留。**

---

# 30. review_records

## 30.1 用途

保存审核操作。

---

## 30.2 表结构

```sql
CREATE TABLE review_records (
    id UUID PRIMARY KEY,

    questionnaire_response_id UUID NOT NULL,

    reviewer_id UUID NOT NULL,

    result VARCHAR(30) NOT NULL,

    comment TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_review_response
        FOREIGN KEY (questionnaire_response_id)
        REFERENCES questionnaire_responses(id),

    CONSTRAINT fk_review_reviewer
        FOREIGN KEY (reviewer_id)
        REFERENCES users(id)
);
```

---

# 31. 数据表完整列表

V1 数据库核心表最终为：

```text
users

questionnaire_templates
questionnaire_template_versions

questionnaire_instances
questionnaire_revisions

ai_conversations
ai_messages
ai_tool_executions

dispatch_tasks

questionnaire_responses
questionnaire_answers

review_records
```

共：

```text
12 张核心表
```

---

# 32. 核心关系

## 32.1 Template

```text
questionnaire_templates
        │
        │ 1:N
        ↓
questionnaire_template_versions
```

一个模板拥有多个版本。

---

## 32.2 Template → Instance

```text
questionnaire_template_versions
        │
        │ 1:N
        ↓
questionnaire_instances
```

一个模板版本可以产生多个具体问卷实例。

---

## 32.3 Instance → Revision

```text
questionnaire_instances
        │
        │ 1:N
        ↓
questionnaire_revisions
```

一个实例拥有多个修改版本。

---

## 32.4 Instance → Response

```text
questionnaire_instances
        │
        │ 1:N
        ↓
questionnaire_responses
```

一个问卷实例理论上可以存在一次或多次填写记录，具体业务规则可以在后续限制。

---

# 33. AI 数据关系

```text
ai_conversations
        │
        │ 1:N
        ↓
ai_messages
        │
        │
        ↓
ai_tool_executions
```

同时：

```text
ai_conversation
       │
       └────→ questionnaire_instance
```

用于表示当前 AI 正在操作哪一份业务数据。

---

# 34. 一次 AI 修改的完整数据流

用户：

```text
“增加一个是否有团伙的问题。”
```

系统执行：

```text
ai_conversations
        ↓
ai_messages
        ↓
LLM Tool Call
        ↓
ai_tool_executions
        ↓
questionnaire_instances.current_schema
        ↓
questionnaire_revisions
```

最终：

```text
Conversation
     │
     ├── Message
     │
     └── Tool Execution
              │
              ↓
        Instance Revision
              │
              ↓
        Current Schema
```

这样数据链条完整。

---

# 35. 数据库事务边界

## 35.1 单个 Tool 调用

例如：

```text
add_question
```

一个 Tool 调用对应一个业务事务。

事务内：

```text
1. 查询 Instance
2. 校验 Section
3. 修改 Schema
4. revision + 1
5. 创建 Revision
6. 创建 Tool Execution
7. Commit
```

---

# 36. AI Tool 事务示例

例如当前：

```text
revision = 3
```

AI 执行：

```text
add_question
```

事务：

```text
BEGIN

读取 Instance

验证参数

修改 current_schema

revision = 4

INSERT questionnaire_revision

INSERT ai_tool_execution

COMMIT
```

最终：

```text
Instance.current_revision = 4
```

---

# 37. 并发控制

考虑两个请求同时修改同一个问卷：

```text
Request A
Request B
```

都读取：

```text
revision = 3
```

如果不控制：

```text
A → revision 4
B → revision 4
```

可能发生覆盖。

因此 V1 建议采用：

> **乐观锁。**

例如：

```sql
UPDATE questionnaire_instances
SET
    current_schema = $1,
    current_revision = current_revision + 1
WHERE
    id = $2
    AND current_revision = $3;
```

如果影响行数：

```text
0
```

说明版本已经发生变化，需要重新读取后处理。

---

# 38. Index 设计

V1 至少创建以下索引。

## Template

```sql
CREATE INDEX idx_template_status
ON questionnaire_templates(status);

CREATE INDEX idx_template_creator
ON questionnaire_templates(created_by);
```

---

## Template Version

```sql
CREATE INDEX idx_template_version_template
ON questionnaire_template_versions(template_id);
```

---

## Instance

```sql
CREATE INDEX idx_instance_template_version
ON questionnaire_instances(template_version_id);

CREATE INDEX idx_instance_status
ON questionnaire_instances(status);

CREATE INDEX idx_instance_creator
ON questionnaire_instances(created_by);
```

---

## Revision

```sql
CREATE INDEX idx_revision_instance
ON questionnaire_revisions(questionnaire_instance_id);
```

---

## AI

```sql
CREATE INDEX idx_ai_conversation_user
ON ai_conversations(user_id);

CREATE INDEX idx_ai_message_conversation
ON ai_messages(conversation_id);

CREATE INDEX idx_tool_execution_conversation
ON ai_tool_executions(conversation_id);

CREATE INDEX idx_tool_execution_instance
ON ai_tool_executions(questionnaire_instance_id);
```

---

## Dispatch

```sql
CREATE INDEX idx_dispatch_assignee
ON dispatch_tasks(assigned_to);

CREATE INDEX idx_dispatch_status
ON dispatch_tasks(status);
```

---

# 39. JSONB 使用边界

V1 中允许 JSONB 的地方主要有：

```text
questionnaire_template_versions.schema
questionnaire_instances.subject_info
questionnaire_instances.current_schema
questionnaire_revisions.schema_snapshot
ai_messages.tool_arguments
ai_messages.tool_result
ai_tool_executions.arguments
ai_tool_executions.result
questionnaire_answers.answer
```

---

# 40. 哪些东西不能随便 JSONB 化

以下内容不建议放进某个大 JSON：

```text
用户
模板
版本
问卷实例
AI会话
AI消息
下发任务
审核记录
```

因为这些对象需要：

```text
查询
关联
权限
统计
排序
约束
事务
```

应该正常建立关系型表。

---

# 41. Questionnaire Schema 与数据库 Schema 的区别

这里一定要区分两个概念。

### 数据库 Schema

指：

```text
tables
columns
foreign keys
indexes
```

---

### Questionnaire Schema

指：

```text
section
question
option
validation
```

例如：

```text
questionnaire_instances.current_schema
```

中的内容。

---

# 42. TypeScript 类型映射

数据库中的：

```json
QuestionnaireSchema
```

应该在 TypeScript 中存在对应类型。

例如：

```ts
export type QuestionType =
  | "text"
  | "textarea"
  | "number"
  | "single_choice"
  | "multiple_choice"
  | "date"
  | "datetime"
  | "boolean";

export interface QuestionOption {
  id: string;
  label: string;
  value: string;
  order: number;
}

export interface QuestionnaireQuestion {
  id: string;
  type: QuestionType;
  title: string;
  description?: string;
  required: boolean;
  order: number;
  options?: QuestionOption[];
}

export interface QuestionnaireSection {
  id: string;
  title: string;
  description?: string;
  order: number;
  questions: QuestionnaireQuestion[];
  children?: QuestionnaireSection[];
}

export interface QuestionnaireSchema {
  id: string;
  title: string;
  description?: string;
  sections: QuestionnaireSection[];
  version: number;
  metadata?: Record<string, unknown>;
}
```

数据库中的：

```text
JSONB
```

就是存储该结构。

---

# 43. TypeScript 与数据库对象的区别

不要把：

```text
Database Row
```

和：

```text
QuestionnaireSchema
```

强行设计成完全一样的类型。

例如：

```ts
interface QuestionnaireInstanceRow {
  id: string;
  templateVersionId: string;
  title: string;
  subjectInfo: unknown;
  currentSchema: unknown;
  currentRevision: number;
  status: string;
  createdBy: string;
}
```

经过 Repository / Mapper 后：

```ts
interface QuestionnaireInstance {
  id: string;
  templateVersionId: string;
  title: string;
  subjectInfo: SubjectInfo;
  currentSchema: QuestionnaireSchema;
  currentRevision: number;
  status: QuestionnaireStatus;
}
```

这样业务层不会被数据库字段格式绑死。

---

# 44. JSONB 数据校验

数据库字段：

```sql
schema JSONB NOT NULL
```

本身不能保证：

```text
sections
questions
type
options
```

一定符合 Questionnaire Schema。

因此需要双重校验：

```text
TypeScript / Runtime Schema Validation
              +
PostgreSQL
```

TypeScript 层可以使用：

```text
Zod
```

等 Runtime Schema Validation 工具。

例如：

```ts
const questionnaireSchema = z.object({
  id: z.string(),
  title: z.string(),
  sections: z.array(sectionSchema),
});
```

数据库负责：

```text
NOT NULL
FK
UNIQUE
CHECK
```

应用层负责：

```text
QuestionnaireSchema
```

的详细结构校验。

---

# 45. 删除策略

## 45.1 正式模板

不建议物理删除。

采用：

```text
status = disabled
```

---

## 45.2 模板版本

已经发布并被使用的版本：

```text
禁止删除
```

---

## 45.3 问卷实例

已经产生调查记录的实例：

```text
不允许直接物理删除
```

至少需要保留业务历史。

---

## 45.4 AI 消息和日志

原则上：

```text
只追加
```

不频繁更新历史记录。

---

# 46. 模板实例化过程

当用户选择：

```text
无人机黑飞核查问卷 V2
```

系统执行：

```text
读取 template_version.schema
          ↓
复制 schema
          ↓
创建 questionnaire_instance
          ↓
current_revision = 1
```

同时创建：

```text
questionnaire_revision
revision_no = 1
schema_snapshot = 原始 Schema
```

这样实例从出生开始就有完整快照。

---

# 47. 实例修改过程

例如：

```text
Instance Revision 1
```

AI：

```text
增加团伙调查
```

数据库事务：

```text
Instance Revision 1
      ↓
修改 current_schema
      ↓
Instance Revision 2
```

Revision 2 保存：

```text
schema_snapshot
```

以及：

```text
operation_id
operation_type
```

---

# 48. AI 修改为什么不直接修改 Template Version

因为：

```text
Template Version
```

代表正式业务定义。

而：

```text
Questionnaire Instance
```

代表一次具体业务。

例如：

```text
正式模板：
无人机黑飞 V2

案件 A：
增加团伙调查

案件 B：
增加活动轨迹调查

案件 C：
没有特殊要求
```

最终：

```text
V2
├── Instance A
│      └── 团伙调查
│
├── Instance B
│      └── 活动轨迹
│
└── Instance C
       └── 原始结构
```

这正是本系统需要解决的问题。

---

# 49. V1 是否需要独立 Question / Section 表

答案：

> **V1 暂不需要。**

不要一开始就设计：

```text
questions
sections
options
question_conditions
question_rules
...
```

大量关系表。

因为目前核心需求是：

```text
整体读取问卷
整体修改问卷
整体渲染问卷
保存问卷版本
```

JSONB 更合适。

---

# 50. 后续什么时候考虑拆表

当未来出现：

```text
题目复用
题库
复杂条件逻辑
题目统计
跨问卷题目分析
题目版本
复杂查询
```

时，再考虑把：

```text
Question
Option
Condition
Rule
```

逐步结构化。

即：

```text
V1
JSONB

↓

V2/V3
混合模型

↓

成熟版本
按业务需要拆分
```

---

# 51. V1 数据库初始化顺序

建议数据库 Migration 按依赖关系建立。

```text
1.  users

2.  questionnaire_templates
2b. questionnaire_templates.current_version_id 的 FK
      （依赖第 3 步，见下方说明）

3.  questionnaire_template_versions
      （不含 source_instance_id 的 FK）

4.  questionnaire_instances

5.  ALTER TABLE questionnaire_template_versions
      ADD CONSTRAINT fk_template_version_source_instance
      （依赖第 4 步，决策 D2）

6.  questionnaire_revisions

7.  ai_conversations

8.  ai_messages

9.  ai_tool_executions

10. dispatch_tasks

11. questionnaire_responses

12. questionnaire_answers

13. review_records
```

## 51.1 两处循环外键必须拆成 ALTER TABLE

本文档存在两处表间循环引用，**建表语句不能直接互相引用**：

```text
循环一：
  questionnaire_templates.current_version_id → questionnaire_template_versions.id
  questionnaire_template_versions.template_id → questionnaire_templates.id

循环二：
  questionnaire_template_versions.source_instance_id → questionnaire_instances.id
  questionnaire_instances.template_version_id → questionnaire_template_versions.id
```

处理方式统一为：

```text
1. 先建两张表，其中一侧的可空字段不带 FK；
2. 再 ALTER TABLE 补上 FK 约束。
```

这一点必须在 Migration 里明确写出来，
否则 Prisma 生成迁移时会出现无法解析的依赖顺序。

## 51.2 本版新增/变更的字段汇总

由已确认决策引入的结构变更：

| 表 | 变更 | 决策 |
| --- | --- | --- |
| `users` | 新增 `roles VARCHAR(30)[]` | D8 |
| `questionnaire_template_versions` | 新增 `source_type`、`source_instance_id` | D2 |
| `questionnaire_revisions` | `created_by` 补 FK | — |
| `questionnaire_revisions` | `operation_id` 不加唯一约束 | D9 |
| `dispatch_tasks` | 新增 `withdrawn_at`、`withdrawn_by` | D1 |
| `questionnaire_answers` | 新增 `revision_no INTEGER NOT NULL` | — |
| `questionnaire_responses` | `status` 增加 `withdrawn` 取值 | D1 |

---

# 52. TypeScript 项目中的数据库目录建议

数据库层可以初步组织为：

```text
src/
├── database/
│   ├── client.ts
│   ├── migrations/
│   ├── schema/
│   └── seeds/
│
├── modules/
│   ├── template/
│   ├── questionnaire/
│   ├── ai/
│   ├── dispatch/
│   ├── response/
│   └── review/
│
└── shared/
```

具体 ORM 目录结构在 TypeScript 项目初始化文档中确定。

---

# 53. 数据访问层原则

业务层不直接执行 SQL。

推荐：

```text
Controller
    ↓
Service
    ↓
Repository
    ↓
Database
```

例如：

```ts
questionnaireService.modifyQuestionnaire()
        ↓
questionnaireRepository.updateSchema()
        ↓
PostgreSQL
```

---

# 54. AI Tool 与 Repository 的关系

AI Tool 不直接调用数据库。

正确结构：

```text
LLM
 ↓
Tool
 ↓
QuestionnaireService
 ↓
QuestionnaireRepository
 ↓
PostgreSQL
```

而不是：

```text
LLM
 ↓
Tool
 ↓
Prisma
```

Tool 仍然属于业务入口。

这样：

```text
权限
校验
事务
版本控制
日志
```

都可以统一处理。

---

# 55. V1 一次完整操作示例

用户说：

```text
“增加一个是否存在团伙的问题。”
```

系统：

```text
① AI Conversation

② AI Message

③ LLM Tool Call

④ Tool Execution

⑤ Questionnaire Service

⑥ 更新 Instance.current_schema

⑦ current_revision: 3 → 4

⑧ 创建 QuestionnaireRevision #4

⑨ Tool Execution SUCCESS

⑩ Assistant Message
```

最终数据库形成：

```text
ai_conversations
        ↓
ai_messages
        ↓
ai_tool_executions
        ↓
questionnaire_instances
        ↓
questionnaire_revisions
```

整条操作链可以追踪。

---

# 56. V1 核心数据一致性规则

必须保证：

### 规则一

```text
Instance.current_revision
```

必须和当前：

```text
current_schema
```

对应。

---

### 规则二

```text
Template Version
```

发布后不可被修改。

---

### 规则三

AI 修改：

```text
Instance
```

而不是：

```text
Template Version
```

---

### 规则四

Tool Execution 成功才视为 AI 修改成功。

---

### 规则五

所有实例修改必须产生 Revision。

---

### 规则六

所有 AI Tool 操作必须带：

```text
operation_id
```

---

### 规则七（D9）

以下四者必须严格一一对应，粒度不可不一致：

```text
一次 Tool 调用
  = 一个 operation_id
  = 一个数据库事务
  = 一次 current_revision 递增
  = 一条 questionnaire_revisions 记录
```

推论：

```text
一条用户消息可能产生多个 Revision（因为含多次 Tool 调用）。
这是设计目标，不是异常。
若未来要合并事务，必须同步调整 operation_id 粒度与 Revision 策略。
```

---

### 规则八（D1）

已下发的实例不允许任何结构写入：

```text
questionnaire_instances.status 为 dispatched / in_progress /
submitted / under_review / returned / completed 时
        ↓
禁止写入 current_schema
禁止产生新的 questionnaire_revisions（撤回操作除外）
```

撤回本身是一次状态变更事务，它：

```text
1. 不修改 current_schema
2. 不产生新的 Revision
3. 只改 status 与撤回相关字段
```

---

### 规则九（D9）

幂等判断必须发生在业务写入之前：

```text
先查 ai_tool_executions.operation_id
        ↓
已成功 → 直接返回历史结果，不得再次写入
        ↓
不存在 → 执行 → 写入执行记录
```

不得依赖 `UNIQUE` 约束报错来实现幂等（见第 24.2 节）。

---

### 规则十

`questionnaire_answers.revision_no` 必须指向该答案实际填写时的
`questionnaire_revisions.revision_no`，且该 Revision 必须已存在。

这条保证了即使未来题目被改名或选项被调整，
历史答案仍可被正确解释（见第 27.3 节）。

---

# 57. V1 数据库核心设计总结

整个数据库最终可以概括为：

```text
                 ┌───────────────┐
                 │     Users     │
                 └───────┬───────┘
                         │
                         ↓
             ┌─────────────────────┐
             │ Questionnaire       │
             │ Template             │
             └──────────┬──────────┘
                        │
                        ↓
             ┌─────────────────────┐
             │ Template Version     │
             │      + JSONB Schema  │
             └──────────┬──────────┘
                        │
                    Instantiate
                        │
                        ↓
             ┌─────────────────────┐
             │ Questionnaire       │
             │ Instance            │
             │      + JSONB Schema │
             └──────────┬──────────┘
                        │
                   AI 修改
                        │
                        ↓
             ┌─────────────────────┐
             │ Questionnaire       │
             │ Revision            │
             └─────────────────────┘

AI 部分：

Conversation
    ↓
Message
    ↓
Tool Execution
    ↓
Instance
```

---

# 58. V1 最终实体模型

```text
User
 │
 ├───────────────┐
 │               │
 ↓               ↓
Template       AI Conversation
 │               │
 ↓               ↓
Template       AI Message
Version           │
 │                ↓
 ↓          AI Tool Execution
Questionnaire      │
Instance ──────────┘
 │
 ├── Revision
 │
 ├── Dispatch Task
 │
 └── Response
       │
       └── Answer
             │
             ↓
           Review
```

---

# 59. 最终设计结论

V1 数据库采用：

```text
PostgreSQL
+
关系型实体
+
JSONB 问卷结构
+
UUID v7
+
Revision
+
AI Tool Audit
```

核心设计思想是：

> **业务关系结构化，问卷内容 JSON 化，AI 操作可追踪，模板和实例彻底隔离。**

其中最核心的四张表为：

```text
questionnaire_template
questionnaire_template_version
questionnaire_instance
questionnaire_revision
```

它们解决：

```text
正式模板
   ↓
模板版本
   ↓
具体调查实例
   ↓
实例修改历史
```

这一整条核心业务链。

而 AI 部分：

```text
ai_conversation
ai_message
ai_tool_execution
```

负责把：

```text
自然语言
   ↓
AI
   ↓
Tool
   ↓
问卷变化
```

完整记录下来。

---

# 60. 下一阶段

数据库设计完成后，系统已经拥有了比较明确的三个核心契约：

```text
① Questionnaire Schema
       ↓
问卷长什么样

② Tool Calling Schema
       ↓
AI可以怎么修改

③ Database Schema
       ↓
这些数据怎么持久化
```

下一步进入 API 设计时，就可以直接围绕这三个契约建立：

```text
Template API
Questionnaire API
AI Conversation API
AI Tool API
Dispatch API
Response API
Review API
```

其中 V1 最值得优先落地的 API 链路是：

```text
POST /ai/conversations
        ↓
POST /ai/conversations/:id/messages
        ↓
LLM
        ↓
Tool Calling
        ↓
Questionnaire Service
        ↓
Questionnaire Instance
```

