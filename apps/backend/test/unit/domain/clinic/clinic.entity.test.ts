import { describe, it, expect } from 'vitest';
import { Clinic } from '@domain/clinic/clinic.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function newClinic() {
  return Clinic.reconstitute({
    tenantId: TENANT_ID,
    name: 'Clínica Teste',
    defaultBillingPolicy: 'per_session',
    defaultSessionDurationMinutes: 50,
    timeZone: 'America/Sao_Paulo',
  });
}

describe('Clinic', () => {
  describe('rename', () => {
    it('atualiza o nome', () => {
      const c = newClinic();
      c.rename('Novo Nome');
      expect(c.name).toBe('Novo Nome');
    });

    it('rejeita nome vazio', () => {
      const c = newClinic();
      expect(() => c.rename('  ')).toThrow(/não pode ficar vazio/);
    });
  });

  describe('updatePolicies', () => {
    it('atualiza defaultBillingPolicy', () => {
      const c = newClinic();
      c.updatePolicies({ defaultBillingPolicy: 'monthly' });
      expect(c.defaultBillingPolicy).toBe('monthly');
    });

    it('atualiza cancellationHoursLimit', () => {
      const c = newClinic();
      c.updatePolicies({ cancellationHoursLimit: 24 });
      expect(c.cancellationHoursLimit).toBe(24);
    });

    it('rejeita cancellationHoursLimit negativo', () => {
      const c = newClinic();
      expect(() => c.updatePolicies({ cancellationHoursLimit: -1 })).toThrow(/não pode ser negativo/);
    });

    it('atualiza defaultSessionDurationMinutes', () => {
      const c = newClinic();
      c.updatePolicies({ defaultSessionDurationMinutes: 60 });
      expect(c.defaultSessionDurationMinutes).toBe(60);
    });

    it('rejeita defaultSessionDurationMinutes zero ou negativo', () => {
      const c = newClinic();
      expect(() => c.updatePolicies({ defaultSessionDurationMinutes: 0 })).toThrow(/maior que zero/);
      expect(() => c.updatePolicies({ defaultSessionDurationMinutes: -10 })).toThrow(/maior que zero/);
    });

    it('atualização parcial não altera o campo omitido', () => {
      const c = newClinic();
      c.updatePolicies({ cancellationHoursLimit: 24 });
      c.updatePolicies({ defaultBillingPolicy: 'weekly' });
      expect(c.cancellationHoursLimit).toBe(24);
      expect(c.defaultBillingPolicy).toBe('weekly');
      expect(c.defaultSessionDurationMinutes).toBe(50);
    });
  });

  describe('updatePaymentInfo', () => {
    it('define pixKey e payeeName', () => {
      const c = newClinic();
      c.updatePaymentInfo({ pixKey: '41999999999', payeeName: 'Clínica Teste LTDA' });
      expect(c.pixKey).toBe('41999999999');
      expect(c.payeeName).toBe('Clínica Teste LTDA');
    });

    it('atualização parcial não apaga o campo omitido', () => {
      const c = newClinic();
      c.updatePaymentInfo({ pixKey: '41999999999', payeeName: 'Clínica Teste LTDA' });
      c.updatePaymentInfo({ pixKey: '41988888888' });
      expect(c.pixKey).toBe('41988888888');
      expect(c.payeeName).toBe('Clínica Teste LTDA');
    });
  });

  describe('eventos de domínio (retrofit da revisão geral)', () => {
    it('rename emite ClinicUpdatedEvent', () => {
      const c = newClinic();
      c.rename('Novo Nome');
      const events = c.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventName).toBe('ClinicaAtualizada');
    });

    it('updatePolicies emite ClinicUpdatedEvent', () => {
      const c = newClinic();
      c.updatePolicies({ cancellationHoursLimit: 24 });
      expect(c.pullDomainEvents()).toHaveLength(1);
    });

    it('updatePaymentInfo emite ClinicUpdatedEvent', () => {
      const c = newClinic();
      c.updatePaymentInfo({ pixKey: '123' });
      expect(c.pullDomainEvents()).toHaveLength(1);
    });
  });

  describe('changeTimeZone — AD-039 (ADR-0064)', () => {
    it('troca o fuso e registra o anterior e o novo no evento', () => {
      const c = newClinic();

      expect(c.changeTimeZone('America/Manaus')).toBe(true);

      expect(c.timeZone).toBe('America/Manaus');
      const events = c.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventName: 'ClinicaAtualizada',
        entityId: TENANT_ID,
        tenantId: TENANT_ID,
        action: 'fuso_alterado',
        fromTimeZone: 'America/Sao_Paulo',
        toTimeZone: 'America/Manaus',
      });
    });

    it('o mesmo fuso que já está em vigor não muda nada e não gera evento', () => {
      const c = newClinic();

      expect(c.changeTimeZone('America/Sao_Paulo')).toBe(false);

      expect(c.timeZone).toBe('America/Sao_Paulo');
      expect(c.pullDomainEvents()).toHaveLength(0);
    });

    it('recusa o que não é o nome exato de uma zona IANA, sem alterar o fuso nem gerar evento', () => {
      const c = newClinic();

      for (const invalid of ['Brasilia', 'america/manaus', 'UTC', '+03:00', '', '  ', undefined, null, 3]) {
        expect(() => c.changeTimeZone(invalid as string), String(invalid)).toThrow(/Fuso horário inválido/);
      }

      expect(c.timeZone).toBe('America/Sao_Paulo');
      expect(c.pullDomainEvents()).toHaveLength(0);
    });

    it('não mexe em mais nada da clínica', () => {
      const c = newClinic();
      c.updatePolicies({ cancellationHoursLimit: 24 });
      c.updatePaymentInfo({ pixKey: '41999999999' });
      c.pullDomainEvents();

      c.changeTimeZone('America/Noronha');

      expect(c.name).toBe('Clínica Teste');
      expect(c.defaultBillingPolicy).toBe('per_session');
      expect(c.cancellationHoursLimit).toBe(24);
      expect(c.defaultSessionDurationMinutes).toBe(50);
      expect(c.pixKey).toBe('41999999999');
    });

    it('os eventos das outras edições continuam com a forma de antes', () => {
      const c = newClinic();
      c.rename('Novo Nome');

      const [event] = c.pullDomainEvents() as unknown as Array<Record<string, unknown>>;
      expect(event.action).toBe('nome_alterado');
      expect(event).not.toHaveProperty('fromTimeZone');
      expect(event).not.toHaveProperty('toTimeZone');
    });
  });

  it('expõe tenantId e defaultSessionDurationMinutes', () => {
    const c = newClinic();
    expect(c.tenantId).toBe(TENANT_ID);
    expect(c.defaultSessionDurationMinutes).toBe(50);
  });
});
