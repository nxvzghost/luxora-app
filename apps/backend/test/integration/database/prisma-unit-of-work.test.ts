import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { Contact } from '@domain/contact/contact.entity';
import { PhoneNumber } from '@domain/contact/phone-number.value-object';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaUnitOfWork } from '@infrastructure/database/prisma-unit-of-work';
import { PrismaAuditLogRepository } from '@infrastructure/database/repositories/prisma-audit-log.repository';
import { PrismaContactRepository } from '@infrastructure/database/repositories/prisma-contact.repository';
import { TenantContext } from '@shared/tenant-context';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from '../../critical/support/dedicated-fixture';

/**
 * ADR-0063 (AD-038) — a unidade de trabalho e a trava de linha do Contact,
 * contra Postgres real e sob RLS.
 *
 * Cada "módulo" abaixo tem o seu PrismaService e o seu cliente, como na
 * aplicação (o repositório de auditoria e o de contatos não compartilham
 * instância). O que se prova é que, dentro de uma unidade de trabalho, os
 * dois gravam na MESMA transação — e fora dela continuam como sempre.
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

let fixturePrisma: PrismaClient;
let fixtureA: DedicatedFixture;
let fixtureB: DedicatedFixture;
const providers: PrismaClientProvider[] = [];

/** Um "módulo": PrismaService e cliente próprios, na clínica dada. */
function moduleFor(tenantId: string) {
  const clientProvider = new PrismaClientProvider();
  providers.push(clientProvider);
  const tenantContext = new TenantContext();
  tenantContext.set(tenantId, null);
  const prisma = new PrismaService(clientProvider, tenantContext);
  return {
    prisma,
    unitOfWork: new PrismaUnitOfWork(prisma),
    contacts: new PrismaContactRepository(prisma),
    audit: new PrismaAuditLogRepository(prisma),
  };
}

let phoneSequence = 0;
function newContact(tenantId: string): Contact {
  phoneSequence += 1;
  const contact = Contact.create({
    id: randomUUID(),
    tenantId,
    phoneNumber: PhoneNumber.normalize(`319${String(60000000 + phoneSequence + Math.floor(Math.random() * 9000000)).padStart(8, '0')}`),
  });
  contact.interagir();
  contact.pullDomainEvents();
  return contact;
}

const auditEntry = (tenantId: string, entityId: string) => ({
  tenantId,
  userId: null,
  actorType: 'system' as const,
  action: 'TesteDaUnidadeDeTrabalho',
  entityType: 'Contact',
  entityId,
  payload: null,
  result: 'success' as const,
});

const storedContact = (id: string) => fixturePrisma.contact.findUnique({ where: { id } });
const storedAudits = (entityId: string) => fixturePrisma.auditLog.count({ where: { entityId } });

async function sessionsBlockedBy(pid: number): Promise<number> {
  const [row] = await fixturePrisma.$queryRaw<Array<{ waiting: number }>>`
    SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))
  `;
  return row.waiting;
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  fixtureA = await createDedicatedFixture(fixturePrisma, 'UNITOFWORKA');
  fixtureB = await createDedicatedFixture(fixturePrisma, 'UNITOFWORKB');
});

afterAll(async () => {
  for (const fixture of [fixtureA, fixtureB]) {
    await fixturePrisma.contactPatientAssociation.deleteMany({ where: { tenantId: fixture.tenantId } });
    await fixturePrisma.contact.deleteMany({ where: { tenantId: fixture.tenantId } });
    await cleanupDedicatedFixture(fixturePrisma, fixture);
  }
  await Promise.all(providers.map((provider) => provider.$disconnect()));
  await fixturePrisma.$disconnect();
});

