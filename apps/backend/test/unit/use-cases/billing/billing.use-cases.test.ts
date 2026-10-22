import { describe, it, expect, vi } from 'vitest';
import { GerarCobrancaUseCase, ConsultarCobrancaUseCase, EnviarCobrancaUseCase } from '@use-cases/billing/billing.use-cases';
import { Billing } from '@domain/billing/billing.entity';
import { Session } from '@domain/session/session.entity';
import { TenantContext } from '@shared/tenant-context';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function tenantContext() {
  const tc = new TenantContext();
  tc.set(TENANT_ID, 'user-1');
  return tc;
}

function auditService() {
  return { recordAll: vi.fn().mockResolvedValue(undefined) } as never;
}

/** K2-a — unidade de trabalho que só executa o trabalho; a transação real é provada nos testes críticos. */
function unitOfWork() {
  return { run: <T>(work: () => Promise<T>) => work() };
}

function fakeSession(id: string, patientId = 'p1', state: 'Realizada' | 'Faturada' | 'Recebida' = 'Realizada') {
  return Session.reconstitute({
    id,
    tenantId: TENANT_ID,
    appointmentId: `apt-${id}`,
    patientId,
    therapistId: 't1',
    state,
  });
}

/** AD-009 — sessionRepo mock que serve findById a partir dos ids fornecidos. */
function sessionRepoMock(sessionIds: string[]) {
  const sessions = new Map(sessionIds.map((id) => [id, fakeSession(id)]));
  return {
    findById: vi.fn((id: string) => Promise.resolve(sessions.get(id) ?? null)),
    save: vi.fn().mockResolvedValue(undefined),
    findSummaries: vi.fn(),
  };
}

