/**
 * UnitOfWork — porta (interface). ADR-0063 (AD-038).
 *
 * Uma unidade de trabalho é UMA transação do banco: tudo o que os
 * repositórios e o AuditService gravarem dentro de `run()` é confirmado
 * junto, ou nada é. Se `work` lançar, tudo é desfeito.
 *
 * Existe para os poucos casos em que um fato e o seu registro precisam ser
 * inseparáveis, ou em que duas operações sobre o mesmo registro não podem
 * correr ao mesmo tempo (ver ContactRepository.findByIdForUpdate()). O
 * padrão do restante da aplicação — cada repositório na sua transação, a
 * auditoria gravada em seguida — não muda.
 *
 * A implementação real (Prisma) vive em infrastructure/, nunca aqui.
 */
export interface UnitOfWork {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
