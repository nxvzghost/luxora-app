import { describe, it, expect, beforeEach } from 'vitest';
import { AppointmentNotice } from '@domain/appointment/appointment-notice';
import { AppointmentOutcomeRecord } from '@domain/appointment/appointment-outcome';
import { IntentResult } from '@domain-services/ai/ai-provider';
import { CancelarConsultaUseCase, RemarcarConsultaUseCase } from '@use-cases/appointment/gerenciar-consulta.use-case';
import {
  PedidoDeConsultaPeloWhatsAppUseCase,
  WhatsAppTurn,
  matchAppointments,
  readHints,
  readNewSlot,
} from '@use-cases/appointment/pedido-pelo-whatsapp.use-case';
import { K11_TEXT, TEAM_NOTICE, describeAppointment, describeSlot } from '@use-cases/appointment/pedido-pelo-whatsapp.textos';
import {
  AFTER_START,
  BEFORE_START,
  CONVERSATION_ID,
  NEW_SLOT,
  START,
  TENANT_ID,
  World,
  appointmentIn,
  createWorld,
  withAppointment,
} from './support/lifecycle-world';

/**
 * K11 — o pedido de cancelamento ou remarcação pelo WhatsApp, em duas etapas
 * (ADR-0069; D1 a D8 de 23/10/2026), sobre o mundo em memória que imita as
 * garantias do banco. As provas no PostgreSQL 16, com o webhook real, estão
 * em test/critical/k11-whatsapp-request-flow.test.ts.
 */

const TZ = 'America/Sao_Paulo';
const PROFESSIONAL = 'Dra. Paula Souza';
const asked = describeAppointment(START, PROFESSIONAL, 'presencial', TZ);

function useCaseFor(world: World): PedidoDeConsultaPeloWhatsAppUseCase {
  const cancelar = new CancelarConsultaUseCase(
    world.repo,
    world.outcomeRepo,
    world.noticeRepo,
    world.clinicRepo as never,
    world.audit as never,
    world.unitOfWork,
    world.clock,
    world.tenantContext,
  );
  const remarcar = new RemarcarConsultaUseCase(
    world.repo,
    world.outcomeRepo,
    world.noticeRepo,
    world.clinicRepo as never,
    world.motor as never,
    world.audit as never,
    world.unitOfWork,
    world.clock,
    world.tenantContext,
  );
  return new PedidoDeConsultaPeloWhatsAppUseCase(
    world.repo,
    world.outcomeRepo,
    world.noticeRepo,
    world.clinicRepo as never,
    world.therapistRepo as never,
    world.clinicTimeZone as never,
    world.notificationRepo as never,
    world.unitOfWork,
    world.clock,
    world.audit as never,
    world.motor as never,
    cancelar,
    remarcar,
  );
}

let sequence = 0;
/** Uma mensagem nova da conversa, chegando agora (o relógio do mundo). */
function message(world: World, overrides: Partial<WhatsAppTurn> = {}): WhatsAppTurn {
  sequence += 1;
  return {
    tenantId: TENANT_ID,
    conversationId: CONVERSATION_ID,
    messageId: `wamid.teste.${sequence}`,
    receivedAt: world.now.value,
    patientId: 'p1',
    identityResolved: true,
    ...overrides,
  };
}

function intentOf(intent: string, extra: Partial<IntentResult> = {}): IntentResult {
  return { intent, confidence: 0.92, entities: {}, requiresEscalation: false, ...extra } as IntentResult;
}

const CANCEL = intentOf('cancelar_consulta');
const YES = intentOf('confirmar_presenca', { confirmation: 'confirma' });
const NO = intentOf('duvida_geral', { confirmation: 'recusa' });

/** Um turno completo do K11: prepare (antes da IA) e handle (depois dela). */
async function turnOf(useCase: PedidoDeConsultaPeloWhatsAppUseCase, turn: WhatsAppTurn, intent: IntentResult) {
  const prepared = await useCase.prepare(turn);
  return { prepared, result: await useCase.handle(turn, intent, prepared) };
}

