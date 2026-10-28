import { describe, it, expect, vi } from 'vitest';
import { IntentActionRouter } from '@use-cases/ai/intent-action-router';
import { SlotNotAvailableError } from '@domain-services/availability/slot-not-available.error';

function makeRouter() {
  const agendarConsulta = { execute: vi.fn() };
  const confirmarConsulta = { execute: vi.fn() };
  const consultarCobranca = { execute: vi.fn() };
  const consultarDisponibilidade = { execute: vi.fn() };
  const router = new IntentActionRouter(
    agendarConsulta as never,
    confirmarConsulta as never,
    consultarCobranca as never,
    consultarDisponibilidade as never,
    { current: vi.fn().mockResolvedValue('America/Sao_Paulo') } as never,
  );
  return { router, agendarConsulta, confirmarConsulta, consultarCobranca, consultarDisponibilidade };
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

  // K11 (ADR-0069; D1 a D8) — cancelar e remarcar só em duas etapas, com a
  // confirmação do paciente em outra mensagem (PedidoDeConsultaPeloWhatsAppUseCase).
  // O roteador não executa nenhuma delas, nem com o id da consulta nas entidades.
  it.each([
    ['cancelar_consulta', { appointmentId: 'a1' }],
    ['nao_comparecer', { appointmentId: 'a1' }],
    ['remarcar_consulta', { appointmentId: 'a1', newScheduledAt: '2026-08-02T10:00:00' }],
  ] as const)('K11 — %s não é executado pelo roteador: nenhuma ação, nenhum caso de uso', async (intent, entities) => {
    const deps = makeRouter();
    const result = await deps.router.route(
      { intent, confidence: 0.9, entities, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1', identityResolved: true },
    );
    expect(result).toEqual({ actionTaken: false });
    for (const useCase of [deps.agendarConsulta, deps.confirmarConsulta, deps.consultarCobranca, deps.consultarDisponibilidade]) {
      expect(useCase.execute).not.toHaveBeenCalled();
    }
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
    consultarCobranca.execute.mockResolvedValue({ amount: 597, state: 'Pendente', patientId: 'p1' });
    const result = await router.route(
      { intent: 'consultar_cobranca', confidence: 0.9, entities: { billingId: 'b1' }, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1' },
    );
    expect(result.actionTaken).toBe(true);
    expect(result.actionSummary).toContain('597');
  });

  it('intent sem roteamento definido (duvida_geral) nunca tenta agir', async () => {
    const { router, agendarConsulta, confirmarConsulta, consultarCobranca } = makeRouter();
    const result = await router.route(
      { intent: 'duvida_geral', confidence: 0.9, entities: {}, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1' },
    );
    expect(result.actionTaken).toBe(false);
    expect(agendarConsulta.execute).not.toHaveBeenCalled();
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

  it('erro de agenda do Caso de Uso (SlotNotAvailableError) nunca é mascarado como sucesso', async () => {
    const { router, agendarConsulta } = makeRouter();
    agendarConsulta.execute.mockRejectedValue(new SlotNotAvailableError());
    const result = await router.route(
      { intent: 'agendar_consulta', confidence: 0.9, entities: { therapistId: 't1', scheduledAt: '2026-08-02T10:00:00' }, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1' },
    );
    expect(result.actionTaken).toBe(false);
    // HttpException.initMessage() usa response.message (texto humano), não
    // response.code — verificado lendo o próprio http.exception.js instalado,
    // não presumido.
    expect(result.error).toContain('não está disponível');
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

describe('IntentActionRouter — identidade antes da ação (ADR-0063, AD-038)', () => {
  const identityDependent = [
    ['agendar_consulta', { therapistId: 't1', scheduledAt: '2026-08-01T10:00:00' }],
    ['cancelar_consulta', { appointmentId: 'a1' }],
    ['nao_comparecer', { appointmentId: 'a1' }],
    ['confirmar_presenca', { appointmentId: 'a1' }],
    ['remarcar_consulta', { appointmentId: 'a1', newScheduledAt: '2026-08-02T10:00:00' }],
    ['consultar_cobranca', { billingId: 'b1' }],
  ] as const;

  function expectNothingCalled(deps: ReturnType<typeof makeRouter>) {
    for (const useCase of [deps.agendarConsulta, deps.confirmarConsulta, deps.consultarCobranca]) {
      expect(useCase.execute).not.toHaveBeenCalled();
    }
  }

  it.each(identityDependent)('%s com a identidade pendente não chama nenhum Caso de Uso', async (intent, entities) => {
    const deps = makeRouter();

    const result = await deps.router.route(
      { intent, confidence: 0.9, entities, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1', identityResolved: false },
    );

    expect(result).toEqual({ actionTaken: false, blockedByIdentity: true });
    expectNothingCalled(deps);
  });

  it.each(identityDependent)('%s sem paciente identificado não chama nenhum Caso de Uso', async (intent, entities) => {
    const deps = makeRouter();

    const result = await deps.router.route({ intent, confidence: 0.9, entities, requiresEscalation: false }, { tenantId: 'tenant1' });

    expect(result).toEqual({ actionTaken: false, blockedByIdentity: true });
    expectNothingCalled(deps);
  });

  it('consultar_disponibilidade não depende de identidade: responde mesmo sem paciente', async () => {
    const { router, consultarDisponibilidade } = makeRouter();
    consultarDisponibilidade.execute.mockResolvedValue([]);

    const result = await router.route(
      { intent: 'consultar_disponibilidade', confidence: 0.9, entities: { therapistId: 't1' }, requiresEscalation: false },
      { tenantId: 'tenant1', identityResolved: false },
    );

    expect(result.actionTaken).toBe(true);
    expect(result.blockedByIdentity).toBeUndefined();
  });

  it('confirmar_presenca passa ao Caso de Uso de quem a consulta tem de ser', async () => {
    const { router, confirmarConsulta } = makeRouter();
    confirmarConsulta.execute.mockResolvedValue({});

    await router.route(
      { intent: 'confirmar_presenca', confidence: 0.9, entities: { appointmentId: 'a1' }, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1', identityResolved: true },
    );

    expect(confirmarConsulta.execute).toHaveBeenCalledWith('a1', { expectedPatientId: 'p1', actor: 'ai_agent' });
  });

  it('K2-b — a recusa do caso de uso depois do início (APPOINTMENT_ALREADY_STARTED) vira "nenhuma ação", nunca sucesso', async () => {
    const { router, confirmarConsulta } = makeRouter();
    confirmarConsulta.execute.mockRejectedValue(new Error('A consulta já começou: não pode mais ser cancelada, remarcada nem confirmada.'));

    const result = await router.route(
      { intent: 'confirmar_presenca', confidence: 0.9, entities: { appointmentId: 'a1' }, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1', identityResolved: true },
    );

    expect(result.actionTaken).toBe(false);
    expect(result.actionSummary).toBeUndefined();
  });

  it('consulta de outro paciente (o Caso de Uso recusa como inexistente): nenhuma ação, nunca sucesso', async () => {
    const { router, confirmarConsulta } = makeRouter();
    confirmarConsulta.execute.mockRejectedValue(new Error('Agendamento não encontrado.'));

    const result = await router.route(
      { intent: 'confirmar_presenca', confidence: 0.9, entities: { appointmentId: 'a-de-outro' }, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1' },
    );

    expect(result.actionTaken).toBe(false);
    expect(result.actionSummary).toBeUndefined();
  });

  it('cobrança de outro paciente não é resumida para quem escreve', async () => {
    const { router, consultarCobranca } = makeRouter();
    consultarCobranca.execute.mockResolvedValue({ amount: 597, state: 'Pendente', patientId: 'p-outro' });

    const result = await router.route(
      { intent: 'consultar_cobranca', confidence: 0.9, entities: { billingId: 'b-de-outro' }, requiresEscalation: false },
      { tenantId: 'tenant1', patientId: 'p1' },
    );

    expect(result).toEqual({ actionTaken: false });
  });
});
