-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_tenant_id_created_at_idx" ON "notification"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "notification_tenant_id_read_at_idx" ON "notification"("tenant_id", "read_at");

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Epic 12 (AD-021) -- Row-Level Security para notification, mesmo padrão de
-- contact/contact_patient_association (ADR-0055/AD-018): toda notificação é
-- criada dentro do fluxo autenticado (RegistrarPagamentoUseCase, já dentro
-- de TenantContext), nunca há necessidade de bypass.
ALTER TABLE "notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "notification";
CREATE POLICY tenant_isolation ON "notification" USING (tenant_id = current_setting('app.tenant_id', true));
