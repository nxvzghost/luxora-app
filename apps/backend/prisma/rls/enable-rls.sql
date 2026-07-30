-- Luxora — Row-Level Security (defesa em profundidade multi-tenant)
-- Fonte de verdade: docs/03-Database/09-Multi-Tenant.md
--
-- AD-002 (23/07/2026): este conteúdo foi incorporado à migration versionada
-- prisma/migrations/20260723190000_enable_rls/migration.sql — é isso que
-- roda de fato hoje, via `prisma migrate deploy`. Este arquivo é mantido só
-- como referência histórica; não edite um sem replicar no outro.
--
-- COMO APLICAR (ordem obrigatória):
--   1. `pnpm --filter @luxora/backend exec prisma migrate dev --name init`
--      → gera a migration inicial real a partir de schema.prisma, com timestamp
--        correto, criando todas as tabelas.
--   2. `pnpm --filter @luxora/backend exec prisma migrate dev --name enable_rls --create-only`
--      → cria uma migration vazia com timestamp posterior ao init.
--   3. Colar o conteúdo deste arquivo dentro do migration.sql gerado no passo 2.
--   4. `pnpm --filter @luxora/backend exec prisma migrate dev`
--      → aplica a migration de RLS.
--
-- Este arquivo NÃO é uma migration do Prisma em si (não está em prisma/migrations/)
-- — é o conteúdo-fonte a ser colado no passo 3, evitando que uma pasta de
-- migration numerada manualmente seja aplicada fora de ordem (uma pasta com
-- timestamp menor que o do init rodaria ANTES das tabelas existirem e falharia).
--
-- Funcionamento: toda transação do Backend deve executar, logo após abrir a conexão:
--   SET app.tenant_id = '<uuid-do-tenant-autenticado>';
-- O filtro de tenant_id na aplicação (Prisma, via TenantContext) continua obrigatório —
-- RLS é uma segunda camada, nunca substitui a primeira.

-- Tabelas multi-tenant (todas exceto tenant em si)
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'clinic_settings', 'ai_settings', 'user', 'therapist', 'patient',
    'appointment', 'session', 'billing', 'billing_session', 'payment', 'audit_log',
    'availability_calendar', 'clinic_holiday', 'recurring_block', 'tenant_api_key',
    'conversation', 'message', 'inbound_processing_inbox'
    -- inbound_processing_inbox (ADR-0054/AD-036): sem conflito do tipo
    -- whatsapp_integration — todo acesso acontece dentro do worker, já com
    -- TenantContext setado via ContextIdFactory, nunca precisa de bypass.
    -- whatsapp_integration DELIBERADAMENTE FORA desta lista — ADR-0053,
    -- ACHADO REAL confirmado por Teste Crítico real: uma primeira tentativa
    -- de habilitar RLS + bypass aqui (mesmo padrão de user/tenant_api_key)
    -- quebrou WhatsAppMessageProvider.send(), que consulta esta tabela
    -- deliberadamente FORA de TenantContext (pode rodar em worker de fila),
    -- filtrando por tenantId explícito no WHERE — sem nenhuma policy de
    -- SELECT compatível, RLS forçada faz essa consulta sempre devolver
    -- zero linhas, quebrando o envio real. Corrigir isso exigiria alterar
    -- WhatsAppMessageProvider (fluxo de saída já existente), fora de escopo
    -- da ADR-0053 (restrição aprovada: preservar a arquitetura existente).
    -- Revertido em prisma/migrations/20260728173344_revert_whatsapp_
    -- integration_rls. O lookup de Tenant por phoneNumberId (PD-007) usa
    -- PrismaClientProvider direto, mesmo padrão já estabelecido para esta
    -- tabela — nunca precisou de bypass de RLS de fato.
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t); -- força mesmo para o owner da tabela
    -- DROP POLICY IF EXISTS antes do CREATE — PD-001 Fase 2 (C2). Este
    -- script cresce a cada tabela nova do Bounded Context Availability
    -- (clinic_holiday em B3, recurring_block em C2); sem o DROP, reaplicar
    -- o array inteiro (necessário sempre que uma tabela nova entra na
    -- lista) falha com "policy already exists" em toda tabela já coberta
    -- por uma execução anterior, não só na tabela nova. Torna o script
    -- inteiro re-executável a qualquer momento, closing um gap que só
    -- tinha sido corrigido ad-hoc (fora deste arquivo) durante a B3.
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    -- tenant_id é TEXT no schema Prisma (String @id @default(uuid()) não vira
    -- o tipo nativo `uuid` do Postgres) — current_setting já retorna text,
    -- então SEM cast é o comportamento correto; ::uuid aqui quebrava com
    -- "operator does not exist: text = uuid" na primeira execução real.
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true))',
      t
    );
  END LOOP;
