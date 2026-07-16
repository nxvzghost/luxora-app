import { describe, it, expect } from 'vitest';
import { Session } from '@domain/session/session.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

describe('Session', () => {
  it('só pode ser criada a partir de um Appointment em estado Confirmada', () => {
    expect(() =>
      Session.createFromConfirmedAppointment({
        id: 's1',
        tenantId: TENANT_ID,
        appointmentId: 'a1',
        appointmentState: 'Reservada',
        patientId: 'p1',
        therapistId: 't1',
      }),
    ).toThrow(/em estado "Confirmada"/);
  });

  it('nasce no estado Realizada quando Appointment está Confirmada', () => {
    const s = Session.createFromConfirmedAppointment({
      id: 's1',
      tenantId: TENANT_ID,
      appointmentId: 'a1',
      appointmentState: 'Confirmada',
      patientId: 'p1',
      therapistId: 't1',
    });
    expect(s.state).toBe('Realizada');
  });

  it('percorre o fluxo até Recebida', () => {
    const s = Session.createFromConfirmedAppointment({
      id: 's1',
      tenantId: TENANT_ID,
      appointmentId: 'a1',
      appointmentState: 'Confirmada',
      patientId: 'p1',
      therapistId: 't1',
    });
    s.transitionTo('Faturada');
    s.transitionTo('Recebida');
    expect(s.state).toBe('Recebida');
  });

  it('Recebida é estado terminal', () => {
    const s = Session.createFromConfirmedAppointment({
      id: 's1',
      tenantId: TENANT_ID,
      appointmentId: 'a1',
      appointmentState: 'Confirmada',
      patientId: 'p1',
      therapistId: 't1',
    });
    s.transitionTo('Faturada');
    s.transitionTo('Recebida');
    expect(() => s.transitionTo('Faturada')).toThrow();
  });

  it('não permite pular direto de Realizada para Recebida', () => {
    const s = Session.createFromConfirmedAppointment({
      id: 's1',
      tenantId: TENANT_ID,
      appointmentId: 'a1',
      appointmentState: 'Confirmada',
      patientId: 'p1',
      therapistId: 't1',
    });
    expect(() => s.transitionTo('Recebida')).toThrow();
  });

  it('emite evento de criação com fromState null', () => {
    const s = Session.createFromConfirmedAppointment({
      id: 's1',
      tenantId: TENANT_ID,
      appointmentId: 'a1',
      appointmentState: 'Confirmada',
      patientId: 'p1',
      therapistId: 't1',
    });
    const events = s.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe('SessaoEstadoAlterado');
  });

  it('expõe appointmentId, patientId, id, tenantId', () => {
    const s = Session.createFromConfirmedAppointment({
      id: 's1',
      tenantId: TENANT_ID,
      appointmentId: 'a1',
      appointmentState: 'Confirmada',
      patientId: 'p1',
      therapistId: 't1',
    });
    expect(s.appointmentId).toBe('a1');
    expect(s.patientId).toBe('p1');
    expect(s.id).toBe('s1');
    expect(s.tenantId).toBe(TENANT_ID);
  });

  it('reconstitute recria a partir de estado salvo', () => {
    const s = Session.reconstitute({
      id: 's2',
      tenantId: TENANT_ID,
      appointmentId: 'a2',
      patientId: 'p1',
      therapistId: 't1',
      state: 'Faturada',
    });
    expect(s.state).toBe('Faturada');
  });
});
