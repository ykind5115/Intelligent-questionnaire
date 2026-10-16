# 11. 远期能力整合计划（条件分支 / 模板分类 / 任务台账）

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v1.2 |
| 编写日期 | 2026-10-15 |
| 状态 | **部分已实现**：L1（条件分支）未排期；L2 的四项已于 2026-10-15 落地（见 §5.0）。已定事项见 §7 |
| 决策依据 | [09-review-and-decisions.md](09-review-and-decisions.md) 决策 **D16** |
| 需求来源 | [文档一.md](文档一.md)、[问卷系统数据库设计文档.md](问卷系统数据库设计文档.md)、[问卷系统数据库模型图.html](问卷系统数据库模型图.html) |

---

## 1. 本文档的定位

`docs/` 下新增的三份文档提出了「模板/实例双套 DAG 邻接表」方案与配套的前端交互原型。
本文档把它们**整合成一条可执行的分阶段计划**，并明确哪些能力现有设计已经具备、
哪些是纯加法、哪些推迟。

三份来源文档的关系：

| 文档 | 性质 | 本文档如何使用 |
| --- | --- | --- |
| [文档一.md](文档一.md) | 前端交互原型文案（模板管理页 + 任务下发页） | 作为**交互需求**采纳，其界面部分归 [06-proj_init.md](06-proj_init.md) 前端排期 |
| [问卷系统数据库设计文档.md](问卷系统数据库设计文档.md) | 行式 DAG 存储方案提案 | 作为**远期备选实现**记录在 §5，不在当前阶段采用 |
| [问卷系统数据库模型图.html](问卷系统数据库模型图.html) | 上者的 ER 图 | 同上，保留作为 §5 的图示参考 |

> **编号说明**：`docs/` 已有 `01–10`，本文档顺延为 **11**，未插入已有编号。
> 本项目曾因编号冲突把 `07-ai_agent_prompt_tool_calling.md` 改为 `08`（见 09 第 11.2 节），
> 故新增文档一律顺延末尾，避免重演。

---

## 2. 整合原则（四条，均为 D16 的直接推论）

1. **不换表。** 问卷结构继续存 `questionnaire_instances.current_schema` /
   `questionnaire_template_versions.schema` 的 JSONB。行式 DAG 邻接表推迟。
2. **分支是纯加法。** 用显式实名字段 `branch` 加进结构，**不复用 `metadata`** ——
   Zod 的 `z.object` 默认剥离未知键，未声明的字段写入 JSONB 后读出来会被静默丢弃。
3. **API 契约不动。** `currentSchema` / `schema` / `schemaSnapshot` 三个 JSON 字段是对外契约，
   现有 12 个测试文件（另 1 个共享 helper）与前端 4 个页面依赖它。
   任何存储层改动都必须保留 `toSchema()` 投影。
4. **不采纳来源文档中两处能力倒退**（详见 §4.8）：
   答案对「当时问的是什么」的追溯链、以及模板版本唯一约束的正确形式。

---

## 3. 能力总表

| # | 能力 | 现有设计 | 阶段 | 是否动表 |
| --- | --- | --- | --- | --- |
| 1 | 条件分支 / 跳题 | ❌ 完全没有 | **L1** | 不动表（改 Zod schema） |
| 2 | 模板分类 `template_category` | ❌ 全仓无 `category` | L2 | 加 1 表 + 1 列 |
| 3 | 任务业务字段（核查对象/时间/核查人） | ⚠️ 只有 `subject_info` JSONB | L2 | 加 1 表（或先扩 Zod） |
| 4 | `instance_no` 可读编号 | ❌ 只有 UUID | L2 | 加 1 列 |
| 5 | `answer_trace` 答题轨迹 | ❌ 无 | L2 | 加 1 表 |
| 6 | 模板/实例交互语义隔离 | ✅ 已有 promote（D2） | 免开发 | — |
| 7 | 实例结构隔离、下发冻结 | ✅ 已有（D1） | 免开发 | — |
| 8 | 模板版本管理 | ✅ 已有，比来源文档更完整 | 免开发 | — |
| 9 | 行式 DAG 邻接表 | — | **L3（触发式）** | 需 `toSchema()` 投影 |

