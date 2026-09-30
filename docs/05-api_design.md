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

确认后默认不允许继续普通结构修改。

如实际业务需要重新调整，应设计明确的：

```text
reopen
```

操作。

V1 暂可不实现。

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

用户确认之后：

```http
POST /api/v1/questionnaire-templates/{templateId}/versions
```

或者由后端提供：

```http
POST /api/v1/ai/conversations/{conversationId}/commit
```

V1 更推荐第二种：

```text
AI Conversation
        ↓
用户点击“保存为模板”
        ↓
commit
        ↓
Template Version
```

这样 AI 会话与最终生成结果天然绑定。

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

GET /questionnaire-instances/{id}

POST /questionnaire-instances

POST /questionnaire-instances/{id}/confirm
```

加上内部：

```text
get_questionnaire
add_section
add_question
update_section
update_question
remove_question
move_question
```

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
│       └── versions/:versionId
│
├── questionnaire-instances
│   ├── POST
│   └── :id
│       ├── GET
│       ├── revisions
│       └── confirm
│
├── ai
│   └── conversations
│       ├── POST
│       └── :id
│           ├── GET
│           ├── messages
│           └── commit
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
