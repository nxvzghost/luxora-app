-- PD-001 / ADR-0040 — Motor de Disponibilidade, Fase 2 (C2).
-- RecurringBlock: Aggregate Root independente do Bounded Context
-- Availability, decisão registrada após análise comparativa formal (C1) —
-- referencia tenant_id/patient_id/therapist_id, nunca é possuído por
-- AvailabilityCalendar. Puramente aditiva, sem backfill (conceito novo,
-- nenhum dado pré-existente).

-- CreateTable
CREATE TABLE "recurring_block" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "therapist_id" TEXT NOT NULL,
    "first_occurrence" TIMESTAMP(3) NOT NULL,
    "interval_days" INTEGER NOT NULL,
    "modality" TEXT NOT NULL,
    "renewal_mode" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_block_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recurring_block_tenant_id_therapist_id_idx" ON "recurring_block"("tenant_id", "therapist_id");

-- AddForeignKey
ALTER TABLE "recurring_block" ADD CONSTRAINT "recurring_block_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_block" ADD CONSTRAINT "recurring_block_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_block" ADD CONSTRAINT "recurring_block_therapist_id_fkey" FOREIGN KEY ("therapist_id") REFERENCES "therapist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
