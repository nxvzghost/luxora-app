import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { INestApplication, Type } from '@nestjs/common';
import { ContextIdFactory } from '@nestjs/core';
import request from 'supertest';
import { PrismaClient, UserRole } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import {
  createDedicatedFixture,
  createDedicatedUserAndLogin,
  cleanupDedicatedFixture,
  DedicatedFixture,
} from './support/dedicated-fixture';
import { Contact, ContactPatientAssociation } from '@domain/contact/contact.entity';
import { PhoneNumber } from '@domain/contact/phone-number.value-object';
import { CONTACT_REPOSITORY, ContactRepository } from '@domain-services/patient-ops/contact.repository';
import { AUDIT_LOG_REPOSITORY, AuditLogEntry } from '@domain-services/platform/audit-log.repository';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaContactRepository } from '@infrastructure/database/repositories/prisma-contact.repository';
import { PrismaAuditLogRepository } from '@infrastructure/database/repositories/prisma-audit-log.repository';
import { TenantContext } from '@shared/tenant-context';
import { IdentificarContatoUseCase } from '@use-cases/contact/identificar-contato.use-case';
import { PromoverContatoUseCase } from '@use-cases/contact/promover-contato.use-case';
import { ReconhecerOuCriarContatoUseCase } from '@use-cases/contact/reconhecer-ou-criar-contato.use-case';
import { ResolverIdentidadeDoContatoUseCase } from '@use-cases/contact/resolver-identidade-do-contato.use-case';

/**
 * Integridade da aprovação de vínculo sob concorrência e falha — ADR-0063
 * (AD-038).
 *
 * O que estes testes provam, contra o Postgres real, com RLS, pela rota
 * real do painel:
 *
 * 1. duas aprovações do mesmo contato ao mesmo tempo: uma vence (201), a
 *    outra é recusada (409), e o banco fica com UM vínculo e UM registro de
 *    aprovação — para pacientes diferentes e para o mesmo paciente;
 * 2. se a gravação da auditoria ou do vínculo falha, NADA fica gravado, e o
 *    contato continua podendo ser aprovado depois;
 * 3. uma clínica não aprova, não audita e nem sequer espera pelo contato de
 *    outra;
 * 4. o que o WhatsApp faz com o mesmo contato no mesmo instante (uma
 *    mensagem, um nome informado, um cadastro confirmado) não desfaz nem
 *    duplica uma aprovação.
 *
 * COMO A CONCORRÊNCIA É PRODUZIDA — sem esperas de tempo fixo. Os dois
 * repositórios abaixo ESTENDEM os de produção e só acrescentam pontos de
 * parada; o SQL executado é o real. Para cada disputa:
 *
 *   a) a primeira operação que trava a linha do contato fica parada, com a
 *      transação aberta e a trava na mão;
 *   b) o teste espera o BANCO informar que outra sessão está bloqueada por
 *      ela (`pg_blocking_pids`) — é a prova de que as duas disputaram a mesma
 *      linha, e não de que uma simplesmente terminou antes da outra começar;
 *   c) só então a primeira é liberada.
 *
 * Se a trava for retirada do código, o passo (b) nunca acontece e o teste
 * falha dizendo exatamente isso.
 */

interface Gates {
  /** Segura a primeira operação que travar este contato, com a trava na mão. */
  lockHold: { contactId: string; taken: boolean; acquired: (backendPid: number) => void; released: Promise<void> } | null;
  /** Segura quem leu este contato pelo telefone (a mensagem que chega), depois da leitura e antes de gravar. */
  readHold: { contactId: string; taken: boolean; reached: () => void; released: Promise<void> } | null;
  /** Faz a gravação do vínculo deste contato falhar, antes ou depois do INSERT. */
  failAssociation: { contactId: string; when: 'antes' | 'depois' } | null;
  /** Faz a gravação deste registro de auditoria falhar, antes ou depois do INSERT. */
  failAudit: { entityId: string; action: string; when: 'antes' | 'depois' } | null;
}

const gates: Gates = { lockHold: null, readHold: null, failAssociation: null, failAudit: null };

class SimulatedWriteFailure extends Error {
  constructor(what: string) {
    super(`falha simulada pelo teste: ${what}`);
  }
}

class GatedContactRepository extends PrismaContactRepository {
  private get db(): PrismaService {
    return (this as unknown as { prisma: PrismaService }).prisma;
  }

