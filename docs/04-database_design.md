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

数据库访问层可以后续选择：

```text
Prisma
Drizzle
TypeORM
原生 pg
```

本数据库设计不强绑定具体 ORM。

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
| created_at    | TIMESTAMPTZ | 创建时间  |
| updated_at    | TIMESTAMPTZ | 更新时间  |

V1 的角色权限可以暂时简化。

如果后续需要完整 RBAC，再独立增加：

```text
roles
permissions
user_roles
role_permissions
```

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

    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_template_version_template
        FOREIGN KEY (template_id)
        REFERENCES questionnaire_templates(id),

    CONSTRAINT fk_template_version_creator
        FOREIGN KEY (created_by)
        REFERENCES users(id),

    CONSTRAINT uq_template_version
        UNIQUE (template_id, version_no)
);
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

    CONSTRAINT uq_instance_revision
        UNIQUE (questionnaire_instance_id, revision_no)
);
```

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
        REFERENCES users(id)
);
```

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
1. users

2. questionnaire_templates

3. questionnaire_template_versions

4. questionnaire_instances

5. questionnaire_revisions

6. ai_conversations

7. ai_messages

8. ai_tool_executions

9. dispatch_tasks

10. questionnaire_responses

11. questionnaire_answers

12. review_records
```

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

