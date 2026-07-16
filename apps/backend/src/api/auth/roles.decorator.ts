import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

export type LuxoraRole = 'admin' | 'therapist' | 'super_admin';

/**
 * @Roles — restringe um endpoint a perfis específicos.
 * Fonte: 02 - CTO/clinicos/docs/02-Arquitetura/06-Autenticacao.md.
 *
 * Uso: @Roles('admin') em um Controller/handler. Aplicado em conjunto com
 * RolesGuard, que lê o role já extraído do JWT por JwtAuthGuard
 * (request.userRole) — nunca confia em role vindo de outro lugar.
 */
export const Roles = (...roles: LuxoraRole[]) => SetMetadata(ROLES_KEY, roles);
