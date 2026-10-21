import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaConversationRepository } from '@infrastructure/database/repositories/prisma-conversation.repository';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { TenantContext } from '@shared/tenant-context';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from '../../critical/support/dedicated-fixture';

/**
 * D-A do A-14 — o histórico que vai para a IA, contra Postgres real e sob
 * RLS: só as mensagens mais recentes, só as da janela de tempo, em ordem
 * cronológica, sem a mensagem atual e sem nada de outra clínica.
 *
 * Os instantes são fixos (2031, longe de qualquer "hoje") e a janela é
 * passada ao repositório: nada aqui depende da hora em que o teste roda. O
 * limite usado é o do padrão aprovado — 19 mensagens anteriores, porque a
 * atual ocupa a vigésima vaga.
 */
function ensureDatabaseUrl(): void {
  if (process.env.DATABASE_URL) {
    return;
  }
  const envPath = path.resolve(__dirname, '../../../.env');
  const content = readFileSync(envPath, 'utf-8');
  const match = content.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/m);
  if (!match) {
    throw new Error(`DATABASE_URL não encontrado em ${envPath}`);
  }
  process.env.DATABASE_URL = match[1];
}

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

ensureDatabaseUrl();

const HOUR = 60 * 60 * 1000;
/** Instante da mensagem atual de cada conversa deste arquivo. */
const NOW = new Date('2031-03-10T12:00:00.000Z');
const SINCE = new Date(NOW.getTime() - 72 * HOUR);
const PREVIOUS_LIMIT = 19;

let fixturePrisma: PrismaClient;
let clientProvider: PrismaClientProvider;
let clinicA: DedicatedFixture;
let clinicB: DedicatedFixture;

interface SeedMessage {
  /** Horas antes da mensagem atual; negativo é depois dela. */
  hoursBefore: number;
  direction: 'entrada' | 'saida';
  content: string;
}

interface SeededConversation {
  conversationId: string;
  currentExternalId: string;
}

function prismaFor(tenantId: string): PrismaService {
  const tenantContext = new TenantContext();
  tenantContext.set(tenantId, null);
  return new PrismaService(clientProvider, tenantContext);
}

function repositoryFor(fixture: DedicatedFixture): PrismaConversationRepository {
  return new PrismaConversationRepository(prismaFor(fixture.tenantId));
}

/** `count` mensagens alternando paciente e resposta, a primeira `fromHours` antes da atual, uma por hora. */
function alternating(label: string, count: number, fromHours: number): SeedMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    hoursBefore: fromHours - i,
    direction: i % 2 === 0 ? 'entrada' : 'saida',
    content: `${label}-${String(i + 1).padStart(2, '0')}`,
  }));
}

async function seedConversation(fixture: DedicatedFixture, messages: SeedMessage[], phoneNumber?: string): Promise<SeededConversation> {
  const conversation = await fixturePrisma.conversation.create({
    data: { tenantId: fixture.tenantId, phoneNumber: phoneNumber ?? `+55419${randomUUID().replace(/\D/g, '').slice(0, 8)}` },
  });
  const currentExternalId = `wamid.${randomUUID()}`;
  await fixturePrisma.message.createMany({
    data: [
      ...messages.map((m) => ({
        tenantId: fixture.tenantId,
        conversationId: conversation.id,
        direction: m.direction,
        content: m.content,
        createdAt: new Date(NOW.getTime() - m.hoursBefore * HOUR),
      })),
      {
        tenantId: fixture.tenantId,
        conversationId: conversation.id,
        direction: 'entrada' as const,
        content: 'MENSAGEM-ATUAL',
        externalId: currentExternalId,
        createdAt: NOW,
      },
    ],
  });
  return { conversationId: conversation.id, currentExternalId };
}

async function recentContents(fixture: DedicatedFixture, seeded: SeededConversation, limit = PREVIOUS_LIMIT): Promise<string[]> {
  const messages = await repositoryFor(fixture).findRecentMessagesBefore({ ...seeded, since: SINCE, limit });
  return messages.map((m) => m.content);
}

async function cleanupConversations(fixture: DedicatedFixture | undefined): Promise<void> {
  if (!fixture) return;
  await fixturePrisma.message.deleteMany({ where: { tenantId: fixture.tenantId } });
  await fixturePrisma.conversation.deleteMany({ where: { tenantId: fixture.tenantId } });
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  clientProvider = new PrismaClientProvider();

  clinicA = await createDedicatedFixture(fixturePrisma, 'DAHISTA');
  clinicB = await createDedicatedFixture(fixturePrisma, 'DAHISTB');
});

afterAll(async () => {
  await cleanupConversations(clinicA);
  await cleanupConversations(clinicB);
  if (clinicA) await cleanupDedicatedFixture(fixturePrisma, clinicA);
  if (clinicB) await cleanupDedicatedFixture(fixturePrisma, clinicB);
  await clientProvider.$disconnect();
  await fixturePrisma.$disconnect();
});

