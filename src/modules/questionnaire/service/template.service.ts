/**
 * Template Service。
 *
 * 依据 docs/06-proj_init.md 第 6.1 节与 docs/05-api_design.md 第 9 节。
 *
 * 负责正式模板与模板版本的生命周期：
 *   创建模板 / 创建版本 / 查询 / 发布 / 停用
 *
 * 注意与 Questionnaire 模块的分工：
 *   - Template 管「正式模板与版本」；
 *   - Questionnaire 管「实例、结构操作、Revision、AI 修改」。
 *   AI 生成模板时写的是 DRAFT 版本（决策 D2/03 文档第 36 节），
 *   不许触碰已发布版本。
 */
import { transaction, type Tx } from "../../../database/transaction.js";
import { prisma } from "../../../database/client.js";
import { questionnaireRepository } from "../repository/questionnaire.repository.js";
import { templateCategoryService } from "./template-category.service.js";
import { newId } from "../../../shared/utils/id.js";
import { toJsonValue } from "../../../shared/utils/json.js";
import {
  ErrorCode,
  OperationError,
  permissionDenied,
  validationError,
} from "../../../shared/errors/index.js";
import {
  questionnaireSchema,
  type QuestionnaireSchema,
} from "../schema/questionnaire.schema.js";
import type { ServiceContext } from "./questionnaire.service.js";

/** 模板管理相关角色（决策 D8） */
const TEMPLATE_ADMIN_ROLES = ["template_admin"];

export interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  /** 所属分类（可空：存量模板与未选分类的模板都是 null） */
  categoryId: string | null;
  status: string;
  currentVersionId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  /** 列表/详情带上分类摘要，省掉前端再查一次 */
  category?: { id: string; code: string; name: string } | null;
}

export interface TemplateVersionRow {
  id: string;
  templateId: string;
  versionNo: number;
  schema: unknown;
  changeNote: string | null;
  status: string;
  sourceType: string;
  sourceInstanceId: string | null;
  createdBy: string;
  createdAt: Date;
}

function assertTemplateAdmin(ctx: ServiceContext): void {
  if (!ctx.roles.some((r) => TEMPLATE_ADMIN_ROLES.includes(r))) {
    throw permissionDenied(
      `当前用户角色 [${ctx.roles.join(", ")}] 无权管理模板，需要 template_admin`
    );
  }
}

/**
 * 一份「空问卷」结构，用于创建模板草稿。
 *
 * 对话式生成模板时，AI 会通过 add_section / add_question 逐步填充它。
 */
export function emptyQuestionnaireSchema(
  schemaId: string,
  title: string,
  description?: string
): QuestionnaireSchema {
  return questionnaireSchema.parse({
    id: schemaId,
    title,
    ...(description !== undefined ? { description } : {}),
    version: 1,
    sections: [],
  });
}

