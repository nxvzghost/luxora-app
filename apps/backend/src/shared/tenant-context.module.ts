import { Global, Module } from '@nestjs/common';
import { TenantContext } from './tenant-context';

/**
 * TenantContextModule — Global() de propósito.
 *
 * BUG REAL ENCONTRADO E CORRIGIDO: TenantContext (Scope.REQUEST) era
 * declarado como provider LOCAL em 10 módulos diferentes (appointments,
 * billing, clinic, patients, therapists, subscription, ai, audit,
 * automations, communication) — cada um criando sua PRÓPRIA instância por
 * requisição, em vez de todos compartilharem a mesma. Isso é invisível
 * quando Guard e serviços usados ficam dentro do MESMO módulo (a maioria
 * dos casos), mas quebra silenciosamente sempre que um módulo importa um
 * serviço de OUTRO módulo que também injeta TenantContext — ex:
 * SubscriptionModule importa AuditModule para reusar AuditService;
 * ProcessarWebhookAssinaturaUseCase (em SubscriptionModule) chamava
 * `this.tenantContext.set(...)` na instância de TenantContext do PRÓPRIO
 * SubscriptionModule, mas AuditService (resolvido via AuditModule) injetava
 * a instância SEPARADA de TenantContext do AuditModule — nunca inicializada
 * nessa requisição, lançando "TenantContext acessado antes de ser
 * inicializado" na primeira chamada real do webhook de pagamento contra o
 * banco. A mesma classe de bug atingiria CriarAssinaturaUseCase (mesmo
 * módulo, mesmo import de AuditModule) na primeira assinatura criada via API
 * de verdade.
 *
 * @Global() garante uma ÚNICA instância de TenantContext por requisição
 * HTTP, compartilhada por todo o grafo de módulos — nunca entre requisições
 * diferentes (Scope.REQUEST continua garantindo isso). Basta importar este
 * módulo uma vez em AppModule; os outros módulos não precisam mais
 * declarar `TenantContext` no próprio array de providers.
 */
@Global()
@Module({
  providers: [TenantContext],
  exports: [TenantContext],
})
export class TenantContextModule {}
