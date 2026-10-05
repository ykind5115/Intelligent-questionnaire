# 智能问卷系统

## 设计评审结论与决策记录 V1.0

---

# 1. 文档目的

本文档是《智能问卷系统》设计文档集（`00` ~ `06`）的评审产出，用于：

1. 记录评审中发现的**设计缺口与不一致**；
2. 记录已由决策人确认的**设计裁决**；
3. 明确每条问题对应的**文档修订动作**与**代码阶段约束**。

本文档与 `00` ~ `06` 冲突时，以本文档的决策为准。

---

# 2. 已确认决策（Decision Log）

| 编号 | 议题 | 决策 | 影响文档 |
| --- | --- | --- | --- |
| D1 | 问卷下发后是否允许修改结构 | **禁止**。下发即代表核查内容已布置完毕。如需改动，**撤销下发（撤回）→ 修改 → 二次下发** | 02, 04, 05 |
| D2 | 实例临时改动能否扶正为模板 | **可以**。实例上提供「保存为新版本」按钮，将当前实例结构生成模板新版本草稿 | 01, 05, 06 |
| D3 | 是否提供人工编辑器 | **必须做，但排在最后**。V1 主线为 AI 主导能力；人工编辑器作为上线前兜底功能，列入计划书最终完善阶段 | 01, 02, 06 |
| D4 | 技术栈 | **Express + Prisma + PostgreSQL + TypeScript + Zod** | 02, 06 |
| D5 | 验收方式 | **先建立固定测试用例集（含测试数据）**，将「AI 生成/修改成功率」变成可量化指标 | 01, 06 |
| D6 | 前端范围 | **后端优先**。前端仅做简要实现（结构树展示 + 对话 + 确认/下发按钮），不做完整管理后台 | 02, 05, 06 |
| D7 | 本地数据库环境 | **使用 Prisma 自带本地 Postgres（`prisma dev`）**，零安装、无需 Docker、无需管理员权限 | 06 |
| D8 | 权限模型 | **`users` 表增加 `roles` 字段**（V1 最简方案），不建独立 RBAC 表 | 04, 05 |
| D9 | Tool 幂等粒度 | **一次 Tool 调用一个 `operation_id`**；实现采「先查后插」，不依赖 UNIQUE 冲突 | 03, 04 |
| D10 | Prisma 版本 | **锁定 `prisma@7.10.0` + `@prisma/client@7.10.0`**（`latest` 当前是 8.0 RC，不采用） | 06 |
| D11 | 登录与账号 | **V1 不做注册/登录接口**。使用 `seed.ts` 固定的 4 个测试账号；开发态由请求头 `x-user-id` 指定当前用户，后端解析为 `CurrentUser`，**接口契约与正式鉴权一致**，后续替换中间件即可接真实鉴权 | 04, 05, 06 |
| D12 | LLM 模型 | **DeepSeek `deepseek-v41-flash`**（OpenAI 兼容协议）。模型名、base URL、Key 全部走环境变量；业务层只依赖 `LLMProvider` 接口 | 06, 08 |
| D13 | 部署与迁移 | **V1 本机跑通**；后期整体迁移到**内网**，届时模型接口替换为自研服务 | 02, 06 |

---

# 3. D1 落地：问卷状态与可修改边界

## 3.1 核心规则

> **问卷实例一旦下发，结构冻结。**
>
> 调查内容的决定权属于**下发人员**，调查人员只负责上门核查与填写。
> 下发动作即为「核查内容已确认」的法律/业务边界。

## 3.2 结构可修改窗口

```text
DRAFT ─────────► CONFIRMED ─────────► DISPATCHED
  │                  │                    │
  │                  │                    │
允许结构修改        允许结构修改          禁止结构修改
（AI + 人工）      （AI + 人工）         （必须撤回）
```

**注意：冻结点是「下发」，不是「确认」。**

```text
confirm  只是「本次问卷结构定稿」，实例还没交给调查员
         → 仍可修改（reopen 语义）

dispatch 才是冻结点，调查员已拿着问卷去核查
         → 必须撤回
```

