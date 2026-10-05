import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from '@api/auth/auth.service';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

const nowInSeconds = () => Math.floor(Date.now() / 1000);

describe('AuthService', () => {
  let jwtServiceMock: { signAsync: ReturnType<typeof vi.fn>; verifyAsync: ReturnType<typeof vi.fn> };
  let prismaMock: { forAuthLookup: ReturnType<typeof vi.fn> };
  let txMock: {
    $executeRaw: ReturnType<typeof vi.fn>;
    user: { findUnique: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  };
  let clientProviderMock: { $transaction: ReturnType<typeof vi.fn> };
  let authService: AuthService;

  function mockUserLookup(user: unknown) {
    prismaMock.forAuthLookup.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({ user: { findUnique: vi.fn().mockResolvedValue(user) } }),
    );
  }

  /** Payload do refresh token já "verificado" pelo JwtService mockado. */
  function mockVerifiedRefreshToken(overrides: Record<string, unknown> = {}) {
    jwtServiceMock.verifyAsync.mockResolvedValue({
      sub: USER_ID,
      tenantId: TENANT_ID,
      role: 'therapist',
      type: 'refresh',
      tv: 0,
      sst: nowInSeconds(),
      ...overrides,
    });
  }

  function signedPayloadOfType(type: 'access' | 'refresh'): Record<string, unknown> {
    const call = jwtServiceMock.signAsync.mock.calls.find(([payload]) => payload.type === type);
    return call?.[0] as Record<string, unknown>;
  }

  beforeEach(() => {
    jwtServiceMock = {
      signAsync: vi.fn().mockImplementation((payload) => Promise.resolve(`fake-jwt-${payload.type}`)),
      verifyAsync: vi.fn(),
    };
    prismaMock = { forAuthLookup: vi.fn() };
    txMock = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      user: { findUnique: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    clientProviderMock = {
      $transaction: vi.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(txMock)),
    };
    // @ts-expect-error — mocks propositalmente simplificados para o escopo do teste
    authService = new AuthService(jwtServiceMock, prismaMock, clientProviderMock);
  });

  afterEach(() => {
    delete process.env.JWT_SESSION_MAX_AGE_DAYS;
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
        tokenVersion: 0,
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
        tokenVersion: 0,
      });
      await authService.login('usuario@luxora.dev', 'senha-correta');
      expect(prismaMock.forAuthLookup).toHaveBeenCalledOnce();
    });

    it('ADR-0056 — o refresh token carrega a versão de sessão do usuário e o início da sessão; o access token não', async () => {
      mockUserLookup({
        id: USER_ID,
        tenantId: TENANT_ID,
        email: 'usuario@luxora.dev',
        passwordHash: await bcrypt.hash('senha-correta', 4),
        role: 'admin',
        deletedAt: null,
        tokenVersion: 7,
      });
      const before = nowInSeconds();
      await authService.login('usuario@luxora.dev', 'senha-correta');

      const refreshPayload = signedPayloadOfType('refresh');
      expect(refreshPayload.tv).toBe(7);
      expect(refreshPayload.sst).toBeGreaterThanOrEqual(before);
      expect(refreshPayload.sst).toBeLessThanOrEqual(nowInSeconds());

      const accessPayload = signedPayloadOfType('access');
      expect(accessPayload.tv).toBeUndefined();
      expect(accessPayload.sst).toBeUndefined();
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

    it('emite novo par de tokens a partir de um refresh token válido de um usuário ativo', async () => {
      mockVerifiedRefreshToken();
      txMock.user.findUnique.mockResolvedValue({
        id: USER_ID,
        tenantId: TENANT_ID,
        role: 'therapist',
        deletedAt: null,
        tokenVersion: 0,
      });
      const result = await authService.refresh('refresh-token-valido');
      expect(result.accessToken).toBe('fake-jwt-access');
      expect(result.refreshToken).toBe('fake-jwt-refresh');
    });

    it('ADR-0056 — rejeita refresh token sem as claims de sessão (emitido antes da revogação existir)', async () => {
      mockVerifiedRefreshToken({ tv: undefined, sst: undefined });
      await expect(authService.refresh('refresh-legado')).rejects.toThrow(UnauthorizedException);
      expect(clientProviderMock.$transaction).not.toHaveBeenCalled();
    });

    it('ADR-0056 — rejeita refresh token com tenantId fora do formato UUID, sem consultar o banco', async () => {
      mockVerifiedRefreshToken({ tenantId: "x'; DROP TABLE \"user\"; --" });
      await expect(authService.refresh('refresh-adulterado')).rejects.toThrow(UnauthorizedException);
      expect(clientProviderMock.$transaction).not.toHaveBeenCalled();
    });

    it('ADR-0056 — rejeita quando o usuário não é encontrado no Tenant do token (removido ou de outro Tenant)', async () => {
      mockVerifiedRefreshToken();
      txMock.user.findUnique.mockResolvedValue(null);
      await expect(authService.refresh('refresh-token')).rejects.toThrow(/encerrada ou revogada/);
      expect(jwtServiceMock.signAsync).not.toHaveBeenCalled();
    });

    it('ADR-0056 — rejeita quando o usuário foi desativado depois da emissão do token', async () => {
      mockVerifiedRefreshToken();
      txMock.user.findUnique.mockResolvedValue({
        id: USER_ID,
        tenantId: TENANT_ID,
        role: 'therapist',
        deletedAt: new Date(),
        tokenVersion: 0,
      });
      await expect(authService.refresh('refresh-token')).rejects.toThrow(/encerrada ou revogada/);
      expect(jwtServiceMock.signAsync).not.toHaveBeenCalled();
    });

    it('ADR-0056 — rejeita quando a versão de sessão do token não é mais a vigente (logout ou revogação)', async () => {
      mockVerifiedRefreshToken({ tv: 3 });
      txMock.user.findUnique.mockResolvedValue({
        id: USER_ID,
        tenantId: TENANT_ID,
        role: 'therapist',
        deletedAt: null,
        tokenVersion: 4,
      });
      await expect(authService.refresh('refresh-revogado')).rejects.toThrow(/encerrada ou revogada/);
      expect(jwtServiceMock.signAsync).not.toHaveBeenCalled();
    });

    it('ADR-0056 — rejeita quando a sessão passou da duração máxima, mesmo com o token ainda válido', async () => {
      process.env.JWT_SESSION_MAX_AGE_DAYS = '30';
      mockVerifiedRefreshToken({ sst: nowInSeconds() - 31 * 86_400 });
      await expect(authService.refresh('refresh-de-sessao-antiga')).rejects.toThrow(/Sessão expirada/);
      expect(clientProviderMock.$transaction).not.toHaveBeenCalled();
    });

    it('ADR-0056 — o novo par usa o papel ATUAL do banco, mantém o início da sessão e a versão vigente', async () => {
      const sessionStartedAt = nowInSeconds() - 3600;
      mockVerifiedRefreshToken({ role: 'admin', tv: 2, sst: sessionStartedAt });
      txMock.user.findUnique.mockResolvedValue({
        id: USER_ID,
        tenantId: TENANT_ID,
        role: 'therapist', // rebaixado depois da emissão do token
        deletedAt: null,
        tokenVersion: 2,
      });

      await authService.refresh('refresh-token');

      expect(signedPayloadOfType('access').role).toBe('therapist');
      const refreshPayload = signedPayloadOfType('refresh');
      expect(refreshPayload.role).toBe('therapist');
      expect(refreshPayload.tv).toBe(2);
      expect(refreshPayload.sst).toBe(sessionStartedAt);
    });

    it('ADR-0056 — consulta o usuário numa transação escopada ao Tenant do token, sem bypass de RLS', async () => {
      mockVerifiedRefreshToken();
      txMock.user.findUnique.mockResolvedValue({
        id: USER_ID,
        tenantId: TENANT_ID,
        role: 'therapist',
        deletedAt: null,
        tokenVersion: 0,
      });

      await authService.refresh('refresh-token');

      // $executeRaw é chamado como template tag: (strings, ...valores).
      const [sqlParts, tenantIdParam] = txMock.$executeRaw.mock.calls[0];
      expect(sqlParts.join('?')).toContain("set_config('app.tenant_id'");
      expect(tenantIdParam).toBe(TENANT_ID);
      expect(txMock.user.findUnique).toHaveBeenCalledWith({ where: { id: USER_ID } });
      expect(prismaMock.forAuthLookup).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('ADR-0056 — incrementa a versão de sessão só se ela ainda for a do token (nunca duas vezes)', async () => {
      mockVerifiedRefreshToken({ tv: 5 });

      await authService.logout('refresh-token');

      expect(txMock.user.updateMany).toHaveBeenCalledWith({
        where: { id: USER_ID, tokenVersion: 5 },
        data: { tokenVersion: { increment: 1 } },
      });
      const [, tenantIdParam] = txMock.$executeRaw.mock.calls[0];
      expect(tenantIdParam).toBe(TENANT_ID);
    });

    it('ADR-0056 — é silencioso para token inválido ou expirado: nada a revogar, nenhuma consulta ao banco', async () => {
      jwtServiceMock.verifyAsync.mockRejectedValue(new Error('expired'));
      await expect(authService.logout('token-invalido')).resolves.toBeUndefined();
      expect(clientProviderMock.$transaction).not.toHaveBeenCalled();
    });

    it('ADR-0056 — é silencioso quando recebe um access token no lugar do refresh token', async () => {
      jwtServiceMock.verifyAsync.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, role: 'admin', type: 'access' });
      await expect(authService.logout('access-token')).resolves.toBeUndefined();
      expect(clientProviderMock.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('issueTokens', () => {
    it('ADR-0056 — sem dados de sessão (bootstrap do primeiro admin), o refresh token nasce com versão 0 e sessão iniciada agora', async () => {
      const before = nowInSeconds();
      await authService.issueTokens(USER_ID, TENANT_ID, 'admin');

      const refreshPayload = signedPayloadOfType('refresh');
      expect(refreshPayload.tv).toBe(0);
      expect(refreshPayload.sst).toBeGreaterThanOrEqual(before);
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
