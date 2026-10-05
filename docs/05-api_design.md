# 智能问卷系统

## API 接口设计说明书 V1.0

---

# 1. 文档概述

## 1.1 文档目的

本文档用于定义智能问卷系统 V1 的后端 API，包括：

* 问卷模板 API
* 问卷模板版本 API
* 问卷实例 API
* AI 对话 API
* 问卷下发 API
* 问卷填写 API
* 问卷审核 API

同时定义 AI Tool 的内部调用契约。

本文档为 TypeScript + Node.js 后端开发提供接口层依据。

---

# 2. API 设计目标

V1 API 重点保证以下两条核心链路：

## 2.1 【V1重点】AI 生成问卷

```text
用户
 ↓
创建 AI Conversation
 ↓
发送自然语言
 ↓
AI Orchestrator
 ↓
LLM
 ↓
Tool Calling
 ↓
Questionnaire Service
 ↓
生成问卷结构
 ↓
前端展示
```

---

## 2.2 【V1重点】AI 修改问卷实例

```text
用户
 ↓
选择模板
 ↓
创建问卷实例
 ↓
创建 AI Conversation
 ↓
发送特殊调查需求
 ↓
LLM
 ↓
Tool Calling
 ↓
Questionnaire Service
 ↓
修改 Instance
 ↓
Revision + 1
 ↓
返回最新问卷
```

---

# 3. API 基础规范

## 3.1 Base URL

统一使用：

```text
/api/v1
```

例如：

```text
GET /api/v1/questionnaire-templates
```

---

# 4. HTTP 方法约定

| 方法     | 用途            |
| ------ | ------------- |
| GET    | 查询资源          |
| POST   | 创建资源 / 执行业务动作 |
| PUT    | 整体更新          |
| PATCH  | 局部更新          |
| DELETE | 删除资源          |

对于业务动作，例如发布、下发、提交、审核，不强行使用 REST 资源更新语义，而采用：

```text
POST /resource/{id}/action
```

例如：

```text
POST /questionnaire-templates/{id}/publish
```

---

# 5. 身份认证

所有业务接口默认需要身份认证。

请求：

```http
Authorization: Bearer <access_token>
```

后端解析得到：

```ts
interface CurrentUser {
  id: string;
  username: string;
  roles: string[];
}
```

当前用户信息由后端上下文提供。

客户端不能自行指定：

```text
created_by
dispatched_by
reviewer_id
```

这些字段必须由后端根据登录用户确定。

---

# 6. 统一响应结构

## 6.1 成功响应

```json
{
  "success": true,
  "data": {},
  "requestId": "0199..."
}
```

---

## 6.2 失败响应

```json
{
  "success": false,
  "error": {
    "code": "QUESTIONNAIRE_NOT_FOUND",
    "message": "问卷不存在"
  },
  "requestId": "0199..."
}
```

---

# 7. HTTP 状态码

建议统一使用：

| 状态码 | 使用场景        |
| --- | ----------- |
| 200 | 查询 / 修改成功   |
| 201 | 创建成功        |
| 204 | 删除成功且无返回内容  |
| 400 | 请求参数错误      |
| 401 | 未认证         |
| 403 | 无权限         |
| 404 | 资源不存在       |
| 409 | 状态冲突 / 版本冲突 |
| 422 | 参数语义不合法     |
| 500 | 服务内部错误      |

---

# 8. 错误码设计

V1 至少定义：

```text
UNAUTHORIZED
FORBIDDEN

INVALID_PARAMETER
VALIDATION_ERROR

TEMPLATE_NOT_FOUND
TEMPLATE_VERSION_NOT_FOUND

QUESTIONNAIRE_NOT_FOUND
QUESTIONNAIRE_LOCKED
REVISION_CONFLICT

QUESTION_NOT_FOUND
SECTION_NOT_FOUND
INVALID_QUESTION_TYPE

AI_CONVERSATION_NOT_FOUND
AI_REQUEST_FAILED
AI_TOOL_EXECUTION_FAILED

DISPATCH_NOT_FOUND
RESPONSE_NOT_FOUND

REVIEW_NOT_FOUND
INVALID_STATUS_TRANSITION
```

由已确认决策补充的错误码：

```text
QUESTIONNAIRE_LOCKED          实例已下发，结构冻结（D1）
WITHDRAW_NOT_ALLOWED          当前状态不允许撤回（D1）
PROMOTE_NOT_ALLOWED           当前状态不允许扶正为模板（D2）
INVALID_TOOL_CONTEXT          Tool 参数 target_id 与 Conversation 不一致（D9 相关）
NESTED_SECTION_UNSUPPORTED    add_section 传了 parent_section_id（V1 不支持嵌套）
```

各错误码的 HTTP 状态映射：

| 错误码 | HTTP | 说明 |
| --- | --- | --- |
| `QUESTIONNAIRE_LOCKED` | 409 | 状态冲突，不是参数错误 |
| `WITHDRAW_NOT_ALLOWED` | 409 | 状态冲突 |
| `PROMOTE_NOT_ALLOWED` | 409 | 状态冲突 |
| `REVISION_CONFLICT` | 409 | 乐观锁冲突 |
| `INVALID_TOOL_CONTEXT` | 400 | 参数与上下文不一致 |
| `NESTED_SECTION_UNSUPPORTED` | 422 | 参数语义合法但 V1 不支持 |

