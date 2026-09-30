# 智能问卷系统

## 系统架构设计说明书 V1.0

---

# 1. 文档概述

## 1.1 文档目的

本文档用于将《智能问卷系统 RPD V1.0》中定义的业务需求转换为系统技术架构，为后续：

* 数据库设计
* 后端接口设计
* AI Agent / Tool Calling 设计
* 前端页面设计
* 项目目录设计
* 系统开发与测试

提供统一技术依据。

---

## 1.2 设计范围

本架构主要覆盖以下业务链路：

```text
问卷模板管理
    ↓
AI 生成问卷
    ↓
模板形成
    ↓
选择模板
    ↓
创建问卷实例
    ↓
AI 修改当前问卷
    ↓
最终问卷
    ↓
问卷下发
    ↓
调查填写
    ↓
提交
    ↓
审核
```

其中 V1 的核心架构重点为：

> **自然语言 → AI 理解 → Tool Calling → 结构化问卷**

以及：

> **标准模板 → 问卷实例 → AI 临时修改 → 最终问卷**

原始需求明确提出：系统需要支持正式问卷模板，并解决特殊调查对象需要临时增加调查字段的问题；同时，创建问卷和临时修改问卷都采用 NL2RESULT 方式，由 AI 理解需求并调用自定义工具完成问卷结构操作。

---

# 2. 架构设计目标

## 2.1 核心目标

系统架构需要满足以下目标：

### 目标一：AI 与传统业务系统解耦

AI 是“问卷结构生成和调整能力”的提供者，但不应该成为整个业务系统的唯一入口。

即使 AI 服务不可用：

```text
模板管理
问卷查看
问卷填写
问卷提交
审核
```

等基础业务仍然可以正常工作。

---

### 目标二：问卷模板与问卷实例彻底隔离

这是本系统最重要的架构原则。

正式模板：

```text
Template
```

具体调查任务：

```text
Questionnaire Instance
```

两者不能混为一谈。

AI 对具体案件进行修改时：

```text
Template
   ↓
Instance
   ↓
AI 修改 Instance
```

而不是：

```text
Template
   ↓
AI 修改 Template
```

这样才能保证一次特殊调查不会污染正式模板。

---

### 目标三：AI 不直接操作数据库

AI 不允许直接生成 SQL 并操作数据库。

采用：

```text
自然语言
    ↓
LLM
    ↓
结构化 Tool Call
    ↓
后端业务服务
    ↓
数据库
```

AI 只能调用系统定义好的问卷操作工具。

---

### 目标四：问卷结构必须可版本化

模板会发生正常版本更迭，因此系统必须区分：

```text
模板
模板版本
问卷实例
实例结构版本
```

历史调查任务使用过的问卷结构不能因为模板后续升级而发生变化。

---

### 目标五：AI 操作必须可追溯

AI 对问卷进行修改时，应能够记录：

```text
用户说了什么
        ↓
AI做了什么判断
        ↓
AI调用了什么工具
        ↓
工具传入了什么参数
        ↓
问卷发生了什么变化
```

用于问题定位、审计和后期模型优化。

---

# 3. 总体架构

系统采用分层架构。

```text
┌──────────────────────────────────────────────┐
│                  表现层 Presentation          │
│                                              │
│  管理端 │ AI问卷设计页 │ 下发页 │ 填写页 │审核页 │
└───────────────────────┬──────────────────────┘
                        │
                        ↓
┌──────────────────────────────────────────────┐
│                  API / BFF 层                 │
│                                              │
│  用户请求 │ 会话 │ 权限 │ 参数校验 │ DTO转换 │
└───────────────────────┬──────────────────────┘
                        │
                        ↓
┌──────────────────────────────────────────────┐
│                业务服务层 Domain              │
│                                              │
│  模板服务                                  │
│  问卷实例服务                              │
│  问卷下发服务                              │
│  填写服务                                  │
│  审核服务                                  │
│  AI编排服务                                │
└───────────────┬────────────────┬─────────────┘
                │                │
                ↓                ↓
┌──────────────────────┐   ┌───────────────────┐
│   AI / Agent Layer   │   │  数据访问层       │
│                      │   │                   │
│ LLM Gateway          │   │ Repository        │
│ Prompt               │   │ ORM / SQL         │
│ Tool Calling         │   │ Transaction       │
│ Context              │   │                   │
└──────────┬───────────┘   └─────────┬─────────┘
           │                         │
           ↓                         ↓
     ┌───────────┐             ┌──────────────┐
     │ LLM 服务  │             │   Database   │
     └───────────┘             └──────────────┘
```

