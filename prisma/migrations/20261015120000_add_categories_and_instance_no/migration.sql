-- 模板分类 + 实例可读编号 + 实例编号发号器
--
-- 依据 docs/11-future-capability-plan.md 第 5.1 / 5.3 节。
--
-- 说明（与计划文档一致的取舍）：
--   1. questionnaire_templates.category_id 与 questionnaire_instances.instance_no
--      都设为**可空**：存量数据（7 个模板 / 13 个实例）在加列时没有值，
--      强制 NOT NULL 会让本迁移在既有库上失败。
--   2. 分类的删除策略是 RESTRICT（见下方外键）：分类是被模板引用的组织维度，
--      误删会静默清空模板的分类归属，宁可让删除失败。
--      这与仓库既有约定一致 —— 库里 RESTRICT 多、无级联删除。
--   3. 唯一约束是 (template_id, version_no)（已存在于 init 迁移），
--      **不是** (category_id, version)：后者会导致「同一分类下只能有一个 v1 模板」。

-- CreateTable
CREATE TABLE "questionnaire_template_categories" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "questionnaire_template_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- instance_no 的按天发号器：靠 INSERT ... ON CONFLICT DO UPDATE 原子自增，
-- 避免 count(*) + 1 在并发下撞号。仅内部使用，不对外暴露。
CREATE TABLE "instance_no_counters" (
    "day" VARCHAR(8) NOT NULL,
    "scope" VARCHAR(32) NOT NULL DEFAULT 'instance',
    "current" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "instance_no_counters_pkey" PRIMARY KEY ("day", "scope")
);

-- AlterTable
ALTER TABLE "questionnaire_instances" ADD COLUMN "instance_no" VARCHAR(64);

-- AlterTable
ALTER TABLE "questionnaire_templates" ADD COLUMN "category_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "questionnaire_template_categories_code_key" ON "questionnaire_template_categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "questionnaire_instances_instance_no_key" ON "questionnaire_instances"("instance_no");

-- CreateIndex
CREATE INDEX "questionnaire_templates_category_id_idx" ON "questionnaire_templates"("category_id");

-- AddForeignKey
ALTER TABLE "questionnaire_templates" ADD CONSTRAINT "questionnaire_templates_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "questionnaire_template_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
