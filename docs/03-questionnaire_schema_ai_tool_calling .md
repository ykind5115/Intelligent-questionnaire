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
  questionnaire_id: string
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
  questionnaire_id: string,
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
  questionnaire_id: string;

  title: string;

  description?: string;

  parent_section_id?: string;
}
```

---

## 16.3 示例 Tool Call

```json
{
  "name": "add_section",
  "arguments": {
    "questionnaire_id": "q_001",
    "title": "团伙关系调查"
  }
}
```

---

## 16.4 Tool Result

```json
{
  "success": true,
  "section": {
    "id": "sec_003",
    "title": "团伙关系调查"
  }
}
```

---

# 17. add_question

## 17.1 功能

向指定分组增加问题。

---

## 17.2 参数

```ts
interface AddQuestionInput {
  questionnaire_id: string;

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
    "questionnaire_id": "q_001",
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
  questionnaire_id: string;

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
  questionnaire_id: string;

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
  questionnaire_id: string;

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
  questionnaire_id: string;

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
questionnaire_id
```

这样后台始终知道：

> 当前修改的是哪一份问卷。

---

# 23. questionnaire_id 的来源

原则：

> **业务上下文优先于模型自行判断。**

例如用户当前处于：

```text
AI修改问卷
```

页面已经绑定：

```text
questionnaire_id = q_001
```

后端创建 AI Session 时保存：

```json
{
  "scene": "modify_questionnaire",
  "questionnaire_id": "q_001"
}
```

AI 在实际 Tool Calling 时仍然可以传入 questionnaire_id，但后端需要核对：

```text
Tool 参数 questionnaire_id
        ==
Session 当前 questionnaire_id
```

不一致则拒绝执行。

这样可以防止 AI 因上下文混淆修改错误问卷。

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
questionnaire_id
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

V1 可以通过：

```text
operation_id
```

实现基础幂等控制。

例如：

```ts
interface ToolExecutionContext {
  operation_id: string;
  conversation_id: string;
  user_id: string;
}
```

后端记录：

```text
operation_id
```

如果相同 operation 已经成功执行：

```text
直接返回原执行结果
```

而不是再次修改数据。

---

# 33. AI 操作日志模型

每次 Tool 调用至少记录：

```ts
interface AiToolExecutionLog {
  id: string;

  conversation_id: string;

  questionnaire_id: string;

  user_id: string;

  tool_name: string;

  arguments: Record<string, unknown>;

  result: Record<string, unknown>;

  success: boolean;

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
