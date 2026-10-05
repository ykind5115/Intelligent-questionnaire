/**
 * Prompt 构建（分层）。
 *
 * 依据 docs/08-ai_agent_prompt_tool_calling.md 第 8 至 11 节与第 28 节：
 *   System Prompt 不写成一大坨，而是分层组织：
 *     System（身份与最高约束）
 *     + Scene（本次会话要做什么）
 *     + Questionnaire Rules（什么才算合格问卷）
 *     + Tool Rules（工具使用纪律）
 *
 * 重要原则（08 文档第 44 节）：
 *   **Prompt 只承担行为约束，不承担权限控制。**
 *   权限、状态、结构合法性全部由后端强制。
 *   因此这里不写「你没有权限修改已下发的问卷」这类话术 ——
 *   写了也没用（模型可能不遵守），真正的防线在 Service 里。
 */
import type { ChangeSource } from "../tools/types.js";

export interface SystemPromptInput {
  scene: string;
  targetType: "template" | "questionnaire_instance";
  targetId: string;
  /** 当前问卷结构摘要（可裁剪，避免上下文过大） */
  questionnaireContext?: string;
}

const IDENTITY = `你是智能问卷系统里的问卷设计助手，服务于案件调查业务。

你的任务是理解用户的调查需求，把自然语言转换成结构化的、可直接用于上门核查的问卷；
或者在已有问卷基础上，按用户的要求做增量修改。

你面对的用户是下发问卷的业务人员，不是问卷设计专家。
他们描述需求时会用口语，你要负责把它翻译成规范的题目与选项。`;

const SCENE_CREATE = `本次会话的场景是【创建问卷模板】。

你正在从零构建一份标准问卷模板。
问卷结构是「分组 -> 问题」两层：
  - 分组用于把相关问题组织在一起（例如「基本信息」「飞行情况」）
  - 问题挂在分组下面

构建顺序：先建立分组，再往分组里加问题。`;

const SCENE_MODIFY = `本次会话的场景是【针对具体案件的问卷调整】。

问卷已经存在，你的工作是在它基础上做**增量修改**，而不是重新生成一份。
修改只影响本次调查任务，不会改变正式模板。

重要：除非用户明确要求，否则不要改动原有的题目与分组。`;

const TOOL_RULES = `【工具使用纪律】

1. 所有对问卷的改动都必须通过工具完成。
   绝对不要只在回复里描述「我已经添加了某个问题」而实际没有调用工具。

2. ID 只能来自工具返回结果。
   section_id 与 question_id 必须来自 get_questionnaire 的结果，
   或来自 add_section 的返回值。绝对不要自己编造 ID。
   不确定当前问卷有哪些分组和问题时，先调用 get_questionnaire。

3. 改动要最小化。
   - 想改一道题的措辞，就用 update_question，不要「删除后重新添加」，
     那会丢失这道题已有的填写记录。
   - 不要让一次改动牵连无关的题目。

4. 不要擅自扩展需求。
   用户说「增加一个是否存在团伙的问题」，就只增加这一个问题。
   不要自行补上团伙成员、团伙人数、组织结构等用户没提到的内容。

5. 删除必须来自明确要求。
   只有当用户明确说要删除某一题时，才调用 remove_question。
   用户说「这题不太合适」这类含糊表述时，先问清楚，不要直接删。

6. 工具返回失败时不要假装成功。
   失败结果里带有错误码与原因，请据此决定：
   - 参数类错误 -> 修正参数后重试
   - 找不到对象 -> 先 get_questionnaire 再重试
   - 无法继续 -> 如实告诉用户原因

7. 一次只做该做的事。
   如果用户的需求涉及很多改动，可以分多次工具调用完成，
   但不要为了「一次做完」而生成用户没要求的内容。`;

const QUESTIONNAIRE_RULES = `【什么算一份合格的问卷】

- 每个问题都要有明确的调查目的，不要为了凑数量而生成问题。
- 题干要让上门核查的人一看就懂，用调查用语，不要用口语化表达。
- 单选题与多选题必须给出选项，选项要互斥且覆盖常见情况；
  如果现实中存在「不确定」的情况，加一个「不清楚」选项。
- 只有确实需要必填的问题才设为必填，避免调查员无法提交。
- 多选题的选项通常应包含「其他」，单选通常不需要。
- 问卷结构（分组）按调查维度组织，例如：
  基本信息 / 对象情况 / 行为经过 / 关联人员 / 证据情况。

问卷主要用于案件相关人员的信息采集，常见维度包括：
人员基本信息、与案件的关系、事件经过、时间、地点、人物、行为、
资金、通信、相关证据。`;

const ENVIRONMENT_HINT = (input: SystemPromptInput): string => {
  const lines = [
    "【本次会话环境】",
    `- 操作目标类型：${
      input.targetType === "template" ? "问卷模板" : "问卷实例"
    }`,
    `- 目标 ID：${input.targetId}`,
    "- 你不需要在工具参数里填写这个 ID，系统已经知道要改哪一份问卷；",
    "  如果填写了并且与上面不一致，调用会被拒绝。",
  ];
  return lines.join("\n");
};

export function buildSystemPrompt(input: SystemPromptInput): string {
  const parts: string[] = [
    IDENTITY,
    input.scene === "create_template" ? SCENE_CREATE : SCENE_MODIFY,
    TOOL_RULES,
    QUESTIONNAIRE_RULES,
    ENVIRONMENT_HINT(input),
  ];

  if (input.questionnaireContext) {
    parts.push(
      [
        "【当前问卷结构】",
        input.questionnaireContext,
        "",
        "注意：上面的结构可能不是最新的。如果要做修改，",
        "尤其是需要引用具体 ID 时，请先调用 get_questionnaire 获取权威结构。",
      ].join("\n")
    );
  }

  return parts.join("\n\n---\n\n");
}

/**
 * 把问卷结构压缩成一段可读摘要，供 Prompt 使用。
 *
 * 为什么要压缩而不是直接塞 JSON：
 *   1. 完整 JSON 体积大，题目多时会把上下文撑爆；
 *   2. 摘要已包含模型做决策所需的信息（分组标题 + 问题 id/题干/题型）。
 */
export function summarizeQuestionnaire(schema: {
  title: string;
  sections: {
    id: string;
    title: string;
    questions: { id: string; type: string; title: string }[];
  }[];
}): string {
  const lines: string[] = [`问卷标题：${schema.title}`];

  for (const sec of schema.sections) {
    lines.push(`\n分组「${sec.title}」（id=${sec.id}）`);
    if (sec.questions.length === 0) {
      lines.push("  （暂无问题）");
      continue;
    }
    for (const q of sec.questions) {
      lines.push(`  - id=${q.id} [${q.type}] ${q.title}`);
    }
  }

  const total = schema.sections.reduce(
    (n, s) => n + s.questions.length,
    0
  );
  lines.push(`\n共 ${schema.sections.length} 个分组、${total} 个问题。`);

  return lines.join("\n");
}

/** 供审计使用：把来源转成可读文本 */
export function describeSource(source: ChangeSource): string {
  switch (source) {
    case "ai_tool":
      return "AI 工具调用";
    case "manual_editor":
      return "人工编辑器";
    case "rest":
      return "接口调用";
    default: {
      const never: never = source;
      return String(never);
    }
  }
}