  async findByIdForUpdate(id: string): Promise<Contact | null> {
    const contact = await super.findByIdForUpdate(id);
    const hold = gates.lockHold;
    if (contact && hold && hold.contactId === id && !hold.taken) {
      hold.taken = true;
      // Mesma transação (a unidade de trabalho em andamento): é o processo do
      // banco que está segurando a trava.
      const [row] = await this.db.forTenant((tx) => tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`);
      hold.acquired(row.pid);
      await hold.released;
    }
    return contact;
  }

  async findByTenantAndPhone(tenantId: string, phoneNumber: PhoneNumber): Promise<Contact | null> {
    const contact = await super.findByTenantAndPhone(tenantId, phoneNumber);
    const hold = gates.readHold;
    if (contact && hold && hold.contactId === contact.id && !hold.taken) {
      hold.taken = true;
      hold.reached();
      await hold.released;
    }
    return contact;
  }

  async saveAssociation(association: ContactPatientAssociation): Promise<void> {
    const failure = gates.failAssociation;
    const applies = failure !== null && failure.contactId === association.contactId;
    if (applies && failure.when === 'antes') {
      throw new SimulatedWriteFailure('o vínculo não foi gravado');
    }
    await super.saveAssociation(association);
    if (applies && failure.when === 'depois') {
      throw new SimulatedWriteFailure('erro logo depois de gravar o vínculo');
    }
  }
}

class GatedAuditLogRepository extends PrismaAuditLogRepository {
  async record(entry: Omit<AuditLogEntry, 'id'>): Promise<void> {
    const failure = gates.failAudit;
    const applies = failure !== null && failure.entityId === entry.entityId && failure.action === entry.action;
    if (applies && failure.when === 'antes') {
      throw new SimulatedWriteFailure('o registro de auditoria não foi gravado');
    }
    await super.record(entry);
    if (applies && failure.when === 'depois') {
      throw new SimulatedWriteFailure('erro logo depois de gravar o registro de auditoria');
    }
  }
}

interface Clinic {
  fixture: DedicatedFixture;
  tenantId: string;
}

let app: INestApplication;
let db: PrismaClient;
let clinicA: Clinic;
let clinicB: Clinic;
let adminA1: { token: string; userId: string };
let adminA2: { token: string; userId: string };
let adminB: { token: string; userId: string };
const openHolds: Array<() => void> = [];

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  openHolds.push(open);
  return { promise, open };
}

/** Faz a primeira operação que travar o contato ficar parada, segurando a trava, até `release()`. */
function holdFirstLocker(contactId: string): { holderPid: Promise<number>; release: () => void } {
  const released = gate();
  let acquired!: (pid: number) => void;
  const holderPid = new Promise<number>((resolve) => (acquired = resolve));
  gates.lockHold = { contactId, taken: false, acquired, released: released.promise };
  return { holderPid, release: released.open };
}

/** Faz a mensagem que ler o contato pelo telefone ficar parada, depois de ler e antes de gravar, até `release()`. */
function holdAfterRead(contactId: string): { reached: Promise<void>; release: () => void } {
  const released = gate();
  let reached!: () => void;
  const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
  gates.readHold = { contactId, taken: false, reached, released: released.promise };
  return { reached: reachedPromise, release: released.open };
}

async function sessionsBlockedBy(holderPid: number): Promise<number> {
  const [row] = await db.$queryRaw<Array<{ waiting: number }>>`
    SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))
  `;
  return row.waiting;
}

/**
 * Espera o banco informar que outra sessão está bloqueada pela que segura a
 * trava. É uma espera por CONDIÇÃO, com prazo: ou a disputa acontece, ou o
 * teste falha — nunca "dorme e torce".
 */
async function waitUntilSomeoneWaitsFor(holderPid: number): Promise<void> {
  // Bem abaixo do tempo máximo de uma transação interativa do Prisma (5 s),
  // que a operação parada está consumindo.
  const deadline = Date.now() + 3_000;
  for (;;) {
    if ((await sessionsBlockedBy(holderPid)) > 0) return;
    if (Date.now() > deadline) {
      throw new Error('Nenhuma outra sessão ficou esperando pela trava do contato: as duas operações não disputaram a mesma linha.');
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Dispara já e devolve a promessa do resultado (o supertest só envia quando alguém espera por ele). */
function start<T>(thenable: PromiseLike<T>): Promise<T> {
  return Promise.resolve(thenable);
}

const link = (token: string, contactId: string, patientId: string) =>
  request(app.getHttpServer()).post(`/api/v1/contacts/${contactId}/link`).set('Authorization', `Bearer ${token}`).send({ patientId });

/** Roda um trecho como o worker do WhatsApp roda: contexto próprio, clínica definida, sem usuário. */
async function asWhatsAppPipeline<T>(clinic: Clinic, run: (get: <S>(token: Type<S> | symbol) => Promise<S>) => Promise<T>): Promise<T> {
  const contextId = ContextIdFactory.create();
  const tenantContext = await app.resolve(TenantContext, contextId, { strict: false });
  tenantContext.set(clinic.tenantId, null);
  return run(<S>(token: Type<S> | symbol) => app.resolve<S>(token as Type<S>, contextId, { strict: false }));
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: Error };
const settle = <T>(promise: Promise<T>): Promise<Settled<T>> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: Error) => ({ ok: false as const, error }),
  );

let phoneSequence = 0;
function nextPhone(): string {
  phoneSequence += 1;
  return `+55319${String(70000000 + phoneSequence + Math.floor(Math.random() * 9000000)).padStart(8, '0')}`;
}

async function pendingContact(clinic: Clinic, state: 'Conversando' | 'Identificado' = 'Identificado', name: string | null = 'Nome Informado Teste') {
  const row = await db.contact.create({
    data: { tenantId: clinic.tenantId, phoneNumber: nextPhone(), name: state === 'Conversando' ? null : name, state },
  });
  return { id: row.id, phoneNumber: row.phoneNumber as string };
}

async function patient(clinic: Clinic, name = `Paciente ${randomUUID()} Teste`): Promise<string> {
  const row = await db.patient.create({ data: { tenantId: clinic.tenantId, name, phone: nextPhone(), state: 'Ativo' } });
  clinic.fixture.patientIds.push(row.id);
  return row.id;
}

/** Tudo o que está gravado sobre o contato — lido direto do banco, de todas as clínicas. */
async function snapshot(contactId: string) {
  const contact = await db.contact.findUniqueOrThrow({ where: { id: contactId }, include: { associations: { orderBy: { createdAt: 'asc' } } } });
  const audits = await db.auditLog.findMany({ where: { entityId: contactId }, orderBy: [{ createdAt: 'asc' }, { action: 'asc' }] });
  return {
    state: contact.state,
    name: contact.name,
    updatedAt: contact.updatedAt.toISOString(),
    patientIds: contact.associations.map((association) => association.patientId),
    associations: contact.associations.map((association) => ({
      tenantId: association.tenantId,
      patientId: association.patientId,
      createdAt: association.createdAt.toISOString(),
    })),
    audits: audits.map((audit) => ({
      tenantId: audit.tenantId,
      action: audit.action,
      userId: audit.userId,
      actorType: audit.actorType,
      payload: audit.payload as Record<string, unknown> | null,
      createdAt: audit.createdAt.toISOString(),
    })),
  };
}

const approvalsIn = (state: Awaited<ReturnType<typeof snapshot>>) =>
  state.audits.filter((audit) => audit.action === 'ContatoVinculadoAPacienteExistente');

const patientCount = (clinic: Clinic) => db.patient.count({ where: { tenantId: clinic.tenantId } });

/**
 * Qual transação do banco gravou cada linha ligada ao contato. `xmin` é a
 * coluna de sistema do Postgres com o identificador da transação que
 * inseriu (ou regravou) a versão atual da linha: linhas com o mesmo `xmin`
 * foram gravadas pela mesma transação. É a prova direta — não depende de
 * relógio nenhum.
 */
async function writingTransactions(contactId: string, patientId?: string) {
  const contact = await db.$queryRaw<Array<{ xid: string }>>`SELECT xmin::text AS xid FROM contact WHERE id = ${contactId}`;
  const links = await db.$queryRaw<Array<{ xid: string }>>`SELECT xmin::text AS xid FROM contact_patient_association WHERE contact_id = ${contactId}`;
  const audits = await db.$queryRaw<Array<{ xid: string; action: string }>>`
    SELECT xmin::text AS xid, action FROM audit_log WHERE entity_id = ${contactId} ORDER BY action
  `;
  const patientRow = patientId
    ? await db.$queryRaw<Array<{ xid: string }>>`SELECT xmin::text AS xid FROM patient WHERE id = ${patientId}`
    : [];
  return {
    contact: contact[0].xid,
    links: links.map((row) => row.xid),
    audits: audits.map((row) => ({ action: row.action, xid: row.xid })),
    patient: patientRow[0]?.xid,
  };
}

async function createClinic(label: string): Promise<Clinic> {
  const fixture = await createDedicatedFixture(db, label, { withActiveSubscription: true });
  return { fixture, tenantId: fixture.tenantId };
}

async function admin(clinic: Clinic, label: string): Promise<{ token: string; userId: string }> {
  const token = await createDedicatedUserAndLogin(db, app, clinic.fixture, label, UserRole.admin);
  return { token, userId: clinic.fixture.userId as string };
}

async function cleanupClinic(clinic: Clinic | undefined): Promise<void> {
  if (!clinic) return;
  await db.contactPatientAssociation.deleteMany({ where: { tenantId: clinic.tenantId } });
  await db.contact.deleteMany({ where: { tenantId: clinic.tenantId } });
  // O cadastro pelo WhatsApp cria pacientes que o teste não conhece pelo id;
  // o filtro é o id de uma clínica que só este arquivo possui.
  const patients = await db.patient.findMany({ where: { tenantId: clinic.tenantId }, select: { id: true } });
  clinic.fixture.patientIds = Array.from(new Set([...clinic.fixture.patientIds, ...patients.map((row) => row.id)]));
  await cleanupDedicatedFixture(db, clinic.fixture);
}

beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await db.$connect();

  app = await bootstrapTestApp({
    overrides: [
      { provide: CONTACT_REPOSITORY, useClass: GatedContactRepository },
      { provide: AUDIT_LOG_REPOSITORY, useClass: GatedAuditLogRepository },
    ],
  });

  clinicA = await createClinic('LINKINTEGRITYA');
  clinicB = await createClinic('LINKINTEGRITYB');
  adminA1 = await admin(clinicA, 'LINKINTEGRITYA');
  adminA2 = await admin(clinicA, 'LINKINTEGRITYA');
  adminB = await admin(clinicB, 'LINKINTEGRITYB');
}, 90_000);

afterEach(() => {
  // Nenhuma transação fica parada nem falha programada sobra para o teste seguinte.
  for (const open of openHolds.splice(0)) open();
  gates.lockHold = null;
  gates.readHold = null;
  gates.failAssociation = null;
  gates.failAudit = null;
});

afterAll(async () => {
  await app?.close();
  if (db) {
    await cleanupClinic(clinicA);
    await cleanupClinic(clinicB);
    await db.$disconnect();
  }
}, 90_000);

describe('[CRÍTICO — ADR-0063, AD-038] aprovação de vínculo: concorrência e atomicidade', () => {
  describe('duas aprovações do mesmo contato ao mesmo tempo', () => {
    it.each([1, 2, 3, 4, 5])('pacientes DIFERENTES: uma vence (201), a outra é recusada (409), e fica um vínculo só — rodada %i', async () => {
      const contact = await pendingContact(clinicA);
      const [p1, p2] = [await patient(clinicA), await patient(clinicA)];

      const hold = holdFirstLocker(contact.id);
      const first = start(link(adminA1.token, contact.id, p1));
      const second = start(link(adminA2.token, contact.id, p2));
      const holderPid = await hold.holderPid; // uma das duas travou o contato e está parada
      await waitUntilSomeoneWaitsFor(holderPid); // a outra está esperando por ele, no banco
      hold.release();
      const [a, b] = await Promise.all([first, second]);

      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const won = a.status === 201 ? { res: a, patientId: p1, by: adminA1 } : { res: b, patientId: p2, by: adminA2 };
      const lost = a.status === 201 ? { res: b, by: adminA2 } : { res: a, by: adminA1 };
      expect(lost.res.body.error.message).toBe('Este número já está vinculado a um paciente.');
      expect(won.res.body).toMatchObject({ contactId: contact.id, patientId: won.patientId, state: 'Vinculado', approvedByUserId: won.by.userId });

      const after = await snapshot(contact.id);
      expect(after.state).toBe('Vinculado');
      expect(after.patientIds).toEqual([won.patientId]);
      const approvals = approvalsIn(after);
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({
        tenantId: clinicA.tenantId,
        userId: won.by.userId,
        actorType: 'user',
        payload: { patientId: won.patientId, approvedByUserId: won.by.userId, approvedAt: won.res.body.approvedAt },
      });
      // Nada ficou registrado em nome de quem perdeu.
      expect(after.audits.some((audit) => audit.userId === lost.by.userId)).toBe(false);
      expect(after.audits.filter((audit) => audit.action === 'ContatoAssociadoAPaciente')).toHaveLength(1);
    }, 30_000);

    it.each([1, 2, 3])('o MESMO paciente (clique em duas abas): uma vence, a outra é recusada, e a auditoria não é duplicada — rodada %i', async () => {
      const contact = await pendingContact(clinicA);
      const p1 = await patient(clinicA);

      const hold = holdFirstLocker(contact.id);
      const first = start(link(adminA1.token, contact.id, p1));
      const second = start(link(adminA1.token, contact.id, p1));
      const holderPid = await hold.holderPid;
      await waitUntilSomeoneWaitsFor(holderPid);
      hold.release();
      const [a, b] = await Promise.all([first, second]);

      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const after = await snapshot(contact.id);
      expect(after.state).toBe('Vinculado');
      expect(after.patientIds).toEqual([p1]);
      expect(approvalsIn(after)).toHaveLength(1);
      expect(after.audits.filter((audit) => audit.action === 'ContatoAssociadoAPaciente')).toHaveLength(1);
    }, 30_000);

    it('depois da disputa, o número identifica o paciente que venceu — e só ele', async () => {
      const contact = await pendingContact(clinicA);
      const [p1, p2] = [await patient(clinicA), await patient(clinicA)];

      const hold = holdFirstLocker(contact.id);
      const first = start(link(adminA1.token, contact.id, p1));
      const second = start(link(adminA2.token, contact.id, p2));
      await waitUntilSomeoneWaitsFor(await hold.holderPid);
      hold.release();
      const [a] = await Promise.all([first, second]);
      const winner = a.status === 201 ? p1 : p2;

      const identity = await asWhatsAppPipeline(clinicA, async (get) => {
        const repository = await get<ContactRepository>(CONTACT_REPOSITORY);
        const resolver = await get(ResolverIdentidadeDoContatoUseCase);
        return resolver.execute((await repository.findById(contact.id)) as Contact);
      });

      expect(identity).toEqual({ status: 'recognized', patientId: winner });
    }, 30_000);
  });

  describe('repetição de uma aprovação já concluída', () => {
    it('a segunda aprovação é recusada — para o mesmo paciente, para outro e por outro administrador — e nada mais é gravado', async () => {
      const contact = await pendingContact(clinicA);
      const [p1, p2] = [await patient(clinicA), await patient(clinicA)];

      const approved = await link(adminA1.token, contact.id, p1);
      expect(approved.status).toBe(201);
      const afterApproval = await snapshot(contact.id);

      expect((await link(adminA1.token, contact.id, p1)).status).toBe(409);
      expect((await link(adminA1.token, contact.id, p2)).status).toBe(409);
      expect((await link(adminA2.token, contact.id, p1)).status).toBe(409);

      const afterRepeats = await snapshot(contact.id);
      expect(afterRepeats).toEqual(afterApproval);
      expect(afterRepeats.patientIds).toEqual([p1]);
      expect(approvalsIn(afterRepeats)).toHaveLength(1);
    }, 30_000);

    it('o horário da aprovação é um só — o mesmo na resposta e no registro de auditoria — e vem antes das gravações que ele carimba', async () => {
      const contact = await pendingContact(clinicA);
      const p1 = await patient(clinicA);

      const beforeRequest = Date.now();
      const res = await link(adminA1.token, contact.id, p1);
      const afterRequest = Date.now();
      expect(res.status).toBe(201);

      const after = await snapshot(contact.id);
      const [approval] = approvalsIn(after);
      expect(approval.payload?.approvedAt).toBe(res.body.approvedAt);
      // Um horário de verdade, dentro da janela da requisição, tomado antes
      // de o vínculo e o registro serem gravados (mesma transação, mesmo
      // relógio: é a aplicação que preenche `created_at`).
      const approvedAt = new Date(res.body.approvedAt).getTime();
      const linkedAt = new Date(after.associations[0].createdAt).getTime();
      const auditedAt = new Date(approval.createdAt).getTime();
      expect(approvedAt).toBeGreaterThanOrEqual(beforeRequest);
      expect(linkedAt).toBeGreaterThanOrEqual(approvedAt);
      expect(auditedAt).toBeGreaterThanOrEqual(linkedAt);
      expect(auditedAt).toBeLessThanOrEqual(afterRequest);
    }, 30_000);

    it('a aprovação que esperou pela outra não carrega o horário de quando começou a esperar', async () => {
      // A que perde nem chega a ter horário; a que vence toma o seu depois de
      // obter a trava — nunca antes de a anterior ter sido liberada.
      const contact = await pendingContact(clinicA);
      const p1 = await patient(clinicA);

      const hold = holdFirstLocker(contact.id);
      const approval = start(link(adminA1.token, contact.id, p1));
      await hold.holderPid; // já passou pela trava; o horário ainda não foi tomado
      const heldUntil = Date.now();
      hold.release();
      const res = await approval;

      expect(res.status).toBe(201);
      expect(new Date(res.body.approvedAt).getTime()).toBeGreaterThanOrEqual(heldUntil);
    }, 30_000);
  });

  describe('uma transação só', () => {
    it('o contato, o vínculo e TODOS os registros de auditoria da aprovação foram gravados pela mesma transação do banco', async () => {
      // Sem nome ainda: a aprovação muda o contato (nome e estado), cria o
      // vínculo e grava três registros de auditoria.
      const contact = await pendingContact(clinicA, 'Conversando');
      const p1 = await patient(clinicA, 'Paciente Da Transacao Teste');

      expect((await link(adminA1.token, contact.id, p1)).status).toBe(201);

      const written = await writingTransactions(contact.id);
      expect(written.links).toHaveLength(1);
      expect(written.audits.map((audit) => audit.action)).toEqual([
        'ContatoAssociadoAPaciente',
        'ContatoIdentificado',
        'ContatoVinculadoAPacienteExistente',
      ]);
      const transactions = new Set([written.contact, ...written.links, ...written.audits.map((audit) => audit.xid)]);
      expect(transactions.size).toBe(1);
    }, 30_000);

    it('duas aprovações de contatos diferentes são duas transações — a unidade de trabalho não mistura requisições', async () => {
      const [first, second] = [await pendingContact(clinicA), await pendingContact(clinicA)];
      const [p1, p2] = [await patient(clinicA), await patient(clinicA)];

      const [a, b] = await Promise.all([start(link(adminA1.token, first.id, p1)), start(link(adminA2.token, second.id, p2))]);
      expect([a.status, b.status]).toEqual([201, 201]);

      const [one, other] = [await writingTransactions(first.id), await writingTransactions(second.id)];
      expect(new Set([one.contact, ...one.links, ...one.audits.map((audit) => audit.xid)]).size).toBe(1);
      expect(new Set([other.contact, ...other.links, ...other.audits.map((audit) => audit.xid)]).size).toBe(1);
      expect(one.contact).not.toBe(other.contact);
      // E cada uma registrou o seu aprovador.
      expect(approvalsIn(await snapshot(first.id))[0].userId).toBe(adminA1.userId);
      expect(approvalsIn(await snapshot(second.id))[0].userId).toBe(adminA2.userId);
    }, 30_000);

    it('o cadastro pelo WhatsApp também: paciente, contato, associação e auditoria na mesma transação', async () => {
      const name = `Cadastro Atomico ${randomUUID().replace(/[^a-f]/g, '')}x Teste`;
      const contact = await pendingContact(clinicA, 'Identificado', name);

      const promoted = await asWhatsAppPipeline(clinicA, async (get) =>
        (await get(PromoverContatoUseCase)).execute({ contactId: contact.id, patientName: name }),
      );

      const written = await writingTransactions(contact.id, promoted.patient.id);
      expect(written.links).toHaveLength(1);
      expect(written.audits.length).toBeGreaterThan(0);
      const transactions = new Set([written.contact, written.patient, ...written.links, ...written.audits.map((audit) => audit.xid)]);
      expect(transactions.size).toBe(1);
    }, 30_000);
  });

  describe('falha na gravação da auditoria', () => {
    it.each(['antes', 'depois'] as const)(
      'o registro da aprovação falha (%s de ser inserido): o vínculo não existe, nada do contato muda e nenhum registro sobra',
      async (when) => {
        // Sem nome ainda: a aprovação grava também o nome e três registros de
        // auditoria. O que falha é o último — os anteriores já tinham sido
        // inseridos na transação e têm de sumir com ela.
        const contact = await pendingContact(clinicA, 'Conversando');
        const p1 = await patient(clinicA, 'Paciente Da Auditoria Teste');
        const before = await snapshot(contact.id);
        gates.failAudit = { entityId: contact.id, action: 'ContatoVinculadoAPacienteExistente', when };

        const res = await link(adminA1.token, contact.id, p1);

        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain('falha simulada');
        const after = await snapshot(contact.id);
        expect(after).toEqual(before);
        expect(after).toMatchObject({ state: 'Conversando', name: null, patientIds: [], audits: [] });

        // O contato não ficou preso: sem a falha, a mesma aprovação passa.
        gates.failAudit = null;
        const retry = await link(adminA1.token, contact.id, p1);
        expect(retry.status).toBe(201);
        const afterRetry = await snapshot(contact.id);
        expect(afterRetry).toMatchObject({ state: 'Vinculado', name: 'Paciente Da Auditoria Teste', patientIds: [p1] });
        expect(afterRetry.audits.map((audit) => audit.action).sort()).toEqual(
          ['ContatoAssociadoAPaciente', 'ContatoIdentificado', 'ContatoVinculadoAPacienteExistente'].sort(),
        );
      },
      30_000,
    );

    it('o PRIMEIRO registro de auditoria falha: nem o contato chega a ficar "Vinculado"', async () => {
      const contact = await pendingContact(clinicA);
      const p1 = await patient(clinicA);
      const before = await snapshot(contact.id);
      gates.failAudit = { entityId: contact.id, action: 'ContatoAssociadoAPaciente', when: 'antes' };

      const res = await link(adminA1.token, contact.id, p1);

      expect(res.status).toBe(500);
      expect(await snapshot(contact.id)).toEqual(before);
    }, 30_000);
  });

  describe('falha durante a criação do vínculo', () => {
    it.each(['antes', 'depois'] as const)(
      'a gravação do vínculo falha (%s do INSERT): o contato não muda de estado, não há vínculo nem auditoria',
      async (when) => {
        const contact = await pendingContact(clinicA, 'Conversando');
        const p1 = await patient(clinicA, 'Paciente Do Vinculo Teste');
        const before = await snapshot(contact.id);
        gates.failAssociation = { contactId: contact.id, when };

        const res = await link(adminA1.token, contact.id, p1);

        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain('falha simulada');
        const after = await snapshot(contact.id);
        expect(after).toEqual(before);
        expect(after).toMatchObject({ state: 'Conversando', name: null, patientIds: [], audits: [] });

        gates.failAssociation = null;
        const retry = await link(adminA1.token, contact.id, p1);
        expect(retry.status).toBe(201);
        expect(await snapshot(contact.id)).toMatchObject({ state: 'Vinculado', patientIds: [p1] });
      },
      30_000,
    );
  });

  describe('entre clínicas diferentes', () => {
    it('o administrador de outra clínica não aprova, não altera e não deixa registro — em nenhuma combinação', async () => {
      const contactOfA = await pendingContact(clinicA);
      const contactOfB = await pendingContact(clinicB);
      const [patientOfA, patientOfB] = [await patient(clinicA), await patient(clinicB)];
      const before = { a: await snapshot(contactOfA.id), b: await snapshot(contactOfB.id) };

      // Contato de A com paciente de B, contato de A com paciente de A, e o
      // próprio contato com paciente de A — tudo pedido pelo administrador de B.
      expect((await link(adminB.token, contactOfA.id, patientOfB)).status).toBe(404);
      expect((await link(adminB.token, contactOfA.id, patientOfA)).status).toBe(404);
      expect((await link(adminB.token, contactOfB.id, patientOfA)).status).toBe(404);
      // E o administrador de A com o paciente de B.
      expect((await link(adminA1.token, contactOfA.id, patientOfB)).status).toBe(404);

      expect(await snapshot(contactOfA.id)).toEqual(before.a);
      expect(await snapshot(contactOfB.id)).toEqual(before.b);
      expect(before.a.audits).toEqual([]);
      expect(before.b.audits).toEqual([]);
    }, 30_000);

    it('enquanto a própria clínica aprova, a outra recebe 404 na hora — não espera pela trava nem percebe que o contato existe', async () => {
      const contact = await pendingContact(clinicA);
      const [patientOfA, patientOfB] = [await patient(clinicA), await patient(clinicB)];

      const hold = holdFirstLocker(contact.id);
      const own = start(link(adminA1.token, contact.id, patientOfA));
      const holderPid = await hold.holderPid; // a aprovação legítima está com a trava na mão

      // Respondido com a trava ainda segura: a RLS tira a linha da frente da
      // outra clínica antes de qualquer espera.
      const foreign = await link(adminB.token, contact.id, patientOfB);
      expect(foreign.status).toBe(404);
      expect(await sessionsBlockedBy(holderPid)).toBe(0);

      hold.release();
      expect((await own).status).toBe(201);

      const after = await snapshot(contact.id);
      expect(after.patientIds).toEqual([patientOfA]);
      expect(after.associations.map((association) => association.tenantId)).toEqual([clinicA.tenantId]);
      expect(after.audits.length).toBeGreaterThan(0);
      expect(after.audits.every((audit) => audit.tenantId === clinicA.tenantId)).toBe(true);
      expect(after.audits.some((audit) => audit.userId === adminB.userId)).toBe(false);
      expect(await db.auditLog.count({ where: { tenantId: clinicB.tenantId, entityId: contact.id } })).toBe(0);
    }, 30_000);
  });

  describe('o que o WhatsApp faz com o mesmo contato no mesmo instante', () => {
    it('uma mensagem lida ANTES da aprovação e gravada DEPOIS não desfaz a aprovação', async () => {
      const contact = await pendingContact(clinicA);
      const p1 = await patient(clinicA);

      const read = holdAfterRead(contact.id);
      const message = start(
        asWhatsAppPipeline(clinicA, async (get) => (await get(ReconhecerOuCriarContatoUseCase)).execute(clinicA.tenantId, contact.phoneNumber)),
      );
      await read.reached; // a mensagem já leu o contato, ainda "Identificado"

      expect((await link(adminA1.token, contact.id, p1)).status).toBe(201);

      read.release(); // e só agora grava
      await message;

      const after = await snapshot(contact.id);
      expect(after.state).toBe('Vinculado');
      expect(after.patientIds).toEqual([p1]);

      const identity = await asWhatsAppPipeline(clinicA, async (get) => {
        const repository = await get<ContactRepository>(CONTACT_REPOSITORY);
        return (await get(ResolverIdentidadeDoContatoUseCase)).execute((await repository.findById(contact.id)) as Contact);
      });
      expect(identity).toEqual({ status: 'recognized', patientId: p1 });
    }, 30_000);

    it('a mensagem de um contato que já conversa registra a atividade sem regravar estado nem nome', async () => {
      const contact = await pendingContact(clinicA, 'Identificado', 'Nome Que Fica Teste');
      const before = await snapshot(contact.id);

      const recognized = await asWhatsAppPipeline(clinicA, async (get) =>
        (await get(ReconhecerOuCriarContatoUseCase)).execute(clinicA.tenantId, contact.phoneNumber),
      );

      const after = await snapshot(contact.id);
      expect(recognized.id).toBe(contact.id);
      expect({ state: after.state, name: after.name, patientIds: after.patientIds }).toEqual({ state: 'Identificado', name: 'Nome Que Fica Teste', patientIds: [] });
      expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(before.updatedAt).getTime());
      expect(after.audits).toEqual([]);
    }, 30_000);

    it('um nome informado enquanto a clínica aprova: espera a aprovação e é recusado — o vínculo fica', async () => {
      const contact = await pendingContact(clinicA, 'Identificado', 'Nome Antes Teste');
      const p1 = await patient(clinicA);

      const hold = holdFirstLocker(contact.id);
      const approval = start(link(adminA1.token, contact.id, p1));
      const holderPid = await hold.holderPid; // a aprovação travou o contato
      const naming = settle(
        asWhatsAppPipeline(clinicA, async (get) => (await get(IdentificarContatoUseCase)).execute({ contactId: contact.id, name: 'Outro Nome Agora Teste' })),
      );
      await waitUntilSomeoneWaitsFor(holderPid); // o nome está esperando pela mesma linha
      hold.release();
      const [approved, named] = await Promise.all([approval, naming]);

      expect(approved.status).toBe(201);
      expect(named.ok).toBe(false);
      const after = await snapshot(contact.id);
      expect(after).toMatchObject({ state: 'Vinculado', name: 'Nome Antes Teste', patientIds: [p1] });
      expect(after.audits.filter((audit) => audit.action === 'ContatoIdentificado')).toEqual([]);
    }, 30_000);

    it('a clínica aprova enquanto um nome é gravado: espera, e os dois valem — o nome fica e o vínculo também', async () => {
      const contact = await pendingContact(clinicA, 'Conversando');
      const p1 = await patient(clinicA, 'Paciente Aprovado Teste');

      const hold = holdFirstLocker(contact.id);
      const naming = start(
        asWhatsAppPipeline(clinicA, async (get) => (await get(IdentificarContatoUseCase)).execute({ contactId: contact.id, name: 'Nome Informado Agora Teste' })),
      );
      const holderPid = await hold.holderPid; // o nome travou o contato
      const approval = start(link(adminA1.token, contact.id, p1));
      await waitUntilSomeoneWaitsFor(holderPid); // a aprovação está esperando
      hold.release();
      const [named, approved] = await Promise.all([naming, approval]);

      expect(named.name).toBe('Nome Informado Agora Teste');
      expect(approved.status).toBe(201);
      // A aprovação leu o contato já com o nome que a pessoa informou e não o trocou pelo do paciente.
      expect(await snapshot(contact.id)).toMatchObject({ state: 'Vinculado', name: 'Nome Informado Agora Teste', patientIds: [p1] });
    }, 30_000);

    it('um cadastro confirmado enquanto a clínica aprova: espera, é recusado e nenhum paciente novo é criado', async () => {
      const name = `Cadastro Tardio ${randomUUID().replace(/[^a-f]/g, '')}x Teste`;
      const contact = await pendingContact(clinicA, 'Identificado', name);
      const p1 = await patient(clinicA);
      const patientsBefore = await patientCount(clinicA);

      const hold = holdFirstLocker(contact.id);
      const approval = start(link(adminA1.token, contact.id, p1));
      const holderPid = await hold.holderPid;
      const promotion = settle(
        asWhatsAppPipeline(clinicA, async (get) => (await get(PromoverContatoUseCase)).execute({ contactId: contact.id, patientName: name })),
      );
      await waitUntilSomeoneWaitsFor(holderPid);
      hold.release();
      const [approved, promoted] = await Promise.all([approval, promotion]);

      expect(approved.status).toBe(201);
      expect(promoted.ok).toBe(false);
      expect(await patientCount(clinicA)).toBe(patientsBefore);
      expect(await db.patient.count({ where: { tenantId: clinicA.tenantId, phone: contact.phoneNumber } })).toBe(0);
      expect(await snapshot(contact.id)).toMatchObject({ state: 'Vinculado', patientIds: [p1] });
    }, 30_000);

    it('a clínica aprova enquanto um cadastro é confirmado: espera e é recusada (409) — fica só o paciente do cadastro', async () => {
      const name = `Cadastro Primeiro ${randomUUID().replace(/[^a-f]/g, '')}x Teste`;
      const contact = await pendingContact(clinicA, 'Identificado', name);
      const p1 = await patient(clinicA);
      const patientsBefore = await patientCount(clinicA);

      const hold = holdFirstLocker(contact.id);
      const promotion = start(
        asWhatsAppPipeline(clinicA, async (get) => (await get(PromoverContatoUseCase)).execute({ contactId: contact.id, patientName: name })),
      );
      const holderPid = await hold.holderPid; // o cadastro travou o contato
      const approval = start(link(adminA1.token, contact.id, p1));
      await waitUntilSomeoneWaitsFor(holderPid);
      hold.release();
      const [promoted, approved] = await Promise.all([promotion, approval]);

      expect(approved.status).toBe(409);
      expect(await patientCount(clinicA)).toBe(patientsBefore + 1);
      const after = await snapshot(contact.id);
      expect(after).toMatchObject({ state: 'Promovido', patientIds: [promoted.patient.id] });
      expect(approvalsIn(after)).toEqual([]);
    }, 30_000);

    it('duas confirmações do mesmo cadastro ao mesmo tempo: um paciente só', async () => {
      const name = `Cadastro Em Dobro ${randomUUID().replace(/[^a-f]/g, '')}x Teste`;
      const contact = await pendingContact(clinicA, 'Identificado', name);
      const patientsBefore = await patientCount(clinicA);
      const promote = () =>
        asWhatsAppPipeline(clinicA, async (get) => (await get(PromoverContatoUseCase)).execute({ contactId: contact.id, patientName: name }));

      const hold = holdFirstLocker(contact.id);
      const first = settle(promote());
      const holderPid = await hold.holderPid;
      const second = settle(promote());
      await waitUntilSomeoneWaitsFor(holderPid);
      hold.release();
      const results = await Promise.all([first, second]);

      expect(results.map((result) => result.ok).sort()).toEqual([false, true]);
      expect(await patientCount(clinicA)).toBe(patientsBefore + 1);
      expect(await db.patient.count({ where: { tenantId: clinicA.tenantId, phone: contact.phoneNumber } })).toBe(1);
      expect((await snapshot(contact.id)).patientIds).toHaveLength(1);
    }, 30_000);

    it('o cadastro falha depois de criar o paciente: o paciente também é desfeito — nunca um paciente sem contato', async () => {
      const name = `Cadastro Interrompido ${randomUUID().replace(/[^a-f]/g, '')}x Teste`;
      const contact = await pendingContact(clinicA, 'Identificado', name);
      const patientsBefore = await patientCount(clinicA);
      const before = await snapshot(contact.id);
      gates.failAssociation = { contactId: contact.id, when: 'depois' };

      const promoted = await settle(
        asWhatsAppPipeline(clinicA, async (get) => (await get(PromoverContatoUseCase)).execute({ contactId: contact.id, patientName: name })),
      );

      expect(promoted.ok).toBe(false);
      expect(await patientCount(clinicA)).toBe(patientsBefore);
      expect(await db.patient.count({ where: { tenantId: clinicA.tenantId, phone: contact.phoneNumber } })).toBe(0);
      expect(await snapshot(contact.id)).toEqual(before);
    }, 30_000);
  });

  it('nenhuma sessão ficou presa esperando por trava ao fim dos testes', async () => {
    const [row] = await db.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM "contact" WHERE id = %FOR UPDATE%'
    `;
    expect(row.waiting).toBe(0);
  });
});
