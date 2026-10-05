/**
 * Questionnaire Service 集成测试（真实数据库）。
 *
 * 覆盖本层最关键、也最容易被写错的行为：
 *   1. 结构修改真的落到 current_schema，且 revision 递增（决策 D9）
 *   2. 每次修改都产生 Revision 快照与审计日志
 *   3. 已下发的实例被拒绝修改（决策 D1）
 *   4. 权限拦截（决策 D8）
 *   5. 幂等：同一 operation_id 重复调用不产生重复数据（决策 D9）
 *   6. 乐观锁冲突（04 文档第 37 节）
 *   7. 撤回：已下发 → draft（决策 D1）
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "../../../src/database/client.js";
import { ErrorCode, isOperationError } from "../../../src/shared/errors/index.js";
import { questionnaireService } from "../../../src/modules/questionnaire/service/questionnaire.service.js";
import { newId } from "../../../src/shared/utils/id.js";
import {
  CTX,
  assignInvestigator,
  countArtifacts,
  createTestInstance,
  deleteTestInstance,
  readInstanceState,
} from "./helpers.js";

/** 断言抛出指定错误码 */
async function expectCode(
  fn: () => Promise<unknown>,
  code: string
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    expect(isOperationError(e)).toBe(true);
    if (isOperationError(e)) {
      expect(e.code).toBe(code);
    }
    return;
  }
  throw new Error(`期望抛出 ${code}，但没有抛出任何错误`);
}

let instanceId = "";
let initialRevision = 1;

beforeAll(async () => {
  // 启动前确认数据库可用，并给出清晰提示
  try {
    await prisma.$queryRawUnsafe("select 1");
  } catch {
    throw new Error(
      "无法连接数据库。请先执行：pnpm exec prisma dev -d 并确认 .env 的 DATABASE_URL"
    );
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  if (instanceId) {
    await deleteTestInstance(instanceId);
    instanceId = "";
  }
});

describe("applyToInstance - 结构修改", () => {
  it("add_section：写入 current_schema，revision 由 1 变 2", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;
    initialRevision = inst.initialRevision;

    const before = await readInstanceState(instanceId);
    const sectionCountBefore =
      (before?.currentSchema as { sections: unknown[] }).sections.length;

    const result = await questionnaireService.applyToInstance(
      instanceId,
      { name: "add_section", input: { title: "团伙关系调查" } },
      CTX.dispatcher()
    );

    expect(result.revision).toBe(initialRevision + 1);
    expect(result.schema.sections).toHaveLength(sectionCountBefore + 1);
    expect(result.details.section).toMatchObject({ title: "团伙关系调查" });

    // 真的落库了
    const after = await readInstanceState(instanceId);
    expect(after?.currentRevision).toBe(initialRevision + 1);
    const sections = (
      after?.currentSchema as { sections: { title: string }[] }
    ).sections;
    expect(sections.map((s) => s.title)).toContain("团伙关系调查");
  });

  it("add_question：新增问题并返回后端生成的 question id", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    // 先建一个分组，再往里加题（模拟「增加团伙调查模块」的真实链路）
    const withSection = await questionnaireService.applyToInstance(
      instanceId,
      { name: "add_section", input: { title: "团伙关系调查" } },
      CTX.dispatcher()
    );
    const sectionId = (withSection.details.section as { id: string }).id;

    const r1 = await questionnaireService.applyToInstance(
      instanceId,
      {
        name: "add_question",
        input: {
          sectionId,
          type: "boolean",
          title: "是否存在团伙？",
          required: true,
        },
      },
      CTX.dispatcher()
    );

    const questionId = (r1.details.question as { id: string }).id;
    expect(questionId).toMatch(/^q_/);
    expect(r1.revision).toBe(initialRevision + 2);

    const r2 = await questionnaireService.applyToInstance(
      instanceId,
      {
        name: "add_question",
        input: { sectionId, type: "textarea", title: "团伙成员情况" },
      },
      CTX.dispatcher()
    );

    expect(r2.revision).toBe(initialRevision + 3);

    const state = await readInstanceState(instanceId);
    const sec = (
      state?.currentSchema as {
        sections: { id: string; questions: { title: string }[] }[];
      }
    ).sections.find((s) => s.id === sectionId);
    expect(sec?.questions.map((q) => q.title)).toEqual([
      "是否存在团伙？",
      "团伙成员情况",
    ]);
  });

  it("每次修改都产生 Revision 快照与审计日志", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    // 起始：1 条 revision（创建时），0 条审计
    const before = await countArtifacts(instanceId);
    expect(before.revisions).toBe(1);
    expect(before.audits).toBe(0);

    await questionnaireService.applyToInstance(
      instanceId,
      { name: "add_section", input: { title: "第一组" } },
      CTX.dispatcher()
    );
    await questionnaireService.applyToInstance(
      instanceId,
      { name: "add_section", input: { title: "第二组" } },
      CTX.dispatcher()
    );

    const after = await countArtifacts(instanceId);
    // 3 条 revision：创建 + 两次修改
    expect(after.revisions).toBe(3);
    expect(after.audits).toBe(2);

    // Revision 与 current_revision 严格对应
    const state = await readInstanceState(instanceId);
    expect(state?.currentRevision).toBe(3);

    const latest = await prisma.questionnaireRevision.findFirst({
      where: { questionnaireInstanceId: instanceId },
      orderBy: { revisionNo: "desc" },
    });
    expect(latest?.revisionNo).toBe(3);
    expect(latest?.operationType).toBe("add_section");
  });

  it("审计日志记录了来源、操作名与参数", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    await questionnaireService.applyToInstance(
      instanceId,
      { name: "add_section", input: { title: "审计校验组" } },
      CTX.dispatcher({ source: "ai_tool", model: "deepseek-v41-flash" })
    );

    const log = await prisma.aiToolExecution.findFirst({
      where: { questionnaireInstanceId: instanceId },
    });

    expect(log?.source).toBe("ai_tool");
    expect(log?.toolName).toBe("add_section");
    expect(log?.success).toBe(true);
    expect(log?.model).toBe("deepseek-v41-flash");
    expect((log?.arguments as { title: string }).title).toBe("审计校验组");
  });
});