**结论：L1 + L2 全部是加法或纯代码改动，L3 只在出现图分析需求时触发。**

---

## 4. L1：条件分支 / 跳题

### 4.1 为什么它排第一

来源文档的核心诉求就是分支：`文档一.md` 的 DAG 编辑器、`condition` 配置、
「有环直接提示，禁止保存草稿」，以及 `问卷系统数据库设计文档.md` §7.4 的环检测。
这是三份文档里**唯一现有设计完全没有**的能力，其余都是加列加表。

### 4.2 结构设计（向后兼容）

新增两个**可选**字段。`QuestionnaireSchema` 的存量数据没有它们，解析后等价于「顺序执行」，
因此**无需数据迁移**：

```jsonc
{
  "id": "q_002",
  "type": "boolean",
  "title": "是否进行过飞行？",
  "order": 2,
  "required": true,

  // 本题作答后按顺序取第一条命中的规则
  "branches": [
    { "when": { "op": "eq", "value": true }, "goTo": "q_004" }
  ],

  // 都不命中时去哪一题；null = 本题为终点，问卷在此结束
  "defaultNext": null
}
```

- `branch` 单数形式不采用：一个题目需要多条规则，且「都不命中」是第三种情况，
  单对象会把它压缩成 `elseGoTo` 一个字段，反而不好扩展。
- `goTo` / `defaultNext` 引用的是**同一份结构内的 `question.id`**（如 `q_004`），
  不是数据库 id。这与现有 `questionnaire_answers.question_id` 的用法一致，
  也让分支规则在模板与实例之间复制时天然可用（现有实现刻意保持题目短 id 稳定）。

### 4.3 比较操作符白名单（V1 只做可枚举的）

| `op` | 语义 | 适用题型 |
| --- | --- | --- |
| `eq` | 等于 | 单选题、布尔、数字、文本 |
| `ne` | 不等于 | 同上 |
| `in` | 属于集合 | 多选题 |
| `not_in` | 不属于集合 | 多选题 |
| `is_answered` | 已作答 | 全部 |
| `is_empty` | 未作答 | 全部 |

**明确不做**：任意表达式、动态计算题、跨题公式、多层级联动。
`01-rpd.md` §17.2 把这些列为「高级问卷逻辑」，与复杂分支分开，本文档不做承诺。

### 4.4 顺序语义（三条规则，必须写死）

分支与「题目 `order`」是两套顺序，必须定义它们如何相互作用：

1. **入口**：取 `order` 最小的题目。
2. **推进**：当前题若命中分支规则 → 跳 `goTo`；否则若 `defaultNext` 有值 → 跳它；
   否则 → **按 `order` 取下一题**；已无下一题 → 问卷结束。
3. **分组归属**：跳到某题时，其所属 section 一并显示。
   `Section.children` 在 V1 仍禁用（03 第 5A 节），故只需处理一层。

> 规则 2 的第三分支是「向后兼容」的关键：存量问卷没有任何分支字段，
> 一律走「按 order 取下一题」，行为与今天完全一致。

### 4.5 新增纯函数 `resolveFlow`

放在 `src/modules/questionnaire/operations/` 下，遵守 Operation 层约定
（纯函数、不碰数据库、不读时钟、不生成随机数）：

```ts
resolveFlow(
  schema: QuestionnaireSchema,
  answers: Readonly<Record<string, unknown>>,
  opts?: { maxSteps?: number }
): FlowStep[]

// FlowStep = { questionId, sectionId, order, matched: "rule" | "default" | "fallthrough" | "entry" }
```

