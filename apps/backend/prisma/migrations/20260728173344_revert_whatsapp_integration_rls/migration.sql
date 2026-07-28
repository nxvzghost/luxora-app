-- ADR-0053 (AD-007) — ACHADO REAL, corrigido durante a validação: a
-- migration anterior (20260728161842) habilitou RLS em whatsapp_integration
-- e uma policy de bypass (whatsapp_lookup_by_phone_number_id) para a
-- resolução de Tenant por phoneNumberId. Isso quebrou um padrão de acesso
-- LEGÍTIMO e pré-existente: WhatsAppMessageProvider.send() consulta essa
-- tabela via PrismaClientProvider direto (não PrismaService.forTenant()),
-- deliberadamente FORA de TenantContext (pode rodar em worker de fila, sem
-- requisição HTTP) — filtra por tenantId explícito no WHERE, nunca via
-- app.tenant_id. Com RLS forçada, essa consulta passou a devolver zero
-- linhas sempre (nenhuma policy de SELECT combinava), quebrando o envio
-- real (Teste Crítico [AD-005] confirmou isso rodando de verdade).
--
-- Corrigir WhatsAppMessageProvider para conviver com RLS está fora de
-- escopo desta AD (restrição aprovada: "preservação integral da
-- arquitetura existente" — não alterar o fluxo de saída). A correção
-- correta aqui é reverter a RLS desta tabela especificamente, mantendo
-- RLS em conversation/message (sem esse mesmo conflito, único caminho de
-- acesso é PrismaService.forTenant()).

DROP POLICY IF EXISTS whatsapp_lookup_by_phone_number_id ON "whatsapp_integration";
DROP POLICY IF EXISTS tenant_isolation ON "whatsapp_integration";
ALTER TABLE "whatsapp_integration" DISABLE ROW LEVEL SECURITY;