| 实例状态 | AI Tool 能否改结构 | 说明 |
| --- | --- | --- |
| `draft` | ✅ 允许 | AI 修改的主要场景 |
| `confirmed` | ✅ 允许 | 尚未下发，可改（reopen 语义） |
| `dispatched` | ❌ 禁止 | 必须撤回 |
| `in_progress` | ❌ 禁止 | 必须撤回 |
| `submitted` | ❌ 禁止 | 必须撤回 |
| `under_review` | ❌ 禁止 | 必须撤回 |
| `completed` | ❌ 禁止 | 终态，只能新建实例 |
| `returned` | ❌ 禁止 | 先回到 `in_progress`，再撤回 |

## 3.3 撤回（撤销下发）

撤回是本决策新增的核心动作：

```text
dispatched / in_progress / submitted
        │
        │  POST /questionnaire-instances/{id}/withdraw
        ↓
      draft        ← 结构重新允许修改
        │
        │  修改（AI / 人工）
        ↓
    confirmed
        │
        │  二次下发
        ↓
    dispatched
```

撤回时必须处理的既有数据：

```text
1. 已产生的 questionnaire_responses
   → 标记 status = withdrawn（不物理删除，保留痕迹）

2. 已保存的 questionnaire_answers
   → 跟随 response 一起失效，不回滚、不删除

3. 撤销关联的 dispatch_tasks
   → status = withdrawn，记录 withdrawn_at / withdrawn_by

4. 实例 current_revision 继续递增
   → 撤回后的修改产生新的 Revision，历史不清空
```

## 3.4 Tool 层约束

所有修改类 Tool 执行前统一校验：

```text
Instance.status == 'draft'
        │
        ├── 是  → 允许执行
        │
        └── 否  → 返回错误
                  {
                    "success": false,
                    "error": {
                      "code": "QUESTIONNAIRE_LOCKED",
                      "message": "问卷已下发，请先撤回后再修改"
                    }
                  }
```

**该校验由后端执行，不依赖 Prompt 约束。** AI 即使调用，也一定会被拒绝。

## 3.5 待补充的错误码

```text
QUESTIONNAIRE_LOCKED      结构已冻结（已下发或已确认）
WITHDRAW_NOT_ALLOWED      当前状态不允许撤回
```

---

# 4. D2 落地：实例结构扶正为模板版本

## 4.1 业务价值

单个案件的特殊改动，如果反复出现在同类案件中，说明标准模板存在缺失。

```text
案件 A：增加「是否存在团伙」   ┐
案件 B：增加「是否存在团伙」   ├── 同类需求反复出现
案件 C：增加「活动轨迹」       ┘
        │
        ↓
   应该进入模板，而不是每次手工补
```

## 4.2 交互设计

实例详情页（AI 调整完成后）提供：

```text
[ 保存为模板新版本 ]
```

点击后：

```text
当前 Instance.current_schema
        │
        │  去掉本次临时改动之外的差异（可选，V1 直接整份采用）
        ↓
Template Version Draft
        │
        │  人工填写 changeNote
        ↓
进入模板管理，走正常发布流程
```

## 4.3 关键约束

> **扶正动作生成的是模板「草稿版本」，不是直接发布。**
>
> 正式模板的发布仍然必须经过模板管理流程，避免临时改动绕过版本治理。

## 4.4 API

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

后端执行：

```text
1. 读取 Instance
2. 校验 Instance 是否处于可扶正状态（draft / confirmed）
3. 读取 Instance.template_version_id → template_id
4. 复制 Instance.current_schema
5. 创建 questionnaire_template_version
   status = draft, version_no = max + 1
6. 记录来源：source_instance_id
7. 返回新版本
```

## 4.5 数据库变更

`questionnaire_template_versions` 增加：

```sql
ALTER TABLE questionnaire_template_versions
    ADD COLUMN source_instance_id UUID,
    ADD COLUMN source_type VARCHAR(20);
    -- 'ai_generated' | 'promoted_from_instance' | 'manual'
```

---

