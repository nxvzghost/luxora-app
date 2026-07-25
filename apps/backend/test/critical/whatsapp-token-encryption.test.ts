import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';
import { TokenCipherService } from '@shared/token-cipher.service';
import { WhatsAppMessageProvider } from '@infrastructure/messaging/whatsapp-message.provider';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';

/**
 * AD-005 — accessToken de WhatsAppIntegration cifrado em repouso.
 *
 * Ponta a ponta contra Postgres real: conecta via HTTP real
 * (POST /whatsapp/connect), confirma que a linha crua no banco NUNCA tem o
 * texto puro, e que o valor decifrado bate com o original — prova o
 * caminho de escrita (ConectarWhatsAppUseCase). Em seguida, instancia
 * WhatsAppMessageProvider diretamente sobre essa mesma linha real do banco
 * (fetch global stubado, sem rede de verdade) para provar o caminho de
 * leitura+uso (decifra corretamente antes de montar o header Authorization).
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let fixture: DedicatedFixture;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();

  app = await bootstrapTestApp();
  fixture = await createDedicatedFixture(fixturePrisma, 'WATOKEN', { withActiveSubscription: true });
  await createDedicatedUserAndLogin(fixturePrisma, app, fixture, 'WATOKEN');
});

afterAll(async () => {
  // whatsapp_integration tem FK própria para tenant_id, sem cascade (mesma
  // classe de achado já registrada para AvailabilityCalendar/RecurringBlock
  // na AD-003) — apagar antes de cleanupDedicatedFixture() tentar apagar o
  // Tenant, senão viola FK. Escopado por tenantId, id conhecido e exclusivo
  // desta fixture.
  await fixturePrisma.whatsAppIntegration.deleteMany({ where: { tenantId: fixture.tenantId } });
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await fixturePrisma.$disconnect();
  await app?.close();
});

describe('[AD-005] Criptografia em repouso — WhatsAppIntegration.accessToken', () => {
  it('POST /whatsapp/connect grava o accessToken cifrado (nunca texto puro) — linha real no Postgres', async () => {
    const plaintextToken = 'EAAG-token-real-de-teste-1234567890abcdef';

    const res = await request(app.getHttpServer())
      .post('/api/v1/whatsapp/connect')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ phoneNumberId: '1234567890', accessToken: plaintextToken });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('connected');

    const row = await fixturePrisma.whatsAppIntegration.findUniqueOrThrow({ where: { tenantId: fixture.tenantId } });

    expect(row.accessToken).not.toBe(plaintextToken);
    expect(row.accessToken.startsWith('v1:')).toBe(true);

    const tokenCipher = new TokenCipherService();
    expect(tokenCipher.decrypt(row.accessToken)).toBe(plaintextToken);
  });

  it('WhatsAppMessageProvider decifra corretamente antes de enviar — header Authorization usa o texto puro original', async () => {
    const plaintextToken = 'EAAG-outro-token-para-o-envio-987654321';
    const connectRes = await request(app.getHttpServer())
      .post('/api/v1/whatsapp/connect')
      .set('Authorization', `Bearer ${fixture.token}`)
      .send({ phoneNumberId: '1234567890', accessToken: plaintextToken });
    expect(connectRes.status).toBe(201);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.TEST123' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const prismaClientProvider = new PrismaClientProvider();
      await prismaClientProvider.$connect();
      const tokenCipher = new TokenCipherService();
      const provider = new WhatsAppMessageProvider(prismaClientProvider, tokenCipher);

      const result = await provider.send({
        tenantId: fixture.tenantId,
        toPhoneNumber: '5511999999999',
        body: 'Olá',
        idempotencyKey: 'k-correlation-test',
        correlationId: '22222222-2222-2222-2222-222222222222',
      });

      expect(result.providerMessageId).toBe('wamid.TEST123');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, options] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
      expect(options.headers.Authorization).toBe(`Bearer ${plaintextToken}`);
      // AD-016 — correlationId propagado até o header da chamada externa.
      expect(options.headers['X-Correlation-Id']).toBe('22222222-2222-2222-2222-222222222222');

      await prismaClientProvider.$disconnect();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
