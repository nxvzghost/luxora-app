import { ClinicHoliday } from '@domain/availability/clinic-holiday.entity';

export interface ClinicHolidayRepository {
  /**
   * Retorna os feriados do Tenant que INTERSECTAM `[from, to)`.
   *
   * A regra de negócio sobre o que conta como sobreposição pertence ao
   * domínio (`ClinicHoliday.overlaps()`, PD-001 Fase 2, B2) — esta consulta
   * apenas implementa, em SQL, a mesma semântica de intervalo (`fromDate <
   * to AND toDate > from`), nunca define ou reinterpreta a regra. Se
   * `overlaps()` mudar de semântica no futuro, esta consulta precisa
   * acompanhar, não o contrário.
   *
   * `tenantId` é recebido explicitamente — este repositório não depende de
   * nenhum contexto implícito (RequestContext, CLS, TenantContext) para
   * saber de qual Tenant consultar, ao contrário dos demais repositórios
   * do projeto. Decisão deliberada desta tarefa: mantém o repositório
   * utilizável por chamadores fora do ciclo de vida de uma requisição HTTP
   * (ex: um job de automação futuro), que não têm um TenantContext ativo.
   */
  findByTenantAndRange(tenantId: string, from: Date, to: Date): Promise<ClinicHoliday[]>;
  save(holiday: ClinicHoliday): Promise<void>;
  /**
   * Retorna o feriado pelo `id`, mas só se pertencer a `tenantId` — nunca
   * um `id` de outro Tenant, mesmo que exista (PD-001 Fase 2, B5). Mesma
   * disciplina de `findByTenantAndRange`: `tenantId` explícito, nunca
   * contexto implícito. Filtro de tenant aplicado explicitamente na query,
   * não só confiado à RLS (defesa em profundidade).
   */
  findById(tenantId: string, holidayId: string): Promise<ClinicHoliday | null>;
  /** Remove o feriado — exige `tenantId` explícito pelo mesmo motivo de `findById`. */
  delete(tenantId: string, holidayId: string): Promise<void>;
}

export const CLINIC_HOLIDAY_REPOSITORY = Symbol('CLINIC_HOLIDAY_REPOSITORY');
