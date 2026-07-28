import { IsEmail, IsIn, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { AssignableUserRole } from '@domain/user/user.entity';

/**
 * `role` restrito a `admin`/`therapist` em TODOS os DTOs deste recurso —
 * nunca `super_admin` (bypassa RBAC de clínica incondicionalmente, ver
 * RolesGuard). Camada de defesa nº 1 (validação de entrada); a entidade
 * `User` (camada nº 2) repete a mesma restrição como invariante de domínio,
 * nunca confiando só na validação do DTO.
 */
const ASSIGNABLE_ROLES: AssignableUserRole[] = ['admin', 'therapist'];

export class BootstrapAdminDto {
  @IsUUID()
  tenantId!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsIn(ASSIGNABLE_ROLES)
  role!: AssignableUserRole;

  @IsOptional()
  @IsUUID()
  therapistId?: string;
}

export class UpdateUserDto {
  @IsIn(ASSIGNABLE_ROLES)
  role!: AssignableUserRole;

  @IsOptional()
  @IsUUID()
  therapistId?: string;
}
