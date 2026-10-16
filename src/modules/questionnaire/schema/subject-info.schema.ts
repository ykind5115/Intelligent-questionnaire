/**
 * 问卷实例的**案件信息** Schema。
 *
 * 依据 docs/11-future-capability-plan.md 第 5.2 节与决策 D16：
 *   `subject_info` 原先只是 `z.record(z.string(), z.unknown())` —— 什么都能塞，
 *   数据库里因此没有任何字段约束。这里把它显式化：
 *
 *   1. **已知字段列出来**，让「调查对象」「核查任务」这两类信息有据可依，
 *      将来要按字段查询时才清楚该拆哪些列；
 *   2. **已知字段全部可选** —— 存量数据只有部分字段，强制必填会让老数据读不出来；
 *   3. **保留未知字段（passthrough）** —— 不同案件确实有不同字段，
 *      这一步只是「把已知的写清楚」，不是「禁止其他字段」。
 *
 * 因此本 Schema 是**约束 + 文档**，而不是收紧。
 * 等到需要「按核查对象检索案件」时，再按这些字段拆出独立表（见计划 §5.2）。
 */
import { z } from "zod";

/**
 * 调查对象信息（人 / 设备 / 组织）。
 *
 * 注意：这些字段可能承载个人信息，落库前应脱敏
 * （04 文档第 40 节与计划 §10 第 6 条）。本 Schema 不强制格式，
 * 因为脱敏后的值（如 `3301**********1234`）过不了严格的格式校验。
 */
const respondentFields = {
  name: z.string().max(200),
  idCard: z.string().max(64),
  phone: z.string().max(64),
  address: z.string().max(500),
};

/** 核查任务信息 */
const taskFields = {
  /** 核查对象（无人机编号 / 被调查人 / 单位名称等） */
  subject: z.string().max(200),
  /** 计划核查时间。用 string 而非 Date：JSON 里就是文本，
   *  且不同案件可能只写到「日期」粒度（如 2026-10-15） */
  inspectTime: z.string().max(64),
  /** 核查人 */
  inspector: z.string().max(200),
};

export const subjectInfoSchema = z
  .object({
    ...Object.fromEntries(
      Object.entries(respondentFields).map(([k, v]) => [k, v.optional()])
    ),
    ...Object.fromEntries(
      Object.entries(taskFields).map(([k, v]) => [k, v.optional()])
    ),
  })
  // 业务字段随案件而变，已知字段之外的必须原样保留
  .passthrough();

export type SubjectInfo = z.infer<typeof subjectInfoSchema>;

/** 已知字段名，供测试与文档引用，避免各处重复硬编码字符串 */
export const SUBJECT_INFO_KNOWN_FIELDS = [
  ...Object.keys(respondentFields),
  ...Object.keys(taskFields),
] as const;
