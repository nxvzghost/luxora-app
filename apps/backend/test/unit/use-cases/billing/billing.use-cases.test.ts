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

function fakeSession(id: string) {
  return Session.reconstitute({
    id,
    tenantId: TENANT_ID,
    appointmentId: `apt-${id}`,
    patientId: 'p1',
    therapistId: 't1',
    state: 'Realizada',
  });
}

/** AD-009 — sessionRepo mock que serve findById a partir dos ids fornecidos. */
function sessionRepoMock(sessionIds: string[]) {
  const sessions = new Map(sessionIds.map((id) => [id, fakeSession(id)]));
  return {
    findById: vi.fn((id: string) => Promise.resolve(sessions.get(id) ?? null)),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

describe('GerarCobrancaUseCase — cobrança agregada (Testes Críticos #4-7)', () => {
  it('rejeita cobrança sem nenhuma sessão vinculada', async () => {
    const repo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn(), linkSessions: vi.fn(), findSessionIdsByBillingId: vi.fn() };
    const useCase = new GerarCobrancaUseCase(repo, sessionRepoMock([]), auditService(), tenantContext());
    await expect(useCase.execute({ patientId: 'p1', amount: 400, dueDate: new Date(), sessionIds: [] })).rejects.toThrow(/ao menos uma sessão/);
  });

  it('cria cobrança por sessão avulsa (1 sessionId — caso N=1)', async () => {
    const repo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn().mockResolvedValue(undefined), linkSessions: vi.fn().mockResolvedValue(undefined), findSessionIdsByBillingId: vi.fn() };
    const useCase = new GerarCobrancaUseCase(repo, sessionRepoMock(['s1']), auditService(), tenantContext());
    await useCase.execute({ patientId: 'p1', amount: 400, dueDate: new Date(), sessionIds: ['s1'] });
    expect(repo.linkSessions).toHaveBeenCalledWith(expect.any(String), ['s1']);
  });

  it('cria cobrança agregada (N sessionIds — semanal/mensal)', async () => {
    const repo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn().mockResolvedValue(undefined), linkSessions: vi.fn().mockResolvedValue(undefined), findSessionIdsByBillingId: vi.fn() };
    const useCase = new GerarCobrancaUseCase(repo, sessionRepoMock(['s1', 's2', 's3', 's4']), auditService(), tenantContext());
    await useCase.execute({ patientId: 'p1', amount: 1600, dueDate: new Date(), sessionIds: ['s1', 's2', 's3', 's4'] });
    expect(repo.linkSessions).toHaveBeenCalledWith(expect.any(String), ['s1', 's2', 's3', 's4']);
  });

  it('nasce no estado Criada', async () => {
    const repo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn().mockResolvedValue(undefined), linkSessions: vi.fn().mockResolvedValue(undefined), findSessionIdsByBillingId: vi.fn() };
    const useCase = new GerarCobrancaUseCase(repo, sessionRepoMock(['s1']), auditService(), tenantContext());
    const billing = await useCase.execute({ patientId: 'p1', amount: 400, dueDate: new Date(), sessionIds: ['s1'] });
    expect(billing.state).toBe('Criada');
  });

  it('AD-009: transiciona todas as Sessions vinculadas para Faturada, na mesma execução', async () => {
    const repo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn().mockResolvedValue(undefined), linkSessions: vi.fn().mockResolvedValue(undefined), findSessionIdsByBillingId: vi.fn() };
    const sessionRepo = sessionRepoMock(['s1', 's2']);
    const audit = auditService();
    const useCase = new GerarCobrancaUseCase(repo, sessionRepo, audit, tenantContext());

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
    const repo = { findById: vi.fn(), findAllByTenant: vi.fn(), save: vi.fn().mockResolvedValue(undefined), linkSessions: vi.fn().mockResolvedValue(undefined), findSessionIdsByBillingId: vi.fn() };
    const useCase = new GerarCobrancaUseCase(repo, sessionRepoMock([]), auditService(), tenantContext());
    await expect(
      useCase.execute({ patientId: 'p1', amount: 400, dueDate: new Date(), sessionIds: ['s-inexistente'] }),
    ).rejects.toThrow(/não encontrada/);
  });
});

describe('EnviarCobrancaUseCase — Módulo 11 (envio real via fila)', () => {
  function makeUseCase(billing: Billing, patient: unknown, clinic: unknown) {
    const billingRepo = { findById: vi.fn().mockResolvedValue(billing), findAllByTenant: vi.fn(), save: vi.fn().mockResolvedValue(undefined), linkSessions: vi.fn(), findOverdueByTenant: vi.fn(), countLinkedSessions: vi.fn().mockResolvedValue(1), findSessionIdsByBillingId: vi.fn() };
    const patientRepo = { findById: vi.fn().mockResolvedValue(patient), findAllByTenant: vi.fn(), save: vi.fn() };
    const clinicRepo = { findByTenantId: vi.fn().mockResolvedValue(clinic), save: vi.fn() };
    const messageQueue = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const useCase = new EnviarCobrancaUseCase(billingRepo, patientRepo, clinicRepo, new ConsultarCobrancaUseCase(billingRepo), messageQueue, auditService());
    return { useCase, messageQueue, billingRepo };
  }

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
