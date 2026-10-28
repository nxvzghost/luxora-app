-- K11 (ADR-0069, seção 10.1, rodada 5; decisões D1 a D8 de 23/10/2026) —
-- cancelamento e remarcação pelo WhatsApp em duas etapas: o pedido do
-- paciente e a resposta dele são comunicações distintas, ligadas e
-- preservadas; só a confirmação explícita, em mensagem seguinte, da mesma
-- conversa e antes do início, leva ao desfecho. Sem trigger e sem função.
--
-- O que esta migration garante, venha a escrita de que versão vier:
--   - um desfecho de autoria `ai_agent` só existe para cancelamento ou
--     remarcação, sem usuário, ligado ao pedido (com a ação pedida) e a uma
--     resposta `confirma` desse mesmo pedido, da mesma consulta, recebida
--     antes do início;
--   - a resposta pertence à mesma consulta e à mesma conversa do pedido;
--   - pedido e resposta são linhas distintas, e cada mensagem gera no máximo
--     uma comunicação (message_id único, da K2-b);
--   - o desfecho registrado por pessoa continua exigindo o usuário, e nada
--     da confirmação entra nele.
--
-- O estado do pedido (aguardando, confirmado, recusado, vencido...) é
-- derivado das comunicações: nenhuma coluna é reescrita (D2).
--
-- Versões anteriores leem `outcome_recorded_by_user_id` como obrigatório:
-- um desfecho da IA (com usuário nulo) as quebraria. Por isso a exigência
-- `appointment-ai-confirmation-v1` (D1): rollback para versão sem ela é
-- recusado, salvo retorno degradado registrado (MIGRATION_RUNBOOK).

CREATE TYPE "NoticeConfirmationAnswer" AS ENUM ('confirma', 'recusa', 'ambigua');
CREATE TYPE "NoticeRequestedAction" AS ENUM ('cancelar', 'remarcar');

-- Comunicação: o pedido que aguarda confirmação e a resposta a ele.
ALTER TABLE "appointment_notice" ADD COLUMN "conversation_id" TEXT,
ADD COLUMN "awaits_confirmation" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "requested_action" "NoticeRequestedAction",
ADD COLUMN "asked_scheduled_at" TIMESTAMP(3),
ADD COLUMN "asked_modality" TEXT,
ADD COLUMN "proposed_scheduled_at" TIMESTAMP(3),
ADD COLUMN "confirms_notice_id" TEXT,
ADD COLUMN "confirmation_answer" "NoticeConfirmationAnswer";

-- Desfecho: a autoria passa a ter tipo de ator; o da IA guarda o pedido e a confirmação.
ALTER TABLE "appointment_outcome" ADD COLUMN "outcome_recorded_by_actor_type" "ActorType" NOT NULL DEFAULT 'user',
ADD COLUMN "closing_requested_action" "NoticeRequestedAction",
ADD COLUMN "confirmation_notice_id" TEXT,
ADD COLUMN "confirmation_answer" "NoticeConfirmationAnswer",
ADD COLUMN "confirmation_notice_timing" "NoticeTiming",
ALTER COLUMN "outcome_recorded_by_user_id" DROP NOT NULL;

-- Alvos das chaves compostas.
CREATE UNIQUE INDEX "conversation_id_tenant_id_key" ON "conversation"("id", "tenant_id");
CREATE UNIQUE INDEX "appointment_notice_request_key" ON "appointment_notice"("id", "appointment_id", "requested_action");
CREATE UNIQUE INDEX "appointment_notice_conversation_key" ON "appointment_notice"("id", "appointment_id", "conversation_id");
CREATE UNIQUE INDEX "appointment_notice_confirmation_key" ON "appointment_notice"("id", "appointment_id", "confirms_notice_id", "confirmation_answer", "timing");
CREATE INDEX "appointment_notice_conversation_id_idx" ON "appointment_notice"("conversation_id");
CREATE INDEX "appointment_notice_confirms_notice_id_idx" ON "appointment_notice"("confirms_notice_id");

-- Onde as migrations rodam com o papel da aplicação, dono das tabelas (CI e
-- local), a K2-b tirou dele todo privilégio de tabela em appointment_notice,
-- inclusive REFERENCES, que criar uma chave estrangeira para ela exige. Só
-- nesse caso o privilégio é devolvido para as chaves abaixo e retirado logo
-- depois. Com a credencial de administrador (homologação e produção) nada
-- disso roda.
DO $$
BEGIN
  IF current_user = 'luxora_app'
     AND (SELECT relowner FROM pg_class WHERE oid = '"appointment_notice"'::regclass) = 'luxora_app'::regrole
     AND NOT has_table_privilege('luxora_app', '"appointment_notice"', 'REFERENCES') THEN
    GRANT REFERENCES ON "appointment_notice" TO luxora_app;
    PERFORM set_config('luxora.k11_temporary_references', 'on', false);
  END IF;
END $$;

