import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '@infrastructure/database/prisma.service';

interface LuxoraJwtPayload {
  sub: string; // userId
  tenantId: string;
  role: 'admin' | 'therapist' | 'super_admin';
  type: 'access' | 'refresh';
}

/**
 * AuthService — Módulo 03.
 *
 * Fonte: 02 - CTO/clinicos/docs/02-Arquitetura/06-Autenticacao.md.
 * Decisão de design: ver ADR-0024 (email globalmente único, não por Tenant)
 * — é o que torna login por email+senha possível sem pedir identificador
 * de clínica ao usuário.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
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

    return this.issueTokens(user.id, user.tenantId, user.role as LuxoraJwtPayload['role']);
  }

  async refresh(refreshToken: string) {
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

    return this.issueTokens(payload.sub, payload.tenantId, payload.role);
  }

  /**
   * AD-001 — visibilidade elevada de `private` para `public` (nenhuma
   * mudança de comportamento) para que `ProvisionarPrimeiroAdminUseCase`
   * reaproveite a emissão de tokens exatamente como `login()` já faz, em
   * vez de duplicar a lógica de assinatura de JWT.
   */
  async issueTokens(userId: string, tenantId: string, role: LuxoraJwtPayload['role']) {
    const basePayload = { sub: userId, tenantId, role };

    const accessToken = await this.jwtService.signAsync(
      { ...basePayload, type: 'access' } satisfies LuxoraJwtPayload,
      { expiresIn: process.env.JWT_EXPIRES_IN ?? '15m' },
    );

    const refreshToken = await this.jwtService.signAsync(
      { ...basePayload, type: 'refresh' } satisfies LuxoraJwtPayload,
      { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d' },
    );

    return { accessToken, refreshToken };
  }

  static async hashPassword(plainPassword: string): Promise<string> {
    const SALT_ROUNDS = 12;
    return bcrypt.hash(plainPassword, SALT_ROUNDS);
  }
}