describe('GerarCobrancaUseCase — cobrança agregada (Testes Críticos #4-7)', () => {
  it('rejeita cobrança sem nenhuma sessão vinculada', async () => {
    const repo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn(), createWithSessions: vi.fn(), findSessionIdsByBillingId: vi.fn(), findOverdueByTenant: vi.fn(), countLinkedSessions: vi.fn(), countOverdueByTenant: vi.fn(), sumPendingByTenant: vi.fn() };
    const useCase = new GerarCobrancaUseCase(repo, sessionRepoMock([]), auditService(), tenantContext(), { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never, unitOfWork());
    await expect(useCase.execute({ patientId: 'p1', amount: 400, dueDate: new Date(), sessionIds: [] })).rejects.toThrow(/ao menos uma sessão/);
  });

  it('cria cobrança por sessão avulsa (1 sessionId — caso N=1)', async () => {
    const repo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn().mockResolvedValue(undefined), createWithSessions: vi.fn().mockResolvedValue(undefined), findSessionIdsByBillingId: vi.fn(), findOverdueByTenant: vi.fn(), countLinkedSessions: vi.fn(), countOverdueByTenant: vi.fn(), sumPendingByTenant: vi.fn() };
    const useCase = new GerarCobrancaUseCase(repo, sessionRepoMock(['s1']), auditService(), tenantContext(), { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never, unitOfWork());
    await useCase.execute({ patientId: 'p1', amount: 400, dueDate: new Date(), sessionIds: ['s1'] });
    expect(repo.createWithSessions).toHaveBeenCalledWith(expect.objectContaining({ patientId: 'p1' }), ['s1']);
  });

  it('cria cobrança agregada (N sessionIds — semanal/mensal)', async () => {
    const repo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn().mockResolvedValue(undefined), createWithSessions: vi.fn().mockResolvedValue(undefined), findSessionIdsByBillingId: vi.fn(), findOverdueByTenant: vi.fn(), countLinkedSessions: vi.fn(), countOverdueByTenant: vi.fn(), sumPendingByTenant: vi.fn() };
    const useCase = new GerarCobrancaUseCase(repo, sessionRepoMock(['s1', 's2', 's3', 's4']), auditService(), tenantContext(), { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never, unitOfWork());
    await useCase.execute({ patientId: 'p1', amount: 1600, dueDate: new Date(), sessionIds: ['s1', 's2', 's3', 's4'] });
    expect(repo.createWithSessions).toHaveBeenCalledWith(expect.objectContaining({ patientId: 'p1' }), ['s1', 's2', 's3', 's4']);
  });

  it('nasce no estado Criada', async () => {
    const repo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn().mockResolvedValue(undefined), createWithSessions: vi.fn().mockResolvedValue(undefined), findSessionIdsByBillingId: vi.fn(), findOverdueByTenant: vi.fn(), countLinkedSessions: vi.fn(), countOverdueByTenant: vi.fn(), sumPendingByTenant: vi.fn() };
    const useCase = new GerarCobrancaUseCase(repo, sessionRepoMock(['s1']), auditService(), tenantContext(), { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never, unitOfWork());
    const billing = await useCase.execute({ patientId: 'p1', amount: 400, dueDate: new Date(), sessionIds: ['s1'] });
    expect(billing.state).toBe('Criada');
  });

  it('AD-009: transiciona todas as Sessions vinculadas para Faturada, na mesma execução', async () => {
    const repo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn().mockResolvedValue(undefined), createWithSessions: vi.fn().mockResolvedValue(undefined), findSessionIdsByBillingId: vi.fn(), findOverdueByTenant: vi.fn(), countLinkedSessions: vi.fn(), countOverdueByTenant: vi.fn(), sumPendingByTenant: vi.fn() };
    const sessionRepo = sessionRepoMock(['s1', 's2']);
    const audit = { recordAll: vi.fn().mockResolvedValue(undefined) };
    const useCase = new GerarCobrancaUseCase(repo, sessionRepo, audit as never, tenantContext(), { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never, unitOfWork());

    await useCase.execute({ patientId: 'p1', amount: 800, dueDate: new Date(), sessionIds: ['s1', 's2'] });

    expect(sessionRepo.save).toHaveBeenCalledTimes(2);
    for (const call of sessionRepo.save.mock.calls) {
      expect((call[0] as Session).state).toBe('Faturada');
    }
    // Billing.create() não emite evento de criação (só transitionTo() emite) —
    // o recordAll() final carrega só os 2 eventos de SessionStateChangedEvent.
    expect(audit.recordAll).toHaveBeenCalledOnce();
    expect((audit.recordAll as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(2);
  });

  it('AD-009: lança NotFoundException se uma sessão vinculada não existir', async () => {
    const repo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn().mockResolvedValue(undefined), createWithSessions: vi.fn().mockResolvedValue(undefined), findSessionIdsByBillingId: vi.fn(), findOverdueByTenant: vi.fn(), countLinkedSessions: vi.fn(), countOverdueByTenant: vi.fn(), sumPendingByTenant: vi.fn() };
    const useCase = new GerarCobrancaUseCase(repo, sessionRepoMock([]), auditService(), tenantContext(), { findById: vi.fn().mockResolvedValue({ id: 'p1' }) } as never, unitOfWork());
    await expect(
      useCase.execute({ patientId: 'p1', amount: 400, dueDate: new Date(), sessionIds: ['s-inexistente'] }),
    ).rejects.toThrow(/não encontrada/);
  });
});

describe('EnviarCobrancaUseCase — Módulo 11 (envio real via fila)', () => {
  function makeUseCase(billing: Billing, patient: unknown, clinic: unknown, channelConnected = true) {
    const billingRepo = { findById: vi.fn().mockResolvedValue(billing), findAllByTenant: vi.fn(), save: vi.fn().mockResolvedValue(undefined), createWithSessions: vi.fn(), findOverdueByTenant: vi.fn(), countLinkedSessions: vi.fn().mockResolvedValue(1), findSessionIdsByBillingId: vi.fn(), countOverdueByTenant: vi.fn(), sumPendingByTenant: vi.fn() };
    const patientRepo = { findById: vi.fn().mockResolvedValue(patient), findAllByTenant: vi.fn(), save: vi.fn(), findByPhone: vi.fn(), findAllByPhone: vi.fn(), findAllByName: vi.fn(), countActiveByTenant: vi.fn() };
    const clinicRepo = { findByTenantId: vi.fn().mockResolvedValue(clinic), save: vi.fn(), findByTenantIdForUpdate: vi.fn(), saveTimeZone: vi.fn() };
    const messageQueue = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const messageChannel = { isConnected: vi.fn().mockResolvedValue(channelConnected) };
    const useCase = new EnviarCobrancaUseCase(billingRepo, patientRepo, clinicRepo, new ConsultarCobrancaUseCase(billingRepo), messageQueue as never, auditService(), messageChannel);
    return { useCase, messageQueue, billingRepo };
  }

  it('Tarefa 05: sem WhatsApp conectado recusa o envio, não enfileira nada e a cobrança continua Criada', async () => {
    const billing = Billing.reconstitute({ id: 'b1', tenantId: TENANT_ID, patientId: 'p1', amount: 400, dueDate: new Date(), state: 'Criada' });
    const { useCase, messageQueue, billingRepo } = makeUseCase(billing, { name: 'Maria Silva', phone: '+5541900000000' }, { pixKey: 'x', payeeName: 'y' }, false);

    await expect(useCase.execute('b1')).rejects.toMatchObject({ response: { code: 'WHATSAPP_NOT_CONNECTED' }, status: 409 });

    expect(messageQueue.enqueue).not.toHaveBeenCalled();
    expect(billingRepo.save).not.toHaveBeenCalled();
    expect(billing.state).toBe('Criada');
  });

  it('transiciona Criada → Enviada e enfileira a mensagem real', async () => {
    const billing = Billing.reconstitute({ id: 'b1', tenantId: TENANT_ID, patientId: 'p1', amount: 400, dueDate: new Date(), state: 'Criada' });
    const patient = { name: 'Maria Silva', phone: '+5541900000000' };
    const clinic = { pixKey: '41999999999', payeeName: 'Clínica Teste' };
    const { useCase, messageQueue, billingRepo } = makeUseCase(billing, patient, clinic);

    const result = await useCase.execute('b1');

    expect(result.state).toBe('Enviada');
    expect(messageQueue.enqueue).toHaveBeenCalledOnce();
    expect(billingRepo.save).toHaveBeenCalledOnce();
  });

  it('usa o idempotencyKey determinístico billing-{id} — reenviar a mesma cobrança nunca duplica', async () => {
    const billing = Billing.reconstitute({ id: 'b1', tenantId: TENANT_ID, patientId: 'p1', amount: 400, dueDate: new Date(), state: 'Criada' });
    const patient = { name: 'Maria Silva', phone: '+5541900000000' };
    const { useCase, messageQueue } = makeUseCase(billing, patient, { pixKey: 'x', payeeName: 'y' });

    await useCase.execute('b1');

    expect(messageQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'billing-b1' }));
  });

  it('lança erro quando o paciente da cobrança não é encontrado', async () => {
    const billing = Billing.reconstitute({ id: 'b1', tenantId: TENANT_ID, patientId: 'p-inexistente', amount: 400, dueDate: new Date(), state: 'Criada' });
    const { useCase } = makeUseCase(billing, null, {});
    await expect(useCase.execute('b1')).rejects.toThrow(/Paciente da cobrança não encontrado/);
  });
});

