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
  status: string;
  currentVersionId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
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
    input: { name: string; description?: string },
    ctx: ServiceContext
  ): Promise<TemplateRow> {
    assertTemplateAdmin(ctx);

    const name = input.name?.trim();
    if (!name) {
      throw validationError("模板名称不能为空", { path: "name" });
    }

    const id = newId();

    return prisma.questionnaireTemplate.create({
      data: {
        id,
        name,
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        status: "draft",
        createdBy: ctx.userId,
      },
    });
  },

  async listTemplates(
    query: { keyword?: string; status?: string },
    options: { skip: number; take: number }
  ): Promise<{ items: TemplateRow[]; total: number }> {
    const where = {
      ...(query.status ? { status: query.status } : {}),
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
      }),
      prisma.questionnaireTemplate.count({ where }),
    ]);

    return { items, total };
  },

  async getTemplate(templateId: string): Promise<TemplateRow> {
    const found = await prisma.questionnaireTemplate.findUnique({
      where: { id: templateId },
    });
    if (!found) {
      throw new OperationError(
        ErrorCode.TEMPLATE_NOT_FOUND,
        `模板不存在：${templateId}`
      );
    }
    return found;
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

      return updated;
    });
  },
};

export type TemplateService = typeof templateService;
