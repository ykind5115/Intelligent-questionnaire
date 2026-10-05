# 智能问卷系统

## Questionnaire Schema + AI Tool Calling 设计说明书 V1.0

---

# 1. 文档概述

## 1.1 文档目的

本文档用于定义智能问卷系统 V1 的：

1. Questionnaire Schema（问卷结构模型）
2. Question Schema（问题模型）
3. Option Schema（选项模型）
4. AI Tool Calling 接口
5. Tool 参数规范
6. Tool 执行规则
7. AI 与后端之间的数据交互方式
8. AI 生成问卷和 AI 修改问卷实例的统一操作模型

本文档是后续：

* 数据库设计
* TypeScript 类型设计
* AI Prompt 设计
* Agent 开发
* Tool 开发
* API 设计
* 前端问卷渲染

的重要依据。

---

# 2. 设计目标

V1 的核心目标是：

> **让自然语言能够稳定地转换成结构化问卷，并能够对已有问卷进行增量修改。**

因此整个系统围绕一个核心闭环：

```text
自然语言
   ↓
LLM
   ↓
理解用户意图
   ↓
Tool Call
   ↓
Tool执行
   ↓
问卷结构改变
   ↓
Tool Result
   ↓
LLM
   ↓
用户看到结果
```

---

# 3. 核心设计原则

## 3.1 Schema 是系统唯一结构语言

AI、后端、前端不能各自定义一套问卷结构。

统一使用：

```text
Questionnaire Schema
```

作为系统内部的标准结构。

---

## 3.2 Tool 是 AI 修改业务数据的唯一入口

AI 不直接：

```text
SQL
Database
ORM
```

AI 只能：

```text
Tool Call
```

然后由后端完成真正的数据修改。

---

## 3.3 V1 采用增量修改

AI 修改问卷时优先采用：

```text
add
update
remove
move
```

而不是重新生成整个问卷。

---

## 3.4 Template 与 Instance 使用同一套 Schema

正式模板和具体问卷实例的结构保持一致。

区别只在于：

```text
Template
= 可复用的正式问卷

Instance
= 某一次具体调查所使用的问卷
```

因此：

```text
QuestionnaireSchema
```

可以同时服务两者。

---

# 4. Questionnaire Schema

## 4.1 顶层结构

V1 的问卷结构定义为：

```ts
interface QuestionnaireSchema {
  id: string;
  title: string;
  description?: string;

  sections: QuestionnaireSection[];

  version: number;

  metadata?: Record<string, unknown>;
}
```

---

# 5. Section Schema

问卷采用树状结构。

第一层使用 Section 表示问卷中的逻辑分组。

> **V1 范围限制：本节虽然定义了 `children`，但 V1 不启用 section 嵌套。**
>
> 详见第 5A 节。

```ts
interface QuestionnaireSection {
  id: string;
  title: string;
  description?: string;

  order: number;

  questions: QuestionnaireQuestion[];

  children?: QuestionnaireSection[];
}
```

例如：

```text
无人机黑飞核查问卷
│
├── 基本信息
│
├── 无人机情况
│
├── 飞行情况
│
└── 关联人员
```

---

# 5A. 树形结构的 V1 范围（重要）

## 5A.1 字段保留，但功能不启用

`QuestionnaireSection.children` 字段**保留在 Schema 中**，但：

> **V1 的所有 Tool 都不支持在嵌套 section 上操作。**

保留字段的原因：未来扩展时不必做破坏性迁移。

## 5A.2 V1 的实际结构

```text
Questionnaire
 └── sections[]          ← 只有一层
      ├── questions[]    ← 问题直接挂在 section 下
      │    └── options[] ← 选择题的选项
      └── (children 恒为空或不存在)
```

## 5A.3 V1 明确不支持的操作

```text
1. add_section 传 parent_section_id
   → 返回 INVALID_PARAMETER（参数存在但暂不支持）

2. 删除整个 section
   → 无 remove_section Tool

3. 移动整个 section
   → 无 move_section Tool

4. 问题套问题（Question.children）
   → Schema 中不存在此字段，任何情况下都不允许

5. add_section 增加 section 的 order
   → 由后端追加到末尾，模型不得指定
```

## 5A.4 为什么 V1 不做嵌套

```text
1. 当前业务场景（无人机黑飞核查、宠物饲养规范核查）
   都是「几个分组 + 组内问题」的两层结构；

2. 嵌套会让 add_question 的定位、order 重算、前端渲染全部复杂化；

3. D6 决定前端只做简要实现，渲染嵌套树会明显拖慢进度；

4. 真有多层需求时，一级分组配合命名规范通常也能表达清楚。
```

## 5A.5 若未来需要启用嵌套

需要同步补充以下内容，缺一不可：

```text
Schema    ：children 的实际使用约束、最大深度
Tool      ：add_section 的 parent_section_id 校验
            remove_section
            move_section
            add_question 支持 question 级嵌套（若需要）
后端      ：order 在兄弟节点间的重算规则
前端      ：递归渲染组件
AI Prompt ：告知模型存在层级结构，以及如何定位嵌套节点
```