function later(world: World, minutes = 5): void {
  world.now.value = new Date(world.now.value.getTime() + minutes * 60_000);
}

function notificationTypes(world: World): string[] {
  return world.notifications.map((n) => n.type);
}

function remarcarPara(slot: Date) {
  const local = slot.toLocaleString('sv-SE', { timeZone: TZ }); // "2026-08-10 06:00:00"
  return intentOf('remarcar_consulta', { entities: { newDate: local.slice(0, 10), newTime: local.slice(11, 16) } });
}

describe('K11 — pedido pelo WhatsApp (etapa 1: o pedido e a pergunta)', () => {
  let world: World;
  let useCase: PedidoDeConsultaPeloWhatsAppUseCase;
  beforeEach(() => {
    world = createWorld({ userId: null, cancellationHoursLimit: 24 });
    withAppointment(world, appointmentIn('Confirmada'));
    useCase = useCaseFor(world);
  });

  it('registra o pedido como comunicação da IA e responde com a pergunta montada pelo backend; a consulta não muda', async () => {
    const { result } = await turnOf(useCase, message(world), CANCEL);

    expect(result).toEqual({ responseMessage: K11_TEXT.askCancel(asked), actionTaken: false });
    expect(world.appointments.get('a1')?.state).toBe('Confirmada');
    expect(world.outcomes.size).toBe(0);
    const [request] = world.notices;
    expect([request.awaitsConfirmation, request.requestedAction, request.intent, request.recordedByActorType, request.channel]).toEqual([
      true,
      'cancelar',
      'pedido_cancelamento',
      'ai_agent',
      'whatsapp',
    ]);
    expect([request.askedScheduledAt, request.askedModality, request.conversationId, request.timing]).toEqual([START, 'presencial', CONVERSATION_ID, 'no_prazo']);
    expect(world.auditedActors).toEqual([{ event: 'ComunicacaoRegistrada', actor: 'ai_agent' }]);
  });

  it('a pergunta diz data, horário e profissional (D3), e nada de cobrança (D8)', async () => {
    const { result } = await turnOf(useCase, message(world), CANCEL);
    expect(result?.responseMessage).toContain('03/08');
    expect(result?.responseMessage).toContain('06:00');
    expect(result?.responseMessage).toContain(PROFESSIONAL);
    expect(result?.responseMessage).not.toMatch(/cobran|multa|taxa|valor|pagamento/i);
  });

  it('D7 — "não vou conseguir ir" antes do início é pedido de cancelamento, com a mesma pergunta', async () => {
    const { result } = await turnOf(useCase, message(world), intentOf('nao_comparecer'));
    expect(result?.responseMessage).toBe(K11_TEXT.askCancel(asked));
    expect([world.notices[0].intent, world.notices[0].requestedAction]).toEqual(['nao_comparecera', 'cancelar']);
    expect(world.appointments.get('a1')?.state).toBe('Confirmada');
  });

  it('confirmação no mesmo turno do pedido não executa nada: só a pergunta', async () => {
    const { result } = await turnOf(useCase, message(world), intentOf('cancelar_consulta', { confirmation: 'confirma' }));
    expect(result?.responseMessage).toBe(K11_TEXT.askCancel(asked));
    expect(world.outcomes.size).toBe(0);
    expect(world.notices).toHaveLength(1);
  });

  it('a mesma mensagem do pedido entregue de novo, mesmo lida como "confirma", repete a pergunta e não grava nada novo', async () => {
    const first = message(world);
    await turnOf(useCase, first, CANCEL);
    later(world);
    const { result } = await turnOf(useCase, { ...first }, intentOf('cancelar_consulta', { confirmation: 'confirma' }));
    expect(result?.responseMessage).toBe(K11_TEXT.askCancel(asked));
    expect(world.notices).toHaveLength(1);
    expect(world.outcomes.size).toBe(0);
  });

  it('remarcação: confere o horário novo (D5), registra-o no pedido e pergunta com os dois horários', async () => {
    const { result } = await turnOf(useCase, message(world), remarcarPara(NEW_SLOT));
    expect(result?.responseMessage).toBe(K11_TEXT.askReschedule(asked, describeSlot(NEW_SLOT, TZ)));
    expect([world.notices[0].requestedAction, world.notices[0].proposedScheduledAt]).toEqual(['remarcar', NEW_SLOT]);
    expect(world.motor.execute).toHaveBeenCalledWith({ therapistId: 't1', scheduledAt: NEW_SLOT, excludeAppointmentId: 'a1' });
  });

  it('remarcação para horário ocupado: avisa e não abre pedido', async () => {
    world.motor.execute.mockResolvedValue(false);
    const { result } = await turnOf(useCase, message(world), remarcarPara(NEW_SLOT));
    expect(result?.responseMessage).toBe(K11_TEXT.newSlotUnavailable(describeSlot(NEW_SLOT, TZ)));
    expect(world.notices).toHaveLength(0);
  });

  it('remarcação sem horário novo pergunta qual; horário no passado é recusado', async () => {
    expect((await turnOf(useCase, message(world), intentOf('remarcar_consulta'))).result?.responseMessage).toBe(K11_TEXT.askNewSlot(asked));
    const past = new Date(world.now.value.getTime() - 3_600_000);
    expect((await turnOf(useCase, message(world), remarcarPara(past))).result?.responseMessage).toBe(K11_TEXT.newSlotInThePast());
    expect(world.notices).toHaveLength(0);
  });

  it('pedido depois do início: não abre pedido, avisa a equipe e diz que não altera por aqui', async () => {
    world.now.value = new Date(START.getTime() + 30 * 60_000);
    const { result } = await turnOf(useCase, message(world), CANCEL);
    expect(result?.responseMessage).toBe(K11_TEXT.alreadyStarted(asked));
    expect(world.notices).toHaveLength(0);
    expect(notificationTypes(world)).toEqual(['whatsapp_request_depois_do_inicio']);
    expect(world.appointments.get('a1')?.state).toBe('Confirmada');
  });

  it('sem consulta futura: diz que não encontrou', async () => {
    world.appointments.clear();
    expect((await turnOf(useCase, message(world), CANCEL)).result?.responseMessage).toBe(K11_TEXT.noAppointment());
  });

  it('com a identidade não resolvida, o K11 não age (ADR-0063)', async () => {
    const turn = message(world, { identityResolved: false, patientId: undefined });
    const { prepared, result } = await turnOf(useCase, turn, CANCEL);
    expect(result).toBeNull();
    expect(prepared.context).toBeUndefined();
    expect(world.notices).toHaveLength(0);
  });

  it('a IA pediu escalonamento: o pedido não é aberto por ela', async () => {
    expect((await turnOf(useCase, message(world), intentOf('cancelar_consulta', { requiresEscalation: true }))).result).toBeNull();
    expect(world.notices).toHaveLength(0);
  });
});

