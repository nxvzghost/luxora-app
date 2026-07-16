import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from '@api/auth/auth.service';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

describe('AuthService', () => {
  let jwtServiceMock: { signAsync: ReturnType<typeof vi.fn>; verifyAsync: ReturnType<typeof vi.fn> };
  let prismaMock: { forAuthLookup: ReturnType<typeof vi.fn> };
  let authService: AuthService;

  function mockUserLookup(user: unknown) {
    prismaMock.forAuthLookup.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({ user: { findUnique: vi.fn().mockResolvedValue(user) } }),
    );
  }

  beforeEach(() => {
    jwtServiceMock = {
      signAsync: vi.fn().mockImplementation((payload) => Promise.resolve(`fake-jwt-${payload.type}`)),
      verifyAsync: vi.fn(),
    };
    prismaMock = { forAuthLookup: vi.fn() };
    // @ts-expect-error — mocks propositalmente simplificados para o escopo do teste
    authService = new AuthService(jwtServiceMock, prismaMock);
  });

  describe('login', () => {
    it('rejeita quando o usuário não existe', async () => {
      mockUserLookup(null);
      await expect(authService.login('inexistente@luxora.dev', 'senha123')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejeita quando o usuário está com deletedAt preenchido (soft delete)', async () => {
      mockUserLookup({
        id: USER_ID,
        tenantId: TENANT_ID,
        email: 'ex-usuario@luxora.dev',
        passwordHash: await bcrypt.hash('senha123', 4),
        role: 'admin',
        deletedAt: new Date(),
      });
      await expect(authService.login('ex-usuario@luxora.dev', 'senha123')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejeita senha incorreta', async () => {
      mockUserLookup({
        id: USER_ID,
        tenantId: TENANT_ID,
        email: 'usuario@luxora.dev',
        passwordHash: await bcrypt.hash('senha-correta', 4),
        role: 'admin',
        deletedAt: null,
      });
      await expect(authService.login('usuario@luxora.dev', 'senha-errada')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('retorna accessToken e refreshToken quando as credenciais são válidas', async () => {
      mockUserLookup({
        id: USER_ID,
        tenantId: TENANT_ID,
        email: 'usuario@luxora.dev',
        passwordHash: await bcrypt.hash('senha-correta', 4),
        role: 'admin',
        deletedAt: null,
      });
      const result = await authService.login('usuario@luxora.dev', 'senha-correta');
      expect(result.accessToken).toBe('fake-jwt-access');
      expect(result.refreshToken).toBe('fake-jwt-refresh');
    });

    it('usa forAuthLookup (não forTenant) — único caminho autorizado para consultar User sem tenant conhecido', async () => {
      mockUserLookup({
        id: USER_ID,
        tenantId: TENANT_ID,
        email: 'usuario@luxora.dev',
        passwordHash: await bcrypt.hash('senha-correta', 4),
        role: 'admin',
        deletedAt: null,
      });
      await authService.login('usuario@luxora.dev', 'senha-correta');
      expect(prismaMock.forAuthLookup).toHaveBeenCalledOnce();
    });
  });

  describe('refresh', () => {
    it('rejeita token inválido/expirado', async () => {
      jwtServiceMock.verifyAsync.mockRejectedValue(new Error('expired'));
      await expect(authService.refresh('token-invalido')).rejects.toThrow(UnauthorizedException);
    });

    it('rejeita quando o token fornecido é um access token, não refresh', async () => {
      jwtServiceMock.verifyAsync.mockResolvedValue({
        sub: USER_ID,
        tenantId: TENANT_ID,
        role: 'admin',
        type: 'access',
      });
      await expect(authService.refresh('access-token-usado-errado')).rejects.toThrow(
        /não é um refresh token/,
      );
    });

    it('emite novo par de tokens a partir de um refresh token válido', async () => {
      jwtServiceMock.verifyAsync.mockResolvedValue({
        sub: USER_ID,
        tenantId: TENANT_ID,
        role: 'therapist',
        type: 'refresh',
      });
      const result = await authService.refresh('refresh-token-valido');
      expect(result.accessToken).toBe('fake-jwt-access');
      expect(result.refreshToken).toBe('fake-jwt-refresh');
    });
  });

  describe('hashPassword', () => {
    it('gera um hash diferente do texto original e verificável por bcrypt.compare', async () => {
      const hash = await AuthService.hashPassword('minha-senha');
      expect(hash).not.toBe('minha-senha');
      expect(await bcrypt.compare('minha-senha', hash)).toBe(true);
    });
  });
});
