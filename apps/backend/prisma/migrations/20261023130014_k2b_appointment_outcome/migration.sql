-- K2-b (ADR-0069, seções 2.4, 2.7, 2.9, 3.2, 3.2b, 3.3 e 3.7; exceção restrita
-- à ADR-0060 aprovada em 21/10/2026) — desfecho da consulta e elegibilidade
-- definitiva das sessões para cobrança, no próprio banco, sem trigger e sem
-- função.
--
-- O que esta migration garante, venha a escrita de que versão vier:
--   - um vínculo novo de cobrança só aponta para sessão ELEGÍVEL, do mesmo
--     paciente e da mesma clínica (chave composta com a elegibilidade);
--   - uma sessão só é elegível com o que ela cobra (kind) e sem anulação;
--   - uma sessão vinculada não deixa de ser elegível;
--   - toda sessão que já existia (legada, criada pela confirmação) e toda
--     sessão criada por uma versão que não conhece a coluna nasce não
--     elegível (DP-27): nenhum desfecho histórico é inventado;
--   - consulta com desfecho fica congelada: state, scheduled_at e modality
--     não mudam e a consulta não é apagada (chave estrangeira do retrato); o
--     papel da aplicação não a atualiza em nada (política RLS restritiva) e
--     não apaga nem reescreve o retrato.
--
-- AppointmentState não ganha valor novo (alternativa (b)): uma versão
-- anterior lê todas as consultas. O que muda para ela (modo degradado):
--   - confirmar, cancelar ou remarcar consulta com desfecho: recusado;
--   - a sessão que a confirmação dela cria nasce não elegível, e por isso
--     ela não consegue cobrá-la (o vínculo é recusado e a cobrança desfeita).
-- Cobranças, vínculos e pagamentos existentes não são alterados: as colunas
-- novas entram com padrões constantes (só metadado no PostgreSQL 16) ou nulas.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'luxora_app') THEN
    RAISE EXCEPTION 'K2-b: o papel da aplicação (luxora_app) não existe; os privilégios e a política restritiva não podem ser aplicados (ver infra/docker/postgres-init/01-app-role.sql)';
  END IF;
END $$;

-- Enums novos. Nenhum enum existente ganha valor.
CREATE TYPE "AppointmentOutcome" AS ENUM ('Realizada', 'Falta', 'FaltaAbonada', 'AvisoTardio', 'Remarcada', 'Cancelada');
CREATE TYPE "NoShowDecision" AS ENUM ('aguardando_decisao', 'cobranca_confirmada');
CREATE TYPE "LateNoticeDecision" AS ENUM ('aguardando_decisao', 'sem_cobranca', 'cobranca_confirmada');
CREATE TYPE "NoticeTiming" AS ENUM ('no_prazo', 'fora_do_prazo', 'sem_limite_configurado', 'depois_do_inicio');
CREATE TYPE "NoticeIntent" AS ENUM ('nao_comparecera', 'atraso', 'pedido_cancelamento', 'pedido_remarcacao', 'indefinida');
CREATE TYPE "NoticeIntentSource" AS ENUM ('ia', 'pessoa');
CREATE TYPE "NoticeChannel" AS ENUM ('whatsapp', 'painel');
CREATE TYPE "NoticeReferenceSource" AS ENUM ('meta_timestamp', 'recebimento_webhook', 'registro_no_painel');
CREATE TYPE "NoticeRequestedBy" AS ENUM ('paciente', 'clinica', 'profissional');
CREATE TYPE "NoticeReviewStatus" AS ENUM ('pendente', 'revisada', 'sem_revisao_necessaria');
CREATE TYPE "AppointmentDecisionKind" AS ENUM ('cobranca_de_falta_confirmada', 'falta_abonada', 'abono_revertido');
CREATE TYPE "SessionKind" AS ENUM ('atendimento', 'falta', 'aviso_fora_do_prazo', 'aviso_tardio');
CREATE TYPE "SessionVoidReason" AS ENUM ('desfecho_corrigido', 'legado_consulta_cancelada', 'legado_consulta_futura');
CREATE TYPE "BillingEligibility" AS ENUM ('elegivel', 'nao_elegivel');

-- Consulta: a remarcação liga a ocorrência nova à anterior.
ALTER TABLE "appointment" ADD COLUMN "rescheduled_from_id" TEXT;