describe("决策 D1：已下发的实例结构冻结", () => {
  for (const status of [
    "dispatched",
    "in_progress",
    "submitted",
    "under_review",
    "completed",
  ]) {
    it(`状态 ${status} 时拒绝修改结构`, async () => {
      const inst = await createTestInstance({ status });
      instanceId = inst.id;

      await expectCode(
        () =>
          questionnaireService.applyToInstance(
            instanceId,
            { name: "add_section", input: { title: "不该被写入" } },
            CTX.dispatcher()
          ),
        ErrorCode.QUESTIONNAIRE_LOCKED
      );

      // 确认数据库没有被改动
      const state = await readInstanceState(instanceId);
      expect(state?.currentRevision).toBe(inst.initialRevision);
      const sections = (
        state?.currentSchema as { sections: { title: string }[] }
      ).sections;
      expect(sections.map((s) => s.title)).not.toContain("不该被写入");
    });
  }

  it("confirmed 状态允许修改（冻结点是下发，不是确认）", async () => {
    const inst = await createTestInstance({ status: "confirmed" });
    instanceId = inst.id;

    const result = await questionnaireService.applyToInstance(
      instanceId,
      { name: "add_section", input: { title: "确认后仍可加组" } },
      CTX.dispatcher()
    );

    expect(result.revision).toBe(inst.initialRevision + 1);
  });
});

describe("决策 D8：权限", () => {
  it("investigator 无权修改结构", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    await expectCode(
      () =>
        questionnaireService.applyToInstance(
          instanceId,
          { name: "add_section", input: { title: "调查员不该能加" } },
          CTX.investigator()
        ),
      ErrorCode.PERMISSION_DENIED
    );
  });

  it("template_admin 可以修改结构", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const result = await questionnaireService.applyToInstance(
      instanceId,
      { name: "add_section", input: { title: "管理员加的组" } },
      CTX.admin()
    );
    expect(result.revision).toBe(inst.initialRevision + 1);
  });

  it("被指派的 investigator 可以读取实例（只读权限）", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;
    // 横向授权要求先建立指派关系
    await assignInvestigator(instanceId);

    const read = await questionnaireService.getInstance(
      instanceId,
      CTX.investigator()
    );
    expect(read.id).toBe(instanceId);
  });
});

describe("决策 D9：幂等", () => {
  it("同一 operation_id 重复调用不产生重复数据，返回同一结果", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    const operationId = newId();
    const ctx = CTX.dispatcher({ operationId });

    const first = await questionnaireService.applyToInstance(
      instanceId,
      { name: "add_section", input: { title: "幂等测试组" } },
      ctx
    );

    const second = await questionnaireService.applyToInstance(
      instanceId,
      { name: "add_section", input: { title: "幂等测试组" } },
      ctx
    );

    // 第二次是重放，revision 不变
    expect(second.revision).toBe(first.revision);
    expect(second.details.idempotentReplay).toBe(true);

    const state = await readInstanceState(instanceId);
    const sections = (
      state?.currentSchema as { sections: { title: string }[] }
    ).sections;
    const matched = sections.filter((s) => s.title === "幂等测试组");
    expect(matched).toHaveLength(1);

    // 只有一条审计记录
    const { audits } = await countArtifacts(instanceId);
    expect(audits).toBe(1);
  });

  it("不同 operation_id 正常重复执行", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    await questionnaireService.applyToInstance(
      instanceId,
      { name: "add_section", input: { title: "重复标题" } },
      CTX.dispatcher({ operationId: newId() })
    );
    await questionnaireService.applyToInstance(
      instanceId,
      { name: "add_section", input: { title: "重复标题" } },
      CTX.dispatcher({ operationId: newId() })
    );

    const state = await readInstanceState(instanceId);
    const sections = (
      state?.currentSchema as { sections: { title: string }[] }
    ).sections;
    expect(sections.filter((s) => s.title === "重复标题")).toHaveLength(2);
  });
});

