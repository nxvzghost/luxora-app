import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Fase 3B da auditoria — todo job enfileirado leva a política de retenção.
 * BullMQ e ioredis são substituídos: o que se confere é exatamente o que os
 * produtores entregam ao BullMQ. A gravação real dessas opções no Redis é
 * conferida em test/critical/whatsapp-outbound-worker.test.ts.
 */
const { add } = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add, close: vi.fn() })),
}));
vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({ quit: vi.fn() })),
}));

import { MessageQueueProducer } from '@infrastructure/messaging/message-queue.producer';
import { WhatsAppInboundQueueProducer } from '@infrastructure/messaging/whatsapp-inbound-queue.producer';
import {
  COMPLETED_JOB_RETENTION,
  FAILED_INBOUND_JOB_RETENTION,
  FAILED_OUTBOUND_JOB_RETENTION,
} from '@infrastructure/messaging/queue-retention';

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

beforeEach(() => {
  add.mockReset();
  add.mockResolvedValue(undefined);
});

describe('Retenção de jobs no Redis (Fase 3B)', () => {
  it('política explícita: concluídos 24 h; falhados 14 dias na saída e 7 dias na entrada', () => {
    expect(COMPLETED_JOB_RETENTION).toEqual({ age: 24 * HOUR });
    expect(FAILED_OUTBOUND_JOB_RETENTION).toEqual({ age: 14 * DAY });
    expect(FAILED_INBOUND_JOB_RETENTION).toEqual({ age: 7 * DAY });
  });

  it('fila de saída: o job é enfileirado com a retenção, sem mudar chave, tentativas nem espera base', async () => {
    const data = { tenantId: 't1', toPhoneNumber: '5500000000000', body: 'Olá', idempotencyKey: 'chave-1' };

    await new MessageQueueProducer().enqueue(data);

    expect(add).toHaveBeenCalledTimes(1);
    const [name, payload, options] = add.mock.calls[0];
    expect(name).toBe('send-message');
    expect(payload).toBe(data);
    expect(options).toEqual({
      jobId: 'chave-1',
      attempts: 3,
      backoff: { type: 'provider-aware', delay: 2000 },
      removeOnComplete: { age: 24 * HOUR },
      removeOnFail: { age: 14 * DAY },
    });
  });

  it('fila de entrada: o job é enfileirado com a retenção, sem mudar chave, tentativas nem espera', async () => {
    const data = { tenantId: 't1', conversationId: 'c1', message: 'Oi', externalId: 'wamid.1' };

    await new WhatsAppInboundQueueProducer().enqueue(data);

    expect(add).toHaveBeenCalledTimes(1);
    const [name, payload, options] = add.mock.calls[0];
    expect(name).toBe('process-message');
    expect(payload).toBe(data);
    expect(options).toEqual({
      jobId: 'wamid.1',
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 24 * HOUR },
      removeOnFail: { age: 7 * DAY },
    });
  });
});
