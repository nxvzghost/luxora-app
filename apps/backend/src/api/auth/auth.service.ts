import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';

type LuxoraRole = 'admin' | 'therapist' | 'super_admin';

interface LuxoraJwtPayload {
  sub: string; // userId
  tenantId: string;
  role: LuxoraRole;
  type: 'access' | 'refresh';
  /** Só em refresh tokens — `User.tokenVersion` no momento da emissão (ADR-0056). */
  tv?: number;
  /** Só em refresh tokens — início da sessão (login), em segundos desde a época; preservado a cada refresh (ADR-0056). */
  sst?: number;
}

/** Refresh token já verificado: assinatura, tipo e formato das claims de sessão. */
type VerifiedRefreshPayload = LuxoraJwtPayload & { type: 'refresh'; tv: number; sst: number };

interface SessionClaims {
  tokenVersion: number;
  sessionStartedAt: number;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_SESSION_MAX_AGE_DAYS = 30;
const SECONDS_PER_DAY = 86_400;

/**
 * AuthService — Módulo 03.
 *
 * Fonte: 02 - CTO/clinicos/docs/02-Arquitetura/06-Autenticacao.md.
 * Decisão de design: ver ADR-0024 (email globalmente único, não por Tenant)
 * — é o que torna login por email+senha possível sem pedir identificador
 * de clínica ao usuário.
 *
 * ADR-0056 — sessão revogável. O access token continua stateless e de curta
 * duração. O refresh token deixou de ser aceito só pela assinatura: cada
 * renovação consulta o usuário no banco e exige que ele exista, esteja
 * ativo e que `tokenVersion` do token ainda seja o vigente.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly clientProvider: PrismaClientProvider,
  ) {}

  async login(email: string, password: string) {
    // Login é o ÚNICO ponto do sistema que consulta User sem TenantContext
    // já estabelecido — por definição, não sabemos o tenant antes de achar
    // o usuário pelo email globalmente único (ADR-0024). forAuthLookup() é
    // a única via permitida para isso — ver prisma/rls/enable-rls.sql.
    const user = await this.prisma.forAuthLookup((tx) =>
      tx.user.findUnique({ where: { email }, include: { therapist: true } }),
    );

    if (!user || user.deletedAt) {
      throw new UnauthorizedException('Credenciais inválidas.');
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Credenciais inválidas.');
    }

    return this.issueTokens(user.id, user.tenantId, user.role as LuxoraRole, {
      tokenVersion: user.tokenVersion,
      sessionStartedAt: AuthService.nowInSeconds(),
    });
  }

  /**
   * ADR-0056 — renova a sessão só se ela ainda for válida no servidor.
   *
   * Antes, bastava a assinatura do refresh token: um usuário desativado
   * continuava renovando por até 7 dias, o papel (`role`) era copiado do
   * token antigo para sempre e não havia como revogar nada. Agora o usuário
   * é relido do banco a cada renovação — dentro de uma transação escopada ao
   * Tenant do próprio token, então a RLS garante que o usuário pertence a
   * esse Tenant — e o novo par de tokens sai com o papel atual.
   */
  async refresh(refreshToken: string) {
    const payload = await this.verifyRefreshToken(refreshToken);

    if (AuthService.nowInSeconds() - payload.sst > AuthService.sessionMaxAgeSeconds()) {
      throw new UnauthorizedException('Sessão expirada. Faça login novamente.');
    }

    const user = await this.withVerifiedTenant(payload.tenantId, (tx) =>
      tx.user.findUnique({ where: { id: payload.sub } }),
    );

    if (!user || user.deletedAt || user.tokenVersion !== payload.tv) {
      throw new UnauthorizedException('Sessão encerrada ou revogada. Faça login novamente.');
    }

    return this.issueTokens(user.id, user.tenantId, user.role as LuxoraRole, {
      tokenVersion: user.tokenVersion,
      sessionStartedAt: payload.sst,
    });
  }

  /**
   * ADR-0056 — logout com efeito real no servidor: incrementa
   * `User.tokenVersion`, invalidando todos os refresh tokens emitidos antes
   * (em qualquer dispositivo). O access token em uso continua válido até
   * expirar (15 minutos por padrão) — é o custo aceito de mantê-lo stateless.
   *
   * Idempotente e silencioso: um token inválido, expirado ou já revogado não
   * tem nada a revogar e não é um erro para quem está saindo. O incremento é
   * condicional à versão do próprio token, então repetir a chamada (ou duas
   * chamadas simultâneas) nunca incrementa duas vezes.
   */
  async logout(refreshToken: string): Promise<void> {
    let payload: VerifiedRefreshPayload;
    try {
      payload = await this.verifyRefreshToken(refreshToken);
    } catch {
      return;
    }

    await this.withVerifiedTenant(payload.tenantId, (tx) =>
      tx.user.updateMany({
        where: { id: payload.sub, tokenVersion: payload.tv },
        data: { tokenVersion: { increment: 1 } },
      }),
    );
  }