**为什么必须由它统一计算**：目前「按什么顺序取题」散落在 `response.service.ts` 的两处
`orderBy: { questionId: "asc" }`（字典序，分支下会乱序）与 `collectQuestions` 的简单展平。
分支上线后这些位置必须都改成走 `resolveFlow`，否则会出现「跳题跳了、但回显顺序还是旧的」。

**末尾题目处理**：`defaultNext` 为 `null` 表示本题为终点。
需要校验：**存在至少一个可达终点**，否则问卷无法结束。

### 4.6 环检测的准确表述

`问卷系统数据库设计文档.md` §7.4 用「新边是否形成环」判定。在跳转指针模型下，
必须区分两种环：

- **多路径汇聚到同一题**：完全合法，DAG 允许。**不能拒绝**。
- **真正无终点的环**（如 `q2 → q3 → q2` 且无出口）：必须拒绝。

因此判据不是「有没有环」，而是「**从入口出发，每条路径是否都能到达终点**」。
实现做法：DFS 全部路径并设 `maxSteps` 上限（如 `题目总数 × 2 + 8`），
超限即判定为无法收敛 —— 这样既拦住真环，又不误杀汇聚。

### 4.7 校验规则的落点

| 校验 | 内容 | 错误处理 |
| --- | --- | --- |
| V1 | `goTo` / `defaultNext` 指向的题目必须存在 | 拒绝写入（悬空引用） |
| V2 | 每条路径都能到达终点（§4.6） | 拒绝写入 |
| V3 | `when.op` 必须在白名单内，`value` 类型与该题题型相容 | 拒绝写入 |
| V4 | 至少有一个可达终点 | 拒绝写入 |
| V5 | 从入口出发不可达的题目 | **告警**，不拒绝（编辑中允许中间态） |

V1–V4 放进 `questionnaireSchema` 的 `superRefine`，由既有的 `assertValidSchema`
在每次 Operation 后自动执行 —— **这是本方案最省力的地方**：校验不需要新增调用点。

### 4.8 必须避开的两处能力倒退

来源文档有两处设计会**削弱**现有能力，整合时明确不采纳：

1. **答案的追溯链。** 来源文档的 `questionnaire_answer_detail` 只绑
   `instance_node_id`，且其伪代码在编辑草稿时 `DELETE FROM instance_node`（第 166-167 行）。
   节点一删，历史答案即成孤儿。
   **保留现有做法**：`questionnaire_revisions.schema_snapshot` 不可变快照 +
   `questionnaire_answers.revision_no`（04 第 27.3 节）。

2. **模板版本唯一约束。** 来源文档写 `UNIQUE (category_id, version)`，
   会导致「同一分类下只能存在一个 v1 模板」。
   **保留现有**：`UNIQUE (template_id, version_no)`。

### 4.9 实施步骤（顺序即依赖顺序）

| 步 | 内容 | 涉及文件 |
| --- | --- | --- |
| 1 | 结构 schema 加 `branches` / `defaultNext` + 操作符白名单 | `src/modules/questionnaire/schema/questionnaire.schema.ts` |
| 2 | 新增纯函数 `resolveFlow` 与环判定 | `src/modules/questionnaire/operations/resolve-flow.ts`（新） |
| 3 | 删除题目时增加悬空引用检查 | `src/modules/questionnaire/operations/remove-question.ts` |
| 4 | 增加设置分支的 Operation（纯函数） | `src/modules/questionnaire/operations/set-question-branch.ts`（新） |
| 5 | 接上写操作联合类型与 Tool | `operations/types.ts`、`operations/index.ts`、`ai/tools/questionnaire.tools.ts`、`ai/tools/tool-registry.ts` |
| 6 | `response.service.ts` 改用 `resolveFlow` 定序（替换两处字典序排序） | `src/modules/response/service/response.service.ts` |
| 7 | 提交时的必填校验改为**只校验路径内题目** | 同上 |
| 8 | 分支的编辑入口（API + 前端） | 见 §4.11（前端为独立工作项，可排在 L1 后端之后） |

