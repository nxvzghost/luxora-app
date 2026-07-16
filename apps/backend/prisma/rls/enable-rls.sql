-- Luxora — Row-Level Security (defesa em profundidade multi-tenant)
-- Fonte de verdade: docs/03-Database/09-Multi-Tenant.md
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
    'appointment', 'session', 'billing', 'billing_session', 'payment', 'audit_log'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t); -- força mesmo para o owner da tabela
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      t
    );
  END LOOP;
END $$;

-- billing_session não tem FK direta explícita de tenant_id no schema Prisma além do campo —
-- a policy acima cobre normalmente porque a coluna tenant_id existe na tabela.

-- ─────────────────────────────────────────────────────────────────────────
-- Exceção deliberada e restrita: lookup de login por email
-- ─────────────────────────────────────────────────────────────────────────
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

-- Nota de operação: nenhuma conexão de aplicação deve usar um usuário de banco com
-- privilégio BYPASSRLS, exceto rotinas administrativas de migração — ver
-- docs/03-Database/09-Multi-Tenant.md, seção "Regras".
