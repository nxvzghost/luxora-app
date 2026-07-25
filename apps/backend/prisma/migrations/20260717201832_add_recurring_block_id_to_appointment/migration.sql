-- PD-001 / ADR-0040 — Motor de Disponibilidade, Fase 2 (C3).
-- Appointment ganha recurring_block_id (nullable) — referência à ocorrência
-- materializada a partir de um RecurringBlock (C1/C2). Puramente aditiva,
-- sem backfill: nenhum Appointment existente foi criado a partir de um
-- RecurringBlock (o conceito não existia até agora).
--
-- UNIQUE(recurring_block_id, scheduled_at) é a garantia física de
-- idempotência da materialização (decisão arquitetural C3, ver relatório):
-- NULL nunca colide consigo mesmo no Postgres, então Appointments avulsos
-- (recurring_block_id = NULL) nunca são afetados por esta constraint —
-- diferente do índice único parcial de unique-active-appointment.sql
-- (ADR-0028), que existe por outro motivo (excluir estados terminais) e
-- por isso precisa de SQL bruto fora do Prisma Schema DSL. Aqui o @@unique
-- nativo do Prisma já é suficiente.
--
-- ON DELETE SET NULL (não RESTRICT, diferente das demais FKs deste
-- schema): se um RecurringBlock for removido no futuro, os Appointments já
-- materializados não devem ser bloqueados nem apagados — só perdem a
-- referência à origem, continuam existindo como Appointments normais.

-- AlterTable
ALTER TABLE "appointment" ADD COLUMN     "recurring_block_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "appointment_recurring_block_id_scheduled_at_key" ON "appointment"("recurring_block_id", "scheduled_at");

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_recurring_block_id_fkey" FOREIGN KEY ("recurring_block_id") REFERENCES "recurring_block"("id") ON DELETE SET NULL ON UPDATE CASCADE;