---

# 4. 系统逻辑分层

## 4.1 Presentation 层

负责用户交互。

主要页面：

```text
模板管理
AI创建问卷
模板详情
问卷下发
AI调整问卷
调查填写
问卷审核
```

其中 V1 最重要的交互页面为：

### AI 问卷设计页面

页面建议采用左右布局：

```text
┌─────────────────────────────────────────────┐
│              AI问卷设计                     │
├──────────────────┬──────────────────────────┤
│                  │                          │
│   AI 对话区      │      问卷结构区          │
│                  │                          │
│ 用户：……         │ ├─ 基本信息              │
│                  │ │  ├─ 姓名                │
│ AI：……           │ │  ├─ 身份证号            │
│                  │ │                        │
│ 用户：……         │ ├─ 无人机情况            │
│                  │ │  ├─ 型号                │
│                  │ │  └─ 数量                │
│                  │                          │
├──────────────────┴──────────────────────────┤
│              保存 / 发布                     │
└─────────────────────────────────────────────┘
```

左侧是：

```text
自然语言
```

右侧是：

```text
结构化结果
```

这样用户可以直接验证 AI 到底生成了什么。

---

# 5. API / BFF 层

这一层作为前端和业务服务之间的统一入口。

主要职责：

* 身份认证
* 权限检查
* 请求参数校验
* DTO 转换
* 错误处理
* API 统一响应
* AI 流式响应转发
* 请求日志

原则：

> API 层不应该承载核心业务逻辑。

例如：

```text
POST /questionnaires/{id}/ai/message
```

API 层只负责接收：

```text
message
conversationId
questionnaireId
```

然后交给 AI 编排服务处理。

---

# 6. 业务领域层

建议将系统核心业务拆成多个领域服务。

---

## 6.1 Template Service

负责正式问卷模板。

职责：

```text
创建模板
查询模板
修改模板
发布模板
停用模板
模板版本管理
```

核心对象：

```text
QuestionnaireTemplate
QuestionnaireTemplateVersion
QuestionnaireSchema
```

---

## 6.2 Questionnaire Instance Service

负责具体调查任务中的问卷实例。

职责：

```text
创建实例
读取实例
修改实例
保存实例版本
确认最终结构
```

这是 V1 中非常重要的服务。

因为：

> **AI 临时修改问卷，本质上是在修改 Instance，而不是 Template。**

---

## 6.3 Dispatch Service

负责问卷下发。

职责：

```text
创建下发任务
指定调查对象
指定调查人员
下发
撤回
查看状态
```

---

## 6.4 Response Service

负责调查人员填写问卷。

职责：

```text
保存答案
恢复填写
提交答案
查看填写状态
```

---

## 6.5 Review Service

负责审核。

```text
待审核
   ↓
审核
   ├── 通过
   └── 退回
```

---

# 7. AI 核心架构

这是整个 V1 最重要的技术部分。

系统不把 AI 当作普通聊天机器人，而是定义为：

> **问卷结构操作 Agent。**

整体结构：

```text
                    用户自然语言
                         │
                         ↓
                ┌─────────────────┐
                │   AI Orchestrator│
                └────────┬────────┘
                         │
          ┌──────────────┼──────────────┐
          ↓              ↓              ↓
      Prompt         当前问卷        对话上下文
          │              │              │
          └──────────────┼──────────────┘
                         ↓
                    LLM Reasoning
                         │
                         ↓
                   Tool Calling
                         │
                         ↓
              ┌──────────────────────┐
              │ Questionnaire Tools  │
              └──────────┬───────────┘
                         ↓
                 Questionnaire Domain
                         │
                         ↓
                      Database
```

---

# 8. AI Orchestrator

AI Orchestrator 是 AI 功能的核心协调层。

职责主要包括：

### 8.1 创建 AI 会话

保存：

```text
conversationId
userId
scene
questionnaireId
```

