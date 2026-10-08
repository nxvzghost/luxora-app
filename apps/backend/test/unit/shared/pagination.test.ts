import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { parsePageLimit } from '@shared/pagination';

/**
 * Tarefa 06 da auditoria — `limit` das rotas de listagem. Antes ia direto
 * para o Prisma: `abc` virava erro interno e `-5` invertia a leitura.
 */
describe('parsePageLimit', () => {
  it.each([
    ['1', 1],
    ['20', 20],
    ['200', 200],
  ])('aceita o inteiro positivo %s', (raw, expected) => {
    expect(parsePageLimit(raw)).toBe(expected);
  });

  it.each([undefined, ''])('ausente ou vazio (%s): devolve undefined, para a rota usar o seu padrão', (raw) => {
    expect(parsePageLimit(raw)).toBeUndefined();
  });

  it.each(['abc', '0', '-5', '2.5', '1e400', 'NaN', ' ', '10abc'])('recusa %s com 400', (raw) => {
    expect(() => parsePageLimit(raw)).toThrow(BadRequestException);
  });
});