/**
 * Tarefa 06 da auditoria (AD-032) — cobrança só para paciente da própria
 * clínica.
 */
describe('Tarefa 06 — GerarCobrancaUseCase confere o paciente', () => {
  it('paciente não encontrado: 404, e nem a cobrança nem o vínculo com a sessão são gravados', async () => {
    const repo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn(), createWithSessions: vi.fn(), findSessionIdsByBillingId: vi.fn(), findOverdueByTenant: vi.fn(), countLinkedSessions: vi.fn(), countOverdueByTenant: vi.fn(), sumPendingByTenant: vi.fn() };
    const sessionRepo = sessionRepoMock(['s1']);
    const patientRepo = { findById: vi.fn().mockResolvedValue(null) };
    const useCase = new GerarCobrancaUseCase(repo, sessionRepo, auditService(), tenantContext(), patientRepo as never, unitOfWork());

    await expect(useCase.execute({ patientId: 'p-de-outra-clinica', amount: 400, dueDate: new Date(), sessionIds: ['s1'] })).rejects.toMatchObject({ status: 404 });

    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.createWithSessions).not.toHaveBeenCalled();
    expect(sessionRepo.save).not.toHaveBeenCalled();
  });

  it('sessão não encontrada (inexistente ou de outra clínica): 404 antes de gravar a cobrança ou o vínculo', async () => {
    const repo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn(), createWithSessions: vi.fn(), findSessionIdsByBillingId: vi.fn(), findOverdueByTenant: vi.fn(), countLinkedSessions: vi.fn(), countOverdueByTenant: vi.fn(), sumPendingByTenant: vi.fn() };
    const sessionRepo = sessionRepoMock(['s1']);
    const patientRepo = { findById: vi.fn().mockResolvedValue({ id: 'p1' }) };
    const useCase = new GerarCobrancaUseCase(repo, sessionRepo, auditService(), tenantContext(), patientRepo as never, unitOfWork());

    await expect(useCase.execute({ patientId: 'p1', amount: 400, dueDate: new Date(), sessionIds: ['s1', 's-de-outra-clinica'] })).rejects.toMatchObject({ status: 404 });

    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.createWithSessions).not.toHaveBeenCalled();
    expect(sessionRepo.save).not.toHaveBeenCalled();
  });
});

/**
 * K2-a (ADR-0069, seções 2.9 e 3.7) — elegibilidade conferida antes de
 * gravar, e tudo dentro da unidade de trabalho.
 */