---

# 9. 模板 API

---

# 9.1 创建问卷模板

```http
POST /api/v1/questionnaire-templates
```

## Request

```json
{
  "name": "无人机黑飞核查问卷",
  "description": "用于无人机相关调查"
}
```

## Response

```json
{
  "success": true,
  "data": {
    "id": "0199...",
    "name": "无人机黑飞核查问卷",
    "description": "用于无人机相关调查",
    "status": "draft",
    "createdBy": "0199...",
    "createdAt": "2026-09-30T08:00:00Z"
  }
}
```

---

# 9.2 查询模板列表

```http
GET /api/v1/questionnaire-templates
```

支持：

```text
page
pageSize
keyword
status
```

例如：

```http
GET /api/v1/questionnaire-templates?page=1&pageSize=20&status=published
```

## Response

```json
{
  "success": true,
  "data": {
    "items": [],
    "page": 1,
    "pageSize": 20,
    "total": 10
  }
}
```

---

# 9.3 获取模板详情

```http
GET /api/v1/questionnaire-templates/{templateId}
```

## Response

```json
{
  "success": true,
  "data": {
    "id": "0199...",
    "name": "无人机黑飞核查问卷",
    "description": "...",
    "status": "published",
    "currentVersionId": "0199..."
  }
}
```

---

# 9.4 获取模板版本列表

```http
GET /api/v1/questionnaire-templates/{templateId}/versions
```

## Response

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "0199...",
        "versionNo": 2,
        "status": "published",
        "changeNote": "增加购买渠道",
        "createdAt": "2026-09-30T08:00:00Z"
      },
      {
        "id": "0198...",
        "versionNo": 1,
        "status": "disabled",
        "changeNote": "初始版本",
        "createdAt": "2026-09-20T08:00:00Z"
      }
    ]
  }
}
```

---

# 9.5 获取模板版本详情

```http
GET /api/v1/questionnaire-templates/{templateId}/versions/{versionId}
```

返回：

```json
{
  "success": true,
  "data": {
    "id": "0199...",
    "templateId": "0199...",
    "versionNo": 2,
    "schema": {
      "id": "schema-001",
      "title": "无人机黑飞核查问卷",
      "sections": []
    },
    "status": "published"
  }
}
```

---

# 9.6 创建模板版本

```http
POST /api/v1/questionnaire-templates/{templateId}/versions
```

## Request

```json
{
  "schema": {
    "id": "schema-001",
    "title": "无人机黑飞核查问卷",
    "sections": []
  },
  "changeNote": "增加购买渠道"
}
```

后端负责：

```text
计算 version_no
生成 version id
校验 Schema
保存版本
```

客户端不能自行指定：

```text
versionNo
createdBy
```

---

# 9.7 修改草稿模板版本

```http
PATCH /api/v1/questionnaire-templates/{templateId}/versions/{versionId}
```

V1 只允许修改：

```text
draft
```

状态的版本。

已经发布的版本禁止直接修改。

---

# 9.8 发布模板版本

```http
POST /api/v1/questionnaire-templates/{templateId}/versions/{versionId}/publish
```

无特殊 Request Body。

成功后：

```text
version.status = published
template.current_version_id = version.id
```

---

# 9.9 停用模板版本

```http
POST /api/v1/questionnaire-templates/{templateId}/versions/{versionId}/disable
```

已经投入使用的历史版本不做物理删除。

---

# 10. 【V1重点】AI 创建问卷 API

AI 创建问卷采用 Conversation 模式。

---

# 10.1 创建 AI 会话

```http
POST /api/v1/ai/conversations
```

## Request

```json
{
  "scene": "create_template"
}
```

## Response

```json
{
  "success": true,
  "data": {
    "conversationId": "0199...",
    "scene": "create_template",
    "targetType": "template",
    "targetId": "0199..."
  }
}
```

创建 `create_template` 会话时，后端可以同时创建一个：

```text
Draft Template
```

作为当前 AI 的操作目标。

---

# 10.2 发送 AI 消息

```http
POST /api/v1/ai/conversations/{conversationId}/messages
```

## Request

```json
{
  "content": "帮我创建一个无人机黑飞核查问卷，需要调查无人机型号、是否飞行过以及飞行地点。"
}
```

---

# 10.3 AI 响应模式

V1 推荐使用：

```text
SSE
```

即 Server-Sent Events。

请求：

```http
POST /api/v1/ai/conversations/{conversationId}/messages
```

响应：

```text
Content-Type: text/event-stream
```

---

# 10.4 AI SSE 事件

建议定义：

```text
message_start
text_delta
tool_call_start
tool_call_result
questionnaire_updated
message_complete
error
```

---

## 10.4.1 text_delta

```text
event: text_delta
data: {"content":"好的，我先建立一个基础问卷。"}
```

---

## 10.4.2 tool_call_start

```text
event: tool_call_start
data: {
  "toolName": "add_section",
  "operationId": "0199..."
}
```

---

## 10.4.3 tool_call_result

```text
event: tool_call_result
data: {
  "operationId": "0199...",
  "success": true
}
```

---

## 10.4.4 questionnaire_updated

```text
event: questionnaire_updated
data: {
  "questionnaireId": "0199...",
  "revision": 4
}
```

前端收到该事件后，可以重新请求问卷结构，也可以由事件直接携带最新结构。

V1 更推荐：

```text
questionnaire_updated
        ↓