---

# 6. Question Schema

V1 问题定义：

```ts
interface QuestionnaireQuestion {
  id: string;

  type: QuestionType;

  title: string;

  description?: string;

  required: boolean;

  order: number;

  options?: QuestionOption[];

  validation?: QuestionValidation;

  metadata?: Record<string, unknown>;
}
```

---

# 7. QuestionType

V1 只支持最基础、最稳定的一组题型。

```ts
type QuestionType =
  | "text"
  | "textarea"
  | "number"
  | "single_choice"
  | "multiple_choice"
  | "date"
  | "datetime"
  | "boolean";
```

---

## 7.1 text

单行文本。

例如：

```text
姓名
无人机型号
购买渠道
```

---

## 7.2 textarea

多行文本。

适合：

```text
情况说明
补充信息
调查经过
```

---

## 7.3 number

数字。

例如：

```text
无人机数量
飞行次数
```

---

## 7.4 single_choice

单选。

例如：

```text
是否拥有无人机？

○ 是
○ 否
○ 不清楚
```

---

## 7.5 multiple_choice

多选。

例如：

```text
无人机用途：

□ 娱乐
□ 商业
□ 航拍
□ 其他
```

---

## 7.6 date

日期。

---

## 7.7 datetime

日期时间。

---

## 7.8 boolean

用于明确的：

```text
是 / 否
```

问题。

---

# 8. Option Schema

单选、多选需要选项。

```ts
interface QuestionOption {
  id: string;

  label: string;

  value: string;

  order: number;
}
```

例如：

```json
{
  "id": "option-001",
  "label": "是",
  "value": "yes",
  "order": 1
}
```

---

# 9. Validation Schema

V1 只提供基础校验。

```ts
interface QuestionValidation {
  minLength?: number;
  maxLength?: number;

  min?: number;
  max?: number;

  pattern?: string;
}
```

例如：

```json
{
  "minLength": 1,
  "maxLength": 100
}
```

---

# 10. 完整问卷示例

```json
{
  "id": "questionnaire-001",
  "title": "无人机黑飞核查问卷",
  "description": "用于无人机相关调查",
  "version": 1,
  "sections": [
    {
      "id": "section-basic",
      "title": "基本信息",
      "order": 1,
      "questions": [
        {
          "id": "question-name",
          "type": "text",
          "title": "姓名",
          "required": true,
          "order": 1
        },
        {
          "id": "question-idcard",
          "type": "text",
          "title": "身份证号",
          "required": true,
          "order": 2
        }
      ]
    },
    {
      "id": "section-drone",
      "title": "无人机情况",
      "order": 2,
      "questions": [
        {
          "id": "question-has-drone",
          "type": "single_choice",
          "title": "是否拥有无人机？",
          "required": true,
          "order": 1,
          "options": [
            {
              "id": "option-yes",
              "label": "是",
              "value": "yes",
              "order": 1
            },
            {
              "id": "option-no",
              "label": "否",
              "value": "no",
              "order": 2
            }
          ]
        }
      ]
    }
  ]
}
```

---

# 11. Schema 的 ID 设计

所有结构节点统一使用唯一 ID。

包括：

```text
Questionnaire ID
Section ID
Question ID
Option ID
```

例如：

```text
q_01
sec_01
ques_01
opt_01
```

V1 不要求 ID 中携带业务含义。

推荐由后端生成。

---

# 12. 为什么不让 AI 生成 ID

AI 可以决定：

```text
增加一个“无人机购买渠道”
```

但是：

```text
question_id = ?
```

不应该由 AI 自己决定。

推荐：

```text
AI Tool Call
   ↓
后端生成 ID
   ↓
创建 Question
   ↓
返回真实 ID
```

例如：

```json
Tool Result:
{
  "success": true,
  "question_id": "9f81..."
}
```

这样可以避免：

* ID 冲突
* ID 重复
* 恶意指定 ID
* AI 上下文中的虚假 ID

---

# 13. Tool Calling 总体设计

V1 工具划分为三类：

```text
读取类
修改类
确认类
```

---

# 14. 读取类 Tool

## 14.1 get_questionnaire

用于获取当前完整问卷结构。

```ts
get_questionnaire({
  target_id: string
})
```

返回：

```ts
{
  success: true,
  questionnaire: QuestionnaireSchema
}
```

---

## 14.2 get_question

用于获取具体问题。

```ts
get_question({
  target_id: string,
  question_id: string
})
```

返回：

```ts
{
  success: true,
  question: QuestionnaireQuestion
}
```

V1 实际开发中可以先只实现 `get_questionnaire`。

`get_question` 可以在复杂问卷增长后再加入。

---

# 15. 修改类 Tool

V1 核心 Tool：

```text
add_section
add_question
update_section
update_question
remove_question
move_question
```

这六个工具基本可以覆盖 V1 的问卷结构修改。

---

# 16. add_section

## 16.1 功能

增加一个新的问卷分组。

例如：

