import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from '@api/auth/jwt-auth.guard';
import { TenantContext } from '@shared/tenant-context';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

/**
 * ADR-0056 (Fase 2 da auditoria, R4) — JwtAuthGuard só aceita access token.
 * Antes, qualquer JWT com assinatura válida autenticava a requisição,
 * inclusive o refresh token de 7 dias.
 *
 * ADR-0067 (A-17) — e só enquanto a versão de sessão e o papel do token
 * forem os vigentes do usuário, com o usuário ativo.
 */
describe('JwtAuthGuard', () => {
  let jwtServiceMock: { verifyAsync: ReturnType<typeof vi.fn> };
  let sessionStateMock: { current: ReturnType<typeof vi.fn> };
  let tenantContext: TenantContext;
  let guard: JwtAuthGuard;

  const accessPayload = (overrides: Record<string, unknown> = {}) => ({
    sub: USER_ID,
    tenantId: TENANT_ID,
    role: 'admin',
    type: 'access',
    tv: 3,
    ...overrides,
  });

  function contextWith(headers: Record<string, string>) {
    const request: { headers: Record<string, string>; userRole?: string } = { headers };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
    return { context, request };
  }

  beforeEach(() => {
    jwtServiceMock = { verifyAsync: vi.fn() };
    sessionStateMock = { current: vi.fn().mockResolvedValue({ tokenVersion: 3, role: 'admin' }) };
    tenantContext = new TenantContext();
    // @ts-expect-error — mock propositalmente simplificado para o escopo do teste
    guard = new JwtAuthGuard(jwtServiceMock, tenantContext, sessionStateMock);
  });

  it('aceita um access token com a sessão vigente e inicializa o TenantContext a partir do payload', async () => {
    jwtServiceMock.verifyAsync.mockResolvedValue(accessPayload());
    const { context, request } = contextWith({ authorization: 'Bearer access-token' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(sessionStateMock.current).toHaveBeenCalledWith(TENANT_ID, USER_ID);
    expect(tenantContext.tenantId).toBe(TENANT_ID);
    expect(tenantContext.userId).toBe(USER_ID);
    expect(request.userRole).toBe('admin');
  });

  it('rejeita um refresh token usado como Bearer e não inicializa o TenantContext', async () => {
    jwtServiceMock.verifyAsync.mockResolvedValue(accessPayload({ type: 'refresh', sst: 1 }));
    const { context } = contextWith({ authorization: 'Bearer refresh-token' });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(tenantContext.isInitialized).toBe(false);
  });

  it('rejeita um JWT assinado mas sem o campo type', async () => {
    jwtServiceMock.verifyAsync.mockResolvedValue(accessPayload({ type: undefined }));
    const { context } = contextWith({ authorization: 'Bearer token-sem-tipo' });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(tenantContext.isInitialized).toBe(false);
  });

  it('rejeita requisição sem header Authorization', async () => {
    const { context } = contextWith({});
    await expect(guard.canActivate(context)).rejects.toThrow('Token ausente.');
    expect(jwtServiceMock.verifyAsync).not.toHaveBeenCalled();
  });

  it('rejeita token com assinatura inválida ou expirado', async () => {
    jwtServiceMock.verifyAsync.mockRejectedValue(new Error('invalid signature'));
    const { context } = contextWith({ authorization: 'Bearer token-adulterado' });
    await expect(guard.canActivate(context)).rejects.toThrow('Token inválido ou expirado.');
  });

  describe('ADR-0067 — revogação imediata', () => {
    it('rejeita access token emitido antes da ADR-0067, sem versão de sessão, sem consultar o estado', async () => {
      jwtServiceMock.verifyAsync.mockResolvedValue(accessPayload({ tv: undefined }));
      const { context } = contextWith({ authorization: 'Bearer token-antigo' });

      await expect(guard.canActivate(context)).rejects.toThrow('Token inválido ou expirado.');
      expect(sessionStateMock.current).not.toHaveBeenCalled();
      expect(tenantContext.isInitialized).toBe(false);
    });

    it('rejeita tenantId ou userId fora do formato UUID, sem consultar o estado', async () => {
      jwtServiceMock.verifyAsync.mockResolvedValue(accessPayload({ tenantId: "x' OR 1=1" }));
      const { context } = contextWith({ authorization: 'Bearer token-forjado' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      expect(sessionStateMock.current).not.toHaveBeenCalled();
    });

    it('rejeita quando a versão de sessão mudou (saiu, foi desativado e reativado)', async () => {
      jwtServiceMock.verifyAsync.mockResolvedValue(accessPayload({ tv: 2 }));
      const { context } = contextWith({ authorization: 'Bearer token-revogado' });

      await expect(guard.canActivate(context)).rejects.toThrow('Sessão encerrada ou alterada. Faça login novamente.');
      expect(tenantContext.isInitialized).toBe(false);
    });

    it('rejeita quando o usuário não existe na clínica do token ou está desativado', async () => {
      sessionStateMock.current.mockResolvedValue(null);
      jwtServiceMock.verifyAsync.mockResolvedValue(accessPayload());
      const { context } = contextWith({ authorization: 'Bearer token-de-desativado' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      expect(tenantContext.isInitialized).toBe(false);
    });

    it('rejeita quando o papel do token não é mais o do usuário (troca de papel)', async () => {
      sessionStateMock.current.mockResolvedValue({ tokenVersion: 3, role: 'therapist' });
      jwtServiceMock.verifyAsync.mockResolvedValue(accessPayload({ role: 'admin' }));
      const { context, request } = contextWith({ authorization: 'Bearer token-com-papel-antigo' });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      expect(request.userRole).toBeUndefined();
    });

    it('um erro ao ler o estado (banco fora do ar) recusa a requisição em vez de deixá-la passar', async () => {
      sessionStateMock.current.mockRejectedValue(new Error('banco fora do ar'));
      jwtServiceMock.verifyAsync.mockResolvedValue(accessPayload());
      const { context } = contextWith({ authorization: 'Bearer access-token' });

      await expect(guard.canActivate(context)).rejects.toThrow('banco fora do ar');
      expect(tenantContext.isInitialized).toBe(false);
    });
  });
});
