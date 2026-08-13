import { describe, it, expect, vi } from 'vitest';
import { ObterResumoDashboardUseCase } from '@use-cases/dashboard/obter-resumo-dashboard.use-case';
import { PatientRepository } from '@domain-services/patient-ops/patient.repository';
import { BillingRepository } from '@domain-services/financial/billing.repository';

function buildPatientRepositoryMock(overrides: Partial<PatientRepository> = {}): PatientRepository {
  return {
    findById: vi.fn(),
    findAllByTenant: vi.fn(),
    save: vi.fn(),
    findByPhone: vi.fn(),
    countActiveByTenant: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

function buildBillingRepositoryMock(overrides: Partial<BillingRepository> = {}): BillingRepository {
  return {
    findById: vi.fn(),
    findAllByTenant: vi.fn(),
    save: vi.fn(),
    linkSessions: vi.fn(),
    findOverdueByTenant: vi.fn(),
    countLinkedSessions: vi.fn(),
    findSessionIdsByBillingId: vi.fn(),
    countOverdueByTenant: vi.fn().mockResolvedValue(0),
    sumPendingByTenant: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

describe('ObterResumoDashboardUseCase', () => {
  it('chama countActiveByTenant, countOverdueByTenant e sumPendingByTenant', async () => {
    const patientRepository = buildPatientRepositoryMock();
    const billingRepository = buildBillingRepositoryMock();
    const useCase = new ObterResumoDashboardUseCase(patientRepository, billingRepository);

    await useCase.execute();

    expect(patientRepository.countActiveByTenant).toHaveBeenCalledTimes(1);
    expect(billingRepository.countOverdueByTenant).toHaveBeenCalledTimes(1);
    expect(billingRepository.sumPendingByTenant).toHaveBeenCalledTimes(1);
  });

  it('retorna exatamente { activePatients, overdueBillings, totalPending } com os valores dos repositórios', async () => {
    const patientRepository = buildPatientRepositoryMock({ countActiveByTenant: vi.fn().mockResolvedValue(7) });
    const billingRepository = buildBillingRepositoryMock({
      countOverdueByTenant: vi.fn().mockResolvedValue(3),
      sumPendingByTenant: vi.fn().mockResolvedValue(1600),
    });
    const useCase = new ObterResumoDashboardUseCase(patientRepository, billingRepository);

    const result = await useCase.execute();

    expect(result).toEqual({ activePatients: 7, overdueBillings: 3, totalPending: 1600 });
  });

  it('executa as três agregações em paralelo (Promise.all), não sequencialmente', async () => {
    const order: string[] = [];
    const patientRepository = buildPatientRepositoryMock({
      countActiveByTenant: vi.fn().mockImplementation(async () => {
        order.push('patients-start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('patients-end');
        return 1;
      }),
    });
    const billingRepository = buildBillingRepositoryMock({
      countOverdueByTenant: vi.fn().mockImplementation(async () => {
        order.push('overdue-start');
        return 2;
      }),
      sumPendingByTenant: vi.fn().mockImplementation(async () => {
        order.push('pending-start');
        return 3;
      }),
    });
    const useCase = new ObterResumoDashboardUseCase(patientRepository, billingRepository);

    await useCase.execute();

    // Se as chamadas fossem sequenciais, 'overdue-start'/'pending-start' só
    // apareceriam depois de 'patients-end'. Em paralelo (Promise.all), ambas
    // disparam antes da mais lenta terminar.
    const patientsEndIndex = order.indexOf('patients-end');
    expect(order.indexOf('overdue-start')).toBeLessThan(patientsEndIndex);
    expect(order.indexOf('pending-start')).toBeLessThan(patientsEndIndex);
  });
});
