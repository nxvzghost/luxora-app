import { BadRequestException } from '@nestjs/common';

/**
 * parsePageLimit — Tarefa 06 da auditoria.
 *
 * ACHADO REAL dos testes de AD-022/AD-032: as rotas de listagem faziam
 * `Number(limit)` e passavam o resultado ao Prisma. `limit=abc` virava
 * `NaN` e a resposta era erro interno (500); `limit=-5` fazia o Prisma ler
 * do fim para o começo; `limit=2.5` e `limit=0` eram aceitos sem sentido.
 *
 * Agora um `limit` que não seja um inteiro maior que zero é recusado com
 * 400. Ausente (ou vazio) continua valendo o padrão de cada rota. Não há
 * teto novo: o contrato de quem já chamava com um número válido não muda.
 */
export function parsePageLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new BadRequestException('limit precisa ser um número inteiro maior que zero.');
  }
  return value;
}