  /**
   * AD-001 — visibilidade elevada de `private` para `public` (nenhuma
   * mudança de comportamento) para que `ProvisionarPrimeiroAdminUseCase`
   * reaproveite a emissão de tokens exatamente como `login()` já faz, em
   * vez de duplicar a lógica de assinatura de JWT.
   *
   * ADR-0056 — `session` é opcional só para esse chamador: um usuário recém
   * criado nasce com `tokenVersion` 0 e a sessão começa agora.
   */
  async issueTokens(userId: string, tenantId: string, role: LuxoraRole, session?: SessionClaims) {
    const basePayload = { sub: userId, tenantId, role };
    const { tokenVersion, sessionStartedAt } = session ?? {
      tokenVersion: 0,
      sessionStartedAt: AuthService.nowInSeconds(),
    };

    const accessToken = await this.jwtService.signAsync(
      { ...basePayload, type: 'access' } satisfies LuxoraJwtPayload,
      { expiresIn: process.env.JWT_EXPIRES_IN ?? '15m' },
    );

    const refreshToken = await this.jwtService.signAsync(
      { ...basePayload, type: 'refresh', tv: tokenVersion, sst: sessionStartedAt } satisfies LuxoraJwtPayload,
      { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d' },
    );

    return { accessToken, refreshToken };
  }

  static async hashPassword(plainPassword: string): Promise<string> {
    const SALT_ROUNDS = 12;
    return bcrypt.hash(plainPassword, SALT_ROUNDS);
  }

  private async verifyRefreshToken(refreshToken: string): Promise<VerifiedRefreshPayload> {
    let payload: LuxoraJwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<LuxoraJwtPayload>(refreshToken);
    } catch {
      throw new UnauthorizedException('Refresh token inválido ou expirado.');
    }

    if (payload.type !== 'refresh') {
      // Impede que um access token seja usado no endpoint de refresh —
      // erro de implementação comum se não validado explicitamente.
      throw new UnauthorizedException('Token fornecido não é um refresh token.');
    }

    // Refresh tokens emitidos antes da ADR-0056 não têm `tv`/`sst` — não há
    // como saber se foram revogados, então exigem um novo login.
    const hasSessionClaims = Number.isInteger(payload.tv) && Number.isInteger(payload.sst);
    if (!hasSessionClaims || !UUID_REGEX.test(payload.tenantId ?? '') || !UUID_REGEX.test(payload.sub ?? '')) {
      throw new UnauthorizedException('Refresh token inválido ou expirado.');
    }

    return payload as VerifiedRefreshPayload;
  }

  /**
   * Transação escopada ao Tenant de um refresh token cuja assinatura JÁ foi
   * verificada — mesma origem de confiança do JwtAuthGuard (o tenantId vem
   * de um JWT assinado por nós, nunca de body/header/query). Não usa
   * `PrismaService.forTenant()` porque refresh e logout rodam antes de
   * existir `TenantContext`, e não usa `forAuthLookup()` porque aqui o
   * Tenant é conhecido: o bypass de RLS não é necessário nem desejável.
   * Mesmo padrão explícito de `PrismaUserRepository.withTenant()`.
   */
  private async withVerifiedTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return this.clientProvider.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx as PrismaClient);
    });
  }

  private static nowInSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  /**
   * Duração máxima de uma sessão desde o login, independente de quantas
   * renovações houve — sem isto, cada refresh emitiria um refresh token novo
   * de 7 dias indefinidamente. `06-Autenticacao.md`: "Sessões deverão
   * possuir tempo máximo configurável".
   */
  private static sessionMaxAgeSeconds(): number {
    const days = Number(process.env.JWT_SESSION_MAX_AGE_DAYS ?? DEFAULT_SESSION_MAX_AGE_DAYS);
    return (Number.isFinite(days) && days > 0 ? days : DEFAULT_SESSION_MAX_AGE_DAYS) * SECONDS_PER_DAY;
  }
}
