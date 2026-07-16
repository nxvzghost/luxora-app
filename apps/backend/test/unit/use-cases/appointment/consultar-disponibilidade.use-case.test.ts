import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ConsultarDisponibilidadeUseCase } from '@use-cases/appointment/consultar-disponibilidade.use-case';
import { Therapist } from '@domain/therapist/therapist.entity';
import { Clinic } from '@domain/clinic/clinic.entity';
import { Appointment } from '@domain/appointment/appointment.entity';
import { ClinicNotFoundError } from '@domain-services/platform/clinic-not-found.error';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function therapistWithMondayMorning() {
  const t = Therapist.create({ id: 't1', tenantId: TENANT_ID, name: 'Dra. Ana' });
  // 2026-08-03 é uma segunda-feira
  t.setAvailability([{ dayOfWeek: 1, startTime: '09:00', endTime: '11:00' }]);
  return t;
}

function makeUseCase(therapist: Therapist | null, appointments: Appointment[] = []) {
  const appointmentRepo = {
    findById: vi.fn(),
    findActiveByTherapistAndRange: vi.fn().mockResolvedValue(appointments),
    save: vi.fn(),
  };
  const therapistRepo = { findById: vi.fn().mockResolvedValue(therapist), findAllByTenant: vi.fn(), save: vi.fn() };
  const clinicRepo = {
    findByTenantId: vi.fn().mockResolvedValue(
      Clinic.reconstitute({
        tenantId: TENANT_ID,
        name: 'Clínica',
        defaultBillingPolicy: 'per_session',
        defaultSessionDurationMinutes: 50, // agora lido de verdade da Clínica, não mais fixo no Use Case
      }),
    ),
    save: vi.fn(),
  };
  return new ConsultarDisponibilidadeUseCase(appointmentRepo, therapistRepo, clinicRepo);
}

describe('ConsultarDisponibilidadeUseCase', () => {
  it('lança NotFoundException quando o terapeuta não existe', async () => {
    const useCase = makeUseCase(null);
    await expect(
      useCase.execute('t-inexistente', TENANT_ID, new Date('2026-08-03'), new Date('2026-08-03')),
    ).rejects.toThrow(NotFoundException);
  });

  it('lança ClinicNotFoundError quando a clínica não existe', async () => {
    const appointmentRepo = { findById: vi.fn(), findActiveByTherapistAndRange: vi.fn().mockResolvedValue([]), save: vi.fn() };
    const therapistRepo = { findById: vi.fn().mockResolvedValue(therapistWithMondayMorning()), findAllByTenant: vi.fn(), save: vi.fn() };
    const clinicRepo = { findByTenantId: vi.fn().mockResolvedValue(null), save: vi.fn() };
    const useCase = new ConsultarDisponibilidadeUseCase(appointmentRepo, therapistRepo, clinicRepo);
    await expect(
      useCase.execute('t1', TENANT_ID, new Date('2026-08-03'), new Date('2026-08-03T23:59:59')),
    ).rejects.toThrow(ClinicNotFoundError);
  });

  it('usa a duração de sessão configurada na Clínica, não mais um valor fixo (60min → 2 slots em vez de 2 com 50min, mas em posições diferentes)', async () => {
    const appointmentRepo = { findById: vi.fn(), findActiveByTherapistAndRange: vi.fn().mockResolvedValue([]), save: vi.fn() };
    const therapistRepo = { findById: vi.fn().mockResolvedValue(therapistWithMondayMorning()), findAllByTenant: vi.fn(), save: vi.fn() };
    const clinicRepo = {
      findByTenantId: vi.fn().mockResolvedValue(
        Clinic.reconstitute({ tenantId: TENANT_ID, name: 'Clínica', defaultBillingPolicy: 'per_session', defaultSessionDurationMinutes: 60 }),
      ),
      save: vi.fn(),
    };
    const useCase = new ConsultarDisponibilidadeUseCase(appointmentRepo, therapistRepo, clinicRepo);
    const slots = await useCase.execute('t1', TENANT_ID, new Date('2026-08-03T00:00:00'), new Date('2026-08-03T23:59:59'));
    // Janela 09:00-11:00 com slots de 60min: só 09:00-10:00 cabe (10:00-11:00 cabe tb!) → 2 slots, mas às 09:00 e 10:00, não 09:00/09:50
    expect(slots).toHaveLength(2);
    expect(slots[1].startsAt.getMinutes()).toBe(0); // prova que não é mais o passo de 50min
  });

  it('gera slots de 50min dentro da janela de disponibilidade (09:00-11:00 → 2 slots)', async () => {
    const useCase = makeUseCase(therapistWithMondayMorning());
    const slots = await useCase.execute(
      't1',
      TENANT_ID,
      new Date('2026-08-03T00:00:00'),
      new Date('2026-08-03T23:59:59'),
    );
    expect(slots).toHaveLength(2); // 09:00-09:50 e 09:50-10:40 (10:40-11:30 ultrapassaria 11:00)
  });

  it('não gera slot algum em dia sem disponibilidade configurada', async () => {
    const useCase = makeUseCase(therapistWithMondayMorning());
    // 2026-08-04 é terça-feira — sem disponibilidade configurada
    const slots = await useCase.execute(
      't1',
      TENANT_ID,
      new Date('2026-08-04T00:00:00'),
      new Date('2026-08-04T23:59:59'),
    );
    expect(slots).toHaveLength(0);
  });

  it('exclui slot que colide com agendamento ativo existente', async () => {
    const existing = Appointment.reconstitute({
      id: 'a1',
      tenantId: TENANT_ID,
      patientId: 'p1',
      therapistId: 't1',
      scheduledAt: new Date('2026-08-03T09:00:00'),
      modality: 'presencial',
      state: 'Confirmada',
      recurring: false,
    });
    const useCase = makeUseCase(therapistWithMondayMorning(), [existing]);
    const slots = await useCase.execute(
      't1',
      TENANT_ID,
      new Date('2026-08-03T00:00:00'),
      new Date('2026-08-03T23:59:59'),
    );
    // Só o slot das 09:50 deveria sobrar (09:00 está ocupado)
    expect(slots).toHaveLength(1);
    expect(slots[0].startsAt.getHours()).toBe(9);
    expect(slots[0].startsAt.getMinutes()).toBe(50);
  });
});
