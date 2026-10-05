-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(100) NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "password_hash" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questionnaire_templates" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "current_version_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "questionnaire_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questionnaire_template_versions" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "schema" JSONB NOT NULL,
    "change_note" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "source_type" VARCHAR(30) NOT NULL DEFAULT 'manual',
    "source_instance_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "questionnaire_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questionnaire_instances" (
    "id" UUID NOT NULL,
    "template_version_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "subject_info" JSONB,
    "current_schema" JSONB NOT NULL,
    "current_revision" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "questionnaire_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questionnaire_revisions" (
    "id" UUID NOT NULL,
    "questionnaire_instance_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "schema_snapshot" JSONB NOT NULL,
    "operation_type" VARCHAR(30),
    "operation_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "questionnaire_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "scene" VARCHAR(50) NOT NULL,
    "target_type" VARCHAR(50),
    "target_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" VARCHAR(20) NOT NULL,
    "content" TEXT,
    "tool_name" VARCHAR(100),
    "tool_call_id" VARCHAR(100),
    "tool_arguments" JSONB,
    "tool_result" JSONB,
    "sequence_no" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_tool_executions" (
    "id" UUID NOT NULL,
    "conversation_id" UUID,
    "questionnaire_instance_id" UUID,
    "message_id" UUID,
    "operation_id" UUID NOT NULL,
    "source" VARCHAR(20) NOT NULL DEFAULT 'ai_tool',
    "tool_name" VARCHAR(100) NOT NULL,
    "arguments" JSONB NOT NULL,
    "result" JSONB,
    "success" BOOLEAN NOT NULL,
    "error_code" VARCHAR(100),
    "model" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_tool_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_tasks" (
    "id" UUID NOT NULL,
    "questionnaire_instance_id" UUID NOT NULL,
    "assigned_to" UUID NOT NULL,
    "dispatched_by" UUID NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "dispatched_at" TIMESTAMPTZ(6),
    "due_at" TIMESTAMPTZ(6),
    "withdrawn_at" TIMESTAMPTZ(6),
    "withdrawn_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questionnaire_responses" (
    "id" UUID NOT NULL,
    "questionnaire_instance_id" UUID NOT NULL,
    "respondent_id" UUID NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "submitted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "questionnaire_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questionnaire_answers" (
    "id" UUID NOT NULL,
    "response_id" UUID NOT NULL,
    "question_id" VARCHAR(100) NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "answer" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "questionnaire_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_records" (
    "id" UUID NOT NULL,
    "questionnaire_response_id" UUID NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "result" VARCHAR(30) NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "questionnaire_templates_current_version_id_key" ON "questionnaire_templates"("current_version_id");

-- CreateIndex
CREATE INDEX "questionnaire_templates_status_idx" ON "questionnaire_templates"("status");

-- CreateIndex
CREATE INDEX "questionnaire_templates_created_by_idx" ON "questionnaire_templates"("created_by");

-- CreateIndex
CREATE INDEX "questionnaire_template_versions_template_id_idx" ON "questionnaire_template_versions"("template_id");

-- CreateIndex
CREATE UNIQUE INDEX "questionnaire_template_versions_template_id_version_no_key" ON "questionnaire_template_versions"("template_id", "version_no");

-- CreateIndex
CREATE INDEX "questionnaire_instances_template_version_id_idx" ON "questionnaire_instances"("template_version_id");

-- CreateIndex
CREATE INDEX "questionnaire_instances_status_idx" ON "questionnaire_instances"("status");

-- CreateIndex
CREATE INDEX "questionnaire_instances_created_by_idx" ON "questionnaire_instances"("created_by");

-- CreateIndex
CREATE INDEX "questionnaire_revisions_questionnaire_instance_id_idx" ON "questionnaire_revisions"("questionnaire_instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "questionnaire_revisions_questionnaire_instance_id_revision__key" ON "questionnaire_revisions"("questionnaire_instance_id", "revision_no");

-- CreateIndex
CREATE INDEX "ai_conversations_user_id_idx" ON "ai_conversations"("user_id");

-- CreateIndex
CREATE INDEX "ai_messages_conversation_id_idx" ON "ai_messages"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_messages_conversation_id_sequence_no_key" ON "ai_messages"("conversation_id", "sequence_no");

-- CreateIndex
CREATE UNIQUE INDEX "ai_tool_executions_operation_id_key" ON "ai_tool_executions"("operation_id");

-- CreateIndex
CREATE INDEX "ai_tool_executions_conversation_id_idx" ON "ai_tool_executions"("conversation_id");

-- CreateIndex
CREATE INDEX "ai_tool_executions_questionnaire_instance_id_idx" ON "ai_tool_executions"("questionnaire_instance_id");

-- CreateIndex
CREATE INDEX "dispatch_tasks_assigned_to_idx" ON "dispatch_tasks"("assigned_to");

-- CreateIndex
CREATE INDEX "dispatch_tasks_status_idx" ON "dispatch_tasks"("status");

-- CreateIndex
CREATE INDEX "questionnaire_responses_questionnaire_instance_id_idx" ON "questionnaire_responses"("questionnaire_instance_id");

-- CreateIndex
CREATE INDEX "questionnaire_responses_respondent_id_idx" ON "questionnaire_responses"("respondent_id");

-- CreateIndex
CREATE UNIQUE INDEX "questionnaire_answers_response_id_question_id_key" ON "questionnaire_answers"("response_id", "question_id");

-- AddForeignKey
ALTER TABLE "questionnaire_templates" ADD CONSTRAINT "questionnaire_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questionnaire_templates" ADD CONSTRAINT "questionnaire_templates_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "questionnaire_template_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questionnaire_template_versions" ADD CONSTRAINT "questionnaire_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "questionnaire_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questionnaire_template_versions" ADD CONSTRAINT "questionnaire_template_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questionnaire_template_versions" ADD CONSTRAINT "questionnaire_template_versions_source_instance_id_fkey" FOREIGN KEY ("source_instance_id") REFERENCES "questionnaire_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questionnaire_instances" ADD CONSTRAINT "questionnaire_instances_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "questionnaire_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questionnaire_instances" ADD CONSTRAINT "questionnaire_instances_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questionnaire_revisions" ADD CONSTRAINT "questionnaire_revisions_questionnaire_instance_id_fkey" FOREIGN KEY ("questionnaire_instance_id") REFERENCES "questionnaire_instances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questionnaire_revisions" ADD CONSTRAINT "questionnaire_revisions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_tool_executions" ADD CONSTRAINT "ai_tool_executions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_tool_executions" ADD CONSTRAINT "ai_tool_executions_questionnaire_instance_id_fkey" FOREIGN KEY ("questionnaire_instance_id") REFERENCES "questionnaire_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_tool_executions" ADD CONSTRAINT "ai_tool_executions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "ai_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_tasks" ADD CONSTRAINT "dispatch_tasks_questionnaire_instance_id_fkey" FOREIGN KEY ("questionnaire_instance_id") REFERENCES "questionnaire_instances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_tasks" ADD CONSTRAINT "dispatch_tasks_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_tasks" ADD CONSTRAINT "dispatch_tasks_dispatched_by_fkey" FOREIGN KEY ("dispatched_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_tasks" ADD CONSTRAINT "dispatch_tasks_withdrawn_by_fkey" FOREIGN KEY ("withdrawn_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questionnaire_responses" ADD CONSTRAINT "questionnaire_responses_questionnaire_instance_id_fkey" FOREIGN KEY ("questionnaire_instance_id") REFERENCES "questionnaire_instances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questionnaire_responses" ADD CONSTRAINT "questionnaire_responses_respondent_id_fkey" FOREIGN KEY ("respondent_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questionnaire_answers" ADD CONSTRAINT "questionnaire_answers_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "questionnaire_responses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_records" ADD CONSTRAINT "review_records_questionnaire_response_id_fkey" FOREIGN KEY ("questionnaire_response_id") REFERENCES "questionnaire_responses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_records" ADD CONSTRAINT "review_records_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