describe('K2-a — GerarCobrancaUseCase confere a elegibilidade e grava tudo de uma vez', () => {
  function billingRepo() {
    return { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn(), createWithSessions: vi.fn().mockResolvedValue(undefined), findSessionIdsByBillingId: vi.fn(), findOverdueByTenant: vi.fn(), countLinkedSessions: vi.fn(), countOverdueByTenant: vi.fn(), sumPendingByTenant: vi.fn() };
  }
  function sessionRepoWith(...sessions: Session[]) {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    return { findById: vi.fn((id: string) => Promise.resolve(byId.get(id) ?? null)), save: vi.fn().mockResolvedValue(undefined), findSummaries: vi.fn() };
  }
  const patientRepo = () => ({ findById: vi.fn().mockResolvedValue({ id: 'p1' }) }) as never;

  it('sessão de outro paciente da mesma clínica: 409 SESSION_OF_ANOTHER_PATIENT, nada gravado', async () => {
    const repo = billingRepo();
    const sessionRepo = sessionRepoWith(fakeSession('s1'), fakeSession('s2', 'p2'));
    const audit = { recordAll: vi.fn() };
    const useCase = new GerarCobrancaUseCase(repo, sessionRepo, audit as never, tenantContext(), patientRepo(), unitOfWork());

    await expect(useCase.execute({ patientId: 'p1', amount: 800, dueDate: new Date(), sessionIds: ['s1', 's2'] })).rejects.toMatchObject({
      status: 409,
      response: { code: 'SESSION_OF_ANOTHER_PATIENT' },
    });
    expect(repo.createWithSessions).not.toHaveBeenCalled();
    expect(sessionRepo.save).not.toHaveBeenCalled();
    expect(audit.recordAll).not.toHaveBeenCalled();
  });

  it.each(['Faturada', 'Recebida'] as const)(
    'sessão já cobrada (%s): 409 SESSION_ALREADY_BILLED do contrato publicado, nada gravado',
    async (state) => {
      const repo = billingRepo();
      const sessionRepo = sessionRepoWith(fakeSession('s1', 'p1', state));
      const useCase = new GerarCobrancaUseCase(repo, sessionRepo, auditService(), tenantContext(), patientRepo(), unitOfWork());

      await expect(useCase.execute({ patientId: 'p1', amount: 400, dueDate: new Date(), sessionIds: ['s1'] })).rejects.toMatchObject({
        status: 409,
        response: { code: 'SESSION_ALREADY_BILLED' },
      });
      expect(repo.createWithSessions).not.toHaveBeenCalled();
      expect(sessionRepo.save).not.toHaveBeenCalled();
    },
  );

  it('sessão já cobrada de outro paciente: 409 SESSION_OF_ANOTHER_PATIENT (o paciente é conferido antes da cobrança existente)', async () => {
    const repo = billingRepo();
    const sessionRepo = sessionRepoWith(fakeSession('s1', 'p2', 'Faturada'));
    const useCase = new GerarCobrancaUseCase(repo, sessionRepo, auditService(), tenantContext(), patientRepo(), unitOfWork());

    await expect(useCase.execute({ patientId: 'p1', amount: 400, dueDate: new Date(), sessionIds: ['s1'] })).rejects.toMatchObject({
      status: 409,
      response: { code: 'SESSION_OF_ANOTHER_PATIENT' },
    });
    expect(repo.createWithSessions).not.toHaveBeenCalled();
  });

  it('a cobrança nova nasce só por createWithSessions (nunca por save), dentro da unidade de trabalho', async () => {
    const repo = billingRepo();
    let insideUnitOfWork = false;
    repo.createWithSessions.mockImplementation(async () => {
      expect(insideUnitOfWork).toBe(true);
    });
    const uow = {
      run: async <T>(work: () => Promise<T>) => {
        insideUnitOfWork = true;
        try {
          return await work();
        } finally {
          insideUnitOfWork = false;
        }
      },
    };
    const useCase = new GerarCobrancaUseCase(repo, sessionRepoWith(fakeSession('s1')), auditService(), tenantContext(), patientRepo(), uow);

    await useCase.execute({ patientId: 'p1', amount: 400, dueDate: new Date(), sessionIds: ['s1'] });
    expect(repo.createWithSessions).toHaveBeenCalledOnce();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('falha ao gravar cobrança e vínculos: a sessão não transiciona e nada vai para a auditoria', async () => {
    const repo = billingRepo();
    repo.createWithSessions.mockRejectedValue(new Error('vínculo recusado'));
    const sessionRepo = sessionRepoWith(fakeSession('s1'));
    const audit = { recordAll: vi.fn() };
    const useCase = new GerarCobrancaUseCase(repo, sessionRepo, audit as never, tenantContext(), patientRepo(), unitOfWork());

    await expect(useCase.execute({ patientId: 'p1', amount: 400, dueDate: new Date(), sessionIds: ['s1'] })).rejects.toThrow('vínculo recusado');
    expect(sessionRepo.save).not.toHaveBeenCalled();
    expect(audit.recordAll).not.toHaveBeenCalled();
  });
});
