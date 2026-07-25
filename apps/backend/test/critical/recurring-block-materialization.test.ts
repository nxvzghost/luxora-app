import { randomUUID, randomInt } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaAppointmentRepository } from '@infrastructure/database/repositories/prisma-appointment.repository';
import { PrismaAvailabilityRepository } from '@infrastructure/database/repositories/prisma-availability.repository';
import { PrismaClinicHolidayRepository } from '@infrastructure/database/repositories/prisma-clinic-holiday.repository';
import { PrismaRecurringBlockRepository } from '@infrastructure/database/repositories/prisma-recurring-block.repository';
import { PrismaAuditLogRepository } from '@infrastructure/database/repositories/prisma-audit-log.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { VerificarDisponibilidadeUseCase } from '@use-cases/availability/verificar-disponibilidade.use-case';
import { MaterializarRecurringBlockUseCase } from '@use-cases/availability/materializar-recurring-block.use-case';
import { RecurringBlock } from '@domain/availability/recurring-block.entity';
import { ClinicHoliday } from '@domain/availability/clinic-holiday.entity';
import { Appointment } from '@domain/appointment/appointment.entity';
import { TenantContext } from '@shared/tenant-context';

/**
 * PD-001 Fase 2, C3 — materialização de ocorrências de RecurringBlock, de
 * ponta a ponta (Repositories reais, Motor real, banco real). Não usa
 * bootstrapTestApp(): não há Controller/Endpoint nesta etapa (fora do
 * escopo da C3) — as peças são montadas diretamente, mesmo padrão de
 * clinic-holiday-persistence.test.ts (B3), estendido para compor também o
 * Motor (VerificarDisponibilidadeUseCase) e a Auditoria (AuditService).
 */

let client: PrismaClientProvider;
let tenantAId: string;
let tenantBId: string;
let patientId: string;
let therapistId: string;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}
const fixturePrisma = new PrismaClient({
  datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } },
});

// Mesmo raciocínio de test/critical/support/unique-slot.ts e de
// clinic-holiday-persistence.test.ts: âncora aleatória bem afastada,
// sorteada uma vez por execução do processo — evita colisão com dado
// deixado por rodadas anteriores e com outros arquivos de teste crítico
// rodando em paralelo contra o mesmo terapeuta seedado. Hora também
// aleatória (não fixa em 14h) — reduz ainda mais a chance de colidir com
// o horário aleatório que unique-slot.ts sorteia para outros arquivos.
const ANCHOR_DAYS_AHEAD = randomInt(30, 9970);
const ANCHOR_HOUR = randomInt(0, 24);
function dateAt(daysFromAnchor: number, hour = ANCHOR_HOUR): Date {
  const date = new Date();
  date.setDate(date.getDate() + ANCHOR_DAYS_AHEAD + daysFromAnchor);
  date.setHours(hour, 0, 0, 0);
  return date;
}

