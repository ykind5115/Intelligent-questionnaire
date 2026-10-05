/**
 * 7 个增量 Tool。
 *
 * 依据 docs/03-questionnaire_schema_ai_tool_calling .md 第 48 节：
 *   V1 只有这 7 个工具，不存在「一次生成整份问卷」的宏工具。
 *
 * 设计约束：
 *   1. 每个 Tool 都是薄适配层：校验参数 → 转成 Operation → 调 Service，
 *      真正的业务逻辑（权限、状态、事务、Revision、审计）全在 Service 里；
 *   2. description 是发给模型的 Prompt 的一部分，
 *      必须写清「何时用/何时不用」与「ID 从哪来」；
 *   3. 参数是 snake_case，服务层是 camelCase，转换只在这里发生。
 */
import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { toolSuccess, toServiceContext } from "./types.js";
import {
  assertInstanceScene,
  optionInputSchema,
  questionTypeSchema,
  resolveTargetId,
  targetIdSchema,
  toToolResult,
} from "./shared.js";
import type { OperationPayload } from "../../questionnaire/service/questionnaire.service.js";

/**
 * 构造 Tool，并保留 Zod schema 的类型推断。
 *
 * 为什么需要它：如果直接写 `const t: ToolDefinition = { ... }`，
 * 泛型会退回默认的 `z.ZodTypeAny`，导致 execute 的 input 变成 unknown。
 * 用这个工厂，input 的类型由各自传入的 inputSchema 精确推导出来。
 */
function makeTool<T extends z.ZodTypeAny, R>(
  def: ToolDefinition<T, R>
): ToolDefinition<T, R> {
  return def;
}

/** 把 payload 应用到实例并返回统一结果（写类工具的公共收尾） */
async function applyWrite(
  payload: OperationPayload,
  context: Parameters<ToolDefinition["execute"]>[1],
  deps: Parameters<ToolDefinition["execute"]>[2],
  targetId: string
) {
  const result = await deps.service.applyToInstance(
    targetId,
    payload,
    {
      ...toServiceContext(context),
      auditToolName: payload.name,
    }
  );

  return toolSuccess(result.details, context.operationId, result.revision);
}

// ============================================================
// 读取类
// ============================================================

export const getQuestionnaireTool = makeTool({
  name: "get_questionnaire",
  mutates: false,
  description:
    "读取当前问卷的完整结构（分组与问题，含每个节点的 id）。" +
    "当你不确定当前问卷有哪些分组、某个问题的 id、或用户提到的题目对应哪一项时，先调用本工具，" +
    "不要凭记忆或猜测回答，也不要编造 id。",
  inputSchema: z.object({ target_id: targetIdSchema }),

  async execute(input, context, deps) {
    try {
      const targetId = resolveTargetId(input.target_id, context);
      const instance = await deps.service.getInstance(
        targetId,
        toServiceContext(context)
      );

      // 读取类也要留痕：便于复盘「模型当时看到的是哪一版结构」
      try {
        await deps.service.recordReadAudit(targetId, {
          ...toServiceContext(context),
          auditToolName: "get_questionnaire",
        }, { revision: instance.currentRevision });
      } catch {
        // 审计失败不应影响读取结果
      }

      return toolSuccess(
        {
          questionnaire: instance.currentSchema,
          revision: instance.currentRevision,
          status: instance.status,
        },
        context.operationId,
        instance.currentRevision
      );
    } catch (error) {
      return toToolResult(error, context.operationId);
    }
  },
});

// ============================================================
// 写入类：分组
// ============================================================

export const addSectionTool = makeTool({
  name: "add_section",
  mutates: true,
  description:
    "在问卷中新增一个分组（section）。分组是一级结构，不能嵌套。" +
    "当用户要求「增加一个模块 / 增加一个部分」时使用。" +
    "返回新分组的 id，后续向该分组加问题时必须使用这个 id。",
  inputSchema: z.object({
    target_id: targetIdSchema,
    title: z.string().min(1).max(200).describe("分组标题，例如「团伙关系调查」"),
    description: z
      .string()
      .optional()
      .describe("分组说明，一般不需要填"),
  }),

  async execute(input, context, deps) {
    try {
      assertInstanceScene(context);
      const targetId = resolveTargetId(input.target_id, context);
      return await applyWrite(
        {
          name: "add_section",
          input: {
            title: input.title,
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
          },
        },
        context,
        deps,
        targetId
      );
    } catch (error) {
      return toToolResult(error, context.operationId);
    }
  },
});

export const updateSectionTool = makeTool({
  name: "update_section",
  mutates: true,
  description:
    "修改已有分组的标题或说明。只修改传入的字段，其余保持不变。" +
    "当用户要求「把某某部分改名为……」时使用。" +
    "需要分组的 id：如果不知道，先调用 get_questionnaire。",
  inputSchema: z.object({
    target_id: targetIdSchema,
    section_id: z.string().min(1).describe("要修改的分组 id"),
    title: z.string().min(1).max(200).optional().describe("新的分组标题"),
    description: z.string().optional().describe("新的分组说明"),
  }),

  async execute(input, context, deps) {
    try {
      assertInstanceScene(context);
      const targetId = resolveTargetId(input.target_id, context);
      return await applyWrite(
        {
          name: "update_section",
          input: {
            sectionId: input.section_id,
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
          },
        },
        context,
        deps,
        targetId
      );
    } catch (error) {
      return toToolResult(error, context.operationId);
    }
  },
});

