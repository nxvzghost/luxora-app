-- Luxora — Índice único parcial: previne dupla-reserva concorrente de horário
-- Fonte: Teste Crítico #10 (02 - CTO/clinicos/docs/09-Testes/01-Testes-Criticos.md)
--
-- AD-002 (23/07/2026): este conteúdo foi incorporado à migration versionada
-- prisma/migrations/20260723190000_enable_rls/migration.sql (como
-- CREATE UNIQUE INDEX IF NOT EXISTS, idempotente) — é isso que roda de fato
-- hoje, via `prisma migrate deploy`. Arquivo mantido só como referência
-- histórica; não edite um sem replicar no outro.
--
-- COMO APLICAR: mesmo processo de prisma/rls/enable-rls.sql — colar dentro
-- de uma migration criada via `prisma migrate dev --create-only`, depois
-- da migration inicial.
--
-- Por que não é um @@unique no schema.prisma: o Prisma Schema DSL não
-- suporta índice único CONDICIONAL (apenas sobre linhas em estado não-
-- terminal). Um @@unique incondicional em (tenant_id, therapist_id,
-- scheduled_at) impediria incorretamente reagendar um horário já cancelado
-- — o cancelamento deve liberar o slot para novo uso.
--
-- Efeito: duas chamadas concorrentes de AgendarConsulta para o mesmo
-- terapeuta/horário nunca resultam em duas linhas "vivas" — a segunda
-- falha na constraint do banco (erro de unique violation), nunca depende
-- apenas da checagem em memória feita por ScheduleSlot.overlapsWith()
-- (domain/availability/schedule-slot.value-object.ts, consultada via
-- VerificarDisponibilidadeUseCase desde o Motor de Disponibilidade —
-- ADR-0040), que sozinha não é suficiente sob concorrência real (race
-- condition clássica de check-then-act).
CREATE UNIQUE INDEX unique_active_appointment_slot
  ON appointment (tenant_id, therapist_id, scheduled_at)
  WHERE state != 'Cancelada';
