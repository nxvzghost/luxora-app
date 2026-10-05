-- Fase 2 da auditoria (R6) — Row-Level Security em message_log.
--
-- message_log tem tenant_id e guarda telefone e corpo de cada mensagem
-- enviada, mas tinha ficado fora de toda migration de RLS. O único acesso do
-- código é PrismaMessageLogRepository, sempre via PrismaService.forTenant()
-- e SEM filtro de tenant na consulta (findUnique por idempotency_key) — o
-- repositório já pressupunha a RLS que a tabela não tinha: sem ela, uma
-- consulta feita no contexto de um Tenant devolveria a linha de outro.
--
-- Mesmo padrão das demais tabelas multi-tenant (ver 20260723190000_enable_rls
-- e 20260813171216_add_notification): RLS habilitada e forçada, policy
-- tenant_isolation pelo app.tenant_id da transação. Nenhum bypass: todo
-- acesso acontece com o Tenant já conhecido.
--
-- Idempotente (IF EXISTS no DROP; ENABLE/FORCE não falham se já ativos).
--
-- Reversão, se necessária (nova migration, nunca edição desta):
--   DROP POLICY IF EXISTS tenant_isolation ON "message_log";
--   ALTER TABLE "message_log" NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE "message_log" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "message_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_log" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "message_log";
CREATE POLICY tenant_isolation ON "message_log" USING (tenant_id = current_setting('app.tenant_id', true));