```text
增加一个“团伙关系调查”部分。
```

---

## 16.2 参数

```ts
interface AddSectionInput {
  target_id: string;

  title: string;

  description?: string;

  parent_section_id?: string;   // V1 暂不支持，传了返回 INVALID_PARAMETER
}
```

## 16.2a V1 的 section 层级限制

见第 5A 节：

```text
V1 只支持一级 section。
parent_section_id 字段保留在接口签名中，但传值会被拒绝。
```

---

## 16.3 示例 Tool Call

```json
{
  "name": "add_section",
  "arguments": {
    "target_id": "q_001",
    "title": "团伙关系调查"
  }
}
```

---

## 16.4 Tool Result

统一使用第 28 节的 `data` 包装格式：

```json
{
  "success": true,
  "data": {
    "section_id": "sec_003",
    "title": "团伙关系调查"
  },
  "metadata": {
    "operation_id": "0199..."
  }
}
```

**注意：** 必须返回后端生成的真实 `section_id`，
模型后续的 `add_question` 只能使用这个 ID（见第 42 节）。

本节早期版本返回的是 `{ "section": { "id": ... } }` 结构，
与第 28 节的统一格式不一致，现已修正为 `data` 包装。

---

# 17. add_question

## 17.1 功能

向指定分组增加问题。

---

## 17.2 参数

```ts
interface AddQuestionInput {
  target_id: string;

  section_id: string;

  type: QuestionType;

  title: string;

  description?: string;

  required?: boolean;

  options?: QuestionOptionInput[];
}
```

---

## 17.3 Option Input

注意：

> AI 创建 Option 时不需要生成最终 Option ID。

```ts
interface QuestionOptionInput {
  label: string;
  value: string;
}
```

由后端生成真正 ID 和 order。

---

## 17.4 示例

用户：

```text
增加一个“是否存在团伙”的单选题。
```

AI：

```json
{
  "name": "add_question",
  "arguments": {
    "target_id": "q_001",
    "section_id": "sec_relation",
    "type": "single_choice",
    "title": "是否存在团伙？",
    "required": true,
    "options": [
      {
        "label": "是",
        "value": "yes"
      },
      {
        "label": "否",
        "value": "no"
      },
      {
        "label": "不清楚",
        "value": "unknown"
      }
    ]
  }
}
```

---

# 18. update_section

## 18.1 功能

修改分组信息。

V1 支持：

```text
title
description
```

例如：

```text
把“关联人员”改成“团伙及关联人员调查”。
```

---

## 18.2 参数

```ts
interface UpdateSectionInput {
  target_id: string;

  section_id: string;

  title?: string;

  description?: string;
}
```

---

# 19. update_question

## 19.1 功能

修改问题。

允许修改：

```text
题目
题型
是否必填
说明
选项
校验规则
```

---

## 19.2 参数

```ts
interface UpdateQuestionInput {
  target_id: string;

  question_id: string;

  title?: string;

  description?: string;

  type?: QuestionType;

  required?: boolean;

  options?: QuestionOptionInput[];

  validation?: QuestionValidation;
}
```

---

# 20. remove_question

## 20.1 功能

删除问题。

```ts
interface RemoveQuestionInput {
  target_id: string;

  question_id: string;
}
```

---

## 20.2 重要规则

V1 不允许 AI 静默删除重要问题。

对于删除操作：

```text
用户明确要求
    ↓
AI调用 remove_question
```

才执行。

如果用户没有提出删除需求，AI 不应该因为“优化问卷”而擅自删除问题。

---

# 21. move_question

## 21.1 功能

调整问题所在位置。

例如：

```text
把“飞行地点”移动到“飞行情况”的第一个位置。
```

---

## 21.2 参数

```ts
interface MoveQuestionInput {
  target_id: string;

  question_id: string;

  target_section_id: string;

  target_order?: number;
}
```

后端重新计算：

```text
order
```

而不是相信 AI 传入的所有顺序值。

---

# 22. Tool 参数的共同约束

所有修改类 Tool 必须带：

```text
target_id
```

这样后台始终知道：

> 当前修改的是哪一份问卷。

## 22.1 参数命名统一：`target_id`

本文档早期版本使用 `questionnaire_id`，`05-api_design.md` 使用 `questionnaireId`，
`08-ai_agent_prompt_tool_calling.md` 早期版本又使用 `questionnaireId` 与 `currentQuestionnaire`。

**现统一为 `target_id`。**

理由：

```text
1. 在 create_template 场景，它指向 Template Draft；
   在 modify_questionnaire 场景，它指向 Questionnaire Instance。
   叫 questionnaire_id 会让「questionnaire」既指模板又指实例，产生歧义。

2. target_id 与 ToolContext.targetId 同名，便于后端做一致性比对。

3. 它表达的是「本次操作的目标对象」，而不是「一个叫 questionnaire 的东西」。
```

因此本文档早期示例中的 `questionnaire_id` 一律读作 `target_id`。

## 22.2 Tool 参数的字段风格

