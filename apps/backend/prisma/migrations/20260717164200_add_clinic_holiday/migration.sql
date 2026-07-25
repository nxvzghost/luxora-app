-- PD-001 / ADR-0040 — Motor de Disponibilidade, Fase 2 (B3).
-- ClinicHoliday: entidade própria do Bounded Context Availability,
-- referenciada por tenant_id — puramente aditiva, sem backfill (conceito
-- novo, nenhum dado pré-existente).

-- CreateTable
CREATE TABLE "clinic_holiday" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "from_date" TIMESTAMP(3) NOT NULL,
    "to_date" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clinic_holiday_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clinic_holiday_tenant_id_from_date_to_date_idx" ON "clinic_holiday"("tenant_id", "from_date", "to_date");

-- AddForeignKey
ALTER TABLE "clinic_holiday" ADD CONSTRAINT "clinic_holiday_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
