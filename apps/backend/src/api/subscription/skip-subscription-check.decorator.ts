import { SetMetadata } from '@nestjs/common';

export const SKIP_SUBSCRIPTION_CHECK = 'skipSubscriptionCheck';

/**
 * @SkipSubscriptionCheck() — Módulo 17.
 *
 * Marca um Controller ou handler como isento da checagem de assinatura
 * ativa. Uso restrito e explícito: login, a própria tela de assinatura
 * (senão uma clínica PastDue nunca conseguiria pagar pra sair do PastDue),
 * e o webhook da Asaas (que não representa uma clínica logada).
 */
export const SkipSubscriptionCheck = () => SetMetadata(SKIP_SUBSCRIPTION_CHECK, true);