```text
Tool 参数（发给 LLM 的 JSON Schema）：snake_case
  → target_id / section_id / question_id / parent_section_id

REST API 的 JSON 字段：camelCase
  → targetId / sectionId / questionId

TypeScript 内部类型：camelCase
  → targetId / sectionId / questionId
```

这样安排的原因：

```text
Tool 参数直接暴露给模型，snake_case 在模型见过的工具定义中更常见，
且与本文档既有示例一致；
REST 层遵循 05-api_design.md 第 37 节的 camelCase 规范。
```

转换由 Tool 层负责，业务层只看到 camelCase。

---

# 23. target_id 的来源

原则：

> **业务上下文优先于模型自行判断。**

例如用户当前处于：

```text
AI修改问卷
```

页面已经绑定：

```text
target_id = q_001
```

后端创建 AI Conversation 时保存：

```json
{
  "scene": "modify_questionnaire",
  "target_type": "questionnaire_instance",
  "target_id": "q_001"
}
```

AI 在实际 Tool Calling 时仍然可以传入 target_id，但后端需要核对：

```text
Tool 参数 target_id
        ==
ToolContext.targetId（来自 Conversation）
```

不一致则拒绝执行，返回 `INVALID_TOOL_CONTEXT`。

这样可以防止 AI 因上下文混淆修改错误问卷。

---

# 23A. 实例结构的可修改边界（决策 D1）

> **问卷实例一旦下发，结构冻结。**

## 23A.1 为什么

```text
调查员主要负责上门核查信息；
具体要核查哪些内容，是下发人员决定的。

因此「下发」这个动作，代表需要核查的内容已经布置清楚了。
```

## 23A.2 状态与可修改性

| 实例状态 | 允许结构修改 | 说明 |
| --- | --- | --- |
| `draft` | ✅ | AI 修改的主要场景 |
| `confirmed` | ✅ | 尚未下发，可改（reopen 语义） |
| `dispatched` | ❌ | 必须撤回 |
| `in_progress` | ❌ | 必须撤回 |
| `submitted` | ❌ | 必须撤回 |
| `under_review` | ❌ | 必须撤回 |
| `returned` | ❌ | 先回到 `in_progress` 再撤回（见 `02-architecture.md` 第 21.3 节） |
| `completed` | ❌ | 终态，只能新建实例 |

## 23A.3 需要改动时的正确路径：撤回后二次下发

```text
dispatched / in_progress / submitted
        │
        │  POST /questionnaire-instances/{id}/withdraw
        ↓
      draft          ← 结构重新允许修改
        │
        │  修改（AI 或人工）
        ↓
    confirmed
        │
        │  二次下发
        ↓
    dispatched
```

撤回时必须处理的既有数据：

```text
1. questionnaire_responses
   → status = withdrawn（不物理删除）

2. questionnaire_answers
   → 跟随 response 失效，不回滚、不删除

3. dispatch_tasks
   → status = withdrawn，记录 withdrawn_at / withdrawn_by

4. current_revision
   → 继续递增，历史 Revision 不清空
```

完整 API 定义见 `05-api_design.md`。

## 23A.4 扶正为模板（决策 D2）

实例上的临时改动，可以「保存为模板新版本」：

```text
Instance.current_schema
        ↓
POST /questionnaire-instances/{id}/promote
        ↓
Template Version Draft（status = draft，不直接发布）
        ↓
走正常模板发布流程
```

约束：

> **扶正生成的必须是模板「草稿版本」，不是直接发布。**
>
> 正式模板的发布仍然必须经过模板版本治理。

这样单个案件的特殊改动不会污染模板，
但反复出现的同类需求可以正式沉淀进模板库。

---

# 24. Tool 执行链路

以 `add_question` 为例：

```text
LLM
 ↓
Tool Call
 ↓
AI Orchestrator
 ↓
Tool Validator
 ↓
Authorization
 ↓
Questionnaire Service
 ↓
Domain Validation
 ↓
Repository
 ↓
Database
 ↓
Tool Result
 ↓
LLM
```

---

# 25. Tool Validator

Tool Validator 负责：

### 参数格式

检查：

```text
target_id
section_id
type
title
```

是否合法。

---

### Schema 校验

例如：

```text
single_choice
```

必须存在：

```text
options
```

而：

```text
text
```

不应该要求 options。

---

### 长度校验

例如：

```text
title
```

不能无限长。

---

# 26. Domain Validation

参数通过后，还需要业务检查。

例如：

```text
section 是否存在？
question 是否存在？
问题是否属于当前 questionnaire？
```

以及：

```text
删除后问卷结构是否仍然合法？
```

---

# 27. Permission Check

执行 Tool 前检查：

```text
当前用户
    ↓
是否拥有当前问卷操作权限？
```

AI 本身没有独立业务权限。

AI 继承当前用户的业务权限上下文。

即：

```text
User Permission
       ↓
AI Tool
       ↓
Business Service
```

## 27.1 角色模型（决策 D8）

`users` 表含 `roles` 字段（VARCHAR 数组），四类角色：