---

### 8.2 构建上下文

根据不同场景向模型提供不同上下文。

### 场景一：生成模板

模型主要获得：

```text
用户需求
历史对话
当前正在构建的问卷
问卷操作工具
```

---

### 场景二：修改问卷实例

模型获得：

```text
当前模板 / 当前实例
调查对象相关信息
当前问卷结构
历史对话
本次特殊调查需求
问卷操作工具
```

这两个场景虽然都使用 LLM，但业务上下文并不完全相同。

---

# 9. Tool Calling 架构

这是系统实现 NL2RESULT 的关键。

用户并不是直接要求 AI 输出最终 JSON，而是：

```text
用户需求
   ↓
LLM
   ↓
调用工具
   ↓
后端执行工具
   ↓
问卷结构改变
```

---

## 9.1 工具的基本分类

V1 可以设计以下基础工具。

### 问卷读取

```text
get_questionnaire
```

用于获取当前问卷结构。

---

### 新增分组

```text
add_section
```

---

### 新增问题

```text
add_question
```

---

### 修改问题

```text
update_question
```

---

### 删除问题

```text
remove_question
```

---

### 移动问题

```text
move_question
```

---

### 修改分组

```text
update_section
```

---

## 9.2 工具调用示例

用户：

```text
“增加一个是否和其他人一起飞的问题。”
```

模型产生：

```text
tool:
add_question
```

参数：

```json
{
  "section_id": "flight",
  "type": "single_choice",
  "title": "是否与其他人员共同飞行？",
  "options": [
    "是",
    "否",
    "不清楚"
  ]
}
```

后端接收到 Tool Call 后：

```text
参数校验
    ↓
权限检查
    ↓
业务规则检查
    ↓
修改问卷结构
    ↓
保存
    ↓
返回结果
```

再把结果交给模型：

```text
Tool Result:
问题创建成功
question_id = xxx
```

然后模型向用户反馈：

> 已增加“是否与其他人员共同飞行”问题。

---

# 10. 为什么需要 Tool，而不是让模型直接输出完整 JSON

如果让模型每次直接生成整棵问卷：

```text
LLM
 ↓
完整 JSON
 ↓
覆盖数据库
```

会产生几个问题：

1. 模型容易遗漏已有内容。
2. 一个小修改可能导致整份问卷被重新生成。
3. 难以精确控制修改范围。
4. 难以进行权限控制。
5. 很难审计到底修改了什么。
6. 容易出现结构破坏。

因此系统采用：

```text
增量操作
```

而不是：

```text
整份覆盖
```

例如：

```text
add_question
remove_question
update_question
move_question
```

每一个 Tool 都是一种明确、可控的操作。

---

# 11. 问卷 Schema 层

由于 AI 最终操作的是问卷结构，因此需要建立统一的：

> **Questionnaire Schema**

Schema 是 AI、后端、前端三方之间的共同语言。

结构可以抽象为：

```text
Questionnaire
│
├── metadata
│
└── sections[]
      │
      ├── id
      ├── title
      └── questions[]
             │
             ├── id
             ├── type
             ├── title
             ├── required
             └── options[]
```

例如：

```json
{
  "id": "questionnaire-001",
  "title": "无人机黑飞核查问卷",
  "sections": [
    {
      "id": "basic",
      "title": "基本信息",
      "questions": [
        {
          "id": "name",
          "type": "text",
          "title": "姓名",
          "required": true
        }
      ]
    }
  ]
}
```

这个 Schema 不只是给 AI 使用。

它同时是：

```text
AI
 ↓
Backend
 ↓
Frontend
```

三者之间的统一数据结构。

---

# 12. 模板生成架构

【V1重点】

模板生成有两种入口：

```text
人工编辑
AI对话生成
```

推荐 V1 就统一到一个内部结构上。

---

## 12.1 AI 生成流程

```text
用户
 ↓
AI聊天页面
 ↓
POST /ai/conversations
 ↓
AI Orchestrator
 ↓
读取当前问卷
 ↓
调用 LLM
 ↓
Tool Calling
 ↓
Questionnaire Service
 ↓
Schema 修改
 ↓
Database
 ↓
返回 Tool Result
 ↓
LLM
 ↓
返回用户
```

