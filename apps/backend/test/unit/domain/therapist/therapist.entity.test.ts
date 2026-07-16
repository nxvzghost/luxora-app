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

  it('nasce com disponibilidade vazia', () => {
    expect(newTherapist().availability).toHaveLength(0);
  });

  describe('setAvailability', () => {
    it('aceita slots válidos', () => {
      const t = newTherapist();
      t.setAvailability([{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }]);
      expect(t.availability).toHaveLength(1);
    });

    it('substitui a disponibilidade inteira (não faz merge)', () => {
      const t = newTherapist();
      t.setAvailability([{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }]);
      t.setAvailability([{ dayOfWeek: 2, startTime: '14:00', endTime: '18:00' }]);
      expect(t.availability).toHaveLength(1);
      expect(t.availability[0].dayOfWeek).toBe(2);
    });

    it('rejeita dayOfWeek fora do intervalo 0-6', () => {
      const t = newTherapist();
      expect(() => t.setAvailability([{ dayOfWeek: 7, startTime: '09:00', endTime: '12:00' }])).toThrow(
        /dayOfWeek inválido/,
      );
    });

    it('rejeita horário em formato inválido', () => {
      const t = newTherapist();
      expect(() =>
        t.setAvailability([{ dayOfWeek: 1, startTime: '25:00', endTime: '12:00' }]),
      ).toThrow(/Horário inválido/);
    });

    it('rejeita início posterior ou igual ao fim', () => {
      const t = newTherapist();
      expect(() =>
        t.setAvailability([{ dayOfWeek: 1, startTime: '12:00', endTime: '09:00' }]),
      ).toThrow(/início deve ser anterior ao fim/);
    });

    it('rejeita sobreposição de horários no mesmo dia', () => {
      const t = newTherapist();
      expect(() =>
        t.setAvailability([
          { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
          { dayOfWeek: 1, startTime: '11:00', endTime: '14:00' },
        ]),
      ).toThrow(/sobreposta/);
    });

    it('permite horários no mesmo dia sem sobreposição', () => {
      const t = newTherapist();
      t.setAvailability([
        { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
        { dayOfWeek: 1, startTime: '14:00', endTime: '18:00' },
      ]);
      expect(t.availability).toHaveLength(2);
    });

    it('permite o mesmo horário em dias diferentes (não é sobreposição)', () => {
      const t = newTherapist();
      t.setAvailability([
        { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
        { dayOfWeek: 2, startTime: '09:00', endTime: '12:00' },
      ]);
      expect(t.availability).toHaveLength(2);
    });
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

    it('setAvailability emite TherapistUpdatedEvent', () => {
      const t = newTherapist();
      t.setAvailability([{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }]);
      expect(t.pullDomainEvents()).toHaveLength(1);
    });

    it('pullDomainEvents esvazia a fila após leitura', () => {
      const t = newTherapist();
      t.rename('Novo Nome');
      t.pullDomainEvents();
      expect(t.pullDomainEvents()).toHaveLength(0);
    });
  });

  it('reconstitute recria a partir de estado salvo, incluindo disponibilidade', () => {
    const t = Therapist.reconstitute({
      id: 't2',
      tenantId: TENANT_ID,
      name: 'Dr. João',
      availability: [{ dayOfWeek: 3, startTime: '10:00', endTime: '16:00' }],
    });
    expect(t.availability).toHaveLength(1);
  });
});
