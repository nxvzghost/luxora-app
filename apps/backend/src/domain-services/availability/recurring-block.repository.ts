import { RecurringBlock } from '@domain/availability/recurring-block.entity';

export interface RecurringBlockRepository {
  save(block: RecurringBlock): Promise<void>;
  /**
   * Retorna o bloco pelo `id`, mas só se pertencer a `tenantId` — nunca um
   * `id` de outro Tenant, mesmo que exista (mesma disciplina de
   * `ClinicHolidayRepository.findById`). `tenantId` explícito, nunca
   * contexto implícito — mesma decisão de `ClinicHolidayRepository` (PD-001
   * Fase 2, B3): mantém o Repository utilizável por chamadores fora do
   * ciclo de vida de uma requisição HTTP (ex: o futuro job de
   * materialização, C-tarefa posterior).
   */
  findById(tenantId: string, blockId: string): Promise<RecurringBlock | null>;
  /**
   * PD-001 Fase 2, C4.2 — lista os blocos de um Terapeuta dentro do Tenant.
   * `tenantId` explícito, mesma disciplina de `findById` — nunca contexto
   * implícito. Filtro por `tenantId` E `therapistId`, nunca só um dos dois:
   * um `therapistId` só é suficiente para identificar unicamente um
   * Terapeuta DENTRO de um Tenant (nada impede, em tese, colisão de id
   * entre Tenants diferentes se a geração de UUID um dia deixasse de ser
   * global — defesa em profundidade, mesmo princípio já aplicado em todo o
   * projeto).
   */
  findByTenantAndTherapist(tenantId: string, therapistId: string): Promise<RecurringBlock[]>;
}

export const RECURRING_BLOCK_REPOSITORY = Symbol('RECURRING_BLOCK_REPOSITORY');
