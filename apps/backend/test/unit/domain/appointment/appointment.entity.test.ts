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

  it('reschedule() move para Reagendada apenas a partir de ReagendamentoSolicitado', () => {
    const a = newAppointment();
    a.transitionTo('Reservada');
    a.transitionTo('Confirmada');
    a.transitionTo('ReagendamentoSolicitado');
    const novaData = new Date('2026-08-05T15:00:00Z');
    a.reschedule(novaData);
    expect(a.state).toBe('Reagendada');
    expect(a.scheduledAt).toEqual(novaData);
  });

  it('reschedule() lança erro se chamado fora de ReagendamentoSolicitado', () => {
    const a = newAppointment();
    expect(() => a.reschedule(new Date())).toThrow(/solicite o reagendamento primeiro/);
  });

  it('Reagendada pode ser confirmada novamente', () => {
    const a = newAppointment();
    a.transitionTo('Reservada');
    a.transitionTo('Confirmada');
    a.transitionTo('ReagendamentoSolicitado');
    a.reschedule(new Date('2026-08-05T15:00:00Z'));
    a.transitionTo('Confirmada');
    expect(a.state).toBe('Confirmada');
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
