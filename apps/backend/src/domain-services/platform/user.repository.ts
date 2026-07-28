import { User } from '@domain/user/user.entity';

/**
 * UserRepository — AD-001.
 *
 * `tenantId` explícito em todo método, mesmo padrão de `ClinicHolidayRepository`
 * (nunca contexto implícito) — necessário porque `provisionFirstAdmin()`
 * roda ANTES de qualquer `TenantContext` existir (não há usuário
 * autenticado ainda), e manter um único padrão de acesso para todo o
 * repositório evita duas formas diferentes de fazer a mesma coisa dentro da
 * mesma classe.
 */
export interface UserRepository {
  findById(tenantId: string, userId: string): Promise<User | null>;
  findAllByTenant(tenantId: string): Promise<User[]>;
  save(user: User): Promise<void>;
  /**
   * Cria o primeiro usuário (admin) de um Tenant que ainda não tem nenhum —
   * operação atômica e de uso único por Tenant (AD-001). Lança erro
   * (mapeado para 409 pelo Caso de Uso) se o Tenant não existir ou já
   * tiver ao menos 1 usuário — inclusive sob concorrência real (duas
   * chamadas simultâneas para o mesmo Tenant nunca resultam em 2 admins).
   */
  provisionFirstAdmin(tenantId: string, user: User): Promise<void>;
}

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');
