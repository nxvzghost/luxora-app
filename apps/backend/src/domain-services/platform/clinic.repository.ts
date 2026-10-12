import { Clinic } from '@domain/clinic/clinic.entity';

export interface ClinicRepository {
  findByTenantId(tenantId: string): Promise<Clinic | null>;
  /** Grava nome, políticas e dados de recebimento. NÃO grava o fuso — ver saveTimeZone(). */
  save(clinic: Clinic): Promise<void>;
  /**
   * AD-039 (ADR-0064) — como findByTenantId(), mas trava a configuração da
   * clínica até o fim da unidade de trabalho em andamento: duas trocas de
   * fuso da mesma clínica acontecem uma depois da outra, e a segunda lê o
   * fuso que a primeira gravou. Só pode ser chamado dentro de uma.
   */
  findByTenantIdForUpdate(tenantId: string): Promise<Clinic | null>;
  /**
   * AD-039 (ADR-0064) — grava o fuso, e só ele. É separado de save() para
   * que nenhuma outra edição da clínica (nome, políticas, PIX), feita a
   * partir de uma leitura anterior, regrave o fuso antigo por cima de uma
   * troca que aconteceu no meio.
   */
  saveTimeZone(clinic: Clinic): Promise<void>;
}

export const CLINIC_REPOSITORY = Symbol('CLINIC_REPOSITORY');
