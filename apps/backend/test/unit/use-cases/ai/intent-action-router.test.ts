import { describe, it, expect, vi } from 'vitest';
import { IntentActionRouter } from '@use-cases/ai/intent-action-router';
import { SlotNotAvailableError } from '@domain-services/availability/slot-not-available.error';

function makeRouter() {
  const agendarConsulta = { execute: vi.fn() };
  const cancelarConsulta = { execute: vi.fn() };
  const confirmarConsulta = { execute: vi.fn() };
  const consultarCobranca = { execute: vi.fn() };
  const remarcarConsulta = { execute: vi.fn() };
  const consultarDisponibilidade = { execute: vi.fn() };
  const router = new IntentActionRouter(
    agendarConsulta,
    cancelarConsulta,
    confirmarConsulta,
    consultarCobranca,
    remarcarConsulta,
    consultarDisponibilidade,
  );
  return { router, agendarConsulta, cancelarConsulta, confirmarConsulta, consultarCobranca, remarcarConsulta, consultarDisponibilidade };
}

describe('IntentActionRouter — regra de segurança: nunca age com entidade faltando', () => {
  it('agendar_consulta com todas as entidades presentes executa a ação', async () => {
    const { router, agendarConsulta } = makeRouter();
    agendarConsulta.execute.mockResolvedValue({ scheduledAt: new Date('2026-08-01T10:00:00') });

    const result = await router.route(
      { intent: 'agendar_consulta', confidence: 0.9, entities: { therapistId: 't1', scheduledAt: '2026-08-01T10:00:00', modality: 'online' }, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1' },
    );

    expect(result.actionTaken).toBe(true);
    expect(agendarConsulta.execute).toHaveBeenCalledOnce();
  });

  it('agendar_consulta SEM therapistId nunca tenta agendar — actionTaken false', async () => {
    const { router, agendarConsulta } = makeRouter();
    const result = await router.route(
      { intent: 'agendar_consulta', confidence: 0.9, entities: { scheduledAt: '2026-08-01T10:00:00' }, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1' },
    );
    expect(result.actionTaken).toBe(false);
    expect(agendarConsulta.execute).not.toHaveBeenCalled();
  });

  it('agendar_consulta SEM patientId no contexto nunca tenta agendar', async () => {
    const { router, agendarConsulta } = makeRouter();
    const result = await router.route(
      { intent: 'agendar_consulta', confidence: 0.9, entities: { therapistId: 't1', scheduledAt: '2026-08-01T10:00:00' }, requiresEscalation: false },
      { tenantId: 'tenant1' },
    );
    expect(result.actionTaken).toBe(false);
    expect(agendarConsulta.execute).not.toHaveBeenCalled();
  });

  it('cancelar_consulta com appointmentId executa', async () => {
    const { router, cancelarConsulta } = makeRouter();
    cancelarConsulta.execute.mockResolvedValue({});
    const result = await router.route(
      { intent: 'cancelar_consulta', confidence: 0.9, entities: { appointmentId: 'a1' }, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1' },
    );
    expect(result.actionTaken).toBe(true);
    expect(cancelarConsulta.execute).toHaveBeenCalledWith('a1');
  });

  it('cancelar_consulta SEM appointmentId nunca executa (nunca "adivinha" qual consulta)', async () => {
    const { router, cancelarConsulta } = makeRouter();
    const result = await router.route(
      { intent: 'cancelar_consulta', confidence: 0.9, entities: {}, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1' },
    );
    expect(result.actionTaken).toBe(false);
    expect(cancelarConsulta.execute).not.toHaveBeenCalled();
  });

  it('confirmar_presenca com appointmentId executa', async () => {
    const { router, confirmarConsulta } = makeRouter();
    confirmarConsulta.execute.mockResolvedValue({});
    const result = await router.route(
      { intent: 'confirmar_presenca', confidence: 0.9, entities: { appointmentId: 'a1' }, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1' },
    );
    expect(result.actionTaken).toBe(true);
  });

  it('consultar_cobranca com billingId retorna resumo', async () => {
    const { router, consultarCobranca } = makeRouter();
    consultarCobranca.execute.mockResolvedValue({ amount: 597, state: 'Pendente' });
    const result = await router.route(
      { intent: 'consultar_cobranca', confidence: 0.9, entities: { billingId: 'b1' }, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1' },
    );
    expect(result.actionTaken).toBe(true);
    expect(result.actionSummary).toContain('597');
  });

  it('intent sem roteamento definido (duvida_geral) nunca tenta agir', async () => {
    const { router, agendarConsulta, cancelarConsulta, confirmarConsulta, consultarCobranca } = makeRouter();
    const result = await router.route(
      { intent: 'duvida_geral', confidence: 0.9, entities: {}, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1' },
    );
    expect(result.actionTaken).toBe(false);
    expect(agendarConsulta.execute).not.toHaveBeenCalled();
    expect(cancelarConsulta.execute).not.toHaveBeenCalled();
    expect(confirmarConsulta.execute).not.toHaveBeenCalled();
    expect(consultarCobranca.execute).not.toHaveBeenCalled();
  });

  it('erro real do Caso de Uso (ex: SESSION_CONFLICT) nunca é mascarado como sucesso', async () => {
    const { router, agendarConsulta } = makeRouter();
    agendarConsulta.execute.mockRejectedValue(new Error('SESSION_CONFLICT'));
    const result = await router.route(
      { intent: 'agendar_consulta', confidence: 0.9, entities: { therapistId: 't1', scheduledAt: '2026-08-01T10:00:00' }, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1' },
    );
    expect(result.actionTaken).toBe(false);
    expect(result.error).toContain('SESSION_CONFLICT');
  });

  it('AD-010: remarcar_consulta com appointmentId e newScheduledAt executa', async () => {
    const { router, remarcarConsulta } = makeRouter();
    remarcarConsulta.execute.mockResolvedValue({ scheduledAt: new Date('2026-08-02T10:00:00') });
    const result = await router.route(
      { intent: 'remarcar_consulta', confidence: 0.9, entities: { appointmentId: 'a1', newScheduledAt: '2026-08-02T10:00:00' }, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1' },
    );
    expect(result.actionTaken).toBe(true);
    expect(remarcarConsulta.execute).toHaveBeenCalledWith('a1', new Date('2026-08-02T10:00:00'));
  });

  it('AD-010: remarcar_consulta com horário indisponível (SlotNotAvailableError) nunca é mascarado como sucesso', async () => {
    const { router, remarcarConsulta } = makeRouter();
    remarcarConsulta.execute.mockRejectedValue(new SlotNotAvailableError());
    const result = await router.route(
      { intent: 'remarcar_consulta', confidence: 0.9, entities: { appointmentId: 'a1', newScheduledAt: '2026-08-02T10:00:00' }, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1' },
    );
    expect(result.actionTaken).toBe(false);
    // HttpException.initMessage() usa response.message (texto humano), não
    // response.code — verificado lendo o próprio http.exception.js instalado,
    // não presumido.
    expect(result.error).toContain('não está disponível');
  });

  it('AD-010: remarcar_consulta SEM newScheduledAt nunca executa', async () => {
    const { router, remarcarConsulta } = makeRouter();
    const result = await router.route(
      { intent: 'remarcar_consulta', confidence: 0.9, entities: { appointmentId: 'a1' }, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1' },
    );
    expect(result.actionTaken).toBe(false);
    expect(remarcarConsulta.execute).not.toHaveBeenCalled();
  });

  it('AD-010: consultar_disponibilidade com therapistId retorna resumo dos horários', async () => {
    const { router, consultarDisponibilidade } = makeRouter();
    consultarDisponibilidade.execute.mockResolvedValue([
      { startsAt: new Date('2026-08-01T10:00:00'), endsAt: new Date('2026-08-01T11:00:00') },
    ]);
    const result = await router.route(
      { intent: 'consultar_disponibilidade', confidence: 0.9, entities: { therapistId: 't1' }, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1' },
    );
    expect(result.actionTaken).toBe(true);
    expect(consultarDisponibilidade.execute).toHaveBeenCalledOnce();
  });

  it('AD-010: consultar_disponibilidade SEM therapistId nunca executa (nunca adivinha o terapeuta)', async () => {
    const { router, consultarDisponibilidade } = makeRouter();
    const result = await router.route(
      { intent: 'consultar_disponibilidade', confidence: 0.9, entities: {}, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1' },
    );
    expect(result.actionTaken).toBe(false);
    expect(consultarDisponibilidade.execute).not.toHaveBeenCalled();
  });

  it('AD-010: consultar_disponibilidade sem horários retorna resumo vazio, não erro', async () => {
    const { router, consultarDisponibilidade } = makeRouter();
    consultarDisponibilidade.execute.mockResolvedValue([]);
    const result = await router.route(
      { intent: 'consultar_disponibilidade', confidence: 0.9, entities: { therapistId: 't1' }, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1' },
    );
    expect(result.actionTaken).toBe(true);
    expect(result.actionSummary).toContain('Nenhum horário');
  });
});
