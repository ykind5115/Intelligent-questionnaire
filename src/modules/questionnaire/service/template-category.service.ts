/**
 * 模板分类 Service。
 *
 * 依据 docs/11-future-capability-plan.md 第 5.1 节与决策 D16。
 *
 * 分类是模板的**组织维度**（业务域），不是版本维度：
 *   同一分类下可以有多个模板，每个模板各自从 v1 开始版本号。
 *   因此唯一约束是 (template_id, version_no)，**不是** (category_id, version)。
 *
 * 权限（沿用模板治理的既有边界，决策 D8）：
 *   - 读：任何已鉴权用户（选模板、按分类筛选都要读）
 *   - 写：只有 template_admin（分类是全组织共享的组织结构，与模板同级）
 */
import { prisma } from "../../../database/client.js";
import { newId } from "../../../shared/utils/id.js";
import {
  ErrorCode,
  OperationError,
  permissionDenied,
  validationError,
} from "../../../shared/errors/index.js";
import type { ServiceContext } from "./questionnaire.service.js";

const TEMPLATE_ADMIN_ROLES = ["template_admin"];

/** 分类编码：供程序判断用的小写标识，如 drone_check */
const CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

export interface TemplateCategoryRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  createdAt: Date;
  /** 引用该分类的模板数（列表与详情都带，便于界面提前禁用「删除」） */
  templateCount: number;
}

/** 统计每个分类被多少模板引用（一次 groupBy，避免逐行 count 的 N+1） */
async function countTemplatesByCategory(): Promise<Map<string, number>> {
  const grouped = await prisma.questionnaireTemplate.groupBy({
    by: ["categoryId"],
    where: { categoryId: { not: null } },
    _count: { _all: true },
  });

  const map = new Map<string, number>();
  for (const g of grouped) {
    if (g.categoryId) map.set(g.categoryId, g._count._all);
  }
  return map;
}

function assertTemplateAdmin(ctx: ServiceContext): void {
  if (!ctx.roles.some((r) => TEMPLATE_ADMIN_ROLES.includes(r))) {
    throw permissionDenied(
      `当前用户角色 [${ctx.roles.join(", ")}] 无权管理模板分类，需要 template_admin`
    );
  }
}

export const templateCategoryService = {
  /** 列出全部分类。数量少（预期几十条），不做分页。 */
  async listCategories(): Promise<TemplateCategoryRow[]> {
    const [rows, counts] = await Promise.all([
      prisma.questionnaireTemplateCategory.findMany({
        orderBy: [{ name: "asc" }],
      }),
      countTemplatesByCategory(),
    ]);

    return rows.map((r) => ({
      ...r,
      templateCount: counts.get(r.id) ?? 0,
    }));
  },

  async getCategory(categoryId: string): Promise<TemplateCategoryRow> {
    const found = await prisma.questionnaireTemplateCategory.findUnique({
      where: { id: categoryId },
    });
    if (!found) {
      throw new OperationError(
        ErrorCode.TEMPLATE_NOT_FOUND,
        `模板分类不存在：${categoryId}`
      );
    }
    const usedBy = await prisma.questionnaireTemplate.count({
      where: { categoryId },
    });
    return { ...found, templateCount: usedBy };
  },

  async createCategory(
    input: { code: string; name: string; description?: string },
    ctx: ServiceContext
  ): Promise<TemplateCategoryRow> {
    assertTemplateAdmin(ctx);

    // 只 trim，**不做 toLowerCase**：编码是要被代码/脚本引用的稳定契约，
    // 静默把 `Drone_Check` 存成 `drone_check` 会让引用的那一方对不上。
    // 大小写不合规就明确报错，让调用方改。
    const code = input.code?.trim();
    const name = input.name?.trim();

    if (!code) {
      throw validationError("分类编码不能为空", { path: "code" });
    }
    // 编码会被代码/脚本引用，必须限定字符集，避免出现带空格或中文的编码
    if (!CODE_PATTERN.test(code)) {
      throw validationError(
        "分类编码只能由小写字母、数字、下划线组成，且以字母开头（2–64 位）",
        { path: "code" }
      );
    }
    if (!name) {
      throw validationError("分类名称不能为空", { path: "name" });
    }

    // 先查后插：给出一句人话，而不是把数据库的唯一约束错误抛给调用方
    const existing = await prisma.questionnaireTemplateCategory.findUnique({
      where: { code },
    });
    if (existing) {
      throw new OperationError(
        ErrorCode.INVALID_STATUS_TRANSITION,
        `分类编码已被占用：${code}`,
        { path: "code", code }
      );
    }

    const created = await prisma.questionnaireTemplateCategory.create({
      data: {
        id: newId(),
        code,
        name,
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
      },
    });
    return { ...created, templateCount: 0 };
  },

  /**
   * 更新分类的名称 / 描述。
   *
   * **不接受改 code**：编码是程序侧引用它的依据，
   * 允许改会让「按 drone_check 判断」的代码悄悄失效。要换编码就新建分类。
   */
  async updateCategory(
    categoryId: string,
    input: { name?: string; description?: string | null },
    ctx: ServiceContext
  ): Promise<TemplateCategoryRow> {
    assertTemplateAdmin(ctx);

    if (input.name === undefined && input.description === undefined) {
      throw validationError("至少要提供 name 或 description 之一", {
        path: "name",
      });
    }

    const name = input.name?.trim();
    if (input.name !== undefined && !name) {
      throw validationError("分类名称不能为空", { path: "name" });
    }

    const existing = await this.getCategory(categoryId);

    const updated = await prisma.questionnaireTemplateCategory.update({
      where: { id: categoryId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
      },
    });
    return { ...updated, templateCount: existing.templateCount };
  },

  /**
   * 删除分类。
   *
   * 安全约束：**仍被模板引用时不允许删除**。
   *   数据库外键是 RESTRICT，这里提前拦下并说清有几个模板在用 ——
   *   与 deleteTemplate 的处理方式一致：宁可让删除失败，
   *   也不要把模板的分类归属静默清空。
   */
  async deleteCategory(
    categoryId: string,
    ctx: ServiceContext
  ): Promise<{ id: string }> {
    assertTemplateAdmin(ctx);

    await this.getCategory(categoryId);

    const usedBy = await prisma.questionnaireTemplate.count({
      where: { categoryId },
    });
    if (usedBy > 0) {
      throw new OperationError(
        ErrorCode.INVALID_STATUS_TRANSITION,
        `该分类仍被 ${usedBy} 个模板引用，不能删除。请先把这些模板改到其他分类或清空分类。`,
        { path: "categoryId", usedByTemplates: usedBy }
      );
    }

    await prisma.questionnaireTemplateCategory.delete({
      where: { id: categoryId },
    });
    return { id: categoryId };
  },
};
