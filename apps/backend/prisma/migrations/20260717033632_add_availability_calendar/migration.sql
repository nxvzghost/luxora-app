-- PD-001 / ADR-0040 — Motor de Disponibilidade, Fase 1 (Centralização).
-- `Therapist` perde `availability` — o dado migra de dono para o novo
-- Bounded Context `Availability` (AvailabilityCalendar, 1 por Terapeuta).

-- CreateTable
CREATE TABLE "availability_calendar" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "therapist_id" TEXT NOT NULL,
    "windows" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "availability_calendar_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "availability_calendar_therapist_id_key" ON "availability_calendar"("therapist_id");

-- AddForeignKey
ALTER TABLE "availability_calendar" ADD CONSTRAINT "availability_calendar_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_calendar" ADD CONSTRAINT "availability_calendar_therapist_id_fkey" FOREIGN KEY ("therapist_id") REFERENCES "therapist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: migra therapist.availability (formato antigo, sem duração própria
-- por janela) para availability_calendar.windows, atribuindo
-- sessionDurationMinutes = 60 (default sugerido) para cada janela existente —
-- ver docs/11-Product-Decisions/PD-001-Motor-de-Disponibilidade. Só migra
-- terapeutas com availability não-nula e não-vazia; o restante fica sem
-- AvailabilityCalendar até configurar (mesmo comportamento de "sem
-- disponibilidade configurada" que já existia antes).
INSERT INTO "availability_calendar" ("id", "tenant_id", "therapist_id", "windows", "created_at", "updated_at")
SELECT
  gen_random_uuid()::text,
  t."tenant_id",
  t."id",
  (
    SELECT jsonb_agg(elem || jsonb_build_object('sessionDurationMinutes', 60))
    FROM jsonb_array_elements(t."availability") AS elem
  ),
  now(),
  now()
FROM "therapist" t
WHERE t."availability" IS NOT NULL
  AND jsonb_array_length(t."availability") > 0;

-- AlterTable
ALTER TABLE "therapist" DROP COLUMN "availability";
