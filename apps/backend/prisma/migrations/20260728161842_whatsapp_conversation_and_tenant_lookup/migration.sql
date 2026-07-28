-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('entrada', 'saida');

-- CreateTable
CREATE TABLE "conversation" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "patient_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "content" TEXT NOT NULL,
    "external_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'enviada',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_tenant_id_phone_number_key" ON "conversation"("tenant_id", "phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "message_external_id_key" ON "message"("external_id");

-- CreateIndex
CREATE INDEX "patient_tenant_id_phone_idx" ON "patient"("tenant_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_integration_phone_number_id_key" ON "whatsapp_integration"("phone_number_id");

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ADR-0053 (AD-007/AD-010) — Row-Level Security para as tabelas novas
-- (conversation, message) e para whatsapp_integration, que nunca tinha
-- RLS ativa (ACHADO REAL — ver prisma/rls/enable-rls.sql para o comentário
-- completo). Mesmo padrão já aplicado em prisma/migrations/20260723190000_enable_rls.
ALTER TABLE "conversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "conversation";
CREATE POLICY tenant_isolation ON "conversation" USING (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE "message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "message";
CREATE POLICY tenant_isolation ON "message" USING (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE "whatsapp_integration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_integration" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "whatsapp_integration";
CREATE POLICY tenant_isolation ON "whatsapp_integration" USING (tenant_id = current_setting('app.tenant_id', true));

-- ADR-0053 / PD-007 — 3ª exceção de bypass de RLS: lookup de Tenant por
-- phoneNumberId, mesmo mecanismo já usado por auth_lookup_by_email e
-- api_key_lookup_by_hash (prisma/migrations/20260723190000_enable_rls).
DROP POLICY IF EXISTS whatsapp_lookup_by_phone_number_id ON "whatsapp_integration";
CREATE POLICY whatsapp_lookup_by_phone_number_id ON "whatsapp_integration"
  FOR SELECT
  USING (current_setting('app.bypass_tenant_check', true) = 'true');