describe('[ADR-0063] PrismaUnitOfWork — uma transação para vários repositórios', () => {
  it('confirma junto o que dois repositórios de módulos diferentes gravaram', async () => {
    const contactsModule = moduleFor(fixtureA.tenantId);
    const auditModule = moduleFor(fixtureA.tenantId);
    const contact = newContact(fixtureA.tenantId);

    await contactsModule.unitOfWork.run(async () => {
      await contactsModule.contacts.save(contact);
      await auditModule.audit.record(auditEntry(fixtureA.tenantId, contact.id));
    });

    expect((await storedContact(contact.id))?.state).toBe('Conversando');
    expect(await storedAudits(contact.id)).toBe(1);
  });

  it('nada do que foi gravado lá dentro é visível de fora antes de confirmar — é uma transação só', async () => {
    const contactsModule = moduleFor(fixtureA.tenantId);
    const auditModule = moduleFor(fixtureA.tenantId);
    const contact = newContact(fixtureA.tenantId);

    await contactsModule.unitOfWork.run(async () => {
      await contactsModule.contacts.save(contact);
      await auditModule.audit.record(auditEntry(fixtureA.tenantId, contact.id));

      // Quem grava enxerga o que gravou; outra conexão, não.
      expect(await contactsModule.contacts.findById(contact.id)).not.toBeNull();
      expect(await storedContact(contact.id)).toBeNull();
      expect(await storedAudits(contact.id)).toBe(0);
    });

    expect(await storedContact(contact.id)).not.toBeNull();
    expect(await storedAudits(contact.id)).toBe(1);
  });

  it('se o trabalho lança, tudo é desfeito — o contato e o registro de auditoria já inseridos', async () => {
    const contactsModule = moduleFor(fixtureA.tenantId);
    const auditModule = moduleFor(fixtureA.tenantId);
    const contact = newContact(fixtureA.tenantId);

    await expect(
      contactsModule.unitOfWork.run(async () => {
        await contactsModule.contacts.save(contact);
        await auditModule.audit.record(auditEntry(fixtureA.tenantId, contact.id));
        throw new Error('falha depois de gravar');
      }),
    ).rejects.toThrow('falha depois de gravar');

    expect(await storedContact(contact.id)).toBeNull();
    expect(await storedAudits(contact.id)).toBe(0);
  });

  it('`created_at` de uma linha inserida pelo Prisma é o relógio da APLICAÇÃO na hora do INSERT — não o início da transação', async () => {
    // O horário da aprovação de vínculo é tomado do relógio da aplicação
    // justamente por isto: é o mesmo relógio que carimba `created_at` em toda
    // a base. Se um dia o Prisma passar a deixar o default para o banco
    // (CURRENT_TIMESTAMP = início da transação), este teste avisa.
    const module = moduleFor(fixtureA.tenantId);
    const entityId = `relogio-${randomUUID()}`;
    let transactionStart = 0;
    let beforeInsert = 0;

    await module.unitOfWork.run(async () => {
      const [clock] = await module.prisma.forTenant((tx) => tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`);
      transactionStart = clock.now.getTime();
      // Pausa feita pelo próprio banco, dentro da transação: separa o início
      // da transação do instante do INSERT sem depender de temporizador.
      await module.prisma.forTenant((tx) => tx.$executeRaw`SELECT pg_sleep(0.25)`);
      beforeInsert = Date.now();
      await module.audit.record(auditEntry(fixtureA.tenantId, entityId));
    });

    const stored = await fixturePrisma.auditLog.findFirstOrThrow({ where: { entityId } });
    expect(stored.createdAt.getTime() - transactionStart).toBeGreaterThanOrEqual(200);
    expect(stored.createdAt.getTime()).toBeGreaterThanOrEqual(beforeInsert);
    expect(stored.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('fora de uma unidade de trabalho nada mudou: cada gravação é confirmada na hora, por conta própria', async () => {
    const module = moduleFor(fixtureA.tenantId);
    const contact = newContact(fixtureA.tenantId);

    await module.contacts.save(contact);
    expect(await storedContact(contact.id)).not.toBeNull();

    await expect(
      (async () => {
        await module.audit.record(auditEntry(fixtureA.tenantId, contact.id));
        throw new Error('falha depois de gravar, sem unidade de trabalho');
      })(),
    ).rejects.toThrow();
    // Sem unidade de trabalho, o registro já tinha sido confirmado.
    expect(await storedAudits(contact.id)).toBe(1);
  });

  it('a RLS vale lá dentro: o contato de outra clínica não é lido, não é travado e não pode ser gravado', async () => {
    const moduleA = moduleFor(fixtureA.tenantId);
    const moduleB = moduleFor(fixtureB.tenantId);
    const contactOfB = newContact(fixtureB.tenantId);
    await moduleB.contacts.save(contactOfB);

    await moduleA.unitOfWork.run(async () => {
      expect(await moduleA.contacts.findById(contactOfB.id)).toBeNull();
      expect(await moduleA.contacts.findByIdForUpdate(contactOfB.id)).toBeNull();
    });

    // Gravar um registro de auditoria em nome de outra clínica é recusado
    // pelo banco, e a unidade de trabalho inteira cai com ele.
    const contactOfA = newContact(fixtureA.tenantId);
    await expect(
      moduleA.unitOfWork.run(async () => {
        await moduleA.contacts.save(contactOfA);
        await moduleA.audit.record(auditEntry(fixtureB.tenantId, contactOfB.id));
      }),
    ).rejects.toThrow();
    expect(await storedContact(contactOfA.id)).toBeNull();
    expect(await storedAudits(contactOfB.id)).toBe(0);
  });

  it('um repositório de outra clínica não entra na unidade de trabalho aberta', async () => {
    const moduleA = moduleFor(fixtureA.tenantId);
    const moduleB = moduleFor(fixtureB.tenantId);
    const contactOfB = newContact(fixtureB.tenantId);

    await expect(
      moduleA.unitOfWork.run(async () => {
        await moduleB.contacts.save(contactOfB);
      }),
    ).rejects.toThrow(/outra clínica/);

    expect(await storedContact(contactOfB.id)).toBeNull();
  });
});

describe('[ADR-0063] PrismaContactRepository — trava de linha e registro de atividade', () => {
  it('findByIdForUpdate() fora de uma unidade de trabalho é recusado — a trava não protegeria nada', async () => {
    const module = moduleFor(fixtureA.tenantId);
    const contact = newContact(fixtureA.tenantId);
    await module.contacts.save(contact);

    await expect(module.contacts.findByIdForUpdate(contact.id)).rejects.toThrow(/unidade de trabalho/);
  });

  it('quem chega depois espera pela trava e lê o que o primeiro confirmou — nunca o estado de antes', async () => {
    const first = moduleFor(fixtureA.tenantId);
    const second = moduleFor(fixtureA.tenantId);
    const contact = newContact(fixtureA.tenantId);
    await first.contacts.save(contact);

    let lockTaken!: (pid: number) => void;
    const holderPid = new Promise<number>((resolve) => (lockTaken = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));

    const holder = first.unitOfWork.run(async () => {
      const locked = (await first.contacts.findByIdForUpdate(contact.id)) as Contact;
      const [row] = await first.prisma.forTenant((tx) => tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`);
      lockTaken(row.pid);
      await released;
      locked.identificar('Nome Gravado Pelo Primeiro');
      await first.contacts.save(locked);
    });

    const pid = await holderPid;
    const waiter = second.unitOfWork.run(async () => second.contacts.findByIdForUpdate(contact.id));

    // Espera por condição, com prazo: o banco tem de informar que a segunda
    // sessão está bloqueada pela primeira.
    const deadline = Date.now() + 3_000;
    while ((await sessionsBlockedBy(pid)) === 0) {
      if (Date.now() > deadline) throw new Error('a segunda leitura não ficou esperando pela trava');
      await new Promise((resolve) => setImmediate(resolve));
    }
    release();
    await holder;
    const seenBySecond = await waiter;

    expect(seenBySecond?.state).toBe('Identificado');
    expect(seenBySecond?.name).toBe('Nome Gravado Pelo Primeiro');
  });

  it('touch() registra a atividade e não regrava estado nem nome', async () => {
    const module = moduleFor(fixtureA.tenantId);
    const contact = newContact(fixtureA.tenantId);
    contact.identificar('Nome Que Fica');
    contact.pullDomainEvents();
    await module.contacts.save(contact);
    const before = await storedContact(contact.id);

    await module.contacts.touch(contact.id);

    const after = await storedContact(contact.id);
    expect(after?.state).toBe('Identificado');
    expect(after?.name).toBe('Nome Que Fica');
    expect(after?.phoneNumber).toBe(before?.phoneNumber);
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
  });

  it('touch() no contato de outra clínica não altera nada', async () => {
    const moduleA = moduleFor(fixtureA.tenantId);
    const moduleB = moduleFor(fixtureB.tenantId);
    const contactOfB = newContact(fixtureB.tenantId);
    await moduleB.contacts.save(contactOfB);
    const before = await storedContact(contactOfB.id);

    await moduleA.contacts.touch(contactOfB.id);

    expect((await storedContact(contactOfB.id))?.updatedAt).toEqual(before?.updatedAt);
  });
});
