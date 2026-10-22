-- K2-a (ADR-0069, seções 3.6, 3.7 e 9.4; exceção restrita à ADR-0060 aprovada
-- em 21/10/2026) — proteção da cobrança no próprio banco, sem trigger e sem
-- função, para que nenhuma versão da aplicação, nem uma antiga num rollback,
-- consiga criar cobrança sem conferir a elegibilidade nem vincular sessão de
-- outro paciente ou de outra clínica.
--
-- O que muda para uma versão que não conhece estas colunas (modo degradado):
--   - criar cobrança: recusado (o protocolo recebe o padrão 'nenhum', que não
--     existe em billing_eligibility_protocol);
--   - criar vínculo: recusado (patient_id é obrigatório nos vínculos novos);
--   - mudar o status de uma cobrança existente (quitar, enviar, régua):
--     continua funcionando. A chave estrangeira só é conferida quando a linha
--     é inserida ou quando o valor da chave muda; um CHECK seria conferido na
--     linha proposta do INSERT … ON CONFLICT DO UPDATE que o Prisma usa, e
--     bloquearia até a quitação (ADR-0069, seção 3.7).
--
-- Nenhum valor existente é alterado: as colunas novas entram com padrões
-- constantes (só metadado no PostgreSQL 16), e o padrão para as linhas novas
-- muda logo em seguida.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'luxora_app') THEN
    RAISE EXCEPTION 'K2-a: o papel da aplicação (luxora_app) não existe; os privilégios por coluna não podem ser aplicados (ver infra/docker/postgres-init/01-app-role.sql)';
  END IF;
END $$;

-- Protocolos de elegibilidade aceitos.
CREATE TABLE "billing_eligibility_protocol" (
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "billing_eligibility_protocol_pkey" PRIMARY KEY ("name")
);
INSERT INTO "billing_eligibility_protocol" ("name", "description")
VALUES ('billing-eligibility-v1', 'Paciente, clínica e estado da sessão conferidos, cobrança e vínculos numa única transação (K2-a)');

-- Exigência mínima de versão, lida por deploy.sh e rollback.sh.
CREATE TABLE "deployment_requirement" (
    "capability" TEXT NOT NULL,
    "required_since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "set_by_migration" TEXT NOT NULL,

    CONSTRAINT "deployment_requirement_pkey" PRIMARY KEY ("capability")
);
INSERT INTO "deployment_requirement" ("capability", "set_by_migration")
VALUES ('billing-eligibility-v1', '20261022120000_k2a_billing_eligibility');

-- Cobrança: as linhas existentes ficam marcadas como legadas, com protocolo nulo.
ALTER TABLE "billing" ADD COLUMN "legacy_billing" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "eligibility_protocol" TEXT;
ALTER TABLE "billing" ALTER COLUMN "legacy_billing" SET DEFAULT false,
ALTER COLUMN "eligibility_protocol" SET DEFAULT 'nenhum';

-- Vínculo: os vínculos existentes ficam marcados como legados, sem paciente.
ALTER TABLE "billing_session" ADD COLUMN "legacy_link" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "patient_id" TEXT;
ALTER TABLE "billing_session" ALTER COLUMN "legacy_link" SET DEFAULT false;

-- Alvos das chaves compostas.
CREATE UNIQUE INDEX "billing_id_tenant_id_patient_id_key" ON "billing"("id", "tenant_id", "patient_id");
CREATE UNIQUE INDEX "session_id_tenant_id_patient_id_key" ON "session"("id", "tenant_id", "patient_id");

-- Cobrança nova só com um protocolo aceito; protocolo nulo só nas legadas.
ALTER TABLE "billing" ADD CONSTRAINT "billing_eligibility_protocol_fkey" FOREIGN KEY ("eligibility_protocol") REFERENCES "billing_eligibility_protocol"("name") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "billing" ADD CONSTRAINT "billing_legacy_or_protocol_check" CHECK ("legacy_billing" OR "eligibility_protocol" IS NOT NULL);

-- Vínculo novo: cobrança e sessão do mesmo paciente e da mesma clínica. Os
-- vínculos legados têm patient_id nulo e, em MATCH SIMPLE, não são conferidos.
ALTER TABLE "billing_session" ADD CONSTRAINT "billing_session_billing_patient_fkey" FOREIGN KEY ("billing_id", "tenant_id", "patient_id") REFERENCES "billing"("id", "tenant_id", "patient_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "billing_session" ADD CONSTRAINT "billing_session_session_patient_fkey" FOREIGN KEY ("session_id", "tenant_id", "patient_id") REFERENCES "session"("id", "tenant_id", "patient_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "billing_session" ADD CONSTRAINT "billing_session_legacy_or_patient_check" CHECK ("legacy_link" OR "patient_id" IS NOT NULL);

-- Privilégios do papel da aplicação. Ele não grava legacy_billing nem
-- legacy_link (não consegue marcar uma linha nova como legada), não muda o
-- protocolo de uma cobrança existente, não muda vínculo existente e não
-- escreve nas tabelas de protocolo e de exigência. Leitura e exclusão
-- continuam como estavam.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "billing_eligibility_protocol" FROM luxora_app;
REVOKE ALL ON "deployment_requirement" FROM luxora_app;
REVOKE INSERT, UPDATE ON "billing", "billing_session" FROM luxora_app;
GRANT INSERT ("id", "tenant_id", "patient_id", "amount", "status", "due_date", "created_at", "updated_at", "eligibility_protocol") ON "billing" TO luxora_app;
GRANT UPDATE ("status", "updated_at") ON "billing" TO luxora_app;
GRANT INSERT ("id", "tenant_id", "billing_id", "session_id", "created_at", "patient_id") ON "billing_session" TO luxora_app;

-- Só onde o papel da aplicação é o dono das tabelas (CI e ambiente local, em
-- que as migrations rodam com ele): a checagem de chave estrangeira trava as
-- linhas com SELECT … FOR KEY SHARE usando o dono da tabela travada, e isso
-- exige UPDATE em pelo menos uma coluna dela. Sem estas duas concessões, o
-- dono não conseguiria inserir cobrança (trava o protocolo) nem excluir
-- cobrança ou sessão (trava os vínculos). As colunas não têm papel na
-- integridade. Em produção o dono é o administrador, que faz a checagem, e o
-- papel da aplicação fica sem UPDATE nessas tabelas. Onde é dono, o papel pode
-- devolver a si qualquer privilégio; ali os privilégios por coluna não são
-- barreira, e a prova deles vale para produção (ADR-0069, seção 3.7).
DO $$
BEGIN
  IF (SELECT relowner FROM pg_class WHERE oid = '"billing_eligibility_protocol"'::regclass) = 'luxora_app'::regrole THEN
    GRANT UPDATE ("description") ON "billing_eligibility_protocol" TO luxora_app;
  END IF;
  IF (SELECT relowner FROM pg_class WHERE oid = '"billing_session"'::regclass) = 'luxora_app'::regrole THEN
    GRANT UPDATE ("created_at") ON "billing_session" TO luxora_app;
  END IF;
END $$;