**第 3 步的必要性**：`remove-question.ts:42` 现在只做 `splice` + `renumberQuestions`，
不检查有没有别的题跳向它。分支上线后，删掉被引用的题会留下悬空 `goTo`。
`helpers.ts:129` 已有 `questionIdExists`，接上即可。
**倾向于「拒绝并返回冲突」而不是「级联清理其他题的分支」** ——
级联会静默改掉用户没打算改的题目，与决策 D1「结构变更必须显式」的精神一致。

**第 7 步的必要性**：`response.service.ts:707-727` 现在是
`collectQuestions(schema).filter(q => q.required)` **无条件求值** ——
平铺取全部必填题。分支下，未被跳转路径经过的必填题不应阻塞提交。

### 4.10 验收标准

- 全部**现有测试不得退化**（受影响范围：**12 个测试文件共 243 个 `it()`**，
  加 1 个共享 helper `tests/integration/questionnaire/helpers.ts`；全仓 16 个测试文件）。
- 新增单元测试（`resolveFlow` 纯函数，不连库）：
  1. 无分支字段的存量结构 → 顺序与今天一致（**向后兼容回归**）
  2. 命中分支跳转
  3. `defaultNext` 生效
  4. 多路径汇聚到同一题 → 允许
  5. `q2 → q3 → q2` 无出口 → 判定失败
  6. 悬空 `goTo` → 拒绝
  7. 不可达题目 → 告警但不拒绝
- 新增集成测试：在草稿实例上设分支 → 下发 → 填写 → 跳题 → 提交（必填只校验路径内）。
- 新增分支字段后，`questionnaire_revisions` 的快照与 `current_revision` 递增行为不变。

### 4.11 前端：拖拽式分支编辑器（已确认要做）

**已确认**：需要前端编辑功能，且**倾向拖拽式**（与 `文档一.md` 第 15、44 行的
「问卷 DAG 编辑器（题目节点、分支跳转连线、条件配置）」一致）。

**现状（决定了工作量）**：`public/` 下**没有任何编辑器**。
`create.js:206`、`templates.js:307`、`instances.js:280`/`:377` 四处都是
**只读的两级列表**（section → question），共用 `common.js:289` 的 `countSchema`。
连「答卷填写页」都还没有（AGENT.md 第 7 节）。所以这不是「给编辑器加个功能」，
而是**从零做一个编辑器**。

**技术约束**：前端**无构建链**，是原生 ES 模块
（AGENT.md 第 7 节：`<script type="module">` 直接加载）。
这决定了拖拽实现只有两条路：

| 方案 | 说明 | 取舍 |
| --- | --- | --- |
| **自研（原生 Pointer Events）** | 用 `pointerdown/move/up` + 绝对定位 + SVG 画连线 | 无依赖、与应用风格一致；但要自己处理命中检测、吸附、缩放、触摸 |
| 引入图形库 | 如 AntV X6 / GoJS / React Flow | React Flow 需要 React + 构建链，与现状冲突；X6 可 CDN 引入但体积大、风格要重做 |

**建议分期，不要一次做成完整 DAG 画布**：

1. **4.11.1 阶段一（先做）：表单式分支编辑。**
   每题下方一行「如果…→ 跳到 [下拉选择题目]」+「+ 添加条件」。
   后端只需 §4.9 的第 1、4、5 步。**能立刻用起来，且不阻塞后端 L1。**
2. **4.11.2 阶段二：列表 + 可视化预览。**
   保留表单编辑，另加一个只读的 DAG 缩略图（SVG，复用 `resolveFlow` 的输出），
   让人一眼看出跳转走向。**这一步风险低、收益高。**