export const templateService = {
  // ----------------------------------------------------------
  // 模板
  // ----------------------------------------------------------

  async createTemplate(
    input: { name: string; description?: string; categoryId?: string },
    ctx: ServiceContext
  ): Promise<TemplateRow> {
    assertTemplateAdmin(ctx);

    const name = input.name?.trim();
    if (!name) {
      throw validationError("模板名称不能为空", { path: "name" });
    }

    // 分类可选。给了就必须真实存在 —— 否则会写进一个悬空的 category_id，
    // 之后前端按分类筛选时会「查不到这个模板」而看不出原因。
    if (input.categoryId !== undefined) {
      await templateCategoryService.getCategory(input.categoryId);
    }

    const id = newId();

    return prisma.questionnaireTemplate.create({
      data: {
        id,
        name,
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.categoryId !== undefined
          ? { categoryId: input.categoryId }
          : {}),
        status: "draft",
        createdBy: ctx.userId,
      },
      include: { category: { select: { id: true, code: true, name: true } } },
    });
  },

  async listTemplates(
    query: { keyword?: string; status?: string; categoryId?: string },
    options: { skip: number; take: number }
  ): Promise<{ items: TemplateRow[]; total: number }> {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.keyword
        ? { name: { contains: query.keyword, mode: "insensitive" as const } }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.questionnaireTemplate.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: options.skip,
        take: options.take,
        include: { category: { select: { id: true, code: true, name: true } } },
      }),
      prisma.questionnaireTemplate.count({ where }),
    ]);

    return { items, total };
  },

  async getTemplate(templateId: string): Promise<TemplateRow> {
    const found = await prisma.questionnaireTemplate.findUnique({
      where: { id: templateId },
      include: { category: { select: { id: true, code: true, name: true } } },
    });
    if (!found) {
      throw new OperationError(
        ErrorCode.TEMPLATE_NOT_FOUND,
        `模板不存在：${templateId}`
      );
    }
    return found;
  },

  /**
   * 更新模板的名称 / 描述 / 分类（模板管理页的「保存」按钮）。
   *
   * 只允许改这三个展示/组织字段：
   *   - 结构属于**版本**，改结构必须新建版本，不能在这里偷偷改
   *   - 状态由 publish / disable 流程控制，不接受客户端直接指定
   * 这样模板记录始终只是「元信息」，不承载结构真相。
   *
   * `categoryId` 接受 null 表示「清空分类」——
   * 与 description 同理，若只允许 string，前端就没法把分类取消掉。
   */
  async updateTemplate(
    templateId: string,
    input: {
      name?: string;
      description?: string | null;
      categoryId?: string | null;
    },
    ctx: ServiceContext
  ): Promise<TemplateRow> {
    assertTemplateAdmin(ctx);

    if (
      input.name === undefined &&
      input.description === undefined &&
      input.categoryId === undefined
    ) {
      throw validationError(
        "至少要提供 name、description 或 categoryId 之一",
        { path: "name" }
      );
    }

    const name = input.name?.trim();
    if (input.name !== undefined && !name) {
      throw validationError("模板名称不能为空", { path: "name" });
    }

    if (typeof input.categoryId === "string") {
      await templateCategoryService.getCategory(input.categoryId);
    }

    // 先确认存在（getTemplate 会抛 TEMPLATE_NOT_FOUND）
    await this.getTemplate(templateId);

    return prisma.questionnaireTemplate.update({
      where: { id: templateId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.categoryId !== undefined
          ? { categoryId: input.categoryId }
          : {}),
      },
      include: { category: { select: { id: true, code: true, name: true } } },
    });
  },

  /**
   * 删除模板（连同其所有版本）。
   *
   * 安全约束（重要）：**已有实例引用了它的版本时不允许删除**。
   *   questionnaire_instances.template_version_id 指向版本，
   *   删掉会让既有案件失去溯源依据（「这份问卷当初照哪个模板做的」）。
   *   必须显式拦住，而不是靠数据库外键抛一个难以理解的错误。
   *
   * 已发布的模板同样不允许直接删除：先 disable，
   * 避免正在被使用的模板突然消失。
   */
  async deleteTemplate(
    templateId: string,
    ctx: ServiceContext
  ): Promise<{ id: string; deletedVersions: number }> {
    assertTemplateAdmin(ctx);

    const template = await this.getTemplate(templateId);

    if (template.status === "published") {
      throw new OperationError(
        ErrorCode.INVALID_STATUS_TRANSITION,
        "已发布的模板不能直接删除。请先停用它（disable），确认无人使用后再删。",
        { path: "status", status: template.status }
      );
    }

    return transaction(async (tx: Tx) => {
      const versions = await tx.questionnaireTemplateVersion.findMany({
        where: { templateId },
        select: { id: true },
      });
      const versionIds = versions.map((v) => v.id);

      if (versionIds.length > 0) {
        const usedBy = await tx.questionnaireInstance.count({
          where: { templateVersionId: { in: versionIds } },
        });
        if (usedBy > 0) {
          throw new OperationError(
            ErrorCode.INVALID_STATUS_TRANSITION,
            `该模板的版本已被 ${usedBy} 个问卷实例引用，不能删除` +
              "（删除会让既有案件失去来源依据）。",
            { path: "templateId", usedByInstances: usedBy }
          );
        }

        await tx.questionnaireTemplateVersion.deleteMany({
          where: { templateId },
        });
      }

      // current_version_id 是模板指向版本的循环外键，必须先断开
      await tx.questionnaireTemplate.update({
        where: { id: templateId },
        data: { currentVersionId: null },
      });
      await tx.questionnaireTemplate.delete({ where: { id: templateId } });

      return { id: templateId, deletedVersions: versionIds.length };
    });
  },

  // ----------------------------------------------------------
  // 模板版本
  // ----------------------------------------------------------

  /**
   * 创建模板版本。
   *
   * version_no 由后端计算（05 文档第 9.6 节：客户端不能指定 versionNo）。
   * 新版本一律为 draft，必须经 publish 才生效。
   */
  /**
   * 列出「可用的已发布模板版本」——下发问卷时选模板用。
   *
   * 每个模板只返回**当前生效的那一个**已发布版本：
   *   业务语义是「选一个模板」，把同一模板的历史版本全列出来只会让人
   *   不知道该选哪个。需要看历史版本时走模板详情页。
   *
   * 顺带算出结构规模（几个分组、几道题）：只显示名字很难判断该选哪个模板。
   */
  async listCurrentPublishedVersions(
    query: { keyword?: string },
    options: { skip: number; take: number }
  ): Promise<{
    items: {
      versionId: string;
      templateId: string;
      templateName: string;
      templateDescription: string | null;
      versionNo: number;
      publishedAt: Date;
      sectionCount: number;
      questionCount: number;
    }[];
    total: number;
  }> {
    const { items, total } =
      await questionnaireRepository.listCurrentPublishedVersions(query, options);

    return {
      total,
      items: items.map((v) => {
        const sections =
          (v.schema as { sections?: { questions?: unknown[] }[] })?.sections ?? [];
        return {
          versionId: v.versionId,
          templateId: v.templateId,
          templateName: v.templateName,
          templateDescription: v.templateDescription,
          versionNo: v.versionNo,
          publishedAt: v.publishedAt,
          sectionCount: sections.length,
          questionCount: sections.reduce(
            (n, s) => n + (s.questions?.length ?? 0),
            0
          ),
        };
      }),
    };
  },

  async createVersion(
    templateId: string,
    input: {
      schema?: QuestionnaireSchema;
      changeNote?: string;
      sourceType?: string;
      sourceInstanceId?: string;
    },
    ctx: ServiceContext
  ): Promise<TemplateVersionRow> {
    assertTemplateAdmin(ctx);

    return transaction(async (tx: Tx) => {
      const template = await tx.questionnaireTemplate.findUnique({
        where: { id: templateId },
      });
      if (!template) {
        throw new OperationError(
          ErrorCode.TEMPLATE_NOT_FOUND,
          `模板不存在：${templateId}`
        );
      }

      const last = await tx.questionnaireTemplateVersion.findFirst({
        where: { templateId },
        orderBy: { versionNo: "desc" },
        select: { versionNo: true },
      });
      const versionNo = (last?.versionNo ?? 0) + 1;

      const schema =
        input.schema ??
        emptyQuestionnaireSchema(newId(), template.name, template.description ?? undefined);

      const parsed = questionnaireSchema.parse(schema);

      return tx.questionnaireTemplateVersion.create({
        data: {
          id: newId(),
          templateId,
          versionNo,
          schema: toJsonValue(parsed),
          ...(input.changeNote !== undefined
            ? { changeNote: input.changeNote }
            : {}),
          status: "draft",
          sourceType: input.sourceType ?? "manual",
          ...(input.sourceInstanceId !== undefined
            ? { sourceInstanceId: input.sourceInstanceId }
            : {}),
          createdBy: ctx.userId,
        },
      });
    });
  },

  async listVersions(templateId: string): Promise<TemplateVersionRow[]> {
    await this.getTemplate(templateId);

    return prisma.questionnaireTemplateVersion.findMany({
      where: { templateId },
      orderBy: { versionNo: "desc" },
    });
  },

  async getVersion(
    templateId: string,
    versionId: string
  ): Promise<TemplateVersionRow> {
    const found = await prisma.questionnaireTemplateVersion.findUnique({
      where: { id: versionId },
    });
    if (!found || found.templateId !== templateId) {
      throw new OperationError(
        ErrorCode.TEMPLATE_VERSION_NOT_FOUND,
        `模板版本不存在：${versionId}`
      );
    }
    return found;
  },

  /**
   * 发布版本。
   *
   * 依据 04 文档第 11.1 节：发布后的版本不可直接修改。
   * 发布时同时把 template.current_version_id 指向该版本。
   */
  async publishVersion(
    templateId: string,
    versionId: string,
    ctx: ServiceContext
  ): Promise<TemplateVersionRow> {
    assertTemplateAdmin(ctx);

    return transaction(async (tx: Tx) => {
      const version = await tx.questionnaireTemplateVersion.findUnique({
        where: { id: versionId },
      });
      if (!version || version.templateId !== templateId) {
        throw new OperationError(
          ErrorCode.TEMPLATE_VERSION_NOT_FOUND,
          `模板版本不存在：${versionId}`
        );
      }

      if (version.status === "published") {
        throw new OperationError(
          ErrorCode.INVALID_STATUS_TRANSITION,
          "该版本已经是发布状态"
        );
      }

      // 发布前必须能通过结构校验，避免把非法问卷放出去
      questionnaireSchema.parse(version.schema);

      const updated = await tx.questionnaireTemplateVersion.update({
        where: { id: versionId },
        data: { status: "published" },
      });

      await tx.questionnaireTemplate.update({
        where: { id: templateId },
        data: { status: "published", currentVersionId: versionId },
      });

      return updated;
    });
  },

  /**
   * 落定一个 AI 对话产出的草稿版本（05 文档第 33 节 commit）。
   *
   * 与 publishVersion 的区别：
   *   commit 只把草稿"定稿"（校验结构非空、写入名称/说明），**不发布**；
   *   发布仍须由 template_admin 显式调用 publishVersion。
   *
   * 为什么要校验「非空」：
   *   AI 对话可能一次都没成功写入（例如模型没调用任何工具），
   *   此时若允许 commit，模板库里会多出一个空模板。
   */
  async commitDraftVersion(
    versionId: string,
    input: { name?: string; description?: string; changeNote?: string },
    ctx: ServiceContext
  ): Promise<{
    templateId: string;
    templateVersionId: string;
    versionNo: number;
    status: string;
  }> {
    assertTemplateAdmin(ctx);

    return transaction(async (tx: Tx) => {
      const version = await tx.questionnaireTemplateVersion.findUnique({
        where: { id: versionId },
      });
      if (!version) {
        throw new OperationError(
          ErrorCode.TEMPLATE_VERSION_NOT_FOUND,
          `模板版本不存在：${versionId}`
        );
      }
      if (version.status !== "draft") {
        throw new OperationError(
          ErrorCode.PERMISSION_DENIED,
          `模板版本状态为 ${version.status}，只有 draft 版本可以提交`
        );
      }

      const parsed = questionnaireSchema.parse(version.schema);
      const questionCount = parsed.sections.reduce(
        (n, s) => n + s.questions.length,
        0
      );

      if (parsed.sections.length === 0 || questionCount === 0) {
        throw new OperationError(
          ErrorCode.VALIDATION_ERROR,
          "问卷还是空的，至少要有 1 个分组和 1 个问题才能保存为模板版本",
          {
            path: "schema",
            sections: parsed.sections.length,
            questions: questionCount,
          }
        );
      }

      // 名称/说明落在模板上（同一模板的多个版本共享名称）
      if (input.name !== undefined || input.description !== undefined) {
        await tx.questionnaireTemplate.update({
          where: { id: version.templateId },
          data: {
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
          },
        });
      }

      const updated = await tx.questionnaireTemplateVersion.update({
        where: { id: versionId },
        data: {
          changeNote: input.changeNote ?? version.changeNote ?? "AI 生成初版",
        },
      });

      return {
        templateId: updated.templateId,
        templateVersionId: updated.id,
        versionNo: updated.versionNo,
        status: updated.status,
      };
    });
  },

  async disableVersion(
    templateId: string,
    versionId: string,
    ctx: ServiceContext
  ): Promise<TemplateVersionRow> {
    assertTemplateAdmin(ctx);

    return transaction(async (tx: Tx) => {
      const version = await tx.questionnaireTemplateVersion.findUnique({
        where: { id: versionId },
      });
      if (!version || version.templateId !== templateId) {
        throw new OperationError(
          ErrorCode.TEMPLATE_VERSION_NOT_FOUND,
          `模板版本不存在：${versionId}`
        );
      }

      const updated = await tx.questionnaireTemplateVersion.update({
        where: { id: versionId },
        data: { status: "disabled" },
      });

      // 若停用的正是当前版本，清空指针，避免模板指向已停用版本
      const template = await tx.questionnaireTemplate.findUnique({
        where: { id: templateId },
      });
      if (template?.currentVersionId === versionId) {
        await tx.questionnaireTemplate.update({
          where: { id: templateId },
          data: { currentVersionId: null },
        });
      }

      // ---- 同步模板状态，避免出现「已发布却没有任何可用版本」 ----
      //
      // 原先只停用版本、清空 currentVersionId，却不改模板 status，
      // 于是模板会一直显示「已发布」，但既没有可用版本、也删不掉
      // （删除被「已发布不能删」拦住），用户被卡在中间没有任何出路。
      // 现在：没有任何已发布版本时，模板状态降为 disabled。
      const stillPublished = await tx.questionnaireTemplateVersion.count({
        where: { templateId, status: "published" },
      });
      if (stillPublished === 0 && template?.status === "published") {
        await tx.questionnaireTemplate.update({
          where: { id: templateId },
          data: { status: "disabled" },
        });
      }

      return updated;
    });
  },
};

export type TemplateService = typeof templateService;
