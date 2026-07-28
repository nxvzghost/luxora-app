import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { UsersController } from './users.controller';
import {
  ProvisionarPrimeiroAdminUseCase,
  CriarUsuarioUseCase,
  ListarUsuariosUseCase,
  AtualizarUsuarioUseCase,
  DesativarUsuarioUseCase,
  ReativarUsuarioUseCase,
} from '@use-cases/user/gerenciar-usuarios.use-case';
import { USER_REPOSITORY } from '@domain-services/platform/user.repository';
import { PrismaUserRepository } from '@infrastructure/database/repositories/prisma-user.repository';
import { THERAPIST_REPOSITORY } from '@domain-services/platform/therapist.repository';
import { PrismaTherapistRepository } from '@infrastructure/database/repositories/prisma-therapist.repository';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { AuditService } from '@domain-services/platform/audit.service';
import { AUDIT_LOG_REPOSITORY } from '@domain-services/platform/audit-log.repository';
import { PrismaAuditLogRepository } from '@infrastructure/database/repositories/prisma-audit-log.repository';
import { AuthService } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { CLINIC_SUBSCRIPTION_REPOSITORY } from '@domain-services/subscription/clinic-subscription.repository';
import { PrismaClinicSubscriptionRepository } from '@infrastructure/database/repositories/prisma-clinic-subscription.repository';

@Module({
  imports: [
    JwtModule.register({ secret: process.env.JWT_SECRET }),
    // AD-001 — o rate limit de POST /users/bootstrap-admin (throttler
    // nomeado 'users-bootstrap-admin') NÃO é registrado aqui. Um segundo
    // ThrottlerModule.forRootAsync() independente neste módulo, importado
    // na mesma árvore do AppModule que o de AuthModule, causou uma
    // regressão real e confirmada no rate limit de /auth/login (achado
    // durante a implementação desta AD, não hipotético — ver comentário
    // completo em auth.module.ts). O throttler está consolidado em UM
    // único registro global, dentro de AuthModule, com os dois throttlers
    // nomeados ('auth-login', 'users-bootstrap-admin') no mesmo array.
  ],
  controllers: [UsersController],
  providers: [
    ProvisionarPrimeiroAdminUseCase,
    CriarUsuarioUseCase,
    ListarUsuariosUseCase,
    AtualizarUsuarioUseCase,
    DesativarUsuarioUseCase,
    ReativarUsuarioUseCase,
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
    { provide: THERAPIST_REPOSITORY, useClass: PrismaTherapistRepository },
    { provide: CLINIC_SUBSCRIPTION_REPOSITORY, useClass: PrismaClinicSubscriptionRepository },
    { provide: AUDIT_LOG_REPOSITORY, useClass: PrismaAuditLogRepository },
    AuditService,
    AuthService,
    JwtAuthGuard,
    RolesGuard,
    SubscriptionAccessGuard,
    PrismaService,
    PrismaClientProvider,
  ],
})
export class UsersModule {}
