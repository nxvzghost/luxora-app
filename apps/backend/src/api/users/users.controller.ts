import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard, SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { SkipSubscriptionCheck } from '../subscription/skip-subscription-check.decorator';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { BootstrapAdminDto, CreateUserDto, UpdateUserDto } from './dto/user.dto';
import {
  ProvisionarPrimeiroAdminUseCase,
  CriarUsuarioUseCase,
  ListarUsuariosUseCase,
  AtualizarUsuarioUseCase,
  DesativarUsuarioUseCase,
  ReativarUsuarioUseCase,
} from '@use-cases/user/gerenciar-usuarios.use-case';
import { User } from '@domain/user/user.entity';

/**
 * UsersController — AD-001 (Epic 5). Política de papel por rota:
 * docs/02-Arquitetura/16-Politica-RBAC.md.
 *
 * `bootstrap-admin` é a ÚNICA rota deste Controller sem `JwtAuthGuard` —
 * decisão arquitetural explícita (Opção A da descoberta da AD-001):
 * endpoint público, mas gated pela regra de negócio "Tenant com zero
 * usuários" (garantida atomicamente em `PrismaUserRepository.
 * provisionFirstAdmin()`, nunca neste Controller), protegido por rate
 * limit próprio (throttler nomeado 'users-bootstrap-admin', registrado em
 * `AuthModule` com `isGlobal: true` — ver comentário em auth.module.ts
 * sobre por que NÃO há um segundo ThrottlerModule.forRootAsync() aqui).
 * @SkipThrottle({ 'auth-login': true }) exclui explicitamente o limite de
 * login desta rota, e o inverso em AuthController.login().
 */
@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly provisionarPrimeiroAdmin: ProvisionarPrimeiroAdminUseCase,
    private readonly criarUsuario: CriarUsuarioUseCase,
    private readonly listarUsuarios: ListarUsuariosUseCase,
    private readonly atualizarUsuario: AtualizarUsuarioUseCase,
    private readonly desativarUsuario: DesativarUsuarioUseCase,
    private readonly reativarUsuario: ReativarUsuarioUseCase,
  ) {}

  @Post('bootstrap-admin')
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ 'auth-login': true })
  @SkipSubscriptionCheck()
  @HttpCode(HttpStatus.CREATED)
  async bootstrapAdmin(@Body() dto: BootstrapAdminDto) {
    return this.provisionarPrimeiroAdmin.execute(dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard, SubscriptionAccessGuard)
  @ApiBearerAuth()
  async list() {
    const users = await this.listarUsuarios.execute();
    return { data: users.map(this.toResponse) };
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard, SubscriptionAccessGuard)
  @ApiBearerAuth()
  @Roles('admin')
  async create(@Body() dto: CreateUserDto) {
    const user = await this.criarUsuario.execute(dto);
    return this.toResponse(user);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard, SubscriptionAccessGuard)
  @ApiBearerAuth()
  @Roles('admin')
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    const user = await this.atualizarUsuario.execute({ id, ...dto });
    return this.toResponse(user);
  }

  @Post(':id/deactivate')
  @UseGuards(JwtAuthGuard, RolesGuard, SubscriptionAccessGuard)
  @ApiBearerAuth()
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async deactivate(@Param('id') id: string) {
    const user = await this.desativarUsuario.execute(id);
    return this.toResponse(user);
  }

  @Post(':id/reactivate')
  @UseGuards(JwtAuthGuard, RolesGuard, SubscriptionAccessGuard)
  @ApiBearerAuth()
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async reactivate(@Param('id') id: string) {
    const user = await this.reativarUsuario.execute(id);
    return this.toResponse(user);
  }

  /** Nunca inclui `passwordHash` — só os campos já expostos por outros recursos análogos (Therapist, Patient). */
  private toResponse(user: User) {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      therapistId: user.therapistId ?? null,
      isActive: user.isActive,
    };
  }
}