// ============================================================
// 写入类：问题
// ============================================================

export const addQuestionTool = makeTool({
  name: "add_question",
  mutates: true,
  description:
    "向指定分组新增一个问题。返回新问题的 id。" +
    "section_id 必须来自 get_questionnaire 的结果或 add_section 的返回值，" +
    "绝对不要自己编造 id。" +
    "只添加用户要求的那一个问题，不要自行扩展出一组相关问题。",
  inputSchema: z.object({
    target_id: targetIdSchema,
    section_id: z.string().min(1).describe("目标分组 id"),
    type: questionTypeSchema,
    title: z.string().min(1).max(500).describe("题干"),
    description: z.string().optional().describe("题目说明或填写提示"),
    required: z.boolean().optional().describe("是否必填，默认否"),
    options: z
      .array(optionInputSchema)
      .optional()
      .describe("选项，仅单选题与多选题需要，至少 2 个且不可重复"),
  }),

  async execute(input, context, deps) {
    try {
      assertInstanceScene(context);
      const targetId = resolveTargetId(input.target_id, context);
      return await applyWrite(
        {
          name: "add_question",
          input: {
            sectionId: input.section_id,
            type: input.type,
            title: input.title,
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
            ...(input.required !== undefined
              ? { required: input.required }
              : {}),
            ...(input.options !== undefined ? { options: input.options } : {}),
          },
        },
        context,
        deps,
        targetId
      );
    } catch (error) {
      return toToolResult(error, context.operationId);
    }
  },
});

export const updateQuestionTool = makeTool({
  name: "update_question",
  mutates: true,
  description:
    "修改已有问题。只修改传入的字段，未传的字段保持不变。" +
    "当用户要求「把某题措辞改成……」「这题改为必填」「这题换成多选题」时使用。" +
    "question_id 必须来自 get_questionnaire 的结果，绝对不要自己编造 id。" +
    "不要用「先删除再新增」的方式改题，那会丢失该题已有的填写记录。" +
    "注意：把题型改成单选/多选时必须同时提供 options。",
  inputSchema: z.object({
    target_id: targetIdSchema,
    question_id: z.string().min(1).describe("要修改的问题 id"),
    title: z.string().min(1).max(500).optional().describe("新的题干"),
    description: z.string().optional().describe("新的题目说明"),
    type: questionTypeSchema.optional().describe("新的题型"),
    required: z.boolean().optional().describe("是否必填"),
    options: z
      .array(optionInputSchema)
      .optional()
      .describe("新的选项列表，传了就会整体替换原有选项"),
  }),

  async execute(input, context, deps) {
    try {
      assertInstanceScene(context);
      const targetId = resolveTargetId(input.target_id, context);
      return await applyWrite(
        {
          name: "update_question",
          input: {
            questionId: input.question_id,
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
            ...(input.type !== undefined ? { type: input.type } : {}),
            ...(input.required !== undefined
              ? { required: input.required }
              : {}),
            ...(input.options !== undefined ? { options: input.options } : {}),
          },
        },
        context,
        deps,
        targetId
      );
    } catch (error) {
      return toToolResult(error, context.operationId);
    }
  },
});

export const removeQuestionTool = makeTool({
  name: "remove_question",
  mutates: true,
  description:
    "删除一个问题。⚠️ 危险操作：只在用户**明确要求删除**某一题时调用。" +
    "绝对不要为了「精简问卷」「优化结构」而自行删除任何问题。" +
    "如果用户的意思含糊（例如「这题不太合适」），应先询问确认，不要直接删除。",
  inputSchema: z.object({
    target_id: targetIdSchema,
    question_id: z.string().min(1).describe("要删除的问题 id"),
  }),

  async execute(input, context, deps) {
    try {
      assertInstanceScene(context);
      const targetId = resolveTargetId(input.target_id, context);
      return await applyWrite(
        {
          name: "remove_question",
          input: { questionId: input.question_id },
        },
        context,
        deps,
        targetId
      );
    } catch (error) {
      return toToolResult(error, context.operationId);
    }
  },
});

export const moveQuestionTool = makeTool({
  name: "move_question",
  mutates: true,
  description:
    "把一个问题移动到另一个分组，或在同一分组内调整顺序。" +
    "当用户要求「把某题移到前面 / 放到某某部分」时使用。" +
    "question_id 与 target_section_id 都必须来自 get_questionnaire 的结果，" +
    "绝对不要自己编造 id。" +
    "target_order 省略时追加到目标分组末尾。",
  inputSchema: z.object({
    target_id: targetIdSchema,
    question_id: z.string().min(1).describe("要移动的问题 id"),
    target_section_id: z.string().min(1).describe("目标分组 id"),
    target_order: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("目标位置，从 1 开始。省略则放到最后。"),
  }),

  async execute(input, context, deps) {
    try {
      assertInstanceScene(context);
      const targetId = resolveTargetId(input.target_id, context);
      return await applyWrite(
        {
          name: "move_question",
          input: {
            questionId: input.question_id,
            targetSectionId: input.target_section_id,
            ...(input.target_order !== undefined
              ? { targetOrder: input.target_order }
              : {}),
          },
        },
        context,
        deps,
        targetId
      );
    } catch (error) {
      return toToolResult(error, context.operationId);
    }
  },
});