3. **4.11.3 阶段三：拖拽画布。**
   在阶段二的基础上把预览图变成可拖拽编辑（节点拖动 + 拉线建分支）。

**为什么这样分期**：拖拽画布是三者中唯一「做错了要全部重做」的部分，
而它的技术风险（无构建链下自研图形交互）与业务收益不成正比 ——
分支规则本身用表单就能完整表达。先让业务用起来，再决定要不要为体验付费。

**编辑器必须处理的交互细节**（无论哪个阶段）：

| # | 细节 | 理由 |
| --- | --- | --- |
| 1 | 删除被引用的题目时，**阻断并列出引用者** | 对应 §4.9 第 3 步；不能静默级联改别的题 |
| 2 | 环/无终点的即时提示 | `文档一.md` 第 45 行要求「实时自动校验，有环直接提示，禁止保存草稿」 |
| 3 | 不可达题目**告警但不阻断** | 对应 §4.7 的 V5 |
| 4 | 明显区分「改本次实例」与「改通用模板」 | `文档一.md` 第 4、37-39、57-60 行的核心诉求：防止运营误覆盖基准模板 |
| 5 | 分支条件只能用**已存在的题目 id**，不接受手输 | 避免制造悬空引用 |

> 第 4 条是 `文档一.md` 全篇的重点，且现有后端已具备对应能力：
> 「另存为新模板」= `promoteToTemplate`（决策 D2），
> 「更新原模板」= 同模板 `versionNo+1` 草稿版本（需再 publish）。
> **前端只需把这两个动作的语义差异在文案和按钮样式上做足，不需要新后端接口。**

---

## 5. L2：加表/加列类能力（相互独立，可分别上线）

### 5.0 本次已实现（2026-10-15）

本轮落地了 §5.1 / §5.2 / §5.3 与实例标题问题，**全部是加法，未改动任何既有表语义**：

| 项 | 内容 | 数据库变更 |
| --- | --- | --- |
| 模板分类 | 新表 + `templates.category_id` + 按分类筛选 + 模板增删改分类 | 新表 `questionnaire_template_categories` |
| 任务业务字段 | `subject_info` 从 `z.record` 改为**显式 Schema**（已知字段 + 保留未知字段） | 无（仅校验层） |
| 实例可读编号 | `instance_no`，格式 `INS-YYYYMMDD-NNNN`，按天发号 | 新列 + 新表 `instance_no_counters` |
| 实例标题 | 建案页不再预填「模板名 + 日期」，改用模板名并聚焦等待补全 | 无（仅前端） |

**迁移**：`prisma/migrations/20261015120000_add_categories_and_instance_no`
（已在本机库执行，7 个模板 / 13 个实例 / 17 条 revision 数据完好）。

**新增接口**：

```text
GET    /api/v1/questionnaire-template-categories        列出分类（任意已鉴权用户）
POST   /api/v1/questionnaire-template-categories        新建分类（template_admin）
PATCH  /api/v1/questionnaire-template-categories/:id    改名称/描述（不接受改 code）
DELETE /api/v1/questionnaire-template-categories/:id    删除（仍被模板引用时拒绝）

GET    /api/v1/questionnaire-templates?categoryId=...   模板列表按分类筛选
POST   /api/v1/questionnaire-templates                  body 支持 categoryId
PATCH  /api/v1/questionnaire-templates/:id              body 支持 categoryId（null = 清空）
```

**已知未做（有意留到后续）**：
- 分类的**新增/改名/删除只能走接口**，没有界面（模板页有下拉可选，但建不了新分类）；
- 实例标题仍**不强制**唯一或非默认值，只是去掉了「看起来像填好了」的时间戳默认值；
- 存量 13 个实例的 `instance_no` 为空（未回填，前端显示「—」）。

### 5.1 模板分类（来源明确要求，但优先级低，有触发条件）

> **已实现。** 下表保留当初「为什么优先级低」的判断依据，以及触发条件 ——
> 分类表本身不贵，但**要不要往分类里放内容**仍取决于模板数量是否真的变多。

