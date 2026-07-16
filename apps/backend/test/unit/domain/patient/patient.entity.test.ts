import { describe, it, expect } from 'vitest';
import { Patient } from '@domain/patient/patient.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function newPatient() {
  return Patient.create({
    id: 'p1',
    tenantId: TENANT_ID,
    name: 'Paciente Teste',
    phone: '+5541900000000',
  });
}

describe('Patient', () => {
  it('nasce no estado Novo', () => {
    expect(newPatient().state).toBe('Novo');
  });

  it('percorre o fluxo completo de cadastro até Ativo', () => {
    const p = newPatient();
    p.transitionTo('Identificado');
    p.transitionTo('Cadastrado');
    p.transitionTo('Ativo');
    expect(p.state).toBe('Ativo');
  });

  it('percorre o ciclo de uma sessão até Pago', () => {
    const p = newPatient();
    p.transitionTo('Identificado');
    p.transitionTo('Cadastrado');
    p.transitionTo('Ativo');
    p.transitionTo('Agendado');
    p.transitionTo('Confirmado');
    p.transitionTo('EmSessao');
    p.transitionTo('PagamentoPendente');
    p.transitionTo('Pago');
    expect(p.state).toBe('Pago');
  });

  it('permite cancelamento antes da confirmação (Agendado → Ativo)', () => {
    const p = newPatient();
    p.transitionTo('Identificado');
    p.transitionTo('Cadastrado');
    p.transitionTo('Ativo');
    p.transitionTo('Agendado');
    p.transitionTo('Ativo');
    expect(p.state).toBe('Ativo');
  });

  it('permite reativação a partir de Inativo', () => {
    const p = newPatient();
    p.transitionTo('Identificado');
    p.transitionTo('Cadastrado');
    p.transitionTo('Ativo');
    p.transitionTo('Inativo');
    p.transitionTo('Ativo');
    expect(p.state).toBe('Ativo');
  });

  it('Alta é estado terminal — nenhuma transição posterior permitida', () => {
    const p = newPatient();
    p.transitionTo('Identificado');
    p.transitionTo('Cadastrado');
    p.transitionTo('Ativo');
    p.transitionTo('Alta');
    expect(() => p.transitionTo('Ativo')).toThrow();
  });

  it('rejeita transição inválida (pular etapas)', () => {
    const p = newPatient();
    expect(() => p.transitionTo('Ativo')).toThrow();
  });

  it('emite PatientStateChangedEvent a cada transição bem-sucedida', () => {
    const p = newPatient();
    p.transitionTo('Identificado');
    const events = p.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe('PacienteEstadoAlterado');
  });

  it('pullDomainEvents esvazia a fila após leitura', () => {
    const p = newPatient();
    p.transitionTo('Identificado');
    p.pullDomainEvents();
    expect(p.pullDomainEvents()).toHaveLength(0);
  });

  it('não emite evento quando transição é rejeitada', () => {
    const p = newPatient();
    try {
      p.transitionTo('Ativo');
    } catch {
      /* esperado */
    }
    expect(p.pullDomainEvents()).toHaveLength(0);
  });

  it('reconstitute recria o Paciente em qualquer estado salvo, sem passar por Novo', () => {
    const p = Patient.reconstitute({
      id: 'p2',
      tenantId: TENANT_ID,
      name: 'Paciente Existente',
      phone: '+5541900000001',
      state: 'Ativo',
    });
    expect(p.state).toBe('Ativo');
  });

  it('expõe billingPolicyOverride quando definido', () => {
    const p = Patient.reconstitute({
      id: 'p3',
      tenantId: TENANT_ID,
      name: 'Paciente Mensal',
      phone: '+5541900000002',
      state: 'Ativo',
      billingPolicyOverride: 'monthly',
    });
    expect(p.billingPolicyOverride).toBe('monthly');
  });

  it('expõe id, tenantId e name corretamente', () => {
    const p = newPatient();
    expect(p.id).toBe('p1');
    expect(p.tenantId).toBe(TENANT_ID);
    expect(p.name).toBe('Paciente Teste');
  });

  it('expõe phone corretamente', () => {
    const p = newPatient();
    expect(p.phone).toBe('+5541900000000');
  });
});