GET questionnaire
```

避免 SSE 中传输过大的完整结构。

---

# 10.5 获取 AI 会话

```http
GET /api/v1/ai/conversations/{conversationId}
```

---

# 10.6 获取 AI 消息

```http
GET /api/v1/ai/conversations/{conversationId}/messages
```

支持：

```text
page
pageSize
```

---

# 11. 问卷实例 API

---

# 11.1 创建问卷实例

```http
POST /api/v1/questionnaire-instances
```

## Request

```json
{
  "templateVersionId": "0199...",
  "title": "张三 - 无人机黑飞核查",
  "subjectInfo": {
    "name": "张三",
    "idCard": "********",
    "address": "********"
  }
}
```

后端执行：

```text
Template Version
        ↓
读取 schema
        ↓
复制 schema
        ↓
创建 Instance
        ↓
创建 Revision 1
```

---

# 11.2 获取问卷实例

```http
GET /api/v1/questionnaire-instances/{instanceId}
```

## Response

```json
{
  "success": true,
  "data": {
    "id": "0199...",
    "templateVersionId": "0199...",
    "title": "张三 - 无人机黑飞核查",
    "subjectInfo": {},
    "currentSchema": {},
    "currentRevision": 3,
    "status": "draft"
  }
}
```

---

# 11.3 修改问卷实例

人工修改接口：

```http
PATCH /api/v1/questionnaire-instances/{instanceId}
```

V1 可以保留。

但是核心 AI 场景不应该直接依赖这个接口修改具体题目，而是：

```text
AI
 ↓
Tool
 ↓
QuestionnaireService
```

原因是 AI Tool 与人工编辑最终都可以复用同一个 Domain Service。

---

# 11.4 获取实例 Revision

```http
GET /api/v1/questionnaire-instances/{instanceId}/revisions
```

---

# 11.5 获取指定 Revision

```http
GET /api/v1/questionnaire-instances/{instanceId}/revisions/{revisionNo}
```

---

# 12. 【V1重点】AI 修改问卷实例

---

# 12.1 创建修改会话

```http
POST /api/v1/ai/conversations
```

## Request

```json
{
  "scene": "modify_questionnaire",
  "targetType": "questionnaire_instance",
  "targetId": "0199..."
}
```

后端检查：

```text
Instance 是否存在
用户是否有权限
Instance 是否允许修改
```

成功后建立 AI Session。

---

# 12.2 获取当前 AI 修改上下文

AI Orchestrator 根据：

```text
conversation.scene
conversation.targetId
```

自动读取：

```text
Questionnaire Instance
Current Schema
Current Revision
Subject Info
Conversation History
```

前端不需要把整份问卷重复塞进每一次请求里。

---

# 12.3 发送修改需求

仍然使用：

```http
POST /api/v1/ai/conversations/{conversationId}/messages
```

例如：

```json
{
  "content": "这个人需要重点核查有没有团伙，以及最近半年去过哪些地方。"
}
```

后端内部：

```text
AI Orchestrator
    ↓
LLM
    ↓
Tool Call
    ↓
Questionnaire Service
    ↓
Revision + 1
```

## 12.3a 下发后该接口必须拒绝（决策 D1）

发送修改需求前，后端校验实例状态：

```text
Instance.status == 'draft' 或 'confirmed'
        → 允许进入 AI 修改流程

Instance.status 为已下发及之后
        → 立即返回 QUESTIONNAIRE_LOCKED
          不调用 LLM，不消耗 Token
```

即：

```json
{
  "success": false,
  "error": {
    "code": "QUESTIONNAIRE_LOCKED",
    "message": "问卷已下发，请先撤回后再修改"
  }
}
```

**该校验在 AI 编排之前执行**，而不是靠 Prompt 约束模型不去改。
理由：调查员已经拿着冻结的问卷上门核查，
此时结构变化会让调查结果与问卷对不上。

正确路径是先 `withdraw`（第 13A 节），再进入本流程。

---

# 12.4 AI 修改后的结果获取

```http
GET /api/v1/questionnaire-instances/{instanceId}
```

前端拿到：

```text
currentSchema
currentRevision
```

进行刷新。

---

# 13. 确认问卷实例

AI 修改完成以后，用户需要明确确认。

```http
POST /api/v1/questionnaire-instances/{instanceId}/confirm
```

状态：

```text
draft
 ↓
confirmed
```

确认（confirm）表示本次问卷结构定稿。

**注意：** 本节早期版本写的是「确认后默认不允许继续普通结构修改」，
**该表述已修正**——`confirmed` 状态下仍然允许修改（reopen 语义），
真正的冻结点是下发（dispatch），见下方 13.1 节。

如实际业务需要重新调整，应设计明确的：

```text
reopen
```

操作。

V1 暂可不实现。

## 13.1 冻结发生在「下发」，不发生在「确认」（决策 D1）

澄清一个容易混淆的点：

```text
confirm   → status = confirmed
            这只是「本次问卷结构定稿」，
            实例尚未下发给调查员，
            因此仍然允许修改（即上面的 reopen 语义）。

dispatch  → status = dispatched
            这才是真正的冻结点：
            调查员已拿着这份问卷去核查了。