**来源依据（确认过原文，不是本文档自创的需求）**：
`文档一.md:10` 把「模板分类」列为模板管理页的列表字段，`:54` 要求「另存为新模板」时
「输入模板名称、**选择分类**」；`问卷系统数据库设计文档.md:112` 给出完整的
`questionnaire_template_category` 表定义，`:159` 附带 `UNIQUE (category_id, version)`。

- 新增 `questionnaire_template_categories`：`id`(uuid) / `code`(unique) / `name` / `description` / 时间戳。
- `questionnaire_templates` 加 `category_id`（可空起步，避免存量 7 个模板被卡住）。
- 约束用 `UNIQUE (template_id, version_no)`（现有），**不用** `(category_id, version)`。
- 前端：`public/templates.html` 加分类筛选；`dispatch.js` 的下拉按分类分组。

**为什么不急 —— 库内实测（2026-10-15，7 个模板）：**

| 模板名 | 状态 | 版本 | 派生实例 |
| --- | --- | --- | --- |
| 无人机黑飞核查问卷 | published | v1 | 2 |
| 宠物饲养规范核查问卷 | published | v1 | 2 |
| Tailscale使用体验 | published | v1 | 3 |
| AI 新建问卷 2026-10-09 16:32 | draft | v1 | 0 |
| AI 新建问卷 2026-10-13 09:51 | published | v1, v2 | 2 |
| AI 新建问卷 2026-10-13 10:01 | published | v1 | 4 |
| AI 新建问卷 2026-10-13 10:41 | draft | v1 | 0 |

**7 个模板里只有 3 个有业务含义的名字，另外 4 个是「AI 新建问卷 + 时间戳」且描述为空。**

来源文档的分类语义是**业务域**（`drone_check` 这类 `category_code`，见
`问卷系统数据库设计文档.md:119`），而那 4 个 AI 自动创建的模板**会同属一个业务域**，
加 `category` 依然区分不开它们 ——
而模板命名这个看似更急的问题，核实后**已经解决**（见下方订正）。
所以分类本身没错，只是现在还不是瓶颈 —— 缺的不是分类，而是**模板数量还不够多**。

**触发条件（决定何时才值得往里填分类）：**
1. 有业务含义的模板数 > 10，下拉选择开始靠眼力筛选；
2. 出现「按业务类型统计模板使用情况」的需求；
3. 需要按分类控制可见性（某类模板只对某些角色开放）—— 这属于权限功能，不是分类本身。

在触发之前，分类表只会增加维护成本（每个模板发布都要选分类）而收益不明显。

**关于那 4 个时间戳模板 —— 是历史数据，不是待改进项（核实后订正）**：

`public/create.js:51-85` 已经有完整的「先取名」流程：先弹窗要求输入问卷名称，
再以 `templateName: name` 创建会话（代码注释：「关键：名字在创建的那一刻就确定」）。
后端 `ai-conversation.service.ts:257-269` 也优先取调用方给的名字，
`AI 新建问卷 ${formatLocalTimestamp(...)}` 只是兜底占位名。

**数据也印证该流程已生效**：4 个时间戳模板都创建于 2026-10-09 / 10-13，而后建的
「Tailscale使用体验」有正常名字。所以这 4 条只是**该流程加上之前留下的旧数据**，
不需要新开发；建议的清理动作是「人工改名或归档」，属日常运营，不属于任何阶段。

**唯一仍然缺省的是实例标题**：13 个实例里大量是 `新案件 - <时间戳>`，甚至 `111`。
建案流程（`public/dispatch.js`）不像建模板那样强制取名。这是真实存在的缺口，
但影响面小，可在 L2 顺手处理。

### 5.2 任务业务字段

来源文档要求「核查对象、核查时间、核查人」等**固定可查**的业务字段。
现有 `questionnaire_instances.subject_info` 是 JSONB，结构随业务可变但**不可按字段查询**。