```text
template_admin      模板管理
dispatcher          问卷创建 / 下发 / 撤回
investigator        问卷填写
reviewer            问卷审核
```

写入类 Tool 要求 `dispatcher` 或 `template_admin`；
`investigator` / `reviewer` 只能读（`get_questionnaire`）。

## 27.2 状态校验（同属执行前检查）

权限之外还必须校验业务状态：

见第 23A 节。若实例已下发：

```json
{
  "success": false,
  "error": {
    "code": "QUESTIONNAIRE_LOCKED",
    "message": "问卷已下发，请先撤回后再修改"
  }
}
```

## 27.3 完整的执行前检查顺序

```text
1. Zod 参数校验（格式、题型与 options 匹配）
2. target_id 一致性校验（对照 Conversation）
3. 角色权限校验
4. 实例状态校验（draft 才允许改）
5. Domain Validation（节点存在性、结构合法性）
        ↓
全部通过后才进入 Questionnaire Service
```

**顺序不可调换，任何一步失败都不写数据库。**

**这些校验全部由后端执行，不依赖 Prompt 约束。**

---

# 28. Tool Result 标准格式

所有 Tool 返回统一格式。

```ts
interface ToolResult<T = unknown> {
  success: boolean;

  data?: T;

  error?: {
    code: string;
    message: string;
  };

  metadata?: {
    operation_id?: string;
  };
}
```

---

# 29. 成功结果示例

```json
{
  "success": true,
  "data": {
    "question_id": "ques_001"
  },
  "metadata": {
    "operation_id": "op_001"
  }
}
```

---

# 30. 失败结果示例

```json
{
  "success": false,
  "error": {
    "code": "QUESTION_NOT_FOUND",
    "message": "指定问题不存在"
  }
}
```

模型拿到失败结果之后，可以继续：

```text
重新读取
重新调用工具
或向用户解释
```

而不是假装执行成功。

---

# 31. Tool Error Code

V1 建议至少定义：

```text
QUESTIONNAIRE_NOT_FOUND
SECTION_NOT_FOUND
QUESTION_NOT_FOUND
INVALID_QUESTION_TYPE
INVALID_OPTIONS
INVALID_PARAMETER
PERMISSION_DENIED
QUESTIONNAIRE_LOCKED
INVALID_OPERATION
SYSTEM_ERROR
```

补充（由已确认决策引入）：

```text
INVALID_TOOL_CONTEXT       Tool 参数 target_id 与 Conversation 不一致
REVISION_CONFLICT          乐观锁冲突，需重新读取
WITHDRAW_NOT_ALLOWED       当前状态不允许撤回
PROMOTE_NOT_ALLOWED        当前状态不允许扶正为模板
NESTED_SECTION_UNSUPPORTED add_section 传了 parent_section_id（V1 不支持）
```

---

# 32. Tool 调用的幂等性

这是实际开发中很容易忽略的问题。

假设用户说：

```text
增加一个购买渠道问题。
```

模型调用：

```text
add_question
```

如果由于网络问题请求重复发送：

```text
add_question
add_question
```

就可能得到两个完全一样的问题。

V1 通过 `operation_id` 实现幂等控制。

例如：

```ts
interface ToolExecutionContext {
  operation_id: string;
  conversation_id: string;
  user_id: string;
}
```

## 32.1 幂等粒度（决策 D9）

> **一次 Tool 调用 = 一个 `operation_id`。**

```text
一次用户消息
  └── LLM 回合
        ├── Tool Call #1  → operation_id = op_001
        ├── Tool Call #2  → operation_id = op_002
        └── Tool Call #3  → operation_id = op_003
```

为什么不是「一次 LLM 回合一个 operation_id」：

```text
一轮里的多个 Tool 各自是独立的数据修改。
若共用一个 operation_id，重试时无法判断
「哪些 Tool 已成功、哪些需要重跑」，
只能整轮回滚或整轮重放，两者都会破坏数据。
```

## 32.2 实现方式：先查后插，不依赖 UNIQUE 冲突

本文档早期版本表述为「相同 operation 已经成功执行 → 直接返回原执行结果」，
但没有说明实现方式，容易被实现成「先 INSERT，靠 UNIQUE 报错来判重」。

**那样做的问题：**

```text
ai_tool_executions.operation_id 上有 UNIQUE 约束。
若实现为「INSERT 失败即视为重复」，
则第二次重试会在数据库层抛异常，
而不是干净地返回第一次的结果。
```

**正确实现：**

```text
BEGIN

  SELECT * FROM ai_tool_executions
   WHERE operation_id = $1

  若查到且 success = true
    → 直接返回已记录的 result，不修改问卷，COMMIT

  若查到且 success = false
    → 说明上次执行失败，允许重试（或返回同一失败）

  若查不到
    → 执行 Tool
    → INSERT ai_tool_executions
    → COMMIT

END
```

`operation_id` 由 AI Orchestrator 为**每个 Tool Call** 生成 UUID v7，
并写入日志，便于前端 `tool_call_start` / `tool_call_result` 事件配对
（见 `05-api_design.md` 第 10.4 节）。