describe('K11 — D3: o backend localiza a consulta; a IA nunca vê identificadores', () => {
  let world: World;
  let useCase: PedidoDeConsultaPeloWhatsAppUseCase;
  const SECOND = new Date('2026-08-05T13:30:00.000Z');
  beforeEach(() => {
    world = createWorld({ userId: null });
    withAppointment(world, appointmentIn('Confirmada'));
    withAppointment(world, appointmentIn('Reservada', { id: 'a2', scheduledAt: SECOND }));
    withAppointment(world, appointmentIn('Reservada', { id: 'a-outro', patientId: 'p2', scheduledAt: SECOND }));
    useCase = useCaseFor(world);
  });

  it('o contexto da IA tem data, dia, horário e profissional — sem id de consulta, de paciente ou de profissional', async () => {
    const { prepared } = await turnOf(useCase, message(world), intentOf('duvida_geral'));
    expect(prepared.context?.upcoming).toEqual([
      { date: '2026-08-03', weekday: expect.any(String), time: '06:00', professional: PROFESSIONAL, modality: 'presencial' },
      { date: '2026-08-05', weekday: expect.any(String), time: '10:30', professional: PROFESSIONAL, modality: 'presencial' },
    ]);
    const serialized = JSON.stringify(prepared.context);
    for (const forbidden of ['a1', 'a2', 'a-outro', 'p1', 'p2', '"t1"', TENANT_ID, CONVERSATION_ID]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('duas consultas e nenhuma indicação: pergunta de qual delas, sem abrir pedido', async () => {
    const { result } = await turnOf(useCase, message(world), CANCEL);
    expect(result?.responseMessage).toMatch(/^Você tem mais de uma consulta: /);
    expect(world.notices).toHaveLength(0);
  });

  it('com a data dita pelo paciente: localiza a consulta certa', async () => {
    await turnOf(useCase, message(world), intentOf('cancelar_consulta', { entities: { appointmentDate: '2026-08-05' } }));
    expect(world.notices.map((n) => n.appointmentId)).toEqual(['a2']);
  });

  it('com horário e profissional ditos: localiza; dados que não casam listam as próximas', async () => {
    await turnOf(useCase, message(world), intentOf('cancelar_consulta', { entities: { appointmentTime: '6:00', professional: 'Paula' } }));
    expect(world.notices.map((n) => n.appointmentId)).toEqual(['a1']);
    const { result } = await turnOf(
      useCase,
      message(world),
      intentOf('cancelar_consulta', { entities: { appointmentDate: '2026-09-01' }, confirmation: 'nao_relacionada' }),
    );
    expect(result?.responseMessage).toMatch(/^Não encontrei uma consulta sua com esses dados\./);
  });

  it('a consulta de outro paciente nunca é candidata', async () => {
    await turnOf(useCase, message(world), intentOf('cancelar_consulta', { entities: { appointmentDate: '2026-08-05' } }));
    expect(world.notices.every((n) => n.patientId === 'p1')).toBe(true);
  });

  it('readHints descarta o que está fora do formato; readNewSlot recusa data que não existe', () => {
    expect(readHints({ appointmentDate: '05/08', appointmentTime: '25:00', professional: 'x'.repeat(81), id: 'a1' })).toEqual({
      date: undefined,
      time: undefined,
      professional: undefined,
    });
    expect(readHints({ appointmentDate: '2026-08-05', appointmentTime: '9:05', professional: 'Dra. Paula' })).toEqual({
      date: '2026-08-05',
      time: '09:05',
      professional: 'Dra. Paula',
    });
    expect(readNewSlot({ newDate: '2026-02-31', newTime: '10:00' }, TZ)).toBeUndefined();
    expect(readNewSlot({ newDate: '2026-08-10', newTime: '06:00' }, TZ)).toEqual(NEW_SLOT);
    expect(matchAppointments([appointmentIn('Confirmada')], { professional: 'Marcos' }, new Map([['t1', PROFESSIONAL]]), TZ)).toEqual([]);
  });
});

describe('K11 — etapa 2: a resposta, em outra mensagem', () => {
  let world: World;
  let useCase: PedidoDeConsultaPeloWhatsAppUseCase;
  beforeEach(async () => {
    world = createWorld({ userId: null, cancellationHoursLimit: 24 });
    withAppointment(world, appointmentIn('Confirmada'));
    useCase = useCaseFor(world);
  });

  async function askCancel() {
    await turnOf(useCase, message(world), CANCEL);
    later(world);
    return world.notices[0];
  }

  it('o pedido pendente vai para a IA como a pergunta feita, para classificar a resposta', async () => {
    await askCancel();
    const prepared = await useCase.prepare(message(world));
    expect(prepared.context?.pendingQuestion).toBe(K11_TEXT.askCancel(asked));
    expect(prepared.pending?.thread.request.id).toBe(world.notices[0].id);
  });

  it('confirmação posterior válida: cancela, com desfecho da IA ligado ao pedido e à resposta (D1, D2)', async () => {
    const request = await askCancel();
    const { result } = await turnOf(useCase, message(world), YES);

    expect(result).toEqual({ responseMessage: K11_TEXT.cancelled(asked), actionTaken: true });
    expect(world.appointments.get('a1')?.state).toBe('Cancelada');
    const reply = world.notices[1];
    expect([reply.confirmsNoticeId, reply.confirmationAnswer, reply.awaitsConfirmation, reply.reviewStatus]).toEqual([
      request.id,
      'confirma',
      false,
      'sem_revisao_necessaria',
    ]);
    const outcome = world.outcomes.get('a1') as AppointmentOutcomeRecord;
    expect([outcome.recordedByActorType, outcome.recordedByUserId, outcome.closingNoticeId, outcome.confirmationNoticeId]).toEqual([
      'ai_agent',
      undefined,
      request.id,
      reply.id,
    ]);
    // O pedido continua o que era: a resposta é outra linha (D2).
    expect([request.awaitsConfirmation, request.confirmationAnswer]).toEqual([true, undefined]);
    expect(new Set(world.auditedActors.map((a) => a.actor))).toEqual(new Set(['ai_agent']));
    expect(world.notifications).toHaveLength(0);
  });

  it('confirmação de remarcação: confere o horário de novo (D5) e cria a ocorrência nova ligada', async () => {
    await turnOf(useCase, message(world), remarcarPara(NEW_SLOT));
    later(world);
    const { result } = await turnOf(useCase, message(world), YES);

    expect(result).toEqual({ responseMessage: K11_TEXT.rescheduled(describeSlot(NEW_SLOT, TZ), asked), actionTaken: true });
    expect(world.motor.execute).toHaveBeenCalledTimes(2);
    const created = [...world.appointments.values()].find((a) => a.rescheduledFromId === 'a1');
    expect([created?.scheduledAt, created?.state]).toEqual([NEW_SLOT, 'Reservada']);
    expect(world.outcomes.get('a1')?.outcome).toBe('Remarcada');
  });

  it('horário novo ocupado na confirmação (D5): não altera, avisa a equipe e diz o horário que continua', async () => {
    await turnOf(useCase, message(world), remarcarPara(NEW_SLOT));
    later(world);
    world.motor.execute.mockResolvedValue(false);
    const { result } = await turnOf(useCase, message(world), YES);

    expect(result?.responseMessage).toBe(K11_TEXT.slotTakenAtConfirmation(describeSlot(NEW_SLOT, TZ), asked));
    expect(result?.actionTaken).toBe(false);
    expect([world.appointments.get('a1')?.state, world.appointments.get('a1')?.scheduledAt]).toEqual(['Confirmada', START]);
    expect(world.outcomes.size).toBe(0);
    expect(notificationTypes(world)).toEqual(['whatsapp_request_horario_indisponivel']);
  });

  it('recusa: a consulta continua, a resposta fica registrada e a equipe é avisada', async () => {
    await askCancel();
    const { result } = await turnOf(useCase, message(world), NO);
    expect(result?.responseMessage).toBe(K11_TEXT.kept(asked));
    expect(world.appointments.get('a1')?.state).toBe('Confirmada');
    expect(world.outcomes.size).toBe(0);
    expect([world.notices[1].confirmationAnswer, world.notices[1].reviewStatus]).toEqual(['recusa', 'pendente']);
    expect(notificationTypes(world)).toEqual(['whatsapp_request_recusa']);
  });

  it.each([
    ['ambígua', intentOf('duvida_geral', { confirmation: 'ambigua' })],
    ['sem classificação', intentOf('duvida_geral')],
    ['"confirma" com escalonamento pedido pela IA', intentOf('duvida_geral', { confirmation: 'confirma', requiresEscalation: true })],
  ])('resposta %s: nada é executado; vai para a equipe', async (_label, intent) => {
    await askCancel();
    const { result } = await turnOf(useCase, message(world), intent);
    expect(result?.responseMessage).toBe(K11_TEXT.unclear());
    expect(world.notices[1].confirmationAnswer).toBe('ambigua');
    expect(world.outcomes.size).toBe(0);
    expect(notificationTypes(world)).toEqual(['whatsapp_request_ambigua']);
  });

  it('mensagem não relacionada com o pedido pendente: o turno segue o fluxo de sempre, sem resposta registrada', async () => {
    await askCancel();
    const { result } = await turnOf(useCase, message(world), intentOf('duvida_geral', { confirmation: 'nao_relacionada' }));
    expect(result).toBeNull();
    expect(world.notices).toHaveLength(1);
  });

  it('outro contato (outra conversa) dizendo "sim": nada é lido como confirmação', async () => {
    await askCancel();
    const { prepared, result } = await turnOf(useCase, message(world, { conversationId: 'conversa-2' }), YES);
    expect(prepared.pending).toBeNull();
    expect(prepared.context?.pendingQuestion).toBeUndefined();
    expect(result).toBeNull();
    expect(world.outcomes.size).toBe(0);
    expect(world.appointments.get('a1')?.state).toBe('Confirmada');
  });

  it('identidade alterada (o número agora identifica outro paciente): nada é executado; vai para a equipe, sem dados', async () => {
    await askCancel();
    const { prepared, result } = await turnOf(useCase, message(world, { patientId: 'p2' }), YES);
    expect(prepared.pending).toBeNull();
    expect(prepared.context?.pendingQuestion).toBeUndefined();
    expect(result).toEqual({ responseMessage: K11_TEXT.handedToTeam(), actionTaken: false });
    expect(world.outcomes.size).toBe(0);
    expect(world.notices).toHaveLength(1);
    expect(notificationTypes(world)).toEqual(['whatsapp_request_identidade_alterada']);
  });

  it('identidade que deixa de estar resolvida: a equipe é avisada e o K11 não age', async () => {
    await askCancel();
    const { result } = await turnOf(useCase, message(world, { identityResolved: false, patientId: undefined }), YES);
    expect(result).toBeNull();
    expect(world.outcomes.size).toBe(0);
    expect(notificationTypes(world)).toEqual(['whatsapp_request_identidade_alterada']);
  });

  it('identidade trocada no meio do turno (o eixo de contato associou outro paciente): não é resposta dele', async () => {
    await askCancel();
    const turn = message(world);
    const prepared = await useCase.prepare(turn);
    const result = await useCase.handle({ ...turn, patientId: 'p2' }, YES, prepared);
    expect(result).toEqual({ responseMessage: K11_TEXT.handedToTeam(), actionTaken: false });
    expect(world.notices).toHaveLength(1);
    expect(world.outcomes.size).toBe(0);
  });

  it('mensagem que chegou antes do pedido (processada fora de ordem) não é resposta', async () => {
    const request = await askCancel();
    const early = message(world, { receivedAt: new Date((request.receivedAt as Date).getTime() - 1_000) });
    const { result } = await turnOf(useCase, early, YES);
    expect(result).toBeNull();
    expect(world.notices).toHaveLength(1);
    expect(world.outcomes.size).toBe(0);
  });

  it('confirmação tardia (depois do início): registrada, não executa, avisa a equipe', async () => {
    await askCancel();
    world.now.value = new Date(START.getTime() + 10 * 60_000);
    const { result } = await turnOf(useCase, message(world), YES);
    expect(result?.responseMessage).toBe(K11_TEXT.tooLate());
    expect([world.notices[1].confirmationAnswer, world.notices[1].timing, world.notices[1].reviewStatus]).toEqual([
      'confirma',
      'depois_do_inicio',
      'pendente',
    ]);
    expect(world.outcomes.size).toBe(0);
    expect(world.appointments.get('a1')?.state).toBe('Confirmada');
    expect(notificationTypes(world)).toEqual(['whatsapp_request_vencido', 'whatsapp_request_tardia']);
    // Nem chega a tentar executar: a consulta não é travada.
    expect(world.repo.findByIdForUpdate).not.toHaveBeenCalled();
  });

  it('vencido há mais de 24 horas: o pedido não espera mais resposta (D6)', async () => {
    await askCancel();
    world.now.value = new Date(START.getTime() + 25 * 3_600_000);
    const { prepared, result } = await turnOf(useCase, message(world), YES);
    expect(prepared.pending).toBeNull();
    expect(result).toBeNull();
    expect(world.notices).toHaveLength(1);
  });

  it('consulta mudada depois da pergunta (D4): a resposta é registrada para revisão, nada é executado, a equipe é avisada', async () => {
    await askCancel();
    const moved = withAppointment(world, appointmentIn('Confirmada', { scheduledAt: new Date(START.getTime() + 2 * 3_600_000) }));
    const { prepared, result } = await turnOf(useCase, message(world), YES);
    expect(prepared.context?.pendingQuestion).toBe(K11_TEXT.askCancel(asked)); // a pergunta como foi feita
    expect(result?.responseMessage).toBe(K11_TEXT.changed());
    expect([world.notices[1].confirmationAnswer, world.notices[1].reviewStatus]).toEqual(['confirma', 'pendente']);
    expect(moved.state).toBe('Confirmada');
    expect(world.outcomes.size).toBe(0);
    expect(notificationTypes(world)).toEqual(['whatsapp_request_consulta_alterada']);
  });

  it('consulta cancelada pela equipe depois da pergunta: a resposta não cria um segundo desfecho', async () => {
    await askCancel();
    const appointment = world.appointments.get('a1')!;
    appointment.transitionTo('Cancelada');
    const panelNotice = AppointmentNotice.recordFromPanel({
      id: 'n-painel',
      appointment,
      intent: 'pedido_cancelamento',
      requestedBy: 'clinica',
      recordedByUserId: 'u1',
      now: world.now.value,
    });
    world.outcomes.set('a1', AppointmentOutcomeRecord.closeByNotice(appointment, panelNotice, 'Cancelada', { userId: 'u1', now: world.now.value }));
    const { result } = await turnOf(useCase, message(world), YES);
    expect(result?.responseMessage).toBe(K11_TEXT.changed());
    expect(world.outcomes.get('a1')?.recordedByActorType).toBe('user');
    expect(notificationTypes(world)).toEqual(['whatsapp_request_consulta_alterada']);
  });

  it('pedido mais novo substitui o anterior: a resposta vale para o mais novo', async () => {
    withAppointment(world, appointmentIn('Reservada', { id: 'a2', scheduledAt: new Date('2026-08-05T13:30:00.000Z') }));
    await turnOf(useCase, message(world), intentOf('cancelar_consulta', { entities: { appointmentDate: '2026-08-03' } }));
    later(world);
    // Com a pergunta pendente, a IA classifica o pedido novo como não relacionado a ela.
    await turnOf(useCase, message(world), intentOf('cancelar_consulta', { entities: { appointmentDate: '2026-08-05' }, confirmation: 'nao_relacionada' }));
    later(world);
    await turnOf(useCase, message(world), YES);
    expect(world.appointments.get('a1')?.state).toBe('Confirmada');
    expect(world.appointments.get('a2')?.state).toBe('Cancelada');
    expect(world.outcomes.get('a2')?.closingNoticeId).toBe(world.notices[1].id);
  });
});

describe('K11 — idempotência', () => {
  let world: World;
  let useCase: PedidoDeConsultaPeloWhatsAppUseCase;
  beforeEach(() => {
    world = createWorld({ userId: null });
    withAppointment(world, appointmentIn('Confirmada'));
    useCase = useCaseFor(world);
  });

  it('a mesma confirmação entregue de novo: responde o mesmo, sem segundo desfecho nem segunda resposta', async () => {
    await turnOf(useCase, message(world), CANCEL);
    later(world);
    const yes = message(world);
    await turnOf(useCase, yes, YES);
    later(world);
    // Na reentrega, a IA pode até classificar diferente: vale o que foi registrado.
    const { result } = await turnOf(useCase, { ...yes }, intentOf('duvida_geral', { confirmation: 'nao_relacionada' }));
    expect(result).toEqual({ responseMessage: K11_TEXT.cancelled(asked), actionTaken: false });
    expect(world.notices).toHaveLength(2);
    expect(world.outcomes.size).toBe(1);
  });

  it('a mesma confirmação de remarcação entregue de novo: uma ocorrência nova só', async () => {
    await turnOf(useCase, message(world), remarcarPara(NEW_SLOT));
    later(world);
    const yes = message(world);
    await turnOf(useCase, yes, YES);
    later(world);
    const { result } = await turnOf(useCase, { ...yes }, YES);
    expect(result).toEqual({ responseMessage: K11_TEXT.rescheduled(describeSlot(NEW_SLOT, TZ), asked), actionTaken: false });
    expect([...world.appointments.values()].filter((a) => a.rescheduledFromId === 'a1')).toHaveLength(1);
  });

  it('o aviso à equipe é um só por pedido e motivo enquanto não for lido', async () => {
    await turnOf(useCase, message(world), CANCEL);
    later(world);
    await turnOf(useCase, message(world, { patientId: 'p2' }), YES);
    later(world);
    await turnOf(useCase, message(world, { patientId: 'p2' }), YES);
    expect(notificationTypes(world)).toEqual(['whatsapp_request_identidade_alterada']);
  });
});

describe('K11 — textos (D8) e avisos à equipe', () => {
  const description = describeAppointment(START, PROFESSIONAL, 'online', TZ);
  const slot = describeSlot(NEW_SLOT, TZ);
  const allTexts = [
    K11_TEXT.askCancel(description),
    K11_TEXT.askReschedule(description, slot),
    K11_TEXT.cancelled(description),
    K11_TEXT.rescheduled(slot, description),
    K11_TEXT.kept(description),
    K11_TEXT.unclear(),
    K11_TEXT.tooLate(),
    K11_TEXT.changed(),
    K11_TEXT.slotTakenAtConfirmation(slot, description),
    K11_TEXT.noAppointment(),
    K11_TEXT.notMatched(description.text),
    K11_TEXT.severalMatches(description.text),
    K11_TEXT.askNewSlot(description),
    K11_TEXT.newSlotUnavailable(slot),
    K11_TEXT.newSlotInThePast(),
    K11_TEXT.alreadyStarted(description),
    K11_TEXT.handedToTeam(),
    ...Object.values(TEAM_NOTICE).flatMap((n) => [n.title, n.message(description.text, 'cancelar'), n.message(description.text, 'remarcar')]),
  ];

  it('nenhum texto ao paciente ou à equipe fala em cobrança (D8)', () => {
    for (const text of allTexts) expect(text).not.toMatch(/cobran|multa|taxa|valor|pagamento|R\$/i);
  });

  it('a modalidade online aparece na descrição', () => {
    expect(description.text.endsWith(', online')).toBe(true);
  });

  it('o horário de referência dos testes: antes do início por padrão', () => {
    expect(BEFORE_START < START && START < AFTER_START).toBe(true);
  });
});
