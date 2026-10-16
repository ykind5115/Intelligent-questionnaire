/**
 * 跳转流程校验的**注册入口**。
 *
 * 为什么单独一个文件：
 *   `flow.ts` 是纯逻辑（不依赖 schema 定义），
 *   `questionnaire.schema.ts` 通过注入点调用图校验以避免循环 import。
 *   本文件负责把两者接起来 —— 任何会「解析问卷结构」的入口只要 import 它，
 *   结构校验就自动带上图校验（悬空引用 / 比较值类型 / 环收敛）。
 *
 *   刻意让注册成为**副作用**而不是要求调用方手动调用：
 *   忘记调用会导致「非法结构被放过」，而这种漏检很难在测试里被发现。
 */
import {
  questionnaireSchema,
  registerFlowChecker,
} from "../schema/questionnaire.schema.js";
import {
  checkFlow,
  findUnreachable,
  resolveFlow,
  type FlowIssue,
} from "./flow.js";

registerFlowChecker((schema) => checkFlow(schema as never));

export {
  checkFlow,
  findUnreachable,
  resolveFlow,
  registerFlowChecker,
  questionnaireSchema,
};
export type { FlowIssue };

export type {
  FlowStep,
  FlowStepReason,
  FlowResult,
  FlowIndex,
  FlowQuestionLike,
  FlowSectionLike,
  FlowSchemaLike,
  FlowOperator,
  ResolveFlowOptions,
} from "./flow.js";

export {
  FLOW_OPERATORS,
  VALUELESS_OPERATORS,
  SET_OPERATORS,
  buildFlowIndex,
  defaultMaxSteps,
  evaluateRule,
  isAnswered,
} from "./flow.js";