# 5. D3 落地：人工编辑器的排期

## 5.1 决策

人工编辑器**必须实现**，但**不进入 V1 主线**。

原因：AI 主导能力是本项目的核心未知数，人工编辑器是已知的工程工作。

## 5.2 排期位置

```text
阶段一 ~ 阶段六：AI 主线（Schema → Operation → Service → Tool → Orchestrator）
        ↓
阶段七：完整业务闭环（下发 / 填写 / 审核 / 撤回）
        ↓
阶段八：验收测试（固定用例集 + 测试数据）
        ↓
阶段九【上线前】：人工编辑器兜底
        │
        ├── 模板编辑器（加题 / 改题 / 删题 / 排序 / 改题型）
        └── 实例编辑器（同上，受 D1 状态约束）
```

## 5.3 架构预留（现在就要做，避免返工）

由于 Tool 与 REST 复用同一个 `QuestionnaireService`（见 `05-api_design.md` 第 29 节），
人工编辑器未来只需接入已有的 Operation 层，**不需要新增业务逻辑**：

```text
              人工编辑器 (阶段九)
                     │
                     ↓
              REST API (阶段八前已存在)
                     │
                     ↓
            QuestionnaireService   ← 与 AI Tool 共用
                     │
                Operation 层       ← 与 AI Tool 共用
                     │
              QuestionnaireSchema
```

**当前必须保证的唯一预留事项：**

> Operation 层（`add-section.ts` / `add-question.ts` ...）必须是**纯函数式的 Schema 变换**，
> 入参为 `(QuestionnaireSchema, Input)`，返回新的 `QuestionnaireSchema`，
> 不耦合 AI 上下文、不耦合 HTTP。

---

# 6. D4 落地：技术栈定版

| 层次 | 选型 |
| --- | --- |
| Runtime | Node.js |
| Language | TypeScript（`strict: true`） |
| HTTP | **Express** |
| ORM | **Prisma** |
| Database | PostgreSQL |
| Validation | Zod |
| LLM | DeepSeek（OpenAI 兼容协议） |
| Streaming | SSE |

## 6.1 目录调整

`06-proj_init.md` 中的 `prisma/` 目录确认保留：

```text
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
```

## 6.2 Drizzle 相关表述

`06-proj_init.md` 中「Prisma / Drizzle / pg」「如果最终使用 Drizzle / 原生 pg」等表述
统一收敛为 **Prisma**。

---

# 7. D5 落地：验收测试方案

## 7.1 问题

现有验收标准（`01-rpd.md` 第 18 / 25 节）为人工主观判断，无法回归测试。

## 7.2 方案：固定用例集

建立 `tests/fixtures/ai-cases/`，每个用例包含：

```json
{
  "id": "case-001",
  "scene": "create_template",
  "messages": [
    "我要做一个无人机黑飞核查问卷，主要调查有没有购买无人机、有没有飞过、在哪里飞过，还需要了解无人机的型号。"
  ],
  "expect": {
    "sections_min": 1,
    "must_contain_question_keywords": ["型号", "飞行"],
    "question_types_valid": true,
    "schema_valid": true
  }
}
```

## 7.3 评测指标

```text
1. Schema 合法性（必须 100%）
   → 生成结果必须能通过 Zod 校验

2. 关键点覆盖率
   → 用户提到的要点，是否都出现在问卷中

3. 工具调用正确率
   → 是否使用了最小必要 Tool，而非整份重写

4. 多轮增量正确性
   → 第二轮修改后，第一轮内容是否仍在
```

## 7.4 测试数据

`prisma/seed.ts` 提供：

```text
用户：
  模板管理员
  下发人员
  调查人员
  审核人员

模板：
  无人机黑飞核查问卷 V1（含基本信息 / 无人机情况 / 飞行情况）
  宠物饲养规范核查问卷 V1

实例：
  张三 - 无人机黑飞核查（draft）
```

---

# 8. D6 落地：前端范围

## 8.1 V1 前端页面（最简实现）