---

## 12.2 连续对话

第二轮：

```text
用户：
“再增加购买渠道。”
```

系统不应该：

```text
重新生成整份问卷
```

而应该：

```text
读取当前问卷
    ↓
理解新增要求
    ↓
add_question
    ↓
得到新问卷
```

因此 AI Session 必须始终能够获取：

> **当前真实问卷结构。**

---

# 13. AI 修改问卷实例架构

【V1重点】

这是本项目区别于普通 AI 问卷生成器的核心。

---

## 13.1 基础关系

```text
Template Version
       │
       │ instantiate
       ↓
Questionnaire Instance
       │
       │ AI modify
       ↓
Modified Instance
```

---

## 13.2 创建实例

假设：

```text
无人机黑飞核查问卷 V2.0
```

用户选择后：

```text
Template Version V2.0
        ↓
复制 / 派生
        ↓
Questionnaire Instance #001
```

此时：

```text
模板保持不变
实例拥有自己的问卷结构
```

---

## 13.3 AI 修改

用户：

```text
“这个调查对象还需要重点核查是否有团伙。”
```

系统：

```text
Instance #001
      ↓
AI
      ↓
add_section
      ↓
add_question
      ↓
Instance #001 更新
```

Template V2.0 完全不发生改变。

---

# 14. 问卷实例版本机制

为了增强可追溯性，建议实例也保留版本概念。

例如：

```text
Instance #001

Revision 1
↓
AI增加“团伙关系”
↓
Revision 2
↓
AI增加“近期去访地点”
↓
Revision 3
↓
用户确认
```

这与正式模板版本并不是一回事。

区别：

```text
模板版本
= 正式业务模板的发布版本

实例修订版本
= 某一次具体调查问卷的修改历史
```

---

# 15. AI 操作日志

建议单独记录 AI 操作。

示例：

```text
AI Action
────────────────────────────
conversation_id
user_id
questionnaire_id
message_id

tool_name:
add_question

tool_args:
{
    ...
}

before_snapshot:
...

after_snapshot:
...

created_at
```

这样后续可以追踪：

```text
谁
在什么时间
因为什么需求
让 AI
通过哪个 Tool
对哪一份问卷
进行了什么修改
```

---

# 16. AI 与数据库之间的边界

严格禁止：

```text
LLM → SQL → Database
```

建议采用：

```text
LLM
 │
 ↓
Tool Call
 │
 ↓
Application Service
 │
 ↓
Repository
 │
 ↓
Database
```

即：

```text
AI决定“做什么”
Backend决定“能不能做”
Database负责“保存结果”
```

例如 AI 想执行：

```text
remove_question
```

后端需要检查：

```text
问题是否存在？
用户有没有权限？
问题是否允许删除？
该问题是否属于已锁定结构？
删除后结构是否仍合法？
```

全部通过后才允许真正写数据库。

---

# 17. 数据存储架构

V1 建议至少逻辑上划分以下核心数据：

```text
用户
 │
 ├── 问卷模板
 │      └── 模板版本
 │
 ├── AI会话
 │      └── AI消息
 │
 └── 问卷实例
        ├── 调查对象
        ├── 实例版本
        ├── 问卷答案
        ├── 下发任务
        └── 审核记录
```

---

# 18. 问卷结构存储策略

V1 建议：

> **业务实体关系使用关系型数据模型，问卷树结构本身使用结构化 JSON 存储。**

例如：

```text
questionnaire_template
questionnaire_template_version
questionnaire_instance
questionnaire_response
```

同时问卷具体结构：

```json
{
  "sections": [...]
}
```

存储为 JSON/JSONB。

这样能够避免 V1 一开始就把：

```text
question
section
option
condition
rule
logic
```

全部拆成大量关系表。

---

## 18.1 为什么适合 V1

因为当前系统最频繁的操作是：

```text
生成一个问卷结构
修改问卷结构
读取整个问卷结构
展示整个问卷结构
```

而不是：

```text
跨百万条问题做复杂关系分析
```

所以 V1 可以优先保证问卷结构操作简单。

后续当条件逻辑、题目复用、统计分析等需求变复杂后，再逐步拆分高频领域。

---

# 19. 前端与后端的数据流

## 19.1 AI 创建问卷