beforeAll(async () => {
  client = new PrismaClientProvider();
  await client.$connect();
  await fixturePrisma.$connect();

  // Tenants próprios e dedicados deste arquivo — não reusa "Clínica Teste
  // A/B" seedadas. Causa raiz (2ª camada, descoberta ao investigar a
  // primeira): ClinicHoliday é validado por Tenant inteiro, não por
  // Terapeuta (VerificarDisponibilidadeUseCase consulta
  // clinicHolidayRepo.findByTenantAndRange(calendar.tenantId, ...), sem
  // filtro de therapistId) — então mesmo um Terapeuta dedicado (ver abaixo)
  // continuava exposto a qualquer ClinicHoliday deixado por OUTRO arquivo
  // de teste crítico no mesmo Tenant (ex: clinic-holiday-persistence.test.ts,
  // que cria feriados sem limpeza entre execuções). Um Tenant dedicado
  // fecha essa segunda camada de vez: ClinicHoliday, Appointment e
  // RecurringBlock são todos filtrados por tenantId explícito + RLS — nenhum
  // outro arquivo, presente ou futuro, pode gravar dado neste Tenant.
  const dedicatedTenantA = await fixturePrisma.tenant.create({
    data: { name: `Tenant Dedicado A — C3 Materialização ${randomUUID()}` },
  });
  const dedicatedTenantB = await fixturePrisma.tenant.create({
    data: { name: `Tenant Dedicado B — C3 Materialização ${randomUUID()}` },
  });
  tenantAId = dedicatedTenantA.id;
  tenantBId = dedicatedTenantB.id;

  // Terapeuta/Paciente próprios e dedicados (1ª camada, já corrigida antes):
  // não usa findFirst() sobre dado seedado nem sobre nenhum critério
  // incidental (nome, ordem de inserção) — id gerado nesta própria
  // execução, posse direta, nenhuma seleção sujeita a poluição de outro
  // arquivo.
  const dedicatedTherapist = await fixturePrisma.therapist.create({
    data: {
      tenantId: tenantAId,
      name: `Terapeuta Dedicado — C3 Materialização ${randomUUID()}`,
      specialty: 'Psicologia',
    },
  });
  therapistId = dedicatedTherapist.id;

  // Disponibilidade ampla nos 7 dias, 24h — mesma amplitude usada pelo seed
  // original, mas pertencente exclusivamente a este terapeuta dedicado.
  await fixturePrisma.availabilityCalendar.create({
    data: {
      tenantId: tenantAId,
      therapistId,
      windows: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        dayOfWeek,
        startTime: '00:00',
        endTime: '23:59',
        sessionDurationMinutes: 60,
      })),
    },
  });

  const dedicatedPatient = await fixturePrisma.patient.create({
    data: {
      tenantId: tenantAId,
      name: `Paciente Dedicado — C3 Materialização ${randomUUID()}`,
      phone: '11999999999',
    },
  });
  patientId = dedicatedPatient.id;
});

afterAll(async () => {
  // Limpeza — evita que este arquivo se torne, ele mesmo, uma nova fonte da
  // mesma classe de poluição que esta correção eliminou (2 camadas:
  // Therapist/Patient e, agora, Tenant inteiro). Ordem respeita as FKs
  // RESTRICT do schema: filhos antes dos pais, Tenant por último.
  await fixturePrisma.auditLog.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } }); // MaterializarRecurringBlockUseCase grava audit_log por Appointment criado
  await fixturePrisma.appointment.deleteMany({ where: { therapistId } });
  await fixturePrisma.recurringBlock.deleteMany({ where: { therapistId } });
  await fixturePrisma.clinicHoliday.deleteMany({ where: { tenantId: tenantAId } });
  await fixturePrisma.availabilityCalendar.deleteMany({ where: { therapistId } });
  await fixturePrisma.therapist.delete({ where: { id: therapistId } });
  await fixturePrisma.patient.delete({ where: { id: patientId } });
  await fixturePrisma.tenant.delete({ where: { id: tenantAId } });
  await fixturePrisma.tenant.delete({ where: { id: tenantBId } });

  await client.$disconnect();
  await fixturePrisma.$disconnect();
});

function buildUseCase(options: { tenantId?: string } = {}) {
  const tenantContext = new TenantContext();
  tenantContext.set(options.tenantId ?? tenantAId, 'user-1');
  const prismaService = new PrismaService(client, tenantContext);

  const appointmentRepo = new PrismaAppointmentRepository(prismaService);
  const availabilityRepo = new PrismaAvailabilityRepository(prismaService);
  const clinicHolidayRepo = new PrismaClinicHolidayRepository(client);
  const recurringBlockRepo = new PrismaRecurringBlockRepository(client);
  const auditLogRepo = new PrismaAuditLogRepository(prismaService);
  const auditService = new AuditService(auditLogRepo, tenantContext);
  const verificarDisponibilidade = new VerificarDisponibilidadeUseCase(availabilityRepo, appointmentRepo, clinicHolidayRepo);

  const useCase = new MaterializarRecurringBlockUseCase(
    recurringBlockRepo,
    appointmentRepo,
    verificarDisponibilidade,
    tenantContext,
    auditService,
  );
  return { useCase, recurringBlockRepo, clinicHolidayRepo, appointmentRepo, tenantContext };
}

