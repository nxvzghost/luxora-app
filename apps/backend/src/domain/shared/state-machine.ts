/**
 * StateMachine — utilitário genérico de máquina de estados finitos.
 *
 * Fonte de verdade: docs/01-Domain/03-Maquina-de-Estados.md, "Regra Geral":
 *   "Uma entidade só pode ocupar um estado por vez."
 *   "Toda mudança de estado deve gerar um evento de domínio e um registro de auditoria."
 *
 * Esta classe garante a primeira regra (transição só é aceita se explicitamente
 * permitida). A segunda regra (evento + auditoria) é responsabilidade de quem
 * usa a StateMachine (ver DomainEntity.transitionTo), não dela mesma — a
 * máquina de estados não deve saber nada sobre infraestrutura de eventos.
 */
export class InvalidStateTransitionError extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`Transição inválida em ${entity}: de "${from}" para "${to}" não é permitida.`);
    this.name = 'InvalidStateTransitionError';
  }
}

export class StateMachine<TState extends string> {
  constructor(
    private readonly entityName: string,
    private readonly transitions: Record<TState, readonly TState[]>,
  ) {}

  canTransition(from: TState, to: TState): boolean {
    return this.transitions[from]?.includes(to) ?? false;
  }

  assertTransition(from: TState, to: TState): void {
    if (!this.canTransition(from, to)) {
      throw new InvalidStateTransitionError(this.entityName, from, to);
    }
  }
}
