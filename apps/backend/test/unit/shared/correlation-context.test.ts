import { describe, it, expect } from 'vitest';
import { CorrelationContext, CORRELATION_ID_REQUEST_KEY, type RequestWithCorrelationId } from '@shared/correlation-context';

describe('CorrelationContext (AD-016)', () => {
  it('lê o correlationId já preenchido no req cru pelo middleware', () => {
    const fakeRequest = { [CORRELATION_ID_REQUEST_KEY]: 'abc-123' } as unknown as RequestWithCorrelationId;
    const ctx = new CorrelationContext(fakeRequest);
    expect(ctx.correlationId).toBe('abc-123');
  });

  it('nunca lança quando o req não tem correlationId — devolve um fallback estável', () => {
    const fakeRequest = {} as unknown as RequestWithCorrelationId;
    const ctx = new CorrelationContext(fakeRequest);
    expect(ctx.correlationId).toBe('sem-correlation-id');
  });
});
