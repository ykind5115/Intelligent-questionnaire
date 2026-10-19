/**
 * Vitest 全局 setup / teardown。
 *
 * 在这里创建「已发布的基准模板」，跑完删掉。
 *
 * 为什么放在全局而不是各测试文件的 beforeAll：
 *   多个测试文件都需要它，而 `fileParallelism: false` 只能保证**串行**，
 *   每个文件仍会各自建/删一次，边界容易出错（例如某个文件在中途失败，
 *   它建的那份就成了残渣，下一个文件又建一份）。
 *   全局 setup 只跑一次，生命周期最清晰。
 */
import {
  ensureTestBaseline,
  removeTestBaseline,
} from "./fixtures/test-baseline.js";
import { prisma } from "../src/database/client.js";

export async function setup(): Promise<void> {
  await ensureTestBaseline();
  // 这里不断开连接：teardown 还要用同一个实例；
  // 连接会在 teardown 的 $disconnect 中释放。
}

export async function teardown(): Promise<void> {
  await removeTestBaseline();
  await prisma.$disconnect();
}