| 页面 | 内容 |
| --- | --- |
| AI 问卷设计页 | 左对话 + 右结构树（只读） + 保存/发布按钮 |
| AI 调整实例页 | 左对话 + 右结构树（只读） + 确认/撤回/下发按钮 |
| 填写页 | 按 Schema 渲染基础题型 + 保存 + 提交 |
| 审核页 | 查看答案 + 通过/退回 |
| 模板列表页 | 简单列表 + 新建 + 查看 |

## 8.2 明确不做

```text
复杂权限后台
统计分析图表
模板审批流
拖拽式编辑器（属于阶段九）
高级题型渲染（图片/文件/定位/表格）
```

---

# 9. 设计缺口清单（修订状态）

> 本节保留评审时的原始记录，便于追溯。
> **A4 / A5 已分别由 D8 / D9 裁决**，B/C 级各项的处理结果见第 11 节。

## 9.1 A 级：核心逻辑缺口（已全部裁决）

| 编号 | 问题 | 裁决 | 修订动作 | 状态 |
| --- | --- | --- | --- | --- |
| A1 | 实例下发后能否修改未定义 | D1：禁止，走撤回 | 补状态机、撤回 API、Tool 状态校验 | ✅ |
| A2 | 临时改动无扶正路径 | D2：保存为新版本按钮 | 补 promote API + 数据表字段 | ✅ |
| A3 | 无人工编辑器，与「AI 挂掉业务照跑」矛盾 | D3：阶段九实现 | 写入计划书 + Operation 层纯函数约束 | ✅ |
| A4 | `users` 表无角色字段，但 `CurrentUser.roles` 存在 | **D8：`users.roles` 字段** | 补 `roles` 字段 + 四类角色 | ✅ |
| A5 | `operation_id` 幂等在重试时会撞 UNIQUE | **D9：一次 Tool 一个 operation_id，先查后插** | 定义幂等粒度与实现方式 | ✅ |

## 9.2 B 级：工程细节（实现前必须定死）

| 编号 | 问题 | 位置 | 建议 |
| --- | --- | --- | --- |
| B1 | `questionnaire_id` 命名歧义（Template vs Instance） | 03 / 05 | Tool 参数统一为 `target_id`，由 `scene` 决定语义 |
| B2 | `sections[].children[]` 定义了嵌套但缺少 section 级操作 | 03 | V1 明确只用一级 section，`children` 保留但工具不支持 |
| B3 | AI 生成模板的保存链路有两条并存 | 05 | 只保留 `POST /ai/conversations/{id}/commit` |
| B4 | create_template 场景写的是 draft template，需与「不改模板」铁律区分 | 01 / 02 | Prompt 中显式区分 `target_type` |
| B5 | `questionnaire_answers` 未绑定 revision | 04 | 增加 `revision_no` 字段 |
| B6 | JSONB 查询边界未规划索引 | 04 | 明确 V1 不做 JSONB 内部查询 |
| B7 | 一个 Tool 一个事务 / 一个 Revision 的粒度 | 04 | 明确定义并写入一致性规则 |
| B8 | SSE 流式写入 `ai_messages` 未定义 | 04 / 05 | 定义「消息完成后落库」策略 |
| B9 | `questionnaire_revisions.created_by` 无外键 | 04 | 补 FK |
| B10 | `version_no INTEGER` 与 UI `V2.0` 的映射 | 04 / 01 | 定义为整数自增，显示层拼 `V{n}.0` |

## 9.3 C 级：风险提示

| 编号 | 风险 | 建议 |
| --- | --- | --- |
| C1 | `subject_info` 含身份证等 PII，且快照会进 LLM 上下文 | 定义敏感字段白名单，不进 Prompt |
| C2 | 每次 Tool 调用携带完整问卷，题目增长后 Token 失控 | 定义截断策略 / Prompt 缓存 |
| C3 | `questionnaire_updated` 每次修改触发一次全量 GET | 按 assistant message 合并刷新 |

---

# 10. 待决策项

以下问题本轮未裁决，需在进入编码前确认。

## 10.1 权限模型（A4）—— 已裁决

