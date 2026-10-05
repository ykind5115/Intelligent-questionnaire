/**
 * Prisma JSONB 字段的赋值辅助。
 *
 * 背景：
 *   Prisma 把 Json 字段的入参类型定义为 InputJsonValue
 *   （本质是带索引签名的 JSON 容器类型）。
 *   而 QuestionnaireSchema 是 Zod 推导出的结构化类型，没有索引签名，
 *   因此 TypeScript 会拒绝直接赋值，即使运行期它确实是纯 JSON 数据。
 *
 * 为什么用一个显式函数而不是到处写 as：
 *   1. 转换点集中，未来 Prisma 调整 Json 类型只需改这里；
 *   2. 函数名本身就是文档：说明这里在做「结构类型 → JSON 值类型」适配；
 *   3. 与 questionnaireSchema.parse() 配合，
 *      保证写入数据库的结构一定是合法问卷（先校验，后转换）。
 *
 * 重要：**只应用于已经过 questionnaireSchema 校验的值**。
 * 不要用它把来路不明的对象直接塞进数据库。
 */
import type { Prisma } from "../../../generated/prisma/client.js";

export function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
