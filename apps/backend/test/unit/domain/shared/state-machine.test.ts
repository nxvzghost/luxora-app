import { describe, it, expect } from 'vitest';
import { StateMachine, InvalidStateTransitionError } from '@domain/shared/state-machine';

type TestState = 'A' | 'B' | 'C';

describe('StateMachine', () => {
  const sm = new StateMachine<TestState>('TestEntity', {
    A: ['B'],
    B: ['C'],
    C: [],
  });

  it('permite transição explicitamente definida', () => {
    expect(sm.canTransition('A', 'B')).toBe(true);
  });

  it('nega transição não definida', () => {
    expect(sm.canTransition('A', 'C')).toBe(false);
  });

  it('nega transição a partir de estado terminal', () => {
    expect(sm.canTransition('C', 'A')).toBe(false);
  });

  it('assertTransition não lança erro para transição válida', () => {
    expect(() => sm.assertTransition('A', 'B')).not.toThrow();
  });

  it('assertTransition lança InvalidStateTransitionError para transição inválida', () => {
    expect(() => sm.assertTransition('A', 'C')).toThrow(InvalidStateTransitionError);
  });

  it('mensagem de erro identifica entidade, origem e destino', () => {
    try {
      sm.assertTransition('A', 'C');
      expect.fail('deveria ter lançado erro');
    } catch (e) {
      expect((e as Error).message).toContain('TestEntity');
      expect((e as Error).message).toContain('"A"');
      expect((e as Error).message).toContain('"C"');
    }
  });
});
