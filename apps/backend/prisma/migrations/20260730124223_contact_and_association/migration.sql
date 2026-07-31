-- CreateEnum
CREATE TYPE "ContactState" AS ENUM ('Novo', 'Conversando', 'Identificado', 'Vinculado', 'Promovido', 'Arquivado', 'Descartado');

-- CreateEnum
CREATE TYPE "ContactPatientRole" AS ENUM ('proprio_paciente', 'responsavel_por');

-- CreateTable
CREATE TABLE "contact" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "name" TEXT,
    "state" "ContactState" NOT NULL DEFAULT 'Novo',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_patient_association" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "role" "ContactPatientRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_patient_association_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contact_tenant_id_phone_number_key" ON "contact"("tenant_id", "phone_number");

-- CreateIndex
CREATE INDEX "contact_patient_association_tenant_id_patient_id_idx" ON "contact_patient_association"("tenant_id", "patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_patient_association_contact_id_patient_id_key" ON "contact_patient_association"("contact_id", "patient_id");

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_patient_association" ADD CONSTRAINT "contact_patient_association_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_patient_association" ADD CONSTRAINT "contact_patient_association_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_patient_association" ADD CONSTRAINT "contact_patient_association_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ADR-0055 (AD-018) — Row-Level Security para contact e
-- contact_patient_association. Sem conflito do tipo whatsapp_integration:
-- toda resolução de Contact acontece depois do Tenant já identificado via
-- phoneNumberId (mesmo raciocínio já usado para conversation/message/
-- inbound_processing_inbox) — nunca há necessidade de bypass.
ALTER TABLE "contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "contact";
CREATE POLICY tenant_isolation ON "contact" USING (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE "contact_patient_association" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_patient_association" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "contact_patient_association";
CREATE POLICY tenant_isolation ON "contact_patient_association" USING (tenant_id = current_setting('app.tenant_id', true));