-- Sessão: toda sessão existente fica não elegível e sem kind — nenhuma tem
-- desfecho comprovado (DP-27, item 5). O padrão continua valendo para as
-- linhas novas: uma versão que não conhece a coluna cria sessão não elegível.
ALTER TABLE "session" ADD COLUMN "billing_eligibility" "BillingEligibility" NOT NULL DEFAULT 'nao_elegivel',
ADD COLUMN "kind" "SessionKind",
ADD COLUMN "void_reason" "SessionVoidReason",
ADD COLUMN "voided_at" TIMESTAMP(3),
ADD COLUMN "voided_by_user_id" TEXT;

-- Vínculo: os vínculos existentes (inclusive os gravados com paciente depois
-- do K2-a) apontam para sessões legadas, não elegíveis; ficam marcados como
-- anteriores à K2-b, com a elegibilidade exigida nula, e a chave composta
-- (MATCH SIMPLE) não os confere. Os vínculos novos recebem 'elegivel'.
ALTER TABLE "billing_session" ADD COLUMN "legacy_eligibility_link" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "required_eligibility" "BillingEligibility";
ALTER TABLE "billing_session" ALTER COLUMN "legacy_eligibility_link" SET DEFAULT false,
ALTER COLUMN "required_eligibility" SET DEFAULT 'elegivel';

-- Desfecho (1:1 com a consulta) e o retrato que a congela.
CREATE TABLE "appointment_outcome" (
    "appointment_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "outcome" "AppointmentOutcome" NOT NULL,
    "outcome_recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome_recorded_by_user_id" TEXT NOT NULL,
    "state_at_outcome" "AppointmentState" NOT NULL,
    "scheduled_at_at_outcome" TIMESTAMP(3) NOT NULL,
    "modality_at_outcome" TEXT NOT NULL,
    "closing_notice_id" TEXT,
    "closing_notice_timing" "NoticeTiming",
    "no_show_decision" "NoShowDecision",
    "no_show_decision_at" TIMESTAMP(3),
    "no_show_decision_by_user_id" TEXT,
    "late_notice_decision" "LateNoticeDecision",
    "late_notice_decision_at" TIMESTAMP(3),
    "late_notice_decision_by_user_id" TEXT,

    CONSTRAINT "appointment_outcome_pkey" PRIMARY KEY ("appointment_id")
);

-- Comunicação do paciente, somente acréscimo.
CREATE TABLE "appointment_notice" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "appointment_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "channel" "NoticeChannel" NOT NULL,
    "message_id" TEXT,
    "provider_sent_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference_time" TIMESTAMP(3) NOT NULL,
    "reference_source" "NoticeReferenceSource" NOT NULL,
    "timing" "NoticeTiming" NOT NULL,
    "minutes_from_start" INTEGER NOT NULL,
    "limit_hours_applied" INTEGER,
    "intent" "NoticeIntent" NOT NULL,
    "intent_source" "NoticeIntentSource" NOT NULL,
    "ambiguous" BOOLEAN NOT NULL DEFAULT false,
    "requested_by" "NoticeRequestedBy",
    "arrived_after_outcome" BOOLEAN NOT NULL DEFAULT false,
    "outcome_at_arrival" "AppointmentOutcome",
    "recorded_by_user_id" TEXT,
    "recorded_by_actor_type" "ActorType" NOT NULL,
    "reason" VARCHAR(200),
    "review_status" "NoticeReviewStatus" NOT NULL DEFAULT 'pendente',
    "reviewed_by_user_id" TEXT,
    "reviewed_at" TIMESTAMP(3),

    CONSTRAINT "appointment_notice_pkey" PRIMARY KEY ("id")
);

-- Decisões sobre o desfecho, somente acréscimo (o motivo de cada uma fica).
CREATE TABLE "appointment_decision" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "appointment_id" TEXT NOT NULL,
    "decision" "AppointmentDecisionKind" NOT NULL,
    "reason" VARCHAR(200),
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_user_id" TEXT NOT NULL,

    CONSTRAINT "appointment_decision_pkey" PRIMARY KEY ("id")
);

