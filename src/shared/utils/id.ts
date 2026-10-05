/**
 * UUID 工具。
 *
 * 依据 docs/04-database_design.md 第 6 节：
 *   业务主键统一使用 UUID v7，且由应用层生成（不依赖 PostgreSQL 生成）。
 *   原因：本系统有大量持续写入的表（message / tool_execution / revision），
 *   UUID v7 的时间有序性更适合这类写入模式。
 */
import { v7 as uuidv7, validate as uuidValidate } from "uuid";

/** 生成 UUID v7 */
export function newId(): string {
  return uuidv7();
}

export { uuidValidate };