describe('[A-14 D-A] PrismaConversationRepository.findRecentMessagesBefore — o histórico que vai para a IA', () => {
  it('com menos mensagens que o limite dentro da janela, vêm todas as elegíveis', async () => {
    const seeded = await seedConversation(clinicA, alternating('POUCAS', 5, 50));

    expect(await recentContents(clinicA, seeded)).toEqual(['POUCAS-01', 'POUCAS-02', 'POUCAS-03', 'POUCAS-04', 'POUCAS-05']);
  });

  it('com mais mensagens recentes que o limite, vêm só as 19 mais recentes antes da atual', async () => {
    const seeded = await seedConversation(clinicA, alternating('MUITAS', 30, 31));

    const contents = await recentContents(clinicA, seeded);
    expect(contents).toHaveLength(19);
    expect(contents).toEqual(Array.from({ length: 19 }, (_, i) => `MUITAS-${String(i + 12).padStart(2, '0')}`));
  });

  it('mensagens com mais de 72 horas nunca vêm, mesmo havendo menos que o limite — 72 horas exatas ainda entram', async () => {
    const seeded = await seedConversation(clinicA, [
      ...alternating('VELHA', 10, 100),
      { hoursBefore: 72 + 1 / 60, direction: 'entrada', content: 'UM-MINUTO-ALEM' },
      { hoursBefore: 72, direction: 'saida', content: 'NO-LIMITE' },
      { hoursBefore: 30, direction: 'entrada', content: 'RECENTE-1' },
      { hoursBefore: 20, direction: 'saida', content: 'RECENTE-2' },
    ]);

    expect(await recentContents(clinicA, seeded)).toEqual(['NO-LIMITE', 'RECENTE-1', 'RECENTE-2']);
  });

  it('os dois limites juntos: com mais de 19 recentes corta a quantidade; com folga na quantidade, corta o tempo — e nada gravado muda', async () => {
    const seeded = await seedConversation(clinicA, [...alternating('FORA', 10, 120), ...alternating('DENTRO', 25, 60)]);
    const before = await fixturePrisma.message.count({ where: { conversationId: seeded.conversationId } });

    const contents = await recentContents(clinicA, seeded);
    expect(contents).toEqual(Array.from({ length: 19 }, (_, i) => `DENTRO-${String(i + 7).padStart(2, '0')}`));
    // Com um limite maior que todas as recentes, o que fica de fora é pela janela de tempo.
    const roomy = await recentContents(clinicA, seeded, 50);
    expect(roomy).toEqual(Array.from({ length: 25 }, (_, i) => `DENTRO-${String(i + 1).padStart(2, '0')}`));
    expect([...contents, ...roomy].some((content) => content.startsWith('FORA'))).toBe(false);
    expect(await fixturePrisma.message.count({ where: { conversationId: seeded.conversationId } })).toBe(before);
    expect(before).toBe(10 + 25 + 1);
  });

  it('ordem cronológica, a mensagem atual fica de fora e nada que tenha chegado depois dela entra', async () => {
    const seeded = await seedConversation(clinicA, [
      { hoursBefore: 3, direction: 'saida', content: 'TERCEIRA' },
      { hoursBefore: 9, direction: 'entrada', content: 'PRIMEIRA' },
      { hoursBefore: 6, direction: 'entrada', content: 'SEGUNDA' },
      { hoursBefore: -1, direction: 'entrada', content: 'DEPOIS-DA-ATUAL' },
    ]);

    const contents = await recentContents(clinicA, seeded);
    expect(contents).toEqual(['PRIMEIRA', 'SEGUNDA', 'TERCEIRA']);
    expect(contents).not.toContain('MENSAGEM-ATUAL');
  });

  it('limite zero devolve nada, sem consultar a conversa', async () => {
    const seeded = await seedConversation(clinicA, alternating('ZERO', 3, 10));

    expect(await recentContents(clinicA, seeded, 0)).toEqual([]);
  });

  it('outra clínica: nada dela entra no histórico, nem pelo mesmo número nem pelo id da conversa', async () => {
    const phoneNumber = `+55419${randomUUID().replace(/\D/g, '').slice(0, 8)}`;
    const conversationA = await seedConversation(clinicA, alternating('CLINICA-A', 4, 10), phoneNumber);
    const conversationB = await seedConversation(clinicB, alternating('CLINICA-B', 4, 10), phoneNumber);

    expect(await recentContents(clinicA, conversationA)).toEqual(['CLINICA-A-01', 'CLINICA-A-02', 'CLINICA-A-03', 'CLINICA-A-04']);
    expect(await recentContents(clinicB, conversationB)).toEqual(['CLINICA-B-01', 'CLINICA-B-02', 'CLINICA-B-03', 'CLINICA-B-04']);
    // A clínica A pedindo a conversa da clínica B, com o identificador certo: a RLS não devolve nada.
    expect(await recentContents(clinicA, conversationB)).toEqual([]);
  });
});