-- Índices e alvos das chaves compostas.
CREATE UNIQUE INDEX "appointment_outcome_appointment_id_tenant_id_key" ON "appointment_outcome"("appointment_id", "tenant_id");
CREATE UNIQUE INDEX "appointment_notice_message_id_key" ON "appointment_notice"("message_id");
CREATE INDEX "appointment_notice_tenant_id_appointment_id_idx" ON "appointment_notice"("tenant_id", "appointment_id");
CREATE UNIQUE INDEX "appointment_notice_closing_key" ON "appointment_notice"("id", "appointment_id", "timing");
CREATE INDEX "appointment_decision_tenant_id_appointment_id_idx" ON "appointment_decision"("tenant_id", "appointment_id");
CREATE UNIQUE INDEX "appointment_rescheduled_from_id_key" ON "appointment"("rescheduled_from_id");
CREATE UNIQUE INDEX "appointment_freeze_key" ON "appointment"("id", "tenant_id", "state", "scheduled_at", "modality");
CREATE UNIQUE INDEX "appointment_id_tenant_id_patient_id_key" ON "appointment"("id", "tenant_id", "patient_id");
CREATE UNIQUE INDEX "session_eligibility_key" ON "session"("id", "tenant_id", "patient_id", "billing_eligibility");

-- Chaves estrangeiras. A checagem de chave estrangeira ignora a RLS: por isso
-- a clínica (e o paciente, onde importa) está na própria chave.
-- Congelamento: mudar state, scheduled_at ou modality de uma consulta com
-- desfecho deixa o retrato apontando para uma chave que não existe mais, e o
-- banco recusa (23503). Apagar a consulta também é recusado.
ALTER TABLE "appointment_outcome" ADD CONSTRAINT "appointment_outcome_freeze_fkey" FOREIGN KEY ("appointment_id", "tenant_id", "state_at_outcome", "scheduled_at_at_outcome", "modality_at_outcome") REFERENCES "appointment"("id", "tenant_id", "state", "scheduled_at", "modality") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- A comunicação que encerra o desfecho é da mesma consulta, e a classificação dela vai junto.
ALTER TABLE "appointment_outcome" ADD CONSTRAINT "appointment_outcome_closing_notice_fkey" FOREIGN KEY ("closing_notice_id", "appointment_id", "closing_notice_timing") REFERENCES "appointment_notice"("id", "appointment_id", "timing") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "appointment_notice" ADD CONSTRAINT "appointment_notice_appointment_fkey" FOREIGN KEY ("appointment_id", "tenant_id", "patient_id") REFERENCES "appointment"("id", "tenant_id", "patient_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "appointment_decision" ADD CONSTRAINT "appointment_decision_outcome_fkey" FOREIGN KEY ("appointment_id", "tenant_id") REFERENCES "appointment_outcome"("appointment_id", "tenant_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_rescheduled_from_fkey" FOREIGN KEY ("rescheduled_from_id", "tenant_id", "patient_id") REFERENCES "appointment"("id", "tenant_id", "patient_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- Elegibilidade: vínculo novo só com sessão elegível do mesmo paciente e da
-- mesma clínica; a sessão vinculada não deixa de ser elegível.
ALTER TABLE "billing_session" ADD CONSTRAINT "billing_session_session_eligibility_fkey" FOREIGN KEY ("session_id", "tenant_id", "patient_id", "required_eligibility") REFERENCES "session"("id", "tenant_id", "patient_id", "billing_eligibility") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- CHECKs sobre a própria linha (ADR-0069, seções 2.7 e 3.7). A linha da
-- consulta não ganha CHECK novo: recusaria cancelamentos das versões anteriores.
ALTER TABLE "session" ADD CONSTRAINT "session_billing_eligibility_check" CHECK ("billing_eligibility" <> 'elegivel' OR ("kind" IS NOT NULL AND "voided_at" IS NULL));
ALTER TABLE "session" ADD CONSTRAINT "session_void_check" CHECK (("voided_at" IS NULL) = ("void_reason" IS NULL));

ALTER TABLE "billing_session" ADD CONSTRAINT "billing_session_required_eligibility_check" CHECK ("required_eligibility" = 'elegivel');
ALTER TABLE "billing_session" ADD CONSTRAINT "billing_session_legacy_or_eligibility_check" CHECK ("legacy_eligibility_link" OR "required_eligibility" IS NOT NULL);

ALTER TABLE "appointment_outcome" ADD CONSTRAINT "appointment_outcome_state_check" CHECK (
  CASE WHEN "outcome" IN ('Remarcada', 'Cancelada') THEN "state_at_outcome" = 'Cancelada'
       ELSE "state_at_outcome" IN ('Reservada', 'Confirmada', 'Reagendada') END);
ALTER TABLE "appointment_outcome" ADD CONSTRAINT "appointment_outcome_no_show_decision_check" CHECK (("outcome" = 'Falta') = ("no_show_decision" IS NOT NULL));
ALTER TABLE "appointment_outcome" ADD CONSTRAINT "appointment_outcome_no_show_decided_check" CHECK (
  CASE WHEN "no_show_decision" = 'cobranca_confirmada' THEN "no_show_decision_at" IS NOT NULL AND "no_show_decision_by_user_id" IS NOT NULL
       ELSE "no_show_decision_at" IS NULL AND "no_show_decision_by_user_id" IS NULL END);
ALTER TABLE "appointment_outcome" ADD CONSTRAINT "appointment_outcome_late_notice_decision_check" CHECK ("late_notice_decision" IS NULL OR "outcome" IN ('AvisoTardio', 'Remarcada', 'Cancelada'));
ALTER TABLE "appointment_outcome" ADD CONSTRAINT "appointment_outcome_late_notice_decided_check" CHECK (
  CASE WHEN "late_notice_decision" IN ('sem_cobranca', 'cobranca_confirmada') THEN "late_notice_decision_at" IS NOT NULL AND "late_notice_decision_by_user_id" IS NOT NULL
       ELSE "late_notice_decision_at" IS NULL AND "late_notice_decision_by_user_id" IS NULL END);
-- A chave da comunicação só é conferida com as duas colunas preenchidas
-- (MATCH SIMPLE): as duas andam juntas, e só nos desfechos que a exigem.
ALTER TABLE "appointment_outcome" ADD CONSTRAINT "appointment_outcome_closing_notice_check" CHECK (
  ("closing_notice_id" IS NULL) = ("closing_notice_timing" IS NULL)
  AND (("outcome" IN ('AvisoTardio', 'Remarcada', 'Cancelada')) = ("closing_notice_id" IS NOT NULL)));
ALTER TABLE "appointment_outcome" ADD CONSTRAINT "appointment_outcome_closing_timing_check" CHECK (
  CASE WHEN "outcome" = 'AvisoTardio' THEN "closing_notice_timing" = 'depois_do_inicio'
       WHEN "outcome" IN ('Remarcada', 'Cancelada') THEN "closing_notice_timing" IN ('no_prazo', 'fora_do_prazo', 'sem_limite_configurado')
       ELSE true END);

ALTER TABLE "appointment_notice" ADD CONSTRAINT "appointment_notice_actor_check" CHECK (
  CASE WHEN "recorded_by_actor_type" = 'user' THEN "recorded_by_user_id" IS NOT NULL ELSE "recorded_by_user_id" IS NULL END);
-- Horário de referência: no painel, o do registro; no WhatsApp, o carimbo da
-- Meta ou o recebimento no webhook — nunca o processamento na fila, nunca o alegado.
ALTER TABLE "appointment_notice" ADD CONSTRAINT "appointment_notice_reference_check" CHECK (
  CASE WHEN "channel" = 'painel' THEN "reference_source" = 'registro_no_painel' AND "reference_time" = "recorded_at" AND "message_id" IS NULL
       ELSE "received_at" IS NOT NULL
            AND (("reference_source" = 'meta_timestamp' AND "reference_time" = "provider_sent_at")
              OR ("reference_source" = 'recebimento_webhook' AND "reference_time" = "received_at")) END);
ALTER TABLE "appointment_notice" ADD CONSTRAINT "appointment_notice_timing_check" CHECK (("timing" = 'depois_do_inicio') = ("minutes_from_start" <= 0));
ALTER TABLE "appointment_notice" ADD CONSTRAINT "appointment_notice_limit_check" CHECK (("timing" IN ('no_prazo', 'fora_do_prazo')) = ("limit_hours_applied" IS NOT NULL));
ALTER TABLE "appointment_notice" ADD CONSTRAINT "appointment_notice_review_check" CHECK (
  CASE WHEN "review_status" = 'revisada' THEN "reviewed_at" IS NOT NULL AND "reviewed_by_user_id" IS NOT NULL
       ELSE "reviewed_at" IS NULL AND "reviewed_by_user_id" IS NULL END);

-- Abono e reversão só com motivo (DP-23, DP-24a).
ALTER TABLE "appointment_decision" ADD CONSTRAINT "appointment_decision_reason_check" CHECK (
  "decision" = 'cobranca_de_falta_confirmada' OR ("reason" IS NOT NULL AND length(btrim("reason")) > 0));

-- Row-Level Security, como as demais tabelas com dado de clínica.
ALTER TABLE "appointment_outcome" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_outcome" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "appointment_outcome" USING (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE "appointment_notice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_notice" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "appointment_notice" USING (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE "appointment_decision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_decision" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "appointment_decision" USING (tenant_id = current_setting('app.tenant_id', true));

-- Congelamento, complemento da chave do retrato: nenhum UPDATE do papel da
-- aplicação alcança uma consulta com desfecho, em coluna nenhuma. Precisa ser
-- RESTRICTIVE: combinada por AND com tenant_isolation (uma permissiva seria
-- combinada por OR e não protegeria nada). Num UPDATE comum a linha fica fora
-- do alcance, sem erro; num INSERT … ON CONFLICT DO UPDATE, erro.
CREATE POLICY appointment_frozen_after_outcome ON "appointment" AS RESTRICTIVE FOR UPDATE TO luxora_app
  USING (NOT EXISTS (SELECT 1 FROM "appointment_outcome" o WHERE o."appointment_id" = "appointment"."id"));

-- Privilégios do papel da aplicação.
--   appointment_outcome: lê e insere; atualiza só o desfecho e as decisões —
--     nunca o retrato, a consulta, a clínica ou a autoria do registro; não apaga.
--   appointment_notice: lê e insere; atualiza só a revisão; não apaga.
--   appointment_decision: lê e insere; não muda nem apaga.
--   billing_session: insere a elegibilidade exigida (o Prisma manda o padrão),
--     nunca legacy_eligibility_link, que só esta migration preenche.
REVOKE ALL ON "appointment_outcome", "appointment_notice", "appointment_decision" FROM luxora_app;
GRANT SELECT, INSERT ON "appointment_outcome", "appointment_notice", "appointment_decision" TO luxora_app;
GRANT UPDATE ("outcome", "no_show_decision", "no_show_decision_at", "no_show_decision_by_user_id", "late_notice_decision", "late_notice_decision_at", "late_notice_decision_by_user_id") ON "appointment_outcome" TO luxora_app;
GRANT UPDATE ("review_status", "reviewed_by_user_id", "reviewed_at") ON "appointment_notice" TO luxora_app;
GRANT INSERT ("required_eligibility") ON "billing_session" TO luxora_app;

-- Só onde o papel da aplicação é o dono das tabelas (CI e ambiente local):
-- apagar um desfecho (só a limpeza dos testes faz isso, com superusuário)
-- confere as decisões com SELECT … FOR KEY SHARE usando o dono de
-- appointment_decision, e isso exige UPDATE em uma coluna dela (mesmo achado
-- do K2-a). Em produção o dono é o administrador e a concessão não existe.
DO $$
BEGIN
  IF (SELECT relowner FROM pg_class WHERE oid = '"appointment_decision"'::regclass) = 'luxora_app'::regrole THEN
    GRANT UPDATE ("decided_at") ON "appointment_decision" TO luxora_app;
  END IF;
END $$;

-- Exigência mínima de versão, lida por deploy.sh e rollback.sh: uma versão
-- sem a capacidade é retorno degradado (MIGRATION_RUNBOOK).
-- Onde as migrations rodam com o papel da aplicação, dono das tabelas (CI e
-- ambiente local), o K2-a tirou dele todo acesso a deployment_requirement: só
-- nesse caso a concessão é devolvida para esta gravação e retirada logo em
-- seguida. Com a credencial de administrador (homologação e produção) nada
-- disso roda.
DO $$
DECLARE
  app_owner_without_insert boolean :=
    current_user = 'luxora_app'
    AND (SELECT relowner FROM pg_class WHERE oid = '"deployment_requirement"'::regclass) = 'luxora_app'::regrole
    AND NOT has_table_privilege('luxora_app', '"deployment_requirement"', 'INSERT');
BEGIN
  IF app_owner_without_insert THEN
    GRANT INSERT ON "deployment_requirement" TO luxora_app;
  END IF;
  INSERT INTO "deployment_requirement" ("capability", "set_by_migration")
  VALUES ('appointment-outcome-v1', '20261023130014_k2b_appointment_outcome');
  IF app_owner_without_insert THEN
    REVOKE INSERT ON "deployment_requirement" FROM luxora_app;
  END IF;
END $$;
