-- PD-004 (Assinaturas) / CEO-DEC-002.5 / CEO-DEC-003.6.
--
-- clinic_subscription ganha pending_plan (nullable, mesmo enum PlanTier) —
-- downgrade nunca é aplicado imediatamente (diferente de upgrade); fica
-- registrado aqui até o início do próximo ciclo de cobrança, quando
-- ClinicSubscription.applyPendingDowngrade() o efetiva. Nenhum gatilho
-- automático chama esse método ainda (depende de tratar o evento de
-- renovação de ciclo da Asaas, não mapeado hoje em
-- ProcessarWebhookAssinaturaUseCase) — pendência explícita, registrada no
-- Relatório da Priority 4, não implementada nesta migration.
--
-- Puramente aditiva, sem backfill: nenhuma assinatura existente tem
-- downgrade agendado (a funcionalidade não existia até agora).

-- AlterTable
ALTER TABLE "clinic_subscription" ADD COLUMN     "pending_plan" "PlanTier";
