/**
 * DomainEvent — base para todo evento de domínio.
 *
 * Fonte de verdade: docs/01-Domain/04-Eventos-de-Dominio.txt, Princípio 10
 * (Todo Evento Deve Ser Imutável — docs/02-Arquitetura/00-Principios-Arquiteturais.md).
 *
 * Um evento, uma vez criado, nunca é alterado — por isso todos os campos são
 * `readonly`. Correção de um fato passado gera um NOVO evento, nunca edita
 * este objeto.
 */
export abstract class DomainEvent {
  readonly occurredAt: Date;

  protected constructor(
    readonly eventName: string,
    readonly entityId: string,
    readonly tenantId: string,
  ) {
    this.occurredAt = new Date();
    Object.freeze(this);
  }
}
