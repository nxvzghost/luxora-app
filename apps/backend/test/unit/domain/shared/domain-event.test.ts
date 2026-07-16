import { describe, it, expect } from 'vitest';
import { DomainEvent } from '@domain/shared/domain-event';

class TestEvent extends DomainEvent {
  declare readonly extra: string;

  constructor(entityId: string, tenantId: string, extra: string) {
    super('TesteEvento', entityId, tenantId, { extra });
  }
}

describe('DomainEvent', () => {
  it('define eventName, entityId, tenantId e occurredAt', () => {
    const e = new TestEvent('entity-1', 'tenant-1', 'valor-extra');
    expect(e.eventName).toBe('TesteEvento');
    expect(e.entityId).toBe('entity-1');
    expect(e.tenantId).toBe('tenant-1');
    expect(e.occurredAt).toBeInstanceOf(Date);
    expect(e.extra).toBe('valor-extra');
  });

  it('é imutável — Princípio 10 (Todo Evento Deve Ser Imutável)', () => {
    const e = new TestEvent('entity-1', 'tenant-1', 'valor-extra');
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      // @ts-expect-error — testando proteção em runtime, não só em tipo
      e.entityId = 'outro-id';
    }).toThrow();
  });
});