## 32.3 注意 operation_id 与 trace_id 的区别

```text
operation_id  单个 Tool 调用的幂等键（本文档，D9）
trace_id      一次用户请求的全链路追踪 ID（用于日志关联，可选）
```

两者不要混用：一次请求中有多个 `operation_id`，但只有一个 `trace_id`。

---

# 33. AI 操作日志模型

每次 Tool 调用至少记录：

```ts
interface AiToolExecutionLog {
  id: string;

  conversation_id: string;

  target_id: string;          // 原 questionnaire_id，见第 22.1 节

  operation_id: string;       // D9：每个 Tool 调用一个

  user_id: string;

  tool_name: string;

  arguments: Record<string, unknown>;

  result: Record<string, unknown>;

  success: boolean;

  error_code?: string;

  model?: string;             // 建议记录，便于问题定位

  created_at: string;
}
```

---

# 34. 修改前后快照

V1 建议额外保存：

```text
before_snapshot
after_snapshot
```

例如：

```json
{
  "tool_name": "add_question",

  "before_snapshot": {
    "version": 3
  },

  "after_snapshot": {
    "version": 4
  }
}
```

这里的版本可以对应问卷实例修订版本。

这样未来能够快速定位：

> “这个问题究竟是谁、什么时候加进去的？”

---

# 35. AI 生成问卷模式

V1 的“AI生成模板”本质上也是 Tool Calling。

AI 可以：

```text
add_section
add_question
update_question
```

因此：

```text
AI 创建问卷
```

和：

```text
AI 修改问卷
```

不需要开发两套完全独立的问卷操作引擎。

区别主要在：

```text
Scene / Context
```

---

# 36. AI Scene

V1 建议至少定义两个 Scene。

```ts
type AiScene =
  | "create_template"
  | "modify_questionnaire";
```

## 36.0 Scene 与 target_type 的对应（避免规则冲突）

`01-rpd.md` 第 8.4 节规定「AI 不得直接修改正式模板」，
而 `create_template` 场景下 AI 确实在写模板相关数据。

两者的区别在于 **target_type**：

| Scene | target_type | AI 实际写入的对象 | 是否允许 |
| --- | --- | --- | --- |
| `create_template` | `template` | **Template Draft**（未发布版本） | ✅ 允许 |
| `create_template` | `template_version`（已发布） | 已发布版本 | ❌ 拒绝 |
| `modify_questionnaire` | `questionnaire_instance` | 问卷实例 | ✅ 允许 |
| `modify_questionnaire` | `template_version` | 正式模板 | ❌ 拒绝 |

因此：

```text
「不得修改正式模板」的准确含义是：
  不得修改 status = published 的 template_version

而不是：
  不得对 template 相关的任何数据做写入
```

后端在 Tool 的 Context Validation 阶段检查：

```text
if (context.scene === "create_template") {
  要求 target 指向的版本 status = draft
}

if (context.scene === "modify_questionnaire") {
  要求 target_type = questionnaire_instance
  且 实例 status = draft（见第 23A 节）
}
```

违反则返回 `PERMISSION_DENIED` 或 `QUESTIONNAIRE_LOCKED`。

> **本节的存在是为了让 Prompt 与后端校验口径一致。**
>
> 如果 Prompt 里只说「不能改模板」，模型在 create_template 场景会拒绝干活；
> 如果后端不区分 draft 与 published，模型就可能改到已发布版本。
> 两者必须以同一套 target_type 规则表达。

---

## 36.1 create_template

目标：

```text
从零构建标准问卷
```

上下文：

```text
用户需求
+
历史对话
+
当前草稿问卷
+
问卷 Tools
```

---

## 36.2 modify_questionnaire

目标：

```text
基于已有实例进行临时修改
```

上下文：

```text
当前问卷
+
调查对象信息
+
用户特殊需求
+
历史对话
+
问卷 Tools
```

---

# 37. AI 的核心行为约束

AI 在这个系统里不是自由修改器。

应该遵循：

```text
先理解
 ↓
必要时读取当前问卷
 ↓
确定需要执行的操作
 ↓
调用最小必要 Tool
 ↓
获取结果
 ↓
继续处理
```

即：

> **最小变更原则。**

---

# 38. 最小变更原则

例如当前问卷：

```text
A
B
C
D
```

用户说：

```text
“把 C 的问题名称改一下。”
```

AI 应该：

```text
update_question(C)
```

而不是：

```text
删除 C
重新添加 C
重新生成整份问卷
```

---

# 39. AI 不应擅自扩展需求

用户：

```text
“增加一个是否存在团伙的问题。”
```

合理行为：

```text
add_question
```

不合理行为：

```text
自动增加：

团伙名称
团伙人数
团伙成员
团伙活动地点
团伙组织结构
……
```

除非：

1. 用户明确要求；
2. 或产品后续明确规定 AI 可以根据业务规则扩展。

V1 建议严格采用：

