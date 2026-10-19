import { describe, it, expect } from 'vitest';
import { logReference } from '@shared/logging/log-reference';

describe('logReference — A-18 (ids de job fora dos logs)', () => {
  const wamid = 'wamid.HBgNNTU0MTk5OTk5OTk5ORUCABIYFjNFQjBDMEE3QjM0QkQ2MkI1RjAzAA==';

  it('nunca devolve o id, nem pedaço dele', () => {
    const ref = logReference(wamid);
    expect(ref).toMatch(/^ref:[0-9a-f]{12}$/);
    expect(ref).not.toContain('HBgN');
    expect(logReference(`conversation-reply-${wamid}`)).not.toContain('conversation-reply');
  });

  it('é estável: o mesmo id dá sempre a mesma referência, e ids diferentes dão referências diferentes', () => {
    expect(logReference(wamid)).toBe(logReference(wamid));
    expect(logReference(wamid)).not.toBe(logReference(`${wamid}x`));
  });

  it('número e texto do mesmo id dão a mesma referência (o BullMQ pode devolver o id como texto)', () => {
    expect(logReference(42)).toBe(logReference('42'));
  });

  it.each([undefined, null, ''])('%j vira "ref:-"', (value) => {
    expect(logReference(value)).toBe('ref:-');
  });
});
