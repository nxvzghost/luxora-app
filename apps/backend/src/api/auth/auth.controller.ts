import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { SkipSubscriptionCheck } from '../subscription/skip-subscription-check.decorator';

/**
 * AuthController — os únicos 3 endpoints da API que não exigem JwtAuthGuard
 * (login e refresh são o próprio mecanismo de obter o token; logout é
 * stateless neste MVP — ver nota abaixo).
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
  async logout() {
    // Logout é stateless neste MVP: JWT de curta duração (15min) e o cliente
    // descarta o token localmente. Não há blacklist de token — se isso se
    // tornar necessário (ex: revogação imediata exigida por incidente de
    // segurança), precisa de um store adicional (Redis), fora de escopo
    // deste módulo. Registrar como possível dívida futura, não como bug.
    return;
  }
}