```

> **问卷一旦下发，结构冻结。**
>
> 调查员负责上门核查，具体核查哪些内容由下发人员决定；
> 「下发」这个动作代表核查内容已经布置清楚。

已下发之后，所有修改类 Tool 与修改类接口一律拒绝：

```json
{
  "success": false,
  "error": {
    "code": "QUESTIONNAIRE_LOCKED",
    "message": "问卷已下发，请先撤回后再修改"
  }
}
```

## 13.2 已确认状态与已下发状态的区分

| 状态 | 能否改结构 | 说明 |
| --- | --- | --- |
| `draft` | ✅ | AI 修改的主要场景 |
| `confirmed` | ✅ | 尚未下发，可改（reopen 语义） |
| `dispatched` 及之后 | ❌ | 必须撤回（见第 13A 节） |

## 13.3 需要改动时的正确路径

```text
已下发
   │
   │  POST /questionnaire-instances/{id}/withdraw
   ↓
 draft          ← 重新允许结构修改
   │
   │  修改（AI 或人工）
   ↓
confirmed
   │
   │  二次下发
   ↓
dispatched
```

**注意：** 本节早期版本提到 `reopen` 操作并说「V1 暂可不实现」。
**现改为：`confirmed` 状态下允许修改（即 reopen 语义），
已下发状态必须通过 `withdraw` 撤回**，见第 13A 节。

---

# 13A. 撤回问卷（撤销下发）【V1 必做】

## 13A.1 解决的问题

用户下发后发现核查内容需要调整。

因为下发后结构冻结（D1），必须提供一条正规的撤回路径，
否则用户只能新建实例，导致同一案件出现两份问卷。

## 13A.2 接口

```http
POST /api/v1/questionnaire-instances/{instanceId}/withdraw
```

Request：

```json
{
  "reason": "需要增加团伙关系调查"
}
```

Response：

```json
{
  "success": true,
  "data": {
    "id": "0199...",
    "status": "draft",
    "withdrawnAt": "2026-09-30T10:00:00Z"
  }
}
```

## 13A.3 允许撤回的状态

| 当前状态 | 允许撤回 | 撤回后 |
| --- | --- | --- |
| `draft` | ❌ | 本就可改，无需撤回 |
| `confirmed` | ❌ | 本就可改，无需撤回 |
| `dispatched` | ✅ | `draft` |
| `in_progress` | ✅ | `draft` |
| `submitted` | ✅ | `draft` |
| `under_review` | ✅ | `draft` |
| `returned` | ✅（需先回 `in_progress`） | `draft` |
| `completed` | ❌ | 终态，只能新建实例 |

**关于 `returned` 的说明（与 `02-architecture.md` 第 21.3 节对齐）：**

```text
returned 表示审核退回，调查员需要重新填写，
它不是一个独立的可撤回入口。

正确顺序：
  returned  →  调查员重新开始填写（in_progress）  →  撤回  →  draft
```

之所以不允许 `returned` 直接撤回：

```text
returned 状态下，调查员的重新填写工作尚未开始，
此时撤回会导致「退回」这个动作的业务含义丢失
（用户分不清是审核退回了，还是下发人员撤回了）。
```

不满足条件时返回：

```json
{
  "success": false,
  "error": {
    "code": "WITHDRAW_NOT_ALLOWED",
    "message": "已完成的调查任务不能撤回"
  }
}
```

## 13A.4 撤回时必须处理的既有数据

```text
1. questionnaire_responses
   → status = 'withdrawn'（不物理删除，保留痕迹）

2. questionnaire_answers
   → 跟随 response 失效，不回滚、不删除

3. dispatch_tasks
   → status = 'withdrawn'
   → 记录 withdrawn_at / withdrawn_by

4. questionnaire_instances
   → status = 'draft'
   → current_revision 继续递增，历史 Revision 不清空
```

## 13A.5 权限

需要 `dispatcher` 角色（决策 D8）。

## 13A.6 数据库支持

`dispatch_tasks` 需要新增：

```sql
withdrawn_at TIMESTAMPTZ,
withdrawn_by UUID
```

`questionnaire_responses.status` 需要支持 `withdrawn` 取值。

---

# 13B. 扶正为模板新版本【决策 D2】

## 13B.1 解决的问题

单个案件的特殊改动，如果反复出现在同类案件中，
说明标准模板存在缺失，应该沉淀进模板库。

```text
案件 A：增加「是否存在团伙」   ┐
案件 B：增加「是否存在团伙」   ├── 同类需求反复出现
案件 C：增加「活动轨迹」       ┘
        │
        ↓
   应该进入模板，而不是每次手工补
```

这同时是 `01-rpd.md` 第 21 节所规划的
「AI 根据历史调查经验推荐问题」的人工版本。

## 13B.2 接口

```http
POST /api/v1/questionnaire-instances/{instanceId}/promote
```

Request：

```json
{
  "changeNote": "由案件实例扶正：增加团伙关系调查"
}
```

Response：

```json
{
  "success": true,
  "data": {
    "templateId": "0199...",
    "templateVersionId": "0199...",
    "versionNo": 3,
    "status": "draft"
  }
}
```

## 13B.3 后端执行

```text
1. 读取 Instance
2. 校验状态（draft / confirmed 才允许扶正）
3. 读取 Instance.template_version_id → template_id
4. 复制 Instance.current_schema
5. 创建 questionnaire_template_version
   status = draft
   version_no = max(version_no) + 1
   source_instance_id = instanceId
   source_type = 'promoted_from_instance'
