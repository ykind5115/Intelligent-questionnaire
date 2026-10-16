/**
 * 流程预览的请求/响应校验（只读，不落库）。
 *
 * 依据 docs/11-future-capability-plan.md 第 4.11 节。
 *
 * 为什么要有这个接口：
 *   编辑器需要一个「按这份结构，某种答案会走成什么样」的预览
 *   （跳过哪些题、哪些题不可达）。如果把求值逻辑在前端再抄一份，
 *   两边迟早会漂移 —— 而分支判定出错是**很难在数据里发现**的那类问题。
 *   因此求值只在后端做一次，前端发结构、拿结果。
 *
 * 只读：不写任何东西，也不产生审计。
 */
import type { Request, Response } from "express";
import { z } from "zod";
import { sendSuccess } from "../../../app/api-response.js";
import { asyncHandler } from "../../../app/error-handler.js";
import { serviceContextOf } from "../../../app/request-context.js";
import { resolveFlow, findUnreachable } from "../operations/index.js";
import { questionnaireService } from "../service/questionnaire.service.js";
import type { QuestionnaireSchema } from "../schema/questionnaire.schema.js";

export const flowPreviewParams = z.object({
  templateId: z.uuid(),
  versionId: z.uuid(),
});

/**
 * 预览请求体。
 *
 * 只接受「一组候选答案」，而不是要求前端传完整枚举：
 *   前端每次只预览它关心的那几种情形（例如「是」和「否」各一次），
 *   这样接口简单，也不至于让前端去枚举组合。
 */
export const flowPreviewBody = z.object({
  cases: z
    .array(
      z.object({
        /** 便于前端对应结果，原样回传 */
        label: z.string().max(100).optional(),
        answers: z.record(z.string(), z.unknown()),
      })
    )
    .min(1)
    .max(20, "一次最多预览 20 种情形"),
});

/**
 * GET  POST 两条都用：GET 用于「不传答案，只看结构与不可达」，
 * POST 用于「带候选答案，看具体路径」。
 */
export const flowPreviewController = {
  /** 结构层面的诊断：不可达题目等（不需要答案） */
  structure: asyncHandler(async (req: Request, res: Response) => {
    const { versionId } = req.params as z.infer<typeof flowPreviewParams>;
    const { schema } = await questionnaireService.getTemplateVersionForEditing(
      versionId,
      serviceContextOf(req)
    );

    const questions = flattenQuestions(schema);

    sendSuccess(req, res, {
      /** 全部题目（按 order），供前端渲染题目选择列表 */
      questions,
      /** 从入口不可达的题目 id（告警，不阻断） */
      unreachable: findUnreachable(schema as never),
      /** 有分支或显式终点的题目 id */
      branchingQuestionIds: questions
        .filter((q) => q.branchCount > 0 || q.defaultNext !== undefined)
        .map((q) => q.id),
    });
  }),

  /** 按候选答案求路径 */
  cases: asyncHandler(async (req: Request, res: Response) => {
    const { versionId } = req.params as z.infer<typeof flowPreviewParams>;
    const body = req.body as z.infer<typeof flowPreviewBody>;

    const { schema } = await questionnaireService.getTemplateVersionForEditing(
      versionId,
      serviceContextOf(req)
    );

    const results = body.cases.map((c) => {
      try {
        const flow = resolveFlow(schema, c.answers);
        return {
          ...(c.label !== undefined ? { label: c.label } : {}),
          questionIds: flow.steps.map((s) => s.questionId),
          reasons: flow.steps.map((s) => s.reason),
          endedBy: flow.endedBy,
          error: null,
        };
      } catch (e) {
        // 预览不该因为结构有问题就整体失败 —— 把问题当作这条情形的结果返回，
        // 用户在编辑器里就能看到「这个结构走不通」，这正是预览的价值。
        return {
          ...(c.label !== undefined ? { label: c.label } : {}),
          questionIds: [],
          reasons: [],
          endedBy: null,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    });

    sendSuccess(req, res, { results });
  }),
};

/** 展平题目（含分组信息与分支摘要），供前端渲染 */
function flattenQuestions(schema: QuestionnaireSchema) {
  const out: {
    id: string;
    title: string;
    type: string;
    required: boolean;
    sectionId: string;
    sectionTitle: string;
    order: number;
    branchCount: number;
    defaultNext: string | null | undefined;
    options: { id: string; label: string }[];
  }[] = [];

  const sections = [...schema.sections].sort((a, b) => a.order - b.order);
  for (const sec of sections) {
    const questions = [...sec.questions].sort((a, b) => a.order - b.order);
    for (const q of questions) {
      out.push({
        id: q.id,
        title: q.title,
        type: q.type,
        required: q.required,
        sectionId: sec.id,
        sectionTitle: sec.title,
        order: q.order,
        branchCount: q.branches?.length ?? 0,
        defaultNext: q.defaultNext,
        options: (q.options ?? []).map((o) => ({ id: o.id, label: o.label })),
      });
    }
  }
  return out;
}
