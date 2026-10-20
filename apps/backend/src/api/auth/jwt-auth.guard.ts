import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TenantContext } from '@shared/tenant-context';
import { SessionStateCache } from '@infrastructure/auth/session-state.cache';

interface LuxoraJwtPayload {
  sub: string; // userId
  tenantId: string;
  role: 'admin' | 'therapist' | 'super_admin';
  type?: 'access' | 'refresh';
  /** Versão de sessão do usuário na emissão (ADR-0056; no access token desde a ADR-0067). */
  tv?: number;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * JwtAuthGuard — um dos dois pontos de entrada autorizados do tenantId no
 * sistema (o outro é TenantApiKeyGuard, PD-003, Business/Enterprise — API
 * key por Tenant em vez de login de usuário). Nenhum outro guard deve
 * chamar `tenantContext.set(...)`.
 *
 * Fonte de verdade: docs/02-Arquitetura/06-Autenticacao.md, docs/04-API/00-Principios-da-API.md.
 *
 * Regra: tenantId e userId SEMPRE vêm do payload do JWT validado, nunca de
 * header custom, query string ou body — isso é o que impede um usuário
 * autenticado no Tenant A de acessar dado do Tenant B trocando um parâmetro.
 *
 * ADR-0067 (A-17) — revogação imediata. O access token só vale enquanto a
 * versão de sessão e o papel que ele carrega forem os vigentes do usuário,
 * e o usuário estiver ativo (`SessionStateCache`: Redis, com o banco como
 * reserva). Sair, desativar ou trocar o papel recusa na hora o token já
 * emitido; antes, ele valia até expirar (15 minutos). Na troca de papel o
 * refresh token continua válido: o painel renova e recebe o papel novo.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly tenantContext: TenantContext,
    private readonly sessionState: SessionStateCache,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token ausente.');
    }

    const token = authHeader.slice('Bearer '.length);

    let payload: LuxoraJwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<LuxoraJwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Token inválido ou expirado.');
    }

    // ADR-0056 — só um access token autentica uma requisição. Sem esta
    // checagem, um refresh token (7 dias) era aceito como Bearer em qualquer
    // rota protegida, anulando a curta duração do access token.
    if (payload.type !== 'access') {
      throw new UnauthorizedException('Token inválido ou expirado.');
    }

    // ADR-0067 — access token emitido antes desta ADR não traz a versão de
    // sessão: recusado, o painel renova e recebe um token novo.
    if (!Number.isInteger(payload.tv) || !UUID_REGEX.test(payload.tenantId ?? '') || !UUID_REGEX.test(payload.sub ?? '')) {
      throw new UnauthorizedException('Token inválido ou expirado.');
    }

    const session = await this.sessionState.current(payload.tenantId, payload.sub);
    if (!session || session.tokenVersion !== payload.tv || session.role !== payload.role) {
      throw new UnauthorizedException('Sessão encerrada ou alterada. Faça login novamente.');
    }

    // Único lugar do sistema onde tenantId é atribuído — nunca em outro ponto do código.
    this.tenantContext.set(payload.tenantId, payload.sub);
    request.userRole = payload.role;

    return true;
  }
}
