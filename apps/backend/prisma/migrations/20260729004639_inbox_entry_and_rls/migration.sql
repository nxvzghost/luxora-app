-- CreateEnum
CREATE TYPE "InboxEntryStatus" AS ENUM ('processing', 'generated', 'dispatched', 'failed');

-- CreateTable
CREATE TABLE "inbound_processing_inbox" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "correlation_id" TEXT,
    "status" "InboxEntryStatus" NOT NULL DEFAULT 'processing',
    "result_payload" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "last_error" TEXT,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "dispatched_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_processing_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inbound_processing_inbox_tenant_id_conversation_id_idx" ON "inbound_processing_inbox"("tenant_id", "conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_processing_inbox_channel_external_id_key" ON "inbound_processing_inbox"("channel", "external_id");

-- AddForeignKey
ALTER TABLE "inbound_processing_inbox" ADD CONSTRAINT "inbound_processing_inbox_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ADR-0054 (AD-036) — Row-Level Security para inbound_processing_inbox.
-- Sem conflito do tipo whatsapp_integration: todo acesso a esta tabela
-- acontece dentro do worker, depois que TenantContext já foi setado via
-- ContextIdFactory (ver WhatsAppInboundQueueWorker) — nunca há necessidade
-- de bypass. Mesmo padrão já aplicado a conversation/message.
ALTER TABLE "inbound_processing_inbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inbound_processing_inbox" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "inbound_processing_inbox";
CREATE POLICY tenant_isolation ON "inbound_processing_inbox" USING (tenant_id = current_setting('app.tenant_id', true));