> **用户需求优先，避免过度生成。**

---

# 40. AI 不应擅自修改正式模板

在：

```text
modify_questionnaire
```

场景下：

```text
Tool
 ↓
Questionnaire Instance
```

而不是：

```text
Tool
 ↓
Template Version
```

后端可以在 Tool Context 中明确：

```json
{
  "scene": "modify_questionnaire",
  "target_type": "instance"
}
```

如果工具试图操作正式模板：

```text
Permission / Operation Denied
```

---

# 41. AI 对话与 Tool Call 的关系

一次用户消息可能产生多个 Tool Call。

例如：

```text
用户：

“增加一个团伙调查模块，
里面要调查有没有团伙以及团伙成员。”
```

AI 可以：

```text
add_section
      ↓
add_question
      ↓
add_question
```

最终形成：

```text
团伙调查
├── 是否存在团伙
└── 团伙成员
```

---

# 42. 多 Tool 调用顺序

工具之间存在依赖关系。

例如：

```text
add_section
      ↓
得到 section_id
      ↓
add_question
```

因此 Tool Result 必须向模型返回新生成对象的 ID。

例如：

```json
{
  "success": true,
  "data": {
    "section_id": "sec_1001"
  }
}
```

然后：

```text
AI
 ↓
add_question(section_id="sec_1001")
```

---

# 43. Tool Transaction

单个 Tool 应保证原子性。

例如：

```text
add_question
```

内部执行：

```text
验证
 ↓
生成 ID
 ↓
创建 Question
 ↓
创建 Options
 ↓
更新版本
 ↓
写操作日志
 ↓
Commit
```

如果中间失败：

```text
Rollback
```

---

# 44. Questionnaire Revision

每次成功修改问卷后：

```text
revision + 1
```

例如：

```text
Revision 1
    ↓
add_question
    ↓
Revision 2
    ↓
update_question
    ↓
Revision 3
```

这样 AI 每次操作都能够与一个明确的问卷状态对应。

## 44.1 粒度：一次 Tool 调用 = 一次 Revision（D9）

```text
一条用户消息
  → 可能触发多次增量 Tool 调用
  → 因此可能产生多个 Revision
```

例如用户说「增加团伙调查模块，里面要调查有没有团伙以及团伙成员」：

```text
Revision 1 → add_section     产生 Revision 2
Revision 2 → add_question    产生 Revision 3
Revision 3 → add_question    产生 Revision 4
```

最终 `current_revision = 4`。

**这不是缺陷，而是设计目标：**

```text
D2  扶正为模板版本时，需要「这次改了什么」的精确 diff
    逐次 Revision 让任意一次 Tool 调用的效果都可独立还原

D9  幂等以单次 Tool 调用为单位
    Revision 粒度必须与 operation_id 粒度一致，
    否则无法回答「这次重试是否会重复产生一批 Revision」
```

## 44.2 与事务边界的一致性

```text
一个 Tool 调用
  = 一个 operation_id
  = 一个数据库事务
  = 一次 Revision 递增
```

四者必须严格对应。若未来需要把多个 Tool 合并成一个事务，
必须同步调整 `operation_id` 粒度与 Revision 策略，
不能只改其中一项。

---

# 45. Revision 与 Template Version 的关系

两套版本必须严格区分：

```text
Template Version
= 正式模板版本

Questionnaire Revision
= 某个具体实例的修改版本
```

例如：

```text
无人机调查模板
    ↓
V2.0
    ↓
实例 A
    ├── Revision 1
    ├── Revision 2
    └── Revision 3

实例 B
    ├── Revision 1
    └── Revision 2
```

实例 A 和 B 可以基于相同模板版本，但各自拥有独立的 Revision。

---

# 46. 前端收到的最终结构

无论问卷是：

```text
人工创建
AI生成
AI修改
```

最终前端都只需要面对：

```text
QuestionnaireSchema
```

即：

```text
AI 是如何得到它的
```

不应该成为前端渲染逻辑的一部分。

前端只负责：

```text
Schema
 ↓
Render
```

---

# 47. 后端对前端和 AI 的双重适配

最终形成：

```text
                    QuestionnaireSchema
                           ↑
                           │
              ┌────────────┴────────────┐
              │                         │
             AI                       Human
              │                         │
         Tool Calling              UI Editor
              │                         │
              └────────────┬────────────┘
                           ↓
                  Questionnaire Service
```

因此以后即便不用 AI：

```text
人工编辑器
```

仍然可以继续使用。

---

# 48. V1 Tool 最小集合

最终 V1 不需要几十个 Tool。

建议第一版只实现：

```text
get_questionnaire

add_section
add_question

update_section
update_question

remove_question
move_question
```

一共：

> **7 个核心 Tool。**

这已经能够完成：

```text
从零创建
增加问题
修改问题
删除问题
调整结构
```

的大部分基础能力。

---

# 49. 暂不进入 V1 的 Tool

以下能力先不要加入核心链路：