END $$;

-- billing_session não tem FK direta explícita de tenant_id no schema Prisma além do campo —
-- a policy acima cobre normalmente porque a coluna tenant_id existe na tabela.

-- ─────────────────────────────────────────────────────────────────────────
-- Exceções deliberadas e restritas (2, ambas usando o mesmo mecanismo de
-- opt-in explícito por transação — PrismaService.forAuthLookup()). ADR-0053
-- avaliou uma 3ª exceção (lookup por phoneNumberId) e concluiu que não é
-- necessária — ver nota acima, no array de tabelas cobertas por RLS.
-- ─────────────────────────────────────────────────────────────────────────

-- 1) Lookup de login por email
-- O fluxo de autenticação (AuthService.login, ver ADR-0024 — email é
-- globalmente único, não por Tenant) precisa localizar um usuário por email
-- ANTES de conhecer o tenantId — a policy `tenant_isolation` padrão
-- bloquearia isso (current_setting('app.tenant_id') não estaria setado).
--
-- Em vez de conceder BYPASSRLS a toda a aplicação (o que anularia a defesa
-- em profundidade para qualquer outra query), adicionamos uma SEGUNDA
-- policy de SELECT, exclusiva da tabela `user`, ativada apenas quando a
-- própria aplicação define explicitamente `app.bypass_tenant_check = 'true'`
-- — nunca por padrão, sempre um opt-in explícito por transação (ver
-- PrismaService.forAuthLookup(), o único lugar do código que faz isso).
--
-- Múltiplas policies de SELECT no Postgres são combinadas com OR: uma linha
-- é visível se QUALQUER policy aplicável passar. Isso significa que login
-- enxerga usuários de qualquer Tenant (necessário), enquanto toda leitura
-- comum de `user` continua restrita pela tenant_isolation normal.
CREATE POLICY auth_lookup_by_email ON "user"
  FOR SELECT
  USING (current_setting('app.bypass_tenant_check', true) = 'true');

-- 2) Lookup de API key por hash (PD-003, Módulo 17)
-- ─────────────────────────────────────────────────────────────────────────
-- TenantApiKeyGuard precisa localizar qual Tenant uma requisição pertence
-- a partir do hash da chave enviada no header — mesmo problema estrutural
-- do login por email (não dá pra saber o tenantId antes de já ter
-- encontrado a linha). Reaproveita o mesmo bypass, nunca abre um mecanismo
-- novo. Segunda e última exceção documentada — qualquer nova precisa do
-- mesmo nível de justificativa e revisão explícita, nunca generalizar isto
-- para "várias tabelas podem pedir bypass".
DROP POLICY IF EXISTS api_key_lookup_by_hash ON tenant_api_key;
CREATE POLICY api_key_lookup_by_hash ON tenant_api_key
  FOR SELECT
  USING (current_setting('app.bypass_tenant_check', true) = 'true');

-- Nota de operação: nenhuma conexão de aplicação deve usar um usuário de banco com
-- privilégio BYPASSRLS, exceto rotinas administrativas de migração — ver
-- docs/03-Database/09-Multi-Tenant.md, seção "Regras".