6. 返回新版本（不修改 template.current_version_id）
```

## 13B.4 关键约束

> **扶正生成的是模板「草稿版本」，不是直接发布。**
>
> 正式模板的发布仍然必须经过模板版本治理流程
> （`POST /questionnaire-templates/{id}/versions/{versionId}/publish`）。

若不满足条件：

```json
{
  "success": false,
  "error": {
    "code": "PROMOTE_NOT_ALLOWED",
    "message": "已下发或已完成的问卷实例不能直接扶正为模板"
  }
}
```

## 13B.5 权限

需要 `template_admin` 角色（决策 D8），
因为该操作会向模板库写入内容。

推荐由 `dispatcher` 发起、`template_admin` 确认；
若同一人兼有两个角色，可一次完成。

---

# 14. 下发 API

---

# 14.1 创建下发任务

```http
POST /api/v1/dispatch-tasks
```

## Request

```json
{
  "questionnaireInstanceId": "0199...",
  "assignedTo": "0199...",
  "dueAt": "2026-10-02T18:00:00Z"
}
```

后端检查：

```text
Instance 是否存在
状态是否为 confirmed
assignedTo 是否存在
当前用户是否有下发权限
```

---

# 14.2 执行下发

```http
POST /api/v1/dispatch-tasks/{dispatchTaskId}/dispatch
```

状态：

```text
pending
 ↓
dispatched
```

同时：

```text
questionnaire_instance
```

进入对应状态。

---

# 14.3 查询下发任务

```http
GET /api/v1/dispatch-tasks
```

支持：

```text
status
assignedTo
page
pageSize
```

---

# 15. 调查填写 API

---

# 15.1 获取待填写问卷

```http
GET /api/v1/questionnaire-instances/{instanceId}/response
```

返回：

```json
{
  "success": true,
  "data": {
    "responseId": "0199...",
    "questionnaire": {},
    "answers": []
  }
}
```

---

# 15.2 保存答案

```http
PUT /api/v1/questionnaire-responses/{responseId}/answers/{questionId}
```

例如：

```json
{
  "answer": "是"
}
```

多选：

```json
{
  "answer": [
    "商业",
    "航拍"
  ]
}
```

---

# 15.3 批量保存答案

为了减少大量 HTTP 请求，建议同时提供：

```http
PUT /api/v1/questionnaire-responses/{responseId}/answers
```

Request：

```json
{
  "answers": [
    {
      "questionId": "q_001",
      "answer": "张三"
    },
    {
      "questionId": "q_002",
      "answer": "yes"
    }
  ]
}
```

---

# 15.4 提交调查结果

```http
POST /api/v1/questionnaire-responses/{responseId}/submit
```

后端检查：

```text
必填项
答案格式
当前状态
填写权限
```

成功：

```text
draft
 ↓
submitted
```

---

# 16. 审核 API

---

# 16.1 获取待审核列表

```http
GET /api/v1/questionnaire-responses/review/pending
```

---

# 16.2 获取审核详情

```http
GET /api/v1/questionnaire-responses/{responseId}/review
```

---

# 16.3 审核通过

```http
POST /api/v1/questionnaire-responses/{responseId}/review
```

Request：

```json
{
  "result": "approved",
  "comment": "调查信息完整"
}
```

---

# 16.4 退回

同一个接口：

```http
POST /api/v1/questionnaire-responses/{responseId}/review
```

Request：

```json
{
  "result": "rejected",
  "comment": "缺少飞行地点调查结果"
}
```

后端根据：

```text
result
```

执行不同状态转换。

---

# 17. AI Tool 内部接口

这里是本项目最关键的接口之一。

需要特别区分：

> **Tool 不是 REST API。**

它是 AI Orchestrator 与业务 Service 之间的内部契约。

---

# 18. Tool 执行统一接口

TypeScript：

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

Tool：

```ts
interface QuestionnaireTool<TInput, TResult> {
  name: string;

  execute(
    input: TInput,
    context: ToolContext
  ): Promise<TResult>;
}
```

---

# 19. get_questionnaire

```ts
interface GetQuestionnaireInput {
  questionnaireId: string;
}
```

调用：

```ts
await questionnaireService.getById(
  input.questionnaireId,
  context.userId
);
```

返回：

```ts
interface GetQuestionnaireResult {
  success: true;
  questionnaire: QuestionnaireSchema;
  revision: number;
}
```

---

# 20. add_section

```ts
interface AddSectionInput {
  questionnaireId: string;

  title: string;

  description?: string;

  parentSectionId?: string;
}
```

返回：

```ts
interface AddSectionResult {
  success: boolean;

  section?: {
    id: string;
    title: string;
  };
}
```

---

# 21. add_question

```ts
interface AddQuestionInput {
  questionnaireId: string;

  sectionId: string;

  type: QuestionType;

  title: string;

  description?: string;

  required?: boolean;

  options?: {
    label: string;
    value: string;
  }[];
}
```

---

# 22. update_section

```ts
interface UpdateSectionInput {
  questionnaireId: string;

  sectionId: string;

