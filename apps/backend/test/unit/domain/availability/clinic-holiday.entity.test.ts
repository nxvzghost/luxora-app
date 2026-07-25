import { describe, it, expect } from 'vitest';
import { ClinicHoliday } from '@domain/availability/clinic-holiday.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function newHoliday(from: Date, to: Date, reason?: string) {
  return ClinicHoliday.create({ id: 'h1', tenantId: TENANT_ID, from, to, reason });
}

describe('ClinicHoliday', () => {
  it('expõe id, tenantId, from, to', () => {
    const h = newHoliday(new Date('2026-12-25T00:00:00'), new Date('2026-12-26T00:00:00'));
    expect(h.id).toBe('h1');
    expect(h.tenantId).toBe(TENANT_ID);
    expect(h.from.toISOString()).toBe(new Date('2026-12-25T00:00:00').toISOString());
    expect(h.to.toISOString()).toBe(new Date('2026-12-26T00:00:00').toISOString());
  });

  describe('create', () => {
    it('aceita um intervalo válido', () => {
      expect(() => newHoliday(new Date('2026-12-25T00:00:00'), new Date('2026-12-26T00:00:00'))).not.toThrow();
    });

    it('rejeita início posterior ou igual ao fim', () => {
      expect(() => newHoliday(new Date('2026-12-26T00:00:00'), new Date('2026-12-25T00:00:00'))).toThrow(
        /anterior ao fim/,
      );
    });
  });

  describe('reason — metadado puro, sem influência em nenhuma regra', () => {
    it('aceita ausência de reason', () => {
      const h = newHoliday(new Date('2026-12-25T00:00:00'), new Date('2026-12-26T00:00:00'));
      expect(h.reason).toBeUndefined();
    });

    it('aceita qualquer valor de reason, incluindo texto arbitrário sem tipo conhecido', () => {
      const h = newHoliday(
        new Date('2026-12-25T00:00:00'),
        new Date('2026-12-26T00:00:00'),
        'qualquer texto livre, não é um tipo conhecido',
      );
      expect(h.reason).toBe('qualquer texto livre, não é um tipo conhecido');
    });

    it('overlaps() não muda de comportamento com reason diferente para o mesmo intervalo', () => {
      const withReason = newHoliday(new Date('2026-12-25T00:00:00'), new Date('2026-12-26T00:00:00'), 'natal');
      const withoutReason = newHoliday(new Date('2026-12-25T00:00:00'), new Date('2026-12-26T00:00:00'));
      const probeFrom = new Date('2026-12-25T10:00:00');
      const probeTo = new Date('2026-12-25T11:00:00');
      expect(withReason.overlaps(probeFrom, probeTo)).toBe(withoutReason.overlaps(probeFrom, probeTo));
    });
  });

  describe('overlaps — teste crítico #10 style (mesma semântica de intervalo já usada em ScheduleSlot/isExcepted)', () => {
    it('detecta sobreposição parcial', () => {
      const h = newHoliday(new Date('2026-12-24T00:00:00'), new Date('2026-12-26T00:00:00'));
      expect(h.overlaps(new Date('2026-12-25T00:00:00'), new Date('2026-12-27T00:00:00'))).toBe(true);
    });

    it('detecta quando o intervalo consultado está totalmente contido no feriado', () => {
      const h = newHoliday(new Date('2026-12-24T00:00:00'), new Date('2026-12-31T00:00:00'));
      expect(h.overlaps(new Date('2026-12-25T09:00:00'), new Date('2026-12-25T10:00:00'))).toBe(true);
    });

    it('não detecta sobreposição quando os intervalos são adjacentes (fim = início do outro)', () => {
      const h = newHoliday(new Date('2026-12-24T00:00:00'), new Date('2026-12-25T00:00:00'));
      expect(h.overlaps(new Date('2026-12-25T00:00:00'), new Date('2026-12-26T00:00:00'))).toBe(false);
    });

    it('não detecta sobreposição quando os intervalos estão distantes', () => {
      const h = newHoliday(new Date('2026-12-25T00:00:00'), new Date('2026-12-26T00:00:00'));
      expect(h.overlaps(new Date('2026-01-01T00:00:00'), new Date('2026-01-02T00:00:00'))).toBe(false);
    });
  });

  describe('domain events — auditoria (revisão pós-B5)', () => {
    it('não emite nenhum evento a partir de create() sozinho — mesma regra de Patient.create()', () => {
      const h = newHoliday(new Date('2026-12-25T00:00:00'), new Date('2026-12-26T00:00:00'));
      expect(h.pullDomainEvents()).toHaveLength(0);
    });

    it('markCreated() enfileira ClinicHolidayCreatedEvent com os dados do feriado', () => {
      const h = newHoliday(new Date('2026-12-25T00:00:00'), new Date('2026-12-26T00:00:00'), 'natal');
      h.markCreated();
      const events = h.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventName).toBe('FeriadoClinicaCriado');
      expect(events[0].entityId).toBe('h1');
      expect(events[0].tenantId).toBe(TENANT_ID);
      expect((events[0] as unknown as { reason?: string }).reason).toBe('natal');
    });

    it('markRemoved() enfileira ClinicHolidayRemovedEvent', () => {
      const h = newHoliday(new Date('2026-12-25T00:00:00'), new Date('2026-12-26T00:00:00'));
      h.markRemoved();
      const events = h.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventName).toBe('FeriadoClinicaRemovido');
      expect(events[0].entityId).toBe('h1');
    });

    it('pullDomainEvents() esvazia a fila — chamadas seguintes retornam vazio até o próximo mark*()', () => {
      const h = newHoliday(new Date('2026-12-25T00:00:00'), new Date('2026-12-26T00:00:00'));
      h.markCreated();
      expect(h.pullDomainEvents()).toHaveLength(1);
      expect(h.pullDomainEvents()).toHaveLength(0);
    });
  });

  describe('INVARIANTE — ClinicHoliday não tem autoridade própria sobre o Motor de Disponibilidade nesta etapa', () => {
    // ClinicHoliday representa um período de indisponibilidade da clínica e
    // não possui autoridade para alterar a disponibilidade por si só nesta
    // etapa. Até que a camada de aplicação passe a consultá-lo, a entidade
    // permanece independente e sem efeito operacional sobre o Motor de
    // Disponibilidade (PD-001 Fase 2, B2). A prova mais forte disso é
    // estrutural (este arquivo não importa AvailabilityCalendar nem
    // nenhuma outra peça do Motor, e nenhum arquivo do Motor foi alterado
    // nesta tarefa — ver relatório) — o teste abaixo documenta e confirma
    // em tempo de execução que a única API pública é `overlaps()`, sem
    // nenhum método de decisão do tipo `isAvailable`/`generateCandidateSlots`.
    it('expõe só overlaps() como capacidade de consulta — nenhum método de decisão do Motor', () => {
      const h = newHoliday(new Date('2026-12-25T00:00:00'), new Date('2026-12-26T00:00:00'));
      expect(typeof h.overlaps).toBe('function');
      expect((h as unknown as { isAvailable?: unknown }).isAvailable).toBeUndefined();
      expect((h as unknown as { generateCandidateSlots?: unknown }).generateCandidateSlots).toBeUndefined();
    });
  });
});