```text
Browser
   │
   │ 用户发送自然语言
   ↓
API
   ↓
AI Orchestrator
   ↓
LLM
   ↓
Tool Call
   ↓
Questionnaire Service
   ↓
DB
   ↓
Tool Result
   ↓
LLM
   ↓
API
   ↓
Browser
```

---

## 19.2 AI 修改问卷

```text
Browser
   │
   │ 当前 Instance ID
   │ 用户特殊需求
   ↓
API
   ↓
AI Orchestrator
   ↓
读取 Instance
   ↓
LLM
   ↓
Tool Call
   ↓
Instance Service
   ↓
DB
```

注意这里的：

```text
Instance ID
```

是一个非常重要的上下文。

AI 修改时，必须明确：

> **“我现在到底在修改哪一份问卷？”**

而不能只依赖自然语言上下文。

---

# 20. AI 会话与业务数据的关系

AI Conversation 不等于问卷本身。

建议：

```text
AI Conversation
        │
        └── 当前操作对象
               │
               ├── Template
               └── Questionnaire Instance
```

例如：

```text
Conversation #1001
scene = create_template
target = Template Draft #001
```

另一条：

```text
Conversation #2001
scene = modify_instance
target = Questionnaire Instance #888
```

这样能够明确区分 AI 当前工作的业务上下文。

---

# 21. 状态机设计

## 21.1 模板状态

```text
DRAFT
  ↓
PUBLISHED
  ↓
DISABLED
```

---

## 21.2 问卷实例状态

```text
DRAFT
  ↓
CONFIRMED
  ↓
DISPATCHED
  ↓
IN_PROGRESS
  ↓
SUBMITTED
  ↓
UNDER_REVIEW
  ↓
COMPLETED
```

退回：

```text
UNDER_REVIEW
      ↓
RETURNED
      ↓
IN_PROGRESS
```

---

# 22. AI 操作状态

AI 操作本身建议也有状态：

```text
PENDING
   ↓
RUNNING
   ↓
SUCCESS
```

异常：

```text
RUNNING
   ↓
FAILED
```

这样 AI 调用异常时不会直接影响整个问卷实例的业务状态。

---

# 23. 异步任务设计

V1 中 AI 问卷生成与修改本身不一定必须使用消息队列。

对于正常交互：

```text
用户输入
 ↓
LLM
 ↓
Tool Call
 ↓
返回结果
```

可以先采用同步请求。

但以下能力以后可以考虑异步：

```text
批量问卷生成
大量历史数据分析
AI问卷质量检查
问卷统计
复杂附件解析
```

因此架构层面需要保持异步任务能力的扩展空间。

---

# 24. 权限边界

权限控制至少需要区分：

```text
模板管理权限
问卷创建权限
问卷下发权限
问卷填写权限
问卷审核权限
```

尤其需要防止：

```text
普通调查人员
    ↓
修改正式模板
```

以及：

```text
AI
 ↓
绕过权限
 ↓
直接修改正式模板
```

所有 AI Tool 最终都必须经过后端业务权限检查。

---

# 25. 数据安全与审计

系统涉及调查对象信息，因此架构必须预留：

```text
Authentication
Authorization
Audit Log
Data Access Log
AI Operation Log
```

尤其对 AI：

```text
用户输入
AI响应
Tool Call
Tool Result
问卷变更
```

需要具备完整的关联关系。

---

# 26. 异常处理

## 26.1 LLM 调用失败

```text
用户
 ↓
AI请求
 ↓
LLM失败
 ↓
返回错误
```

问卷原结构不发生变化。

---

## 26.2 Tool 调用失败

例如：

```text
AI：
remove_question(id=123)
```

但问题不存在。

Tool 返回：

```json
{
  "success": false,
  "error_code": "QUESTION_NOT_FOUND"
}
```

然后模型根据 Tool Result 决定后续回复。

---

## 26.3 AI 参数非法

例如模型要求：

```text
add_question
type = "unknown_type"
```

后端直接拒绝：

```text
Schema Validation Failed
```

不能让非法结构进入数据库。

---

## 26.4 数据库写入失败

Tool 执行失败后：

```text
Transaction Rollback
```

保证问卷结构不会出现半成功状态。

---