**D8：`users` 表增加 `roles` 字段。**

```sql
ALTER TABLE users
    ADD COLUMN roles VARCHAR(30)[] NOT NULL DEFAULT '{}';
```

角色枚举（与 `02-architecture.md` 第 24 节的权限边界对应）：

```text
template_admin      模板管理
dispatcher          问卷创建 / 下发 / 撤回
investigator        问卷填写
reviewer            问卷审核
```

裁决理由：V1 用户量小、角色固定，独立 RBAC 表属于过度设计。`roles` 为数组，
允许一人多角色（例如管理员兼审核人）。后续需要细粒度权限时，`roles` 字段
可以平滑迁移为 `user_roles` 关联表，不影响调用方。

## 10.2 Tool 幂等粒度（A5）—— 已裁决

**D9：一次 Tool 调用一个 `operation_id`。**

```text
一次用户消息
  └── LLM 回合
        ├── Tool Call #1  → operation_id = op_001
        ├── Tool Call #2  → operation_id = op_002
        └── Tool Call #3  → operation_id = op_003
```

裁决理由：`03-questionnaire_schema_ai_tool_calling .md` 第 32 节要求
「重复请求不产生重复问题」，只有细粒度才能精确判断哪个 Tool 已执行过。

实现方式（**不依赖 UNIQUE 冲突**）：

```text
1. 事务开始
2. SELECT * FROM ai_tool_executions WHERE operation_id = $1
3. 若已存在且 success = true
   → 直接返回已记录的结果，不再修改问卷
4. 若不存在
   → 执行 Tool
   → INSERT ai_tool_executions
   → COMMIT
```

`operation_id` 由 AI Orchestrator 为每个 Tool Call 生成 UUID v7，
并写入日志，便于前端 `tool_call_start` / `tool_call_result` 事件配对。

## 10.3 其余 —— 已全部裁决

| 议题 | 决策 |
| --- | --- |
| 登录方式 | **D11**：V1 用固定测试账号 + `x-user-id` 请求头 |
| LLM 型号与 Key | **D12**：`deepseek-v41-flash`，Key 走环境变量 `AI_API_KEY` |
| 部署形态 | **D13**：本机跑通，后期迁内网并换模型接口 |

### 10.3.1 D11 实现方式

```text
seed.ts 写入 4 个固定用户（各带一个角色）：

  admin        template_admin
  dispatcher1  dispatcher
  investigator1 investigator
  reviewer1    reviewer

开发态鉴权中间件：

  请求头 x-user-id: <userId>
        ↓
  查 users 表
        ↓
  注入 req.currentUser = { id, username, roles }
```

关键约定：

```text
1. 业务代码只依赖 CurrentUser（id / username / roles），
   不感知「当前是测试账号还是 JWT」；

2. 因此正式接入鉴权时，只需替换 auth.middleware.ts 的实现，
   业务层与权限校验代码零改动；

3. x-user-id 中间件必须仅在 NODE_ENV !== 'production' 时启用，
   生产环境若缺少真实鉴权中间件应当直接拒绝启动，
   而不是静默降级为「人人可指定身份」。
```

### 10.3.2 D12 实现方式

```text
配置全部走环境变量（06-proj_init.md 第 9.1 节）：

  AI_BASE_URL   DeepSeek 的 OpenAI 兼容端点
  AI_API_KEY    密钥（.env，不提交 Git）
  AI_MODEL      deepseek-v41-flash

代码侧：

  LLMProvider（接口）
      ├── DeepSeekProvider     ← V1 使用
      └── CustomProvider       ← 内网迁移时新增（D13）
```

**注意：** 模型 id 的确切拼写未在文档中确认。
若上游实际标识不同（例如 `deepseek-v4-flash`），
只需改 `.env` 的 `AI_MODEL`，代码无需变动。
**这是把模型名放进环境变量的直接收益。**

### 10.3.3 D13 内网迁移的约束（现在就守）

因为要迁内网并换模型，以下四件事**必须在 V1 就做对**：