```text
duplicate_question
merge_questions
batch_update
conditional_logic
calculate_value
import_questionnaire
export_questionnaire
ai_analyze_answers
ai_optimize_questionnaire
```

这些属于后续增强能力。

---

# 50. V1 Tool 调用完整示例

用户：

```text
我要创建一个无人机黑飞核查问卷。
需要调查无人机型号、是否飞行过、飞行地点。
```

AI：

```text
add_section("无人机情况")
```

Tool Result：

```json
{
  "success": true,
  "data": {
    "section_id": "sec_001"
  }
}
```

AI：

```text
add_question(
  section_id="sec_001",
  type="text",
  title="无人机型号"
)
```

Tool Result：

```json
{
  "success": true,
  "data": {
    "question_id": "q_001"
  }
}
```

AI：

```text
add_question(
  section_id="sec_001",
  type="boolean",
  title="是否进行过飞行？"
)
```

Tool Result：

```json
{
  "success": true,
  "data": {
    "question_id": "q_002"
  }
}
```

AI：

```text
add_question(
  section_id="sec_001",
  type="text",
  title="飞行地点"
)
```

最终：

```text
无人机黑飞核查问卷
└── 无人机情况
    ├── 无人机型号
    ├── 是否进行过飞行？
    └── 飞行地点
```

---

# 51. V1 AI 修改示例

当前实例：

```text
无人机黑飞核查问卷
├── 基本信息
├── 无人机情况
└── 飞行情况
```

用户：

```text
“这个调查对象还要重点了解是否存在团伙。”
```

AI：

```text
add_section(
  "团伙关系调查"
)
```

Tool Result：

```text
section_id = sec_004
```

然后：

```text
add_question(
  section_id = sec_004,
  title = "是否存在团伙？",
  type = "boolean"
)
```

最终：

```text
无人机黑飞核查问卷
├── 基本信息
├── 无人机情况
├── 飞行情况
└── 团伙关系调查
    └── 是否存在团伙？
```

正式模板不发生任何改变。

---

# 52. V1 核心架构关系

最终形成：

```text
                    ┌───────────────┐
                    │     User      │
                    └───────┬───────┘
                            │
                       Natural Language
                            │
                            ↓
                    ┌───────────────┐
                    │      LLM      │
                    └───────┬───────┘
                            │
                       Tool Calling
                            │
                            ↓
              ┌─────────────────────────┐
              │ Questionnaire Tools     │
              │                         │
              │ get_questionnaire       │
              │ add_section             │
              │ add_question            │
              │ update_section          │
              │ update_question         │
              │ remove_question         │
              │ move_question           │
              └────────────┬────────────┘
                           │
                     Validation
                           │
                     Authorization
                           │
                           ↓
              ┌─────────────────────────┐
              │ Questionnaire Service   │
              └────────────┬────────────┘
                           │
                           ↓
                  QuestionnaireSchema
                           │
                 ┌─────────┴─────────┐
                 ↓                   ↓
              Template            Instance
```

---

# 53. 关键设计结论

V1 最终确定以下架构原则：

### 结论一：问卷使用统一 Schema

模板与实例共用同一结构模型。

---

### 结论二：AI 使用 Tool 操作问卷

AI 不直接操作数据库。

---

### 结论三：Tool 使用增量操作

核心操作：

```text
Add
Update
Remove
Move
```

---

### 结论四：实例继承模板，但拥有自己的结构

```text
Template Version
       ↓
Instance
       ↓
Revision 1
       ↓
Revision 2
```

---

### 结论五：AI 场景由上下文区分

```text
create_template
modify_questionnaire
```

底层 Tool 可以复用。

---

### 结论六：后端拥有最终决定权

即使 AI 产生了合法 JSON，也不代表操作一定允许执行。

最终必须经过：

```text
Schema Validation
+
Permission Check
+
Domain Validation
+
Transaction
```

---

# 54. 后续设计依赖

本文件完成后，后续数据库设计至少需要围绕以下对象展开：

```text
questionnaire_template
questionnaire_template_version

questionnaire_instance
questionnaire_revision

ai_conversation
ai_message
ai_tool_execution_log
```

而 API 设计则至少需要覆盖：

```text
模板
问卷实例
AI 对话
Tool Execution
下发
填写
审核
```

---

# 55. V1 最终目标

V1 的最终技术能力可以浓缩成一句话：

> **把问卷定义成一种可结构化操作的数据对象，再让 LLM 通过有限、可验证、可审计的 Tool 对这个对象进行增量修改。**

因此整个 V1 最核心的技术闭环是：

```text
                    Natural Language
                           ↓
                          LLM
                           ↓
                      Tool Calling
                           ↓
                   Questionnaire Tool
                           ↓
                  Validation / Permission
                           ↓
                 Questionnaire Service
                           ↓
                  Questionnaire Schema
                           ↓
              ┌────────────┴────────────┐
              ↓                         ↓
        Template Version          Questionnaire Instance
                                           ↓
                                        Revision
```

只要这一层设计稳定，后面的数据库、API、前端渲染实际上都可以围绕这套契约展开。