| 方案 | 说明 |
| --- | --- |
| **先扩 Zod（推荐）** | 给 `subject_info` 定义明确的 Zod schema（核查对象/时间/核查人），保持 JSONB 的灵活性 |
| 再拆表 | 当出现「按核查对象检索任务」「按核查时间统计」需求时，拆出 `inspection_tasks` 表 |

来源文档的 `inspection_task.status`（`pending/doing/done`）**建议不采纳为流转控制字段**：
现有已有实例状态机（8 个状态）+ `dispatch_tasks.status`（4 个状态），
再加一套会造成三者打架；若确需，只作为**纯业务台账字段**，不参与状态机校验。

### 5.3 `instance_no` 可读编号

- 格式建议 `INS-YYYYMMDD-####`，日序号 4 位补零。
- 唯一约束 + 事务内生成；**不要用 count+1**（并发会撞号），用当天最大值 + 行锁。
- 存量 13 个实例需回填，回填规则按 `created_at` 排序生成。

### 5.4 `answer_trace` 答题轨迹

- 字段对齐来源文档：`answer_id` / `instance_node_id` / `action`(`enter`/`skip`/`jump`) /
  `next_node_id` / `trigger_at`。
- 用途：回放、审计、分支规则调优。
- **依赖 L1 的分支能力**，故排在 L1 之后。若 L1 未落地则无 `skip`/`jump` 可言。

---

## 6. L3：行式 DAG 邻接表（触发式，非当前计划）

**触发条件**：出现 §6 类图分析需求 —— 跨问卷题目统计、题库、题目复用、题目版本。
`04-database_design.md` 第 50 节已把「题目统计 / 跨问卷题目分析」与「复杂条件逻辑」并列，
但它们**不会单独到来**：分支能力用 §4 的 JSON 方案即可满足，
真正逼出拆表的是**统计**。

**若触发，必须遵守**：

1. **保留 `toSchema()` 投影。** 在 Service 边界把行式表组装回现有 JSON 树形状，
   作为**唯一**转换点。这样 API 契约不变，12 个测试文件 243 个用例（另 1 个共享 helper）
   与前端 4 个页面都不受影响。
2. **迁移源用 `questionnaire_revisions.schema_snapshot`。** 它是自包含的完整历史快照
   （实测 17 份），可原样回放成 DAG，历史审计不丢。实例侧用 `current_schema`。
3. **保留 `revision_no` 追溯语义**（同 §4.8 第 1 点）。
4. **主键类型要统一考虑。** 来源文档用 `BIGSERIAL`，而现有全库是 `uuid`
   （`users.id` 是 uuid，鉴权与授权全按 uuid）。混用会带来额外转换成本。
5. **正确约束是 `UNIQUE (template_id, version_no)`**，不是 `(category_id, version)`。

---

## 7. 已定事项（2026-10-15 拍板）

| # | 问题 | 结论 | 影响 |
| --- | --- | --- | --- |
| 1 | L1 是否列入当前版本？ | **不列入**。只需在**后续版本**实现，当前版本不动 | L1 只保留本计划，不排期、不写代码 |
| 2 | 「更新原模板」是否需要立即生效？ | **暂不处理**。维持现状（`promoteToTemplate` 生成 draft 新版本，需再 publish） | 不改 `questionnaire.service.ts` |
| 3 | `inspection_task` 是否独立成表？ | **按 §5.2 建议**：先扩 `subject_info` 的 Zod schema，不拆表；且**不新增流转状态**（`inspection_task.status` 不采纳为状态机字段） | 见 §5.2 |
| 4 | 分支编辑入口是否要做？ | **要做**，前端需新增编辑功能，**倾向拖拽式** | 新增 §4.11，仍需排期 |
| 5 | 模板分类是否必要？ | **来源明确要求，但优先级低**。库内只有 7 个模板（3 个有业务名），量还不够大；已给出触发条件（见 §5.1） | 暂不实现，触发后再做 |