-- Chaves estrangeiras. A checagem ignora a RLS: a clínica está na chave da conversa.
ALTER TABLE "appointment_notice" ADD CONSTRAINT "appointment_notice_conversation_fkey" FOREIGN KEY ("conversation_id", "tenant_id") REFERENCES "conversation"("id", "tenant_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- A resposta é da mesma consulta e da mesma conversa do pedido.
ALTER TABLE "appointment_notice" ADD CONSTRAINT "appointment_notice_confirms_fkey" FOREIGN KEY ("confirms_notice_id", "appointment_id", "conversation_id") REFERENCES "appointment_notice"("id", "appointment_id", "conversation_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- O desfecho da IA aponta para um pedido da mesma consulta, com a ação que ele pediu...
ALTER TABLE "appointment_outcome" ADD CONSTRAINT "appointment_outcome_request_fkey" FOREIGN KEY ("closing_notice_id", "appointment_id", "closing_requested_action") REFERENCES "appointment_notice"("id", "appointment_id", "requested_action") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- ...e para a resposta que confirma esse pedido, com a classificação de quando ela chegou.
ALTER TABLE "appointment_outcome" ADD CONSTRAINT "appointment_outcome_confirmation_fkey" FOREIGN KEY ("confirmation_notice_id", "appointment_id", "closing_notice_id", "confirmation_answer", "confirmation_notice_timing") REFERENCES "appointment_notice"("id", "appointment_id", "confirms_notice_id", "confirmation_answer", "timing") ON DELETE NO ACTION ON UPDATE NO ACTION;

DO $$
BEGIN
  IF current_setting('luxora.k11_temporary_references', true) = 'on' THEN
    REVOKE REFERENCES ON "appointment_notice" FROM luxora_app;
    PERFORM set_config('luxora.k11_temporary_references', 'off', false);
  END IF;
END $$;

-- CHECKs sobre a própria linha. Os que comparam colunas que podem ser nulas
-- ficam dentro de COALESCE(..., false): um CHECK aceita a linha cujo
-- resultado é NULL, e uma chave composta (MATCH SIMPLE) não confere a linha
-- com qualquer coluna nula — sem isso, um desfecho da IA sem a ação do pedido
-- ou sem a resposta classificada passaria pelas duas.
-- Pedido que aguarda confirmação: só da IA, pelo WhatsApp, numa conversa,
-- pedido pelo paciente, com o retrato da consulta perguntada; remarcar leva o
-- horário novo, e só remarcar o leva.
ALTER TABLE "appointment_notice" ADD CONSTRAINT "appointment_notice_request_check" CHECK (COALESCE(
  "awaits_confirmation" = ("requested_action" IS NOT NULL)
  AND (NOT "awaits_confirmation" OR (
    "channel" = 'whatsapp' AND "recorded_by_actor_type" = 'ai_agent' AND "requested_by" = 'paciente'
    AND "conversation_id" IS NOT NULL AND "asked_scheduled_at" IS NOT NULL AND "asked_modality" IS NOT NULL
    AND "confirms_notice_id" IS NULL
    AND CASE "requested_action"
          WHEN 'cancelar' THEN "intent" IN ('pedido_cancelamento', 'nao_comparecera')
          ELSE "intent" = 'pedido_remarcacao' END))
  AND CASE WHEN "requested_action" = 'remarcar' THEN "proposed_scheduled_at" IS NOT NULL
           ELSE "proposed_scheduled_at" IS NULL END, false));
-- Resposta a um pedido: a resposta e o pedido andam juntos; só da IA, pelo
-- WhatsApp, numa conversa, e nunca é ela mesma um pedido.
ALTER TABLE "appointment_notice" ADD CONSTRAINT "appointment_notice_reply_check" CHECK (
  ("confirms_notice_id" IS NULL) = ("confirmation_answer" IS NULL)
  AND ("confirms_notice_id" IS NULL OR (
    "channel" = 'whatsapp' AND "recorded_by_actor_type" = 'ai_agent'
    AND "conversation_id" IS NOT NULL AND NOT "awaits_confirmation")));
-- Autoria do desfecho (D1): pessoa, com o usuário e nada da confirmação; IA,
-- sem usuário, só cancelamento ou remarcação, ligada ao pedido com a ação
-- correspondente e a uma resposta `confirma` recebida antes do início.
ALTER TABLE "appointment_outcome" ADD CONSTRAINT "appointment_outcome_actor_check" CHECK (COALESCE(
  CASE "outcome_recorded_by_actor_type"
    WHEN 'user' THEN "outcome_recorded_by_user_id" IS NOT NULL
      AND "closing_requested_action" IS NULL AND "confirmation_notice_id" IS NULL
      AND "confirmation_answer" IS NULL AND "confirmation_notice_timing" IS NULL
    WHEN 'ai_agent' THEN "outcome_recorded_by_user_id" IS NULL
      AND "outcome" IN ('Cancelada', 'Remarcada')
      AND "closing_notice_id" IS NOT NULL AND "confirmation_notice_id" IS NOT NULL
      AND "confirmation_answer" = 'confirma'
      AND "confirmation_notice_timing" IN ('no_prazo', 'fora_do_prazo', 'sem_limite_configurado')
      AND "closing_requested_action" = CASE "outcome" WHEN 'Cancelada' THEN 'cancelar'::"NoticeRequestedAction" ELSE 'remarcar'::"NoticeRequestedAction" END
    ELSE false
  END, false));

-- Privilégios: o papel da aplicação continua só inserindo e lendo as
-- comunicações (UPDATE apenas nas colunas de revisão, da K2-b) e o desfecho
-- (UPDATE apenas nas colunas de desfecho e decisão). Nenhuma coluna nova é
-- atualizável: a autoria e a confirmação não são reescritas.

-- Exigência mínima de versão (D1), como na K2-b: onde as migrations rodam com
-- o papel da aplicação, dono das tabelas (CI e local), a concessão de INSERT
-- em deployment_requirement é devolvida só para esta gravação.
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
  VALUES ('appointment-ai-confirmation-v1', '20261023220000_k11_ai_confirmed_requests');
  IF app_owner_without_insert THEN
    REVOKE INSERT ON "deployment_requirement" FROM luxora_app;
  END IF;
END $$;