function newBlock(firstOccurrence: Date) {
  return RecurringBlock.create({
    id: randomUUID(),
    tenantId: tenantAId,
    patientId,
    therapistId,
    firstOccurrence,
    intervalDays: 7,
    modality: 'presencial',
    renewalMode: 'automatic',
  });
}

describe('MaterializarRecurringBlockUseCase — materialização de ponta a ponta (C3)', () => {
  it('materializa as ocorrências dentro da janela — Appointments reais, com recurringBlockId e state Reservada', async () => {
    const { useCase, recurringBlockRepo } = buildUseCase();
    const block = newBlock(dateAt(0));
    await recurringBlockRepo.save(block);

    // Janela cobre 0, 7 e 14 dias a partir da âncora (3 ocorrências).
    const result = await useCase.execute({ recurringBlockId: block.id, from: dateAt(-1), to: dateAt(15) });

    expect(result.created).toHaveLength(3);
    expect(result.skipped).toHaveLength(0);
    for (const appointment of result.created) {
      expect(appointment.recurringBlockId).toBe(block.id);
      expect(appointment.state).toBe('Reservada');
      expect(appointment.isRecurring).toBe(true);
    }
  });

  it('idempotência: materializar a mesma janela duas vezes não duplica nenhuma ocorrência', async () => {
    const { useCase, recurringBlockRepo } = buildUseCase();
    const block = newBlock(dateAt(100));
    await recurringBlockRepo.save(block);
    const window = { recurringBlockId: block.id, from: dateAt(99), to: dateAt(115) }; // 100, 107, 114

    const first = await useCase.execute(window);
    expect(first.created).toHaveLength(3);
    expect(first.skipped).toHaveLength(0);

    const second = await useCase.execute(window);
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(3);
    expect(second.skipped.every((s) => s.reason === 'already_materialized')).toBe(true);
  });

  it('ClinicHoliday bloqueia a ocorrência específica sem derrubar o restante do lote — Motor consultado, nunca duplicado', async () => {
    const { useCase, recurringBlockRepo, clinicHolidayRepo } = buildUseCase();
    const block = newBlock(dateAt(200));
    await recurringBlockRepo.save(block);

    const holidayOccurrence = dateAt(207); // 2ª ocorrência da série (200, 207, 214)
    const holiday = ClinicHoliday.create({
      id: randomUUID(),
      tenantId: tenantAId,
      from: new Date(holidayOccurrence.getTime() - 60 * 60 * 1000),
      to: new Date(holidayOccurrence.getTime() + 2 * 60 * 60 * 1000),
    });
    await clinicHolidayRepo.save(holiday);

    const result = await useCase.execute({ recurringBlockId: block.id, from: dateAt(199), to: dateAt(215) });

    expect(result.created).toHaveLength(2);
    expect(result.skipped).toContainEqual({ scheduledAt: holidayOccurrence, reason: 'not_available' });
  });

  it('lança NotFoundException para RecurringBlock inexistente', async () => {
    const { useCase } = buildUseCase();
    await expect(
      useCase.execute({ recurringBlockId: randomUUID(), from: dateAt(300), to: dateAt(315) }),
    ).rejects.toThrow(/não encontrado/);
  });

  it(
    'corrida de concorrência real (Postgres): duas materializações simultâneas do mesmo bloco, com janelas ' +
      'parcialmente sobrepostas, nunca duplicam — UNIQUE dispara, SESSION_CONFLICT é tratado, exatamente 1 ' +
      'retry no lado que perde a corrida, recuperação idempotente sem propagar exceção',
    async () => {
      // Uma única infraestrutura compartilhada entre os dois lados (mesmo appointmentRepo) —
      // reflete o que aconteceria de verdade: duas requisições concorrentes do mesmo Tenant
      // batem no mesmo Repository/conexão de banco, não em cópias isoladas.
      const { useCase: useCaseA, recurringBlockRepo, appointmentRepo, tenantContext } = buildUseCase();
      const prismaService2 = new PrismaService(client, tenantContext);
      const availabilityRepo2 = new PrismaAvailabilityRepository(prismaService2);
      const clinicHolidayRepo2 = new PrismaClinicHolidayRepository(client);
      const auditLogRepo2 = new PrismaAuditLogRepository(prismaService2);
      const auditService2 = new AuditService(auditLogRepo2, tenantContext);
      const verificarDisponibilidade2 = new VerificarDisponibilidadeUseCase(availabilityRepo2, appointmentRepo, clinicHolidayRepo2);
      const useCaseB = new MaterializarRecurringBlockUseCase(
        recurringBlockRepo,
        appointmentRepo,
        verificarDisponibilidade2,
        tenantContext,
        auditService2,
      );

      const block = newBlock(dateAt(400));
      await recurringBlockRepo.save(block);

      // A: 400, 407, 414 — B: 407, 414, 421 — overlap em 407/414 (onde a corrida é forçada),
      // exclusivas em 400 (só A) e 421 (só B).
      const overlapping = [dateAt(407), dateAt(414)];

      // Corrida real, mas com o ponto de colisão forçado deterministicamente no saveMany() —
      // não no Motor. Sem isso, o timing natural entre dois pipelines completos (idempotência +
      // Motor + saveMany) é ambíguo: o lado "perdedor" pode legitimamente ser barrado pelo Motor
      // (vendo o Appointment já commitado do outro lado como conflito de horário — mecanismo
      // pré-existente, correto, mas não o que este teste precisa provar) EM VEZ de pelo P2002 do
      // saveMany(). Só o primeiro a chamar saveMany() é atrasado — suas checagens de Motor já
      // rodaram antes do atraso, contra um estado limpo, então ele monta o lote completo antes de
      // saber que vai perder a corrida. Isso NÃO altera nenhuma implementação de produção: o spy
      // sempre chama a implementação real por baixo, só adia quando ela é invocada.
      const originalSaveMany = appointmentRepo.saveMany.bind(appointmentRepo);
      let callIndex = 0;
      const saveManySpy = vi
        .spyOn(appointmentRepo, 'saveMany')
        .mockImplementation(async (appointments: Appointment[], tx?: unknown) => {
          const myIndex = callIndex++;
          if (myIndex === 0) {
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          return originalSaveMany(appointments, tx);
        });

      const [resultA, resultB] = await Promise.all([
        useCaseA.execute({ recurringBlockId: block.id, from: dateAt(399), to: dateAt(415) }),
        useCaseB.execute({ recurringBlockId: block.id, from: dateAt(406), to: dateAt(422) }),
      ]);

      // Recuperação idempotente: Promise.all resolveu para os dois lados, nenhuma exceção propagou.

      // Nenhuma data foi criada duas vezes entre os dois resultados.
      const allCreated = [...resultA.created, ...resultB.created].map((a) => a.scheduledAt.toISOString());
      expect(new Set(allCreated).size).toBe(allCreated.length);

      // Cada ocorrência compartilhada foi criada por exatamente um dos dois lados — o outro a
      // reconhece especificamente como already_materialized (a corrida foi forçada a passar pelo
      // saveMany()/retry, não pelo Motor).
      for (const shared of overlapping) {
        const createdByA = resultA.created.some((a) => a.scheduledAt.getTime() === shared.getTime());
        const createdByB = resultB.created.some((a) => a.scheduledAt.getTime() === shared.getTime());
        expect(createdByA !== createdByB).toBe(true);
        const skippedByOther = (createdByA ? resultB : resultA).skipped.some(
          (s) => s.scheduledAt.getTime() === shared.getTime() && s.reason === 'already_materialized',
        );
        expect(skippedByOther).toBe(true);
      }

      // As ocorrências exclusivas de cada lado são sempre criadas, corrida ou não.
      expect(resultA.created.some((a) => a.scheduledAt.getTime() === dateAt(400).getTime())).toBe(true);
      expect(resultB.created.some((a) => a.scheduledAt.getTime() === dateAt(421).getTime())).toBe(true);

      // Prova direta no banco — a UNIQUE(recurring_block_id, scheduled_at) é o que garante isto:
      // sem ela, os dois lados teriam inserido linhas com `id` diferentes para a mesma ocorrência
      // lógica, e haveria duplicata real.
      const rows = await fixturePrisma.appointment.findMany({ where: { recurringBlockId: block.id } });
      expect(rows).toHaveLength(4);
      const rowDates = new Set(rows.map((r) => r.scheduledAt.toISOString()));
      expect(rowDates).toEqual(new Set([dateAt(400), dateAt(407), dateAt(414), dateAt(421)].map((d) => d.toISOString())));

      // Com a colisão forçada deterministicamente: exatamente 3 chamadas a saveMany() no total —
      // a chamada atrasada (falha com SESSION_CONFLICT), a chamada do outro lado (sucesso), e o
      // retry único da chamada atrasada (sucesso, só com a ocorrência exclusiva restante). Nunca
      // um 2º retry.
      expect(saveManySpy.mock.calls.length).toBe(3);
    },
  );

  it('a constraint UNIQUE(recurring_block_id, scheduled_at) rejeita diretamente uma segunda inserção idêntica, sem passar pela checagem de idempotência do Caso de Uso', async () => {
    const { recurringBlockRepo, appointmentRepo } = buildUseCase();
    const block = newBlock(dateAt(500));
    await recurringBlockRepo.save(block);
    const scheduledAt = dateAt(500);

    const first = Appointment.create({
      id: randomUUID(),
      tenantId: tenantAId,
      patientId,
      therapistId,
      scheduledAt,
      modality: 'presencial',
      recurring: true,
      recurringBlockId: block.id,
    });
    first.transitionTo('Reservada');
    await appointmentRepo.save(first);

    const second = Appointment.create({
      id: randomUUID(), // id diferente — só (recurringBlockId, scheduledAt) se repete
      tenantId: tenantAId,
      patientId,
      therapistId,
      scheduledAt,
      modality: 'presencial',
      recurring: true,
      recurringBlockId: block.id,
    });
    second.transitionTo('Reservada');

    let caught: unknown;
    try {
      await appointmentRepo.save(second);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).getResponse()).toMatchObject({ code: 'SESSION_CONFLICT' });

    const rows = await fixturePrisma.appointment.findMany({ where: { recurringBlockId: block.id, scheduledAt } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
  });

  it('isolamento entre tenants: Tenant B nunca materializa um RecurringBlock do Tenant A — NotFoundException, nenhum Appointment criado', async () => {
    const { recurringBlockRepo } = buildUseCase(); // Tenant A (default)
    const block = newBlock(dateAt(600));
    await recurringBlockRepo.save(block);

    const { useCase: useCaseAsTenantB } = buildUseCase({ tenantId: tenantBId });

    await expect(
      useCaseAsTenantB.execute({ recurringBlockId: block.id, from: dateAt(599), to: dateAt(615) }),
    ).rejects.toThrow(NotFoundException);

    const rows = await fixturePrisma.appointment.findMany({ where: { recurringBlockId: block.id } });
    expect(rows).toHaveLength(0);
  });
});