describe("乐观锁", () => {
  it("expectedRevision 不匹配时抛 REVISION_CONFLICT", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    await expectCode(
      () =>
        questionnaireService.applyToInstance(
          instanceId,
          { name: "add_section", input: { title: "不该生效" } },
          CTX.dispatcher(),
          { expectedRevision: 999 }
        ),
      ErrorCode.REVISION_CONFLICT
    );

    const state = await readInstanceState(instanceId);
    expect(state?.currentRevision).toBe(inst.initialRevision);
  });
});

describe("决策 D1：撤回", () => {
  it("dispatched → withdraw → draft，且不产生新 Revision", async () => {
    const inst = await createTestInstance({ status: "dispatched" });
    instanceId = inst.id;

    const { revisions: revisionsBefore } = await countArtifacts(instanceId);

    const withdrawn = await questionnaireService.withdrawInstance(
      instanceId,
      CTX.dispatcher(),
      "需要增加团伙关系调查"
    );

    expect(withdrawn.status).toBe("draft");

    const state = await readInstanceState(instanceId);
    expect(state?.status).toBe("draft");
    // 撤回只改状态，不产生新 Revision
    expect(state?.currentRevision).toBe(inst.initialRevision);

    const { revisions: revisionsAfter } = await countArtifacts(instanceId);
    expect(revisionsAfter).toBe(revisionsBefore);

    // 撤回后可以继续改结构
    const result = await questionnaireService.applyToInstance(
      instanceId,
      { name: "add_section", input: { title: "撤回后新增的组" } },
      CTX.dispatcher()
    );
    expect(result.revision).toBe(inst.initialRevision + 1);
  });

  it("draft 状态不允许撤回（本就可改）", async () => {
    const inst = await createTestInstance({ status: "draft" });
    instanceId = inst.id;

    await expectCode(
      () => questionnaireService.withdrawInstance(instanceId, CTX.dispatcher()),
      ErrorCode.WITHDRAW_NOT_ALLOWED
    );
  });

  it("completed 状态不允许撤回", async () => {
    const inst = await createTestInstance({ status: "completed" });
    instanceId = inst.id;

    await expectCode(
      () => questionnaireService.withdrawInstance(instanceId, CTX.dispatcher()),
      ErrorCode.WITHDRAW_NOT_ALLOWED
    );
  });

  it("returned 状态不允许直接撤回（需先回到 in_progress）", async () => {
    const inst = await createTestInstance({ status: "returned" });
    instanceId = inst.id;

    await expectCode(
      () => questionnaireService.withdrawInstance(instanceId, CTX.dispatcher()),
      ErrorCode.WITHDRAW_NOT_ALLOWED
    );
  });
});

describe("确认问卷", () => {
  it("draft → confirmed", async () => {
    const inst = await createTestInstance({ status: "draft" });
    instanceId = inst.id;

    const confirmed = await questionnaireService.confirmInstance(
      instanceId,
      CTX.dispatcher()
    );
    expect(confirmed.status).toBe("confirmed");
  });

  it("confirmed 不能再次确认", async () => {
    const inst = await createTestInstance({ status: "confirmed" });
    instanceId = inst.id;

    await expectCode(
      () => questionnaireService.confirmInstance(instanceId, CTX.dispatcher()),
      ErrorCode.INVALID_STATUS_TRANSITION
    );
  });
});

describe("错误处理", () => {
  it("实例不存在时抛 QUESTIONNAIRE_NOT_FOUND", async () => {
    await expectCode(
      () =>
        questionnaireService.applyToInstance(
          newId(),
          { name: "add_section", input: { title: "x" } },
          CTX.dispatcher()
        ),
      ErrorCode.QUESTIONNAIRE_NOT_FOUND
    );
  });

  it("分组不存在的 add_question 不会写入任何数据", async () => {
    const inst = await createTestInstance();
    instanceId = inst.id;

    await expectCode(
      () =>
        questionnaireService.applyToInstance(
          instanceId,
          {
            name: "add_question",
            input: { sectionId: "sec_not_exist", type: "text", title: "x" },
          },
          CTX.dispatcher()
        ),
      ErrorCode.SECTION_NOT_FOUND
    );

    // 事务回滚：revision 未变，也没有审计记录
    const state = await readInstanceState(instanceId);
    expect(state?.currentRevision).toBe(inst.initialRevision);
    const { audits } = await countArtifacts(instanceId);
    expect(audits).toBe(0);
  });
});
