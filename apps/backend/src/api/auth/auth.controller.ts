import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard, SkipThrottle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { SkipSubscriptionCheck } from '../subscription/skip-subscription-check.decorator';

/**
 * AuthController — os únicos 3 endpoints da API que não exigem JwtAuthGuard
 * (login e refresh são o próprio mecanismo de obter o token; logout recebe
 * o refresh token no corpo, porque é ele que precisa ser revogado e o
 * access token pode já ter expirado — ver ADR-0056).
 *
 * @SkipSubscriptionCheck() explícito (Módulo 17) — login nunca pode ser
 * bloqueado por assinatura inativa, senão uma clínica PastDue nem
 * conseguiria entrar para ver a cobrança pendente.
 *
 * Fonte: 02 - CTO/clinicos/docs/04-API/01-Contratos-REST.md, seção Auth.
 */
@ApiTags('auth')
@SkipSubscriptionCheck()
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * AD-006 — ThrottlerGuard aplicado só nesta rota, nunca globalmente
   * (decisão de escopo da AD). Chave padrão do @nestjs/throttler (IP do
   * request, via req.ip — decisão explícita: não compor com email, ver
   * ADR da AD-006). Limite/janela vêm do ThrottlerModule registrado em
   * AuthModule (AUTH_THROTTLE_LIMIT/AUTH_THROTTLE_TTL_MS). Depende de
   * app.set('trust proxy', 1) em main.ts para que req.ip seja o cliente
   * real, não o proxy, atrás do Railway em produção.
   */
  @Post('login')
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ 'users-bootstrap-admin': true })
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() dto: RefreshDto) {
    // ADR-0056 — revoga no servidor todos os refresh tokens do usuário
    // (incrementa User.tokenVersion). Responde 204 mesmo para um token
    // inválido, expirado ou já revogado: não há nada a revogar e quem está
    // saindo não precisa de um erro. O access token em uso segue válido até
    // expirar (15 minutos por padrão) — custo aceito de mantê-lo stateless.
    await this.authService.logout(dto.refreshToken);
  }
}
