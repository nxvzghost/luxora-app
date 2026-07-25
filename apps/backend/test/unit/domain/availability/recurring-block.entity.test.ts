import { describe, it, expect } from 'vitest';
import { RecurringBlock } from '@domain/availability/recurring-block.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const PATIENT_ID = 'p1';
const THERAPIST_ID = 't1';

function newBlock(overrides: Partial<{ intervalDays: number; modality: 'presencial' | 'online'; renewalMode: 'automatic' | 'manual' }> = {}) {
  return RecurringBlock.create({
    id: 'rb1',
    tenantId: TENANT_ID,
    patientId: PATIENT_ID,
    therapistId: THERAPIST_ID,
    firstOccurrence: new Date('2026-08-04T14:00:00'),
    intervalDays: overrides.intervalDays ?? 7,
    modality: overrides.modality ?? 'presencial',
    renewalMode: overrides.renewalMode ?? 'automatic',
  });
}

describe('RecurringBlock', () => {
  it('expõe id, tenantId, patientId, therapistId, firstOccurrence, intervalDays, modality, renewalMode', () => {
    const b = newBlock();
    expect(b.id).toBe('rb1');
    expect(b.tenantId).toBe(TENANT_ID);
    expect(b.patientId).toBe(PATIENT_ID);
    expect(b.therapistId).toBe(THERAPIST_ID);
    expect(b.firstOccurrence.toISOString()).toBe(new Date('2026-08-04T14:00:00').toISOString());
    expect(b.intervalDays).toBe(7);
    expect(b.modality).toBe('presencial');
    expect(b.renewalMode).toBe('automatic');
  });

  describe('create — invariante de intervalDays', () => {
    it('aceita intervalDays semanal (7)', () => {
      expect(() => newBlock({ intervalDays: 7 })).not.toThrow();
    });

    it('aceita intervalDays quinzenal (14)', () => {
      expect(() => newBlock({ intervalDays: 14 })).not.toThrow();
    });

    it('rejeita intervalDays zero', () => {
      expect(() => newBlock({ intervalDays: 0 })).toThrow(/inteiro positivo/);
    });

    it('rejeita intervalDays negativo', () => {
      expect(() => newBlock({ intervalDays: -7 })).toThrow(/inteiro positivo/);
    });

    it('rejeita intervalDays fracionário', () => {
      expect(() => newBlock({ intervalDays: 7.5 })).toThrow(/inteiro positivo/);
    });
  });

  describe('modality e renewalMode — aceitam os dois valores válidos', () => {
    it('aceita modality presencial e online', () => {
      expect(newBlock({ modality: 'presencial' }).modality).toBe('presencial');
      expect(newBlock({ modality: 'online' }).modality).toBe('online');
    });

    it('aceita renewalMode automatic e manual', () => {
      expect(newBlock({ renewalMode: 'automatic' }).renewalMode).toBe('automatic');
      expect(newBlock({ renewalMode: 'manual' }).renewalMode).toBe('manual');
    });
  });

  describe('reconstitute — não reaplica validação de create()', () => {
    it('reconstitui a partir de props já validadas anteriormente', () => {
      const b = RecurringBlock.reconstitute({
        id: 'rb2',
        tenantId: TENANT_ID,
        patientId: PATIENT_ID,
        therapistId: THERAPIST_ID,
        firstOccurrence: new Date('2026-08-04T14:00:00'),
        intervalDays: 7,
        modality: 'online',
        renewalMode: 'manual',
      });
      expect(b.id).toBe('rb2');
      expect(b.modality).toBe('online');
    });
  });

  describe('INVARIANTE — RecurringBlock não tem autoridade própria sobre o Motor de Disponibilidade', () => {
    // Mesma prova estrutural já usada para ClinicHoliday: domínio puro, sem
    // nenhum método de decisão do Motor, sem semântica de pausa/cancelamento
    // — só markCreated()/pullDomainEvents() (C4.1), que não decidem nada
    // sobre o Motor, apenas registram o evento de auditoria a ser emitido.
    it('não expõe nenhum método de decisão do Motor nem semântica de pausa/cancelamento', () => {
      const b = newBlock();
      expect((b as unknown as { isAvailable?: unknown }).isAvailable).toBeUndefined();
      expect((b as unknown as { generateCandidateSlots?: unknown }).generateCandidateSlots).toBeUndefined();
      expect((b as unknown as { pause?: unknown }).pause).toBeUndefined();
      expect((b as unknown as { cancel?: unknown }).cancel).toBeUndefined();
    });
  });

  describe('domain events — auditoria (PD-001 Fase 2, C4.1)', () => {
    it('não emite nenhum evento a partir de create() sozinho — mesma regra de Patient.create()/ClinicHoliday.create()', () => {
      const b = newBlock();
      expect(b.pullDomainEvents()).toHaveLength(0);
    });

    it('markCreated() enfileira RecurringBlockCreatedEvent com os dados do bloco', () => {
      const b = newBlock({ intervalDays: 14 });
      b.markCreated();
      const events = b.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventName).toBe('BlocoRecorrenteCriado');
      expect(events[0].entityId).toBe('rb1');
      expect(events[0].tenantId).toBe(TENANT_ID);
      expect((events[0] as unknown as { patientId: string }).patientId).toBe(PATIENT_ID);
      expect((events[0] as unknown as { therapistId: string }).therapistId).toBe(THERAPIST_ID);
      expect((events[0] as unknown as { intervalDays: number }).intervalDays).toBe(14);
    });

    it('pullDomainEvents() esvazia a fila — chamadas seguintes retornam vazio até o próximo markCreated()', () => {
      const b = newBlock();
      b.markCreated();
      expect(b.pullDomainEvents()).toHaveLength(1);
      expect(b.pullDomainEvents()).toHaveLength(0);
    });
  });
});