# 27. 一致性设计

对于一个 Tool Call：

```text
AI：
add_question
```

后台执行应尽可能保证：

```text
验证
 ↓
业务检查
 ↓
数据库写入
 ↓
操作日志
 ↓
提交事务
```

作为一个完整的业务操作。

如果：

```text
问卷结构更新成功
```

但：

```text
AI操作记录失败
```

则最终状态需要有明确策略。

V1 建议将：

> **问卷结构数据作为核心事务数据。**

日志可以采用独立机制补偿，不因普通日志异常阻塞问卷主要业务。

---

# 28. V1 推荐部署结构

V1 不建议一开始拆成大量微服务。

可以采用：

```text
                Frontend
                   │
                   ↓
             Backend API
                   │
        ┌──────────┴─────────┐
        │                    │
        ↓                    ↓
 Questionnaire Domain     AI Module
        │                    │
        │                    ↓
        │                  LLM
        │
        ↓
     Database
```

也就是：

> **模块化单体 + 独立 AI 模块边界**

而不是：

```text
Template Service
Instance Service
AI Service
Dispatch Service
Review Service
...
```

一开始全部拆成独立微服务。

---

# 29. 推荐的后端模块划分

以 TypeScript / Node.js 为例，可以采用：

```text
src/
├── modules/
│   ├── template/
│   │   ├── controller/
│   │   ├── service/
│   │   ├── repository/
│   │   └── domain/
│   │
│   ├── questionnaire/
│   │   ├── controller/
│   │   ├── service/
│   │   ├── repository/
│   │   └── domain/
│   │
│   ├── dispatch/
│   ├── response/
│   ├── review/
│   │
│   └── ai/
│       ├── controller/
│       ├── service/
│       ├── orchestrator/
│       ├── prompts/
│       ├── tools/
│       └── domain/
│
├── shared/
│   ├── database/
│   ├── auth/
│   ├── logger/
│   ├── errors/
│   └── utils/
│
└── app/
```

这一层只是推荐的工程落地形式，最终目录结构放到项目初始化设计文档中再确定。

---

# 30. V1 核心模块关系

V1 的核心可以简化成四块：

```text
┌─────────────────┐
│ Questionnaire   │
│ Schema          │
└────────┬────────┘
         │
         │ 被AI操作
         ↓
┌─────────────────┐
│ AI Orchestrator │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│ Questionnaire   │
│ Tools           │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│ Questionnaire   │
│ Service         │
└────────┬────────┘
         │
         ↓
      Database
```

其中：

> **Questionnaire Schema 是核心数据语言。**

> **AI Orchestrator 是智能入口。**

> **Tools 是 AI 与业务系统之间的安全边界。**

> **Questionnaire Service 是最终业务执行者。**

---

# 31. 两条 V1 核心链路

## 31.1 链路 A：AI 生成模板

```text
用户
 ↓
AI对话
 ↓
AI Orchestrator
 ↓
LLM
 ↓
Tool Calling
 ↓
Template / Questionnaire Service
 ↓
Schema
 ↓
保存 Draft
 ↓
用户继续对话
 ↓
继续 Tool Calling
 ↓
完成模板
 ↓
发布
```

---

## 31.2 链路 B：AI 修改实例

```text
用户
 ↓
选择模板版本
 ↓
创建 Instance
 ↓
填写调查对象信息
 ↓
进入 AI 调整
 ↓
用户自然语言描述特殊需求
 ↓
AI Orchestrator
 ↓
LLM
 ↓
Tool Calling
 ↓
Instance Service
 ↓
修改当前 Instance
 ↓
用户确认
 ↓
最终问卷
 ↓
下发
```

---

# 32. 最核心的架构边界

整个系统最终必须守住下面四条边界。

### 边界一

```text
正式模板 ≠ 问卷实例
```

---

### 边界二

```text
AI ≠ 业务执行器
```

AI 负责理解和提出操作。

业务服务负责真正执行。

---

### 边界三

```text
自然语言 ≠ 数据库结构
```

自然语言必须经过：

```text
LLM
 ↓
Tool Schema
 ↓
业务校验
 ↓
Domain Service
```

之后才能进入数据库。

---

### 边界四

```text
AI修改 ≠ 直接覆盖整份问卷
```

