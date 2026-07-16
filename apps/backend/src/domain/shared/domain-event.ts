/**
 * DomainEvent — base para todo evento de domínio.
 *
 * Fonte de verdade: docs/01-Domain/04-Eventos-de-Dominio.txt, Princípio 10
 * (Todo Evento Deve Ser Imutável — docs/02-Arquitetura/00-Principios-Arquiteturais.md).
 *
 * Um evento, uma vez criado, nunca é alterado — por isso todos os campos são
 * `readonly`. Correção de um fato passado gera um NOVO evento, nunca edita
 * este objeto.
 *
 * `Object.freeze(this)` acontece aqui, na base, e não em cada subclasse —
 * de propósito: se cada subclasse tivesse que lembrar de chamar
 * `Object.freeze(this)` por conta própria, esquecer uma vez quebraria a
 * imutabilidade silenciosamente, sem nenhum erro. Campos extras de uma
 * subclasse (ex: `fromState`/`toState`) são passados por `extraFields` em vez
 * de `readonly x` no constructor da subclasse — parâmetro de propriedade só é
 * atribuído a `this` DEPOIS que `super(...)` retorna, então congelar aqui com
 * esse padrão impediria a subclasse de definir o próprio campo ("Cannot add
 * property X, object is not extensible"). Passando por `extraFields`, a
 * atribuição acontece dentro deste constructor, antes do freeze — subclasse
 * declara o campo com `declare readonly x: T` (só tipo, sem atribuição).
 */
export abstract class DomainEvent {
  readonly occurredAt: Date;

  protected constructor(
    readonly eventName: string,
    readonly entityId: string,
    readonly tenantId: string,
    extraFields?: Record<string, unknown>,
  ) {
    this.occurredAt = new Date();
    if (extraFields) {
      Object.assign(this, extraFields);
    }
    Object.freeze(this);
  }
}