  title?: string;

  description?: string;
}
```

---

# 23. update_question

```ts
interface UpdateQuestionInput {
  questionnaireId: string;

  questionId: string;

  title?: string;

  description?: string;

  type?: QuestionType;

  required?: boolean;

  options?: {
    label: string;
    value: string;
  }[];

  validation?: QuestionValidation;
}
```

---

# 24. remove_question

```ts
interface RemoveQuestionInput {
  questionnaireId: string;

  questionId: string;
}
```

原则：

> 删除必须来源于明确的用户需求。

---

# 25. move_question

```ts
interface MoveQuestionInput {
  questionnaireId: string;

  questionId: string;

  targetSectionId: string;

  targetOrder?: number;
}
```

---

# 26. Tool 执行标准流程

所有 Tool 统一：

```text
Tool.execute()
      ↓
Input Validation
      ↓
Context Validation
      ↓
Permission Check
      ↓
Domain Service
      ↓
Transaction
      ↓
Revision
      ↓
Audit Log
      ↓
Tool Result
```

---

# 27. Tool Context 校验

例如当前：

```text
scene = modify_questionnaire
targetId = instance_001
```

但是 AI Tool 传入：

```text
questionnaireId = instance_999
```

后端必须拒绝：

```json
{
  "success": false,
  "error": {
    "code": "INVALID_TOOL_CONTEXT",
    "message": "工具操作目标与当前 AI 会话不一致"
  }
}
```

---

# 28. Revision 并发控制

修改实例的 Tool 可以携带：

```ts
expectedRevision?: number;
```

例如：

```json
{
  "questionnaireId": "q_001",
  "expectedRevision": 3
}
```

后端：

```text
currentRevision == expectedRevision
```

才允许修改。

否则：

```text
409 REVISION_CONFLICT
```

AI 收到冲突结果后：

```text
get_questionnaire
      ↓
读取最新结构
      ↓
重新执行操作
```

---

# 29. API 与 Tool 的关系

这一点非常重要。

不是：

```text
Frontend
 ↓
REST API
 ↓
Tool API
 ↓
Database
```

而是：

```text
                ┌──────── Frontend
                │
                ↓
             REST API
                ↓
             Service
                ↓
             Database


LLM
 ↓
Tool
 ↓
Service
 ↓
Database
```

也就是说：

> **REST API 和 Tool 是两种不同的入口，但最终复用同一套业务 Service。**

这样不会出现两套业务逻辑。

---

# 30. Service 层

例如：

```ts
class QuestionnaireService {
  async addQuestion(
    input: AddQuestionInput,
    context: ServiceContext
  ) {
    // 权限
    // Schema 校验
    // Revision 校验
    // 修改 Schema
    // 持久化
    // 创建 Revision
  }
}
```

REST Controller：

```ts
POST /questionnaire-instances/:id/...
```

调用：

```ts
questionnaireService.addQuestion()
```

AI Tool：

```ts
add_question.execute()
```

同样调用：

```ts
questionnaireService.addQuestion()
```

---

# 31. AI API 与业务 API 的边界

AI API 负责：

```text
conversation
message
stream
```

问卷 API 负责：

```text
instance
schema
revision
```

因此 AI 不应该返回：

```text
“我已经修改数据库成功”
```

这样的不可验证结果。

真正的数据变化通过：

```text
questionnaire instance API
```

查询即可得到最终状态。

---

# 32. 前端 AI 页面推荐调用流程

## 32.1 创建模板

```text
POST /ai/conversations
scene=create_template
        ↓
返回 conversationId
        ↓
POST /ai/conversations/{id}/messages
        ↓
SSE
        ↓
questionnaire_updated
        ↓
GET template / draft
```

---

## 32.2 修改实例

```text
POST /ai/conversations
scene=modify_questionnaire
targetId=instanceId
        ↓
返回 conversationId
        ↓
POST /ai/conversations/{id}/messages
        ↓
SSE
        ↓
questionnaire_updated
        ↓
GET /questionnaire-instances/{instanceId}
```

---

# 33. AI 创建模板的最终保存

AI 对话过程中：

```text
Draft Template
```

不断变化。

## 33.1 唯一的保存路径：Conversation Commit

本文档早期版本给出了两条并存的路径：

```http
POST /api/v1/questionnaire-templates/{templateId}/versions   ← 已废弃
POST /api/v1/ai/conversations/{conversationId}/commit
```

**两条路并存会造成两套语义**（一条是「创建版本」，一条是「提交会话」），
V1 **只保留 commit**：

```text
AI Conversation
        ↓
用户点击"保存为模板"
        ↓
POST /ai/conversations/{id}/commit
        ↓
Template Version
```

理由：

```text
1. AI 会话与最终生成结果天然绑定，不需要外部再传一次 schema；
2. 避免「会话里的草稿」与「客户端传来的 schema」不一致；
3. 用户心智只有「对话生成 → 保存」一步。
```

## 33.2 那么 `POST /questionnaire-templates/{id}/versions` 还用吗

**仍然保留，但语义收窄**为「人工/非 AI 场景创建模板版本」，
主要供以下场景使用（见决策 D2、D3）：

```text
1. 人工编辑器保存版本（D3，上线前阶段）
2. 实例扶正后由 template_admin 调整并另存新版本（D2）
3. 手工新建模板版本（不走 AI 的场景）
```

**AI 生成模板的链路不得使用该接口。**

## 33.3 两者的分工

```text
AI 生成        → POST /ai/conversations/{id}/commit
人工编辑        → POST /questionnaire-templates/{id}/versions
实例扶正        → POST /questionnaire-instances/{id}/promote
                    ↓ 之后同样走 questionnaire-templates/.../versions