优先采用：

```text
Add
Update
Delete
Move
```

这种增量结构操作。

---

# 33. V1 架构验收标准

V1 架构成立，需要能够证明以下链路完整可运行。

## 场景一：AI 创建模板

```text
自然语言
 ↓
LLM
 ↓
Tool Call
 ↓
问卷结构
 ↓
数据库
 ↓
前端展示
```

---

## 场景二：连续补充

```text
第一次对话
 ↓
创建问卷
 ↓
第二次对话
 ↓
修改现有问卷
 ↓
第三次对话
 ↓
继续修改
```

最终问卷应是逐步演化出来的，而不是每轮重新生成。

---

## 场景三：模板派生实例

```text
Template V2.0
      ↓
Instance #001
```

---

## 场景四：AI 临时修改

```text
Instance #001
      ↓
AI
      ↓
Tool Call
      ↓
Instance Revision #2
```

同时：

```text
Template V2.0
```

保持完全不变。

---

## 场景五：最终下发

```text
修改后的 Instance
       ↓
用户确认
       ↓
Dispatch
       ↓
调查人员
       ↓
填写
       ↓
提交
       ↓
审核
```

---

# 34. V1 技术实现优先级

建议按照以下顺序开发。

## 第一阶段：问卷 Schema

首先确定：

```text
Section
Question
Option
Questionnaire
```

这些基础结构以及 JSON Schema。

这是整个系统的地基。

---

## 第二阶段：问卷 CRUD

先不接 AI，实现：

```text
创建
查询
修改
删除
```

确保问卷结构本身能够稳定运行。

---

## 第三阶段：Tool Calling

建立：

```text
get_questionnaire
add_section
add_question
update_question
remove_question
move_question
```

先让工具能够脱离 AI 独立运行。

---

## 第四阶段：AI Orchestrator

接入：

```text
LLM
Prompt
Context
Tool Calling
Tool Result
Conversation
```

跑通：

```text
用户一句话
 ↓
AI
 ↓
工具
 ↓
问卷发生变化
```

---

## 第五阶段：AI 创建问卷

完整实现：

```text
AI → 创建模板
```

---

## 第六阶段：模板实例化

完成：

```text
Template Version
       ↓
Questionnaire Instance
```

---

## 第七阶段：AI 修改实例

完成：

```text
用户特殊需求
       ↓
AI
       ↓
修改当前 Instance
```

---

## 第八阶段：下发、填写、审核

把 AI 核心能力接入完整业务闭环。

---

# 35. 架构总结

本系统 V1 的技术核心不是传统的：

```text
前端表单
    ↓
CRUD
    ↓
数据库
```

而是：

```text
                  自然语言
                     │
                     ↓
              ┌─────────────┐
              │     LLM     │
              └──────┬──────┘
                     │
                Tool Calling
                     │
                     ↓
              ┌─────────────┐
              │ Questionnaire│
              │    Tools     │
              └──────┬──────┘
                     │
                     ↓
              ┌─────────────┐
              │ Domain      │
              │ Service     │
              └──────┬──────┘
                     │
                     ↓
              ┌─────────────┐
              │ Questionnaire│
              │    Schema    │
              └──────┬──────┘
                     │
          ┌──────────┴──────────┐
          ↓                     ↓
     Template Version       Questionnaire
                                  Instance
                                      │
                              AI 临时修改
                                      │
                                      ↓
                                  最终问卷
                                      │
                                      ↓
                                   下发调查
```

因此，**V1 真正需要重点攻克的并不是“做一个问卷管理后台”，而是建立一个可靠的“自然语言 → 问卷结构操作”的转换链路。**

一旦这一层成立，后面的模板管理、下发、填写、审核，本质上都是围绕这个核心问卷结构能力搭建业务流程。

# 36. 与后续设计文档的关系

本架构设计完成后，后续建议严格按照以下顺序继续：

```text
RPD
 ↓
系统架构设计        ← 当前
 ↓
数据库设计
 ↓
Questionnaire Schema 设计
 ↓
AI Prompt / Agent 设计
 ↓
Tool Calling 接口设计
 ↓
REST API 接口设计
 ↓
TypeScript 项目初始化与目录设计
 ↓
编码
```


