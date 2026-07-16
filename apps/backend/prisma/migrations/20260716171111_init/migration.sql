-- CreateEnum
CREATE TYPE "BillingPolicy" AS ENUM ('per_session', 'weekly', 'monthly');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'therapist', 'super_admin');

-- CreateEnum
CREATE TYPE "PatientState" AS ENUM ('Novo', 'Identificado', 'Cadastrado', 'Ativo', 'Agendado', 'Confirmado', 'EmSessao', 'PagamentoPendente', 'Pago', 'EmFollowUp', 'Inativo', 'Alta');

-- CreateEnum
CREATE TYPE "AppointmentState" AS ENUM ('Criada', 'Reservada', 'Confirmada', 'ReagendamentoSolicitado', 'Reagendada', 'Cancelada');

-- CreateEnum
CREATE TYPE "SessionState" AS ENUM ('Realizada', 'Faturada', 'Recebida');

-- CreateEnum
CREATE TYPE "BillingStatus" AS ENUM ('criada', 'enviada', 'visualizada', 'pendente', 'atrasada', 'negociada', 'escalada', 'quitada', 'cancelada');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('recebido', 'em_conferencia', 'confirmado', 'divergente', 'estornado');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('user', 'ai_agent', 'system');

-- CreateEnum
CREATE TYPE "AuditResult" AS ENUM ('success', 'failure');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('professional', 'business', 'enterprise');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('monthly', 'yearly');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'cancelled');

-- CreateTable
CREATE TABLE "tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinic_settings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "default_billing_policy" "BillingPolicy" NOT NULL DEFAULT 'per_session',
    "cancellation_hours_limit" INTEGER,
    "default_session_duration_minutes" INTEGER NOT NULL DEFAULT 50,
    "pix_key" TEXT,
    "payee_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clinic_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_integration" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "whatsapp_integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_settings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "monthly_budget_cap" DECIMAL(10,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "therapist_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "therapist" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "specialty" TEXT,
    "phone" TEXT,
    "availability" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "therapist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "state" "PatientState" NOT NULL DEFAULT 'Novo',
    "billing_policy_override" "BillingPolicy",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "therapist_id" TEXT NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "modality" TEXT NOT NULL DEFAULT 'presencial',
    "state" "AppointmentState" NOT NULL DEFAULT 'Criada',
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "appointment_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "therapist_id" TEXT NOT NULL,
    "state" "SessionState" NOT NULL DEFAULT 'Realizada',
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "BillingStatus" NOT NULL DEFAULT 'criada',
    "due_date" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_session" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "billing_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "billing_id" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "method" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'recebido',
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT,
    "actor_type" "ActorType" NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "payload" JSONB,
    "result" "AuditResult" NOT NULL,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_log" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "to_phone_number" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinic_subscription" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "plan" "PlanTier" NOT NULL,
    "billing_cycle" "BillingCycle" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'trialing',
    "asaas_customer_id" TEXT,
    "asaas_subscription_id" TEXT,
    "current_period_end" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clinic_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asaas_webhook_event" (
    "id" TEXT NOT NULL,
    "asaas_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asaas_webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clinic_settings_tenant_id_key" ON "clinic_settings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_integration_tenant_id_key" ON "whatsapp_integration"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_settings_tenant_id_key" ON "ai_settings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_therapist_id_key" ON "user"("therapist_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "appointment_tenant_id_therapist_id_scheduled_at_idx" ON "appointment"("tenant_id", "therapist_id", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "session_appointment_id_key" ON "session"("appointment_id");

-- CreateIndex
CREATE INDEX "session_tenant_id_patient_id_idx" ON "session"("tenant_id", "patient_id");

-- CreateIndex
CREATE INDEX "billing_tenant_id_patient_id_status_idx" ON "billing"("tenant_id", "patient_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "billing_session_session_id_key" ON "billing_session"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_billing_id_key" ON "payment"("billing_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_idempotency_key_key" ON "payment"("idempotency_key");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_created_at_idx" ON "audit_log"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_log_idempotency_key_key" ON "message_log"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "clinic_subscription_tenant_id_key" ON "clinic_subscription"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "clinic_subscription_asaas_subscription_id_key" ON "clinic_subscription"("asaas_subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "asaas_webhook_event_asaas_event_id_key" ON "asaas_webhook_event"("asaas_event_id");

-- AddForeignKey
ALTER TABLE "clinic_settings" ADD CONSTRAINT "clinic_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_integration" ADD CONSTRAINT "whatsapp_integration_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_therapist_id_fkey" FOREIGN KEY ("therapist_id") REFERENCES "therapist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "therapist" ADD CONSTRAINT "therapist_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient" ADD CONSTRAINT "patient_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_therapist_id_fkey" FOREIGN KEY ("therapist_id") REFERENCES "therapist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_therapist_id_fkey" FOREIGN KEY ("therapist_id") REFERENCES "therapist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing" ADD CONSTRAINT "billing_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing" ADD CONSTRAINT "billing_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_session" ADD CONSTRAINT "billing_session_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_session" ADD CONSTRAINT "billing_session_billing_id_fkey" FOREIGN KEY ("billing_id") REFERENCES "billing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_session" ADD CONSTRAINT "billing_session_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_billing_id_fkey" FOREIGN KEY ("billing_id") REFERENCES "billing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_log" ADD CONSTRAINT "message_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinic_subscription" ADD CONSTRAINT "clinic_subscription_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
