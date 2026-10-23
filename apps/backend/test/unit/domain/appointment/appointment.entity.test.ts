import { describe, it, expect } from 'vitest';
import { Appointment } from '@domain/appointment/appointment.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function newAppointment() {
  return Appointment.create({
    id: 'a1',
    tenantId: TENANT_ID,
    patientId: 'p1',
    therapistId: 't1',
    scheduledAt: new Date('2026-08-01T15:00:00Z'),
    modality: 'presencial',
    recurring: false,
  });
}

describe('Appointment', () => {
  it('nasce no estado Criada', () => {
    expect(newAppointment().state).toBe('Criada');
  });

  it('percorre o fluxo feliz até Confirmada', () => {
    const a = newAppointment();
    a.transitionTo('Reservada');
    a.transitionTo('Confirmada');
    expect(a.state).toBe('Confirmada');
  });

  it('permite cancelamento em qualquer estado não-terminal', () => {
    const a = newAppointment();
    a.transitionTo('Reservada');
    a.transitionTo('Cancelada');
    expect(a.state).toBe('Cancelada');
  });

  it('Cancelada é estado terminal', () => {
    const a = newAppointment();
    a.transitionTo('Cancelada');
    expect(() => a.transitionTo('Reservada')).toThrow();
  });

  // K2-b (ADR-0069, seção 5) — a remarcação não move o horário da mesma
  // ocorrência: cria outra, ligada à anterior.
  it('rescheduledFrom() cria a ocorrência nova Reservada, no horário novo, ligada à anterior', () => {
    const previous = newAppointment();
    previous.transitionTo('Reservada');
    previous.transitionTo('Confirmada');
    const novaData = new Date('2026-08-05T15:00:00Z');
    const next = Appointment.rescheduledFrom(previous, { id: 'a1b', scheduledAt: novaData });
    expect(next.id).toBe('a1b');
    expect(next.state).toBe('Reservada');
    expect(next.scheduledAt).toEqual(novaData);
    expect(next.rescheduledFromId).toBe('a1');
    expect([next.patientId, next.therapistId, next.modality, next.tenantId]).toEqual(['p1', 't1', 'presencial', TENANT_ID]);
    // A anterior não muda: quem a encerra é o caso de uso.
    expect(previous.state).toBe('Confirmada');
    expect(previous.scheduledAt).toEqual(new Date('2026-08-01T15:00:00Z'));
    expect(next.pullDomainEvents().map((e) => e.eventName)).toEqual(['AgendamentoEstadoAlterado', 'ConsultaRemarcada']);
  });

  it('a ocorrência nova não herda o horário fixo de origem (a anterior mantém a chave de materialização)', () => {
    const previous = Appointment.reconstitute({
      id: 'a6',
      tenantId: TENANT_ID,
      patientId: 'p1',
      therapistId: 't1',
      scheduledAt: new Date('2026-08-01T15:00:00Z'),
      modality: 'online',
      state: 'Reservada',
      recurring: true,
      recurringBlockId: 'rb1',
    });
    const next = Appointment.rescheduledFrom(previous, { id: 'a6b', scheduledAt: new Date('2026-08-02T15:00:00Z') });
    expect(next.recurringBlockId).toBeUndefined();
    expect(next.isRecurring).toBe(true);
    expect(next.modality).toBe('online');
  });

  it('Reagendada (legado) ainda pode ser confirmada', () => {
    const a = Appointment.reconstitute({
      id: 'a7',
      tenantId: TENANT_ID,
      patientId: 'p1',
      therapistId: 't1',
      scheduledAt: new Date('2026-08-05T15:00:00Z'),
      modality: 'presencial',
      state: 'Reagendada',
      recurring: false,
    });
    a.transitionTo('Confirmada');
    expect(a.state).toBe('Confirmada');
  });

  it('hasStarted(): no instante do início já começou; 1 ms antes, não', () => {
    const a = newAppointment();
    const start = new Date('2026-08-01T15:00:00Z');
    expect(a.hasStarted(new Date(start.getTime() - 1))).toBe(false);
    expect(a.hasStarted(start)).toBe(true);
    expect(a.hasStarted(new Date(start.getTime() + 60_000))).toBe(true);
  });

  it('isOpen só em Reservada, Confirmada e Reagendada', () => {
    const states = ['Criada', 'Reservada', 'Confirmada', 'ReagendamentoSolicitado', 'Reagendada', 'Cancelada'] as const;
    const open = states.filter((state) =>
      Appointment.reconstitute({ id: 'x', tenantId: TENANT_ID, patientId: 'p1', therapistId: 't1', scheduledAt: new Date(), modality: 'presencial', state, recurring: false }).isOpen,
    );
    expect(open).toEqual(['Reservada', 'Confirmada', 'Reagendada']);
  });

  it('isRecurring reflete o valor definido na criação', () => {
    const a = Appointment.create({
      id: 'a2',
      tenantId: TENANT_ID,
      patientId: 'p1',
      therapistId: 't1',
      scheduledAt: new Date(),
      modality: 'online',
      recurring: true,
    });
    expect(a.isRecurring).toBe(true);
  });

  it('emite evento a cada transição', () => {
    const a = newAppointment();
    a.transitionTo('Reservada');
    const events = a.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe('AgendamentoEstadoAlterado');
  });

  it('expõe patientId, therapistId, tenantId, id', () => {
    const a = newAppointment();
    expect(a.patientId).toBe('p1');
    expect(a.therapistId).toBe('t1');
    expect(a.tenantId).toBe(TENANT_ID);
    expect(a.id).toBe('a1');
  });

  it('reconstitute recria em qualquer estado salvo', () => {
    const a = Appointment.reconstitute({
      id: 'a3',
      tenantId: TENANT_ID,
      patientId: 'p1',
      therapistId: 't1',
      scheduledAt: new Date(),
      modality: 'presencial',
      state: 'Confirmada',
      recurring: false,
    });
    expect(a.state).toBe('Confirmada');
  });

  // AD-004 — modality nunca era exposta publicamente pela entidade, o que
  // por sua vez impedia PrismaAppointmentRepository.upsertAll() de gravá-la
  // (não compilava referenciar appointment.modality sem este getter).
  it('expõe modality definida em create()', () => {
    const a = Appointment.create({
      id: 'a4',
      tenantId: TENANT_ID,
      patientId: 'p1',
      therapistId: 't1',
      scheduledAt: new Date(),
      modality: 'online',
      recurring: false,
    });
    expect(a.modality).toBe('online');
  });

  it('expõe modality restaurada por reconstitute()', () => {
    const a = Appointment.reconstitute({
      id: 'a5',
      tenantId: TENANT_ID,
      patientId: 'p1',
      therapistId: 't1',
      scheduledAt: new Date(),
      modality: 'online',
      state: 'Confirmada',
      recurring: false,
    });
    expect(a.modality).toBe('online');
  });
});
