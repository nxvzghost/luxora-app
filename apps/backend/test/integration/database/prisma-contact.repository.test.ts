import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { ContactModule } from '@api/patient-ops/contact.module';
import { CONTACT_REPOSITORY } from '@domain-services/patient-ops/contact.repository';
import { PrismaContactRepository } from '@infrastructure/database/repositories/prisma-contact.repository';
import { ReconhecerOuCriarContatoUseCase } from '@use-cases/contact/reconhecer-ou-criar-contato.use-case';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { TenantContext } from '@shared/tenant-context';
import { Contact, ContactPatientAssociation } from '@domain/contact/contact.entity';
import { PhoneNumber } from '@domain/contact/phone-number.value-object';
import { TenantContextModule } from '@shared/tenant-context.module';
import { MetricsModule } from '@shared/metrics.module';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from '../../critical/support/dedicated-fixture';

/**
 * ADR-0055 (AD-018), Fase 3 — Infraestrutura.
 *
 * Prova, contra Postgres real (nunca mocks — mesma exigência já aplicada a
 * toda persistência crítica do projeto), que o mapeamento Prisma ⇄ Domínio
 * de Contact/ContactPatientAssociation sobrevive a um round-trip real, que
 * o comportamento P2002-tolerante de saveAssociation() é de fato idempotente
 * sob reentrega, e — o ponto mais importante desta Fase, já que nenhuma
 * regra de negócio nova é testada aqui — que a RLS aplicada nas migrations
 * da Fase 1 realmente isola Contact/ContactPatientAssociation por Tenant no
 * nível do banco, não só por filtro de aplicação.
 *
 * Sem globalSetup dedicado (test/integration ainda não tem um) — lê
 * DATABASE_URL de apps/backend/.env diretamente quando process.env ainda
 * não o tiver, mesmo mecanismo (só leitura, mesma precedência) já usado em
 * test/critical/support/global-setup.ts.
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

function repositoryForTenant(tenantId: string): PrismaContactRepository {
  const clientProvider = new PrismaClientProvider();
  const tenantContext = new TenantContext();
  tenantContext.set(tenantId, null);
  const prismaService = new PrismaService(clientProvider, tenantContext);
  return new PrismaContactRepository(prismaService);
}

ensureDatabaseUrl();

let fixturePrisma: PrismaClient;
let fixtureA: DedicatedFixture;
let fixtureB: DedicatedFixture;
let repoA: PrismaContactRepository;
let repoB: PrismaContactRepository;

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();

  fixtureA = await createDedicatedFixture(fixturePrisma, 'AD018CONTACTA');
  fixtureB = await createDedicatedFixture(fixturePrisma, 'AD018CONTACTB');

  repoA = repositoryForTenant(fixtureA.tenantId);
  repoB = repositoryForTenant(fixtureB.tenantId);
});

afterAll(async () => {
  await fixturePrisma.contactPatientAssociation.deleteMany({ where: { tenantId: { in: [fixtureA.tenantId, fixtureB.tenantId] } } });
  await fixturePrisma.contact.deleteMany({ where: { tenantId: { in: [fixtureA.tenantId, fixtureB.tenantId] } } });
  await cleanupDedicatedFixture(fixturePrisma, fixtureA);
  await cleanupDedicatedFixture(fixturePrisma, fixtureB);
  await fixturePrisma.$disconnect();
});

describe('[AD-018 Fase 3] PrismaContactRepository — persistência real', () => {
  it('save() cria um Contact e findByTenantAndPhone() o devolve com os mesmos dados', async () => {
    const phone = PhoneNumber.normalize('11988880001');
    const contact = Contact.create({ id: randomUUID(), tenantId: fixtureA.tenantId, phoneNumber: phone });

    await repoA.save(contact);
    const found = await repoA.findByTenantAndPhone(fixtureA.tenantId, phone);

    expect(found).not.toBeNull();
    expect(found!.id).toBe(contact.id);
    expect(found!.state).toBe('Novo');
    expect(found!.phoneNumber?.equals(phone)).toBe(true);
    expect(found!.name).toBeNull();
  });

  it('Fase 8.0 — concorrência: duas save() simultâneas do mesmo (tenantId, phoneNumber) novo, com ids diferentes, nunca lançam e nunca duplicam linha', async () => {
    // Reproduz exatamente a corrida real (achado do discovery de
    // hardening): duas mensagens quase simultâneas do MESMO telefone,
    // nunca visto antes, geram dois ids novos distintos em
    // ReconhecerOuCriarContatoUseCase.execute() (cada chamada gera seu
    // próprio randomUUID()) — os dois tentam o ramo create() do upsert,
    // a segunda violando @@unique([tenantId, phoneNumber]). Promise.all
    // contra Postgres real garante uma corrida genuína, não apenas
    // sequencial.
    const phone = PhoneNumber.normalize('11988880008');
    const contactA = Contact.create({ id: randomUUID(), tenantId: fixtureA.tenantId, phoneNumber: phone });
    const contactB = Contact.create({ id: randomUUID(), tenantId: fixtureA.tenantId, phoneNumber: phone });
    contactA.interagir();
    contactB.interagir();

    await expect(Promise.all([repoA.save(contactA), repoA.save(contactB)])).resolves.toBeDefined();

    const rows = await fixturePrisma.contact.findMany({ where: { tenantId: fixtureA.tenantId, phoneNumber: phone.toE164() } });
    expect(rows).toHaveLength(1);
    expect(['Conversando']).toContain(rows[0].state);
    expect([contactA.id, contactB.id]).toContain(rows[0].id);
  });

  it('save() em cima de um Contact já existente atualiza (upsert), nunca duplica linha', async () => {
    const phone = PhoneNumber.normalize('11988880002');
    const contact = Contact.create({ id: randomUUID(), tenantId: fixtureA.tenantId, phoneNumber: phone });
    await repoA.save(contact);

    contact.interagir();
    contact.identificar('Carlos');
    await repoA.save(contact);

    const found = await repoA.findById(contact.id);
    expect(found!.state).toBe('Identificado');
    expect(found!.name).toBe('Carlos');

    const rows = await fixturePrisma.contact.findMany({ where: { id: contact.id } });
    expect(rows).toHaveLength(1);
  });

  it('sobrevive a uma nova instância do repositório — nunca depende de estado em memória do processo', async () => {
    const phone = PhoneNumber.normalize('11988880003');
    const contact = Contact.create({ id: randomUUID(), tenantId: fixtureA.tenantId, phoneNumber: phone });
    await repoA.save(contact);

    const freshRepo = repositoryForTenant(fixtureA.tenantId);
    const found = await freshRepo.findByTenantAndPhone(fixtureA.tenantId, phone);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(contact.id);
  });

  it('anonimizar() persiste phoneNumber e name nulos, e o mapper reconstitui null corretamente na volta', async () => {
    const phone = PhoneNumber.normalize('11988880004');
    const contact = Contact.create({ id: randomUUID(), tenantId: fixtureA.tenantId, phoneNumber: phone });
    contact.arquivar();
    contact.anonimizar();
    await repoA.save(contact);

    const found = await repoA.findById(contact.id);
    expect(found!.state).toBe('Descartado');
    expect(found!.phoneNumber).toBeNull();
    expect(found!.name).toBeNull();

    const row = await fixturePrisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(row.phoneNumber).toBeNull();
  });

  it('saveAssociation() persiste e findAssociationsByContactId() a devolve', async () => {
    const phone = PhoneNumber.normalize('11988880005');
    const contact = Contact.create({ id: randomUUID(), tenantId: fixtureA.tenantId, phoneNumber: phone });
    contact.interagir();
    contact.identificar('Ana');
    await repoA.save(contact);

    const association = contact.promoverParaPaciente(randomUUID(), fixtureA.patientId);
    await repoA.saveAssociation(association);

    const associations = await repoA.findAssociationsByContactId(contact.id);
    expect(associations).toHaveLength(1);
    expect(associations[0].patientId).toBe(fixtureA.patientId);
    expect(associations[0].role).toBe('proprio_paciente');
  });

  it('saveAssociation() é idempotente sob reentrega — mesmo (contactId, patientId) com id novo não duplica nem lança', async () => {
    const phone = PhoneNumber.normalize('11988880006');
    const contact = Contact.create({ id: randomUUID(), tenantId: fixtureA.tenantId, phoneNumber: phone });
    contact.interagir();
    contact.identificar('Bruno');
    await repoA.save(contact);

    const firstAssociationId = randomUUID();
    await repoA.saveAssociation(
      ContactPatientAssociation.create({
        id: firstAssociationId,
        tenantId: fixtureA.tenantId,
        contactId: contact.id,
        patientId: fixtureA.patientId,
        role: 'proprio_paciente',
      }),
    );

    // Simula reentrega (mesmo worker BullMQ processando o job de novo após
    // falha antes do ack) — novo id de associação, mesmo par (contact, patient).
    await expect(
      repoA.saveAssociation(
        ContactPatientAssociation.create({
          id: randomUUID(),
          tenantId: fixtureA.tenantId,
          contactId: contact.id,
          patientId: fixtureA.patientId,
          role: 'proprio_paciente',
        }),
      ),
    ).resolves.toBeUndefined();

    const rows = await fixturePrisma.contactPatientAssociation.findMany({ where: { contactId: contact.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(firstAssociationId);
  });

  it('RLS: um repositório escopado ao Tenant B nunca enxerga um Contact do Tenant A, mesmo pedindo pelo tenantId de A explicitamente', async () => {
    const phone = PhoneNumber.normalize('11988880007');
    const contact = Contact.create({ id: randomUUID(), tenantId: fixtureA.tenantId, phoneNumber: phone });
    await repoA.save(contact);

    const crossTenantByPhone = await repoB.findByTenantAndPhone(fixtureA.tenantId, phone);
    expect(crossTenantByPhone).toBeNull();

    const crossTenantById = await repoB.findById(contact.id);
    expect(crossTenantById).toBeNull();
  });

  it('DI: ContactModule resolve CONTACT_REPOSITORY e ReconhecerOuCriarContatoUseCase — wiring completo', async () => {
    // TenantContextModule e MetricsModule são @Global() (ver
    // shared/tenant-context.module.ts e shared/metrics.module.ts) — só
    // entram no grafo compilado se algum módulo os importar
    // explicitamente; AppModule faz isso em produção. MetricsModule
    // entrou aqui na Fase 8.2 (ADR-0055/AD-018): AnthropicContactIntentClassifier
    // e ContactIntentActionRouter passaram a injetar MetricsService. AuditModule
    // NÃO precisa entrar aqui: ContactModule já o importa internamente (Fase 4
    // — ReconhecerOuCriarContatoUseCase injeta AuditService), prova real de
    // que o módulo é autocontido, não depende de quem o consome também
    // importar AuditModule ao lado (como AIModule já fazia, mas que
    // sozinho NÃO seria suficiente — achado real desta Fase, ver commit).
    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule, MetricsModule, ContactModule],
    }).compile();
    const repository = moduleRef.get(CONTACT_REPOSITORY);
    expect(repository).toBeInstanceOf(PrismaContactRepository);
    const useCase = moduleRef.get(ReconhecerOuCriarContatoUseCase);
    expect(useCase).toBeInstanceOf(ReconhecerOuCriarContatoUseCase);
    await moduleRef.close();
  });
});