```

三条路最终都落到同一张 `questionnaire_template_versions` 表，
且都产生 `status = draft` 的版本，都必须经过 publish 才生效。

---

# 34. AI Conversation Commit

```http
POST /api/v1/ai/conversations/{conversationId}/commit
```

## Request

```json
{
  "name": "无人机黑飞核查问卷",
  "description": "用于无人机相关调查",
  "changeNote": "AI生成初版"
}
```

后端：

```text
读取当前 Draft
       ↓
Schema Validation
       ↓
创建 Template Version
       ↓
返回 Template Version
```

---

# 35. AI 修改实例后的确认

与创建模板不同：

```text
AI修改
 ↓
Instance Revision
 ↓
用户确认
```

因此：

```http
POST /api/v1/questionnaire-instances/{instanceId}/confirm
```

确认的其实是：

> **当前 Revision。**

可以在请求中带：

```json
{
  "revision": 5
}
```

后端校验：

```text
currentRevision == 5
```

之后才进入：

```text
confirmed
```

---

# 36. 分页规范

列表接口统一：

```text
page
pageSize
```

默认：

```text
page = 1
pageSize = 20
```

最多：

```text
pageSize = 100
```

避免一次返回大量：

```text
AI Message
Tool Log
Revision
```

---

# 37. 字段命名规范

REST JSON：

```text
camelCase
```

例如：

```json
{
  "questionnaireInstanceId": "0199...",
  "currentRevision": 3,
  "createdAt": "..."
}
```

PostgreSQL：

```text
snake_case
```

例如：

```text
questionnaire_instance_id
current_revision
created_at
```

TypeScript：

```text
camelCase
```

---

# 38. API DTO 与数据库模型分离

不要直接把数据库 Entity 返回给前端。

例如：

```text
Database Row
     ↓
Repository
     ↓
Domain Model
     ↓
DTO
     ↓
Response
```

原因包括：

```text
隐藏内部字段
控制返回内容
统一字段命名
减少数据库与 API 耦合
```

---

# 39. V1 API 优先级

## P0 —— 核心

```text
POST /ai/conversations
POST /ai/conversations/{id}/messages
POST /ai/conversations/{id}/commit

POST /questionnaire-instances
GET  /questionnaire-instances/{id}

POST /questionnaire-instances/{id}/confirm
```

加上内部 Tool：

```text
get_questionnaire
add_section
add_question
update_section
update_question
remove_question
move_question
```

## P0.5 —— 由决策 D1 提升为必做

撤回是「下发后冻结」规则的配套能力，**没有它用户会被锁死**，
因此从原 P1 提升：

```text
POST /questionnaire-instances/{id}/withdraw     ← D1
```

扶正（D2）同样提升，否则「临时改动」永远无法沉淀：

```text
POST /questionnaire-instances/{id}/promote      ← D2
```

实现顺序上可略晚于 withdraw，但必须在 V1 内完成。

---

## P1 —— 基础业务

```text
GET /questionnaire-templates
POST /questionnaire-templates

GET /questionnaire-templates/{id}
GET /questionnaire-templates/{id}/versions

POST /dispatch-tasks
POST /dispatch-tasks/{id}/dispatch

GET /questionnaire-instances/{id}/response
PUT /questionnaire-responses/{id}/answers
POST /questionnaire-responses/{id}/submit

POST /questionnaire-responses/{id}/review
```

---

## P2 —— 后续增强

例如：

```text
复杂权限
模板审批
高级统计
批量操作
复杂问卷逻辑
AI结果分析
问卷智能优化
```

---

# 40. V1 核心 API 总览

```text
/api/v1

├── questionnaire-templates
│   ├── GET
│   ├── POST
│   └── :id
│       ├── GET
│       ├── versions
│       │   └── POST                        ← 人工/扶正场景创建版本
│       └── versions/:versionId
│           ├── PATCH                       ← 仅 draft 版本
│           ├── publish
│           └── disable
│
├── questionnaire-instances
│   ├── POST
│   └── :id
│       ├── GET
│       ├── revisions
│       ├── confirm
│       ├── withdraw                        ← D1【P0.5】
│       └── promote                         ← D2【P0.5】
│
├── ai
│   └── conversations
│       ├── POST
│       └── :id
│           ├── GET
│           ├── messages
│           └── commit                      ← AI 生成模板的唯一保存入口
│
├── dispatch-tasks
│   ├── GET
│   └── POST
│
└── questionnaire-responses
    ├── :id
    │   ├── answers
    │   ├── submit
    │   └── review
```

## 40.1 三条「保存版本」路径的分工

```text
POST /ai/conversations/:id/commit              AI 对话生成 → 模板版本
POST /questionnaire-templates/:id/versions     人工编辑 → 模板版本
POST /questionnaire-instances/:id/promote      实例扶正 → 模板版本（草稿）
```

三者产出的都是 `status = draft` 的 `questionnaire_template_versions`，
都必须经过 `publish` 才成为正式版本。

---

# 41. V1 核心 AI API 链路

## AI 创建模板

```text
POST /ai/conversations
        ↓