```text
1. 模型接口抽象
   → 业务层不得出现任何 DeepSeek 专有概念（参数名、错误码、字段）
   → 只依赖 LLMProvider 接口 + 标准化后的 ChatResult / ChatEvent

2. 不依赖公网
   → 运行时不得调用任何公网服务
   → 依赖安装期可以用镜像（registry.npmmirror.com）与 DeepSeek API，
     但这两者都属于「构建/配置期依赖」，不是运行时代码依赖

3. 密钥与地址可配
   → 禁止硬编码 base URL / api key / model 名
   → 全部经 config/ai.ts 读取

4. Prisma 环境自包含
   → 本机用 prisma dev；内网迁移时仅替换 DATABASE_URL 指向内网 PG
   → 因此代码中不得假定「数据库一定是 prisma dev 起的本地实例」
```

**待确认（不阻塞开发）：** 内网自研模型接口的协议
（OpenAI 兼容 / 私有协议 / 需要 SDK）。若为私有协议，
`CustomProvider` 内需额外做一层请求与响应格式转换。

---

# 11. 修订动作清单（已完成）

| 文档 | 修订内容 | 状态 |
| --- | --- | --- |
| `01-rpd.md` | 补充下发后不可改的明确规则；补充扶正路径；补充人工编辑器排期 | ✅ |
| `02-architecture.md` | 状态机增加撤回流转；补充 Prompt 编排层；`questionnaire_id` → `target_id` | ✅ |
| `03-...tool_calling .md` | Tool 状态校验、`target_id` 命名统一、section 嵌套范围（第 5A 节）、实例边界（第 23A 节）、Revision 粒度、幂等实现 | ✅ |
| `04-database_design.md` | `roles`、`source_type`/`source_instance_id`、`revision_no`、撤回字段、补 FK、幂等实现、Migration 顺序 | ✅ |
| `05-api_design.md` | withdraw / promote API、错误码、模板保存链路收敛、下发拦截 | ✅ |
| `06-proj_init.md` | 技术栈收敛为 Express + Prisma、`allowBuilds` 坑、`prisma dev`、开发顺序 | ✅ |
| `08-ai_agent_prompt_tool_calling.md` | 宏 Tool 降级为 Prompt 编排约定、Schema 对齐 03、目录对齐 06 | ✅ |

## 11.2 新增文档

| 文档 | 说明 |
| --- | --- |
| `08-ai_agent_prompt_tool_calling.md` | 原为 `07-ai_agent_prompt_tool_calling.md`，与本文档编号冲突，已改为 08 |
| `09-review-and-decisions.md` | 本文档，评审结论与决策记录 |

## 11.3 本次修订解决的跨文档冲突

| 冲突 | 原状 | 处理 |
| --- | --- | --- |
| Tool 层模型 | 03 用 7 个增量 Tool；08 用 3 个宏 Tool | **以 03 为准**，宏 Tool 降级为 Prompt 编排约定 |
| Schema 字段名 | 03 用 `title`/`Section.children`；08 用 `question`/`Question.children` | **以 03 为准** |
| 版本模型 | 04 用 Template Version + Revision 双轨；08 用单一 V1/V2 | **以 04 为准** |
| 目录结构 | 06 用 `src/modules/ai/`；08 用 `src/ai/` | **以 06 为准** |
| Tool 参数命名 | 03 用 `questionnaire_id`；05 用 `questionnaireId`；08 用 `currentQuestionnaire` | 统一为 **`target_id`**（snake_case，仅限 Tool 参数） |
| 模板保存链路 | 05 同时给出 versions 与 commit 两条路 | 收敛为：AI 走 commit，人工/扶正走 versions |
| 幂等实现 | 03 表述含糊，易实现成依赖 UNIQUE 报错 | 明确为**先查后插**，UNIQUE 仅兜底 |
| 冻结时机 | 多处写「确认后冻结」 | 明确**冻结点是下发**，`confirmed` 仍可改 |

---

# 12. 环境实测结果

本节记录在目标机器上**实际验证过**的结论，避免编码阶段踩坑。
