import { describe, it, expect } from 'vitest';
import { AppointmentOutcomeRecord } from '@domain/appointment/appointment-outcome';
import { ListarPedidosPeloWhatsAppUseCase } from '@use-cases/appointment/listar-pedidos-pelo-whatsapp.use-case';
import { BEFORE_START, START, World, appointmentIn, createWorld, whatsAppReply, whatsAppRequest, withAppointment } from './support/lifecycle-world';

/**
 * K11 — as pendências da equipe (D6: o estado é derivado na leitura, sem
 * agendador) e a autoria "IA, confirmado pelo paciente" dos pedidos que a IA
 * executou.
 */
function listar(world: World) {
  return new ListarPedidosPeloWhatsAppUseCase(world.noticeRepo, world.repo, world.outcomeRepo, world.clock);
}

const statuses = async (world: World) => (await listar(world).execute()).map((item) => [item.appointment.id, item.status]);

describe('ListarPedidosPeloWhatsAppUseCase (K11)', () => {
  it('pedido aguardando aparece; depois do início, aparece como vencido — sem nenhum agendador', async () => {
    const world = createWorld({ userId: null });
    const appointment = withAppointment(world, appointmentIn('Confirmada'));
    whatsAppRequest(world, appointment);
    expect(await statuses(world)).toEqual([['a1', 'aguardando']]);
    world.now.value = new Date(START.getTime() + 60_000);
    expect(await statuses(world)).toEqual([['a1', 'vencido']]);
  });

  it('resposta ambígua ou confirmação não executada pedem a equipe; recusa não', async () => {
    const world = createWorld({ userId: null });
    const a1 = withAppointment(world, appointmentIn('Confirmada'));
    const a2 = withAppointment(world, appointmentIn('Confirmada', { id: 'a2', scheduledAt: new Date(START.getTime() + 86_400_000) }));
    const a3 = withAppointment(world, appointmentIn('Confirmada', { id: 'a3', scheduledAt: new Date(START.getTime() + 2 * 86_400_000) }));
    whatsAppReply(world, whatsAppRequest(world, a1, { conversationId: 'c1' }), a1, 'ambigua');
    whatsAppReply(world, whatsAppRequest(world, a2, { conversationId: 'c2' }), a2, 'confirma');
    whatsAppReply(world, whatsAppRequest(world, a3, { conversationId: 'c3' }), a3, 'recusa');
    expect(await statuses(world)).toEqual([
      ['a1', 'encaminhado'],
      ['a2', 'nao_executado'],
    ]);
  });

  it('confirmado pela IA aparece por 7 dias, com o desfecho da IA', async () => {
    const world = createWorld({ userId: null });
    const appointment = withAppointment(world, appointmentIn('Confirmada'));
    const request = whatsAppRequest(world, appointment);
    const confirmation = whatsAppReply(world, request, appointment, 'confirma');
    appointment.transitionTo('Cancelada');
    world.outcomes.set('a1', AppointmentOutcomeRecord.closeByConfirmedRequest(appointment, request, confirmation, 'Cancelada', { now: BEFORE_START }));

    const [item] = await listar(world).execute();
    expect([item.status, item.replies.map((r) => r.id)]).toEqual(['confirmado', [confirmation.id]]);
    world.now.value = new Date(BEFORE_START.getTime() + 8 * 86_400_000);
    expect(await statuses(world)).toEqual([]);
  });

  it('só o pedido mais novo de cada conversa conta; o anterior foi substituído', async () => {
    const world = createWorld({ userId: null });
    const a1 = withAppointment(world, appointmentIn('Confirmada'));
    const a2 = withAppointment(world, appointmentIn('Confirmada', { id: 'a2', scheduledAt: new Date(START.getTime() + 86_400_000) }));
    whatsAppRequest(world, a1);
    whatsAppRequest(world, a2, { receivedAt: new Date(BEFORE_START.getTime() - 60_000) });
    expect(await statuses(world)).toEqual([['a2', 'aguardando']]);
  });

  it('pedido que pede a equipe sai da lista quando a consulta ganha desfecho', async () => {
    const world = createWorld({ userId: null });
    const appointment = withAppointment(world, appointmentIn('Confirmada'));
    whatsAppRequest(world, appointment);
    world.now.value = new Date(START.getTime() + 3_600_000);
    expect(await statuses(world)).toEqual([['a1', 'vencido']]);
    world.outcomes.set('a1', AppointmentOutcomeRecord.recordNoShow(appointment, { userId: 'u1', now: world.now.value }));
    expect(await statuses(world)).toEqual([]);
  });
});