| 6 | 本轮（2026-10-15）做了哪些？ | **L2 的四项已落地**：模板分类、`subject_info` 显式 Schema、`instance_no` 可读编号、建案标题不再用时间戳默认值。详见 §5.0 | 迁移 `20261015120000_add_categories_and_instance_no` 已在本机库执行 |
> 来源文档 `文档一.md` 第 47 节写「页面底部按钮（3 个）」但实际列出 4 个（含【取消】），
> 属笔误，实现时按 4 个处理。

## 8. 与既有文档的关系

| 文档 | 关系 |
| --- | --- |
| [09-review-and-decisions.md](09-review-and-decisions.md) | **权威**。本文档所有取舍的裁决依据是 D16；冲突时以 09 为准 |
| [01-rpd.md](01-rpd.md) | §17.2「高级问卷逻辑」/ §21「V2 更强的条件分支」是本文档 §4 的上游需求 |
| [03-questionnaire_schema_ai_tool_calling .md](03-questionnaire_schema_ai_tool_calling%20.md) | 第 48 节 7 个 Tool、第 49 节把 `conditional_logic` 列为「暂不进入 V1」；本文档 §4.9 第 5 步即把它转为 V1 之后的第 8 个 Tool |
| [04-database_design.md](04-database_design.md) | 第 50 节给出「JSONB → 混合 → 拆分」的演进路线，是本文档 §5/§6 的依据 |
| [06-proj_init.md](06-proj_init.md) | 前端排期与页面清单；`文档一.md` 的界面需求归此文档 |
| [10-database-reference.md](10-database-reference.md) | 字段级速查。本文档 §5 加表加列时须同步更新 |

---

## 9. 本文档明确不做的事

- ❌ 不在当前阶段把结构改成行式 DAG 表（D16）
- ❌ 不引入新的测试/格式化工具链（测试栈固定为 Vitest；仓库 lint/format 脚本目前是坏的，
  见 AGENT.md 第 2 节，本计划不顺手修它）
- ❌ 不做任意条件表达式、动态计算题、多层级联动（`01` §17.2 归为高级逻辑）
- ❌ 不新增状态维度（不采纳来源文档的 `inspection_task.status` 作为流转控制）
- ❌ 不承诺 L1/L2/L3 的排期 —— L1 已明确**不列入当前版本**，只待后续版本安排（§7 第 1 项）

---

## 附：本计划涉及的文件清单

**将新增**

```text
src/modules/questionnaire/operations/resolve-flow.ts
src/modules/questionnaire/operations/set-question-branch.ts
docs/11-future-capability-plan.md          ← 本文档
```

**将修改（L1）**

```text
src/modules/questionnaire/schema/questionnaire.schema.ts
src/modules/questionnaire/operations/remove-question.ts
src/modules/questionnaire/operations/types.ts
src/modules/questionnaire/operations/index.ts
src/modules/ai/tools/questionnaire.tools.ts
src/modules/ai/tools/tool-registry.ts
src/modules/response/service/response.service.ts
```

**将修改（L2，各自独立）**

```text
prisma/schema.prisma  + 新迁移
src/modules/questionnaire/repository/questionnaire.repository.ts
src/modules/questionnaire/service/template.service.ts
src/modules/questionnaire/service/questionnaire.service.ts
public/templates.js / public/dispatch.js / public/common.js
docs/10-database-reference.md
```

**将新增（§4.11 前端分支编辑器，独立工作项）**

```text
public/editor-flow.js           ← 分支条件表单 + DAG 预览/拖拽（分期，见 §4.11）
public/editor.html             ← 若有独立页面需求
src/modules/questionnaire/controller/editor.controller.ts  ← 复用既有编辑器路由，按需扩展
```
