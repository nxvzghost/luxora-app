import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { User, AssignableUserRole } from '@domain/user/user.entity';
import { USER_REPOSITORY, UserRepository } from '@domain-services/platform/user.repository';
import { THERAPIST_REPOSITORY, TherapistRepository } from '@domain-services/platform/therapist.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { TenantContext } from '@shared/tenant-context';
import { AuthService } from '@api/auth/auth.service';

/**
 * ProvisionarPrimeiroAdminUseCase — AD-001, bootstrap público (Opção A).
 *
 * Roda ANTES de qualquer TenantContext existir (nenhum usuário autenticado
 * ainda) — nunca chama `tenantContext.set(...)` (só JwtAuthGuard/
 * TenantApiKeyGuard podem fazer isso). A garantia de "nunca 2 admins para o
 * mesmo Tenant" vive inteiramente em `UserRepository.provisionFirstAdmin()`
 * (lock de linha no Tenant, ver PrismaUserRepository) — este Use Case nunca
 * faz a checagem de contagem ele mesmo, para não duplicar (e divergir de)
 * a garantia atômica do repositório.
 *
 * ACHADO REAL: este Use Case NÃO chama `AuditService.recordAll()` (diferente
 * de todos os outros desta AD) — `PrismaAuditLogRepository.record()` usa
 * `PrismaService.forTenant()` incondicionalmente, que exige `TenantContext`
 * já inicializado (nunca está, neste fluxo). O evento de auditoria é escrito
 * por `PrismaUserRepository.provisionFirstAdmin()` diretamente, na mesma
 * transação da criação do usuário — ver a nota completa lá.
 */
export interface ProvisionarPrimeiroAdminInput {
  tenantId: string;
  email: string;
  password: string;
}

@Injectable()
export class ProvisionarPrimeiroAdminUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly repo: UserRepository,
    private readonly authService: AuthService,
  ) {}

  async execute(input: ProvisionarPrimeiroAdminInput): Promise<{ accessToken: string; refreshToken: string }> {
    if (input.password.length < 8) {
      throw new BadRequestException('Senha deve ter ao menos 8 caracteres.');
    }

    const passwordHash = await AuthService.hashPassword(input.password);
    const user = User.create({
      id: randomUUID(),
      tenantId: input.tenantId,
      email: input.email,
      passwordHash,
      role: 'admin',
    });
    user.markCreated();

    // Lança NotFoundException (Tenant inexistente) ou ConflictException
    // (Tenant já provisionado) — nunca cria um segundo admin, mesmo sob
    // concorrência real (ver PrismaUserRepository.provisionFirstAdmin()).
    // O evento de auditoria enfileirado por markCreated() é consumido e
    // gravado DENTRO deste método (ver nota lá) — nunca aqui.
    await this.repo.provisionFirstAdmin(input.tenantId, user);

    return this.authService.issueTokens(user.id, user.tenantId, 'admin');
  }
}

export interface CriarUsuarioInput {
  email: string;
  password: string;
  role: AssignableUserRole;
  therapistId?: string;
}

@Injectable()
export class CriarUsuarioUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly repo: UserRepository,
    @Inject(THERAPIST_REPOSITORY) private readonly therapistRepo: TherapistRepository,
    private readonly tenantContext: TenantContext,
    private readonly auditService: AuditService,
  ) {}

  async execute(input: CriarUsuarioInput): Promise<User> {
    if (input.password.length < 8) {
      throw new BadRequestException('Senha deve ter ao menos 8 caracteres.');
    }

    if (input.role === 'therapist') {
      if (!input.therapistId) {
        throw new BadRequestException('therapistId é obrigatório para usuários com papel "therapist".');
      }
      const therapist = await this.therapistRepo.findById(input.therapistId);
      if (!therapist) {
        throw new NotFoundException('Terapeuta não encontrado.');
      }
    }

    const passwordHash = await AuthService.hashPassword(input.password);
    const user = User.create({
      id: randomUUID(),
      tenantId: this.tenantContext.tenantId,
      email: input.email,
      passwordHash,
      role: input.role,
      therapistId: input.role === 'therapist' ? input.therapistId : undefined,
    });
    user.markCreated();

    await this.repo.save(user);
    await this.auditService.recordAll(user.pullDomainEvents());
    return user;
  }
}

@Injectable()
export class ListarUsuariosUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly repo: UserRepository,
    private readonly tenantContext: TenantContext,
  ) {}

  async execute(): Promise<User[]> {
    return this.repo.findAllByTenant(this.tenantContext.tenantId);
  }
}

export interface AtualizarUsuarioInput {
  id: string;
  role: AssignableUserRole;
  therapistId?: string;
}

@Injectable()
export class AtualizarUsuarioUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly repo: UserRepository,
    @Inject(THERAPIST_REPOSITORY) private readonly therapistRepo: TherapistRepository,
    private readonly tenantContext: TenantContext,
    private readonly auditService: AuditService,
  ) {}

  async execute(input: AtualizarUsuarioInput): Promise<User> {
    const user = await this.repo.findById(this.tenantContext.tenantId, input.id);
    if (!user) {
      throw new NotFoundException('Usuário não encontrado.');
    }

    if (input.role === 'therapist') {
      if (!input.therapistId) {
        throw new BadRequestException('therapistId é obrigatório para usuários com papel "therapist".');
      }
      const therapist = await this.therapistRepo.findById(input.therapistId);
      if (!therapist) {
        throw new NotFoundException('Terapeuta não encontrado.');
      }
    }

    user.changeRole(input.role, input.role === 'therapist' ? input.therapistId : undefined);
    await this.repo.save(user);
    await this.auditService.recordAll(user.pullDomainEvents());
    return user;
  }
}

@Injectable()
export class DesativarUsuarioUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly repo: UserRepository,
    private readonly tenantContext: TenantContext,
    private readonly auditService: AuditService,
  ) {}

  async execute(id: string): Promise<User> {
    const user = await this.repo.findById(this.tenantContext.tenantId, id);
    if (!user) {
      throw new NotFoundException('Usuário não encontrado.');
    }
    user.deactivate();
    await this.repo.save(user);
    await this.auditService.recordAll(user.pullDomainEvents());
    return user;
  }
}

@Injectable()
export class ReativarUsuarioUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly repo: UserRepository,
    private readonly tenantContext: TenantContext,
    private readonly auditService: AuditService,
  ) {}

  async execute(id: string): Promise<User> {
    const user = await this.repo.findById(this.tenantContext.tenantId, id);
    if (!user) {
      throw new NotFoundException('Usuário não encontrado.');
    }
    user.reactivate();
    await this.repo.save(user);
    await this.auditService.recordAll(user.pullDomainEvents());
    return user;
  }
}
