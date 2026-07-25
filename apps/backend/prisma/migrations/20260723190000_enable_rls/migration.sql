-- AD-002 — Formaliza como migration versionada a Row-Level Security e o
-- índice único de concorrência que, até aqui, só existiam como scripts
-- soltos aplicados manualmente (prisma/rls/enable-rls.sql e
-- prisma/rls/unique-active-appointment.sql — ambos preservados como
-- referência histórica, seu conteúdo agora vive aqui).
--
-- Idempotente por construção: toda ALTER TABLE ... ENABLE/FORCE ROW LEVEL
-- SECURITY não falha se já ativa; todo CREATE POLICY é precedido de DROP
-- POLICY IF EXISTS; o índice usa CREATE UNIQUE INDEX IF NOT EXISTS. Seguro
-- para rodar tanto em banco limpo quanto em um banco que já teve estes
-- scripts aplicados manualmente antes desta migration existir.
--
-- Funcionamento: toda transação do Backend deve executar, logo após abrir a
-- conexão: SET app.tenant_id = '<uuid-do-tenant-autenticado>'. O filtro de
-- tenant_id na aplicação (Prisma, via TenantContext) continua obrigatório —
-- RLS é uma segunda camada, nunca substitui a primeira.

-- ─────────────────────────────────────────────────────────────────────────
-- RLS — tabelas multi-tenant (todas exceto tenant em si)
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'clinic_settings', 'ai_settings', 'user', 'therapist', 'patient',
    'appointment', 'session', 'billing', 'billing_session', 'payment', 'audit_log',
    'availability_calendar', 'clinic_holiday', 'recurring_block', 'tenant_api_key'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t); -- força mesmo para o owner da tabela
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    -- tenant_id é TEXT no schema Prisma (String @id @default(uuid()) não vira
    -- o tipo nativo `uuid` do Postgres) — current_setting já retorna text,
    -- então SEM cast é o comportamento correto.
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true))',
      t
    );
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Exceções deliberadas e restritas (2, ambas usando o mesmo mecanismo de
-- opt-in explícito por transação — PrismaService.forAuthLookup())
-- ─────────────────────────────────────────────────────────────────────────

-- 1) Lookup de login por email (AuthService.login, ADR-0024 — email é
-- globalmente único, não por Tenant). Múltiplas policies de SELECT no
-- Postgres são combinadas com OR: login enxerga usuários de qualquer
-- Tenant (necessário), leitura comum de `user` continua restrita pela
-- tenant_isolation normal.
DROP POLICY IF EXISTS auth_lookup_by_email ON "user";
CREATE POLICY auth_lookup_by_email ON "user"
  FOR SELECT
  USING (current_setting('app.bypass_tenant_check', true) = 'true');

-- 2) Lookup de API key por hash (PD-003, Módulo 17) — TenantApiKeyGuard
-- precisa localizar o Tenant a partir do hash antes de conhecê-lo. Reaproveita
-- o mesmo bypass; nunca abre mecanismo novo além destas 2 exceções.
DROP POLICY IF EXISTS api_key_lookup_by_hash ON tenant_api_key;
CREATE POLICY api_key_lookup_by_hash ON tenant_api_key
  FOR SELECT
  USING (current_setting('app.bypass_tenant_check', true) = 'true');

-- ─────────────────────────────────────────────────────────────────────────
-- Índice único parcial — previne dupla-reserva concorrente de horário
-- (Teste Crítico #10). Não é um @@unique no schema.prisma porque o Prisma
-- Schema DSL não suporta índice único condicional (só sobre linhas em
-- estado não-terminal) — um @@unique incondicional impediria reagendar um
-- horário já cancelado.
-- ─────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_appointment_slot
  ON appointment (tenant_id, therapist_id, scheduled_at)
  WHERE state != 'Cancelada';
