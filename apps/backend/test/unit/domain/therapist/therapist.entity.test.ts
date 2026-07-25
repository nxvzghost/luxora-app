import { describe, it, expect } from 'vitest';
import { Therapist } from '@domain/therapist/therapist.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function newTherapist() {
  return Therapist.create({ id: 't1', tenantId: TENANT_ID, name: 'Dra. Ana', specialty: 'Psicologia' });
}

describe('Therapist', () => {
  it('rejeita criação com nome vazio', () => {
    expect(() => Therapist.create({ id: 't1', tenantId: TENANT_ID, name: '  ' })).toThrow(
      /Nome do terapeuta é obrigatório/,
    );
  });

  describe('rename', () => {
    it('atualiza o nome', () => {
      const t = newTherapist();
      t.rename('Dra. Ana Silva');
      expect(t.name).toBe('Dra. Ana Silva');
    });

    it('remove espaços em branco', () => {
      const t = newTherapist();
      t.rename('  Dra. Ana Silva  ');
      expect(t.name).toBe('Dra. Ana Silva');
    });

    it('rejeita nome vazio', () => {
      const t = newTherapist();
      expect(() => t.rename('   ')).toThrow(/não pode ficar vazio/);
    });
  });

  it('expõe id, tenantId, specialty', () => {
    const t = newTherapist();
    expect(t.id).toBe('t1');
    expect(t.tenantId).toBe(TENANT_ID);
    expect(t.specialty).toBe('Psicologia');
  });

  describe('eventos de domínio (retrofit da revisão geral)', () => {
    it('rename emite TherapistUpdatedEvent', () => {
      const t = newTherapist();
      t.rename('Novo Nome');
      const events = t.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventName).toBe('TerapeutaAtualizado');
    });

    it('pullDomainEvents esvazia a fila após leitura', () => {
      const t = newTherapist();
      t.rename('Novo Nome');
      t.pullDomainEvents();
      expect(t.pullDomainEvents()).toHaveLength(0);
    });
  });

  it('reconstitute recria a partir de estado salvo', () => {
    const t = Therapist.reconstitute({
      id: 't2',
      tenantId: TENANT_ID,
      name: 'Dr. João',
    });
    expect(t.id).toBe('t2');
    expect(t.name).toBe('Dr. João');
  });
});