POST /ai/conversations/{id}/messages
        ↓
SSE
        ↓
LLM
        ↓
Tool
        ↓
QuestionnaireService
        ↓
Draft Template
        ↓
POST /ai/conversations/{id}/commit
        ↓
Template Version
```

---

## AI 修改实例

```text
POST /ai/conversations

scene:
modify_questionnaire

target:
questionnaire_instance
        ↓
POST /ai/conversations/{id}/messages
        ↓
SSE
        ↓
LLM
        ↓
Tool
        ↓
QuestionnaireService
        ↓
Revision + 1
        ↓
用户确认
        ↓
POST /questionnaire-instances/{id}/confirm
        ↓
Dispatch
```

---

# 42. 一个完整的实际调用示例

用户进入：

> “新建问卷”

前端：

```http
POST /api/v1/ai/conversations
```

```json
{
  "scene": "create_template"
}
```

得到：

```json
{
  "conversationId": "conv-001"
}
```

然后：

```http
POST /api/v1/ai/conversations/conv-001/messages
```

```json
{
  "content": "创建一个无人机黑飞核查问卷，需要调查无人机型号、是否飞行过、飞行地点。"
}
```

后台：

```text
LLM
 ↓
add_section
 ↓
Tool
 ↓
add_question
 ↓
Tool
 ↓
add_question
 ↓
Tool
 ↓
questionnaire_updated
```

前端刷新：

```http
GET /api/v1/questionnaire-templates/{id}
```

继续聊天：

```text
“还要增加购买渠道。”
```

再次：

```http
POST /ai/conversations/conv-001/messages
```

后台：

```text
LLM
 ↓
add_question
 ↓
Revision
 ↓
questionnaire_updated
```

最后：

```http
POST /api/v1/ai/conversations/conv-001/commit
```

生成正式模板版本。

---

# 43. 一个完整的实例修改示例

用户：

> “我要给张三下发无人机黑飞核查问卷。”

创建实例：

```http
POST /api/v1/questionnaire-instances
```

```json
{
  "templateVersionId": "template-v2",
  "title": "张三 - 无人机黑飞核查",
  "subjectInfo": {
    "name": "张三"
  }
}
```

创建 AI 修改会话：

```http
POST /api/v1/ai/conversations
```

```json
{
  "scene": "modify_questionnaire",
  "targetType": "questionnaire_instance",
  "targetId": "instance-001"
}
```

发送：

```http
POST /api/v1/ai/conversations/conv-002/messages
```

```json
{
  "content": "这次重点核查有没有团伙，以及最近半年去过哪些地方。"
}
```

AI：

```text
add_section
 ↓
add_question
 ↓
add_question
 ↓
Revision 1 → 4
```

用户确认：

```http
POST /api/v1/questionnaire-instances/instance-001/confirm
```

然后：

```text
POST /api/v1/dispatch-tasks
```

最终完成：

```text
模板
 ↓
实例
 ↓
AI临时修改
 ↓
确认
 ↓
下发
```

---

# 44. API 设计中的核心原则

## 原则一

> **REST API 面向业务资源。**

例如：

```text
Template
Instance
Response
Review
```

---

## 原则二

> **AI API 面向 AI 会话。**

例如：

```text
Conversation
Message
Stream
Commit
```

---

## 原则三

> **Tool 面向 AI 可执行动作。**

例如：

```text
add_question
update_question
remove_question
```

---

## 原则四

> **最终业务状态永远以数据库中的业务实体为准。**

AI 回复：

```text
“已经增加了问题”
```

不是最终事实。

只有：

```text
questionnaire_instance.current_schema
```

真正改变，才代表修改成功。

---

# 45. V1 API 最终架构

最终形成：

```text
                         Frontend
                            │
             ┌──────────────┴───────────────┐
             ↓                              ↓
       Questionnaire API               AI API
             │                              │
             │                         AI Orchestrator
             │                              │
             │                             LLM
             │                              │
             │                         Tool Calling
             │                              │
             └──────────────┬───────────────┘
                            ↓
                   Questionnaire Service
                            │
                   ┌────────┴────────┐
                   ↓                 ↓
              Repository          Audit
                   │
                   ↓
                PostgreSQL
```

---

# 46. V1 接口设计结论

V1 的 API 设计最终围绕三个核心对象：

```text
Template
Instance
AI Conversation
```

展开。

其中：

```text
Template
    ↓
定义标准问卷

Instance
    ↓
表示具体调查

AI Conversation
    ↓
通过自然语言改变 Template / Instance
```

三者之间形成：

```text
                 AI Conversation
                   │        │
                   │        │
         create_template    │
                   ↓        │
                Template    │
                            │
                modify_questionnaire
                            ↓
                         Instance
```

最核心的调用链为：

```text
自然语言
   ↓
POST /ai/conversations/{id}/messages
   ↓
AI Orchestrator
   ↓
LLM
   ↓
Tool Calling
   ↓
QuestionnaireService
   ↓
Revision
   ↓
PostgreSQL
   ↓
questionnaire_updated
   ↓
Frontend
```

这一条链就是本项目 V1 的“主干 API”。
