-- PD-004 (Assinaturas) / CEO-DEC-003.1 / CEO-DEC-003.2 / ADR-0039.
--
-- clinic_subscription ganha past_due_since (nullable) — marco de início do
-- estado PastDue, base do período de tolerância/regularização de 7 dias
-- exigido pelas decisões acima. Antes desta coluna, PAYMENT_OVERDUE
-- (ProcessarWebhookAssinaturaUseCase) bloqueava o acesso imediatamente,
-- sem nenhum prazo — divergência identificada no Relatório de
-- Reconciliação (Sprint 1, Priority 1).
--
-- Puramente aditiva, sem backfill: qualquer assinatura hoje em PastDue no
-- banco nasceu sob o comportamento antigo (sem tolerância) e ficará com
-- past_due_since = NULL após esta migration. A entidade (ClinicSubscription
-- .hasActiveAccess) trata PastDue sem past_due_since como fora do período
-- de tolerância — falha fechado, mantém o bloqueio já em vigor para essas
-- assinaturas em vez de liberar acesso por omissão de dado. Reavaliação
-- manual dessas assinaturas específicas é uma decisão operacional, fora do
-- escopo desta migration.

-- AlterTable
ALTER TABLE "clinic_subscription" ADD COLUMN     "past_due_since" TIMESTAMP(3);
