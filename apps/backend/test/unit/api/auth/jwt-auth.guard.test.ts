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
 */
describe('JwtAuthGuard', () => {
  let jwtServiceMock: { verifyAsync: ReturnType<typeof vi.fn> };
  let tenantContext: TenantContext;
  let guard: JwtAuthGuard;

  function contextWith(headers: Record<string, string>) {
    const request: { headers: Record<string, string>; userRole?: string } = { headers };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
    return { context, request };
  }

  beforeEach(() => {
    jwtServiceMock = { verifyAsync: vi.fn() };
    tenantContext = new TenantContext();
    // @ts-expect-error — mock propositalmente simplificado para o escopo do teste
    guard = new JwtAuthGuard(jwtServiceMock, tenantContext);
  });

  it('aceita um access token válido e inicializa o TenantContext a partir do payload', async () => {
    jwtServiceMock.verifyAsync.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, role: 'admin', type: 'access' });
    const { context, request } = contextWith({ authorization: 'Bearer access-token' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(tenantContext.tenantId).toBe(TENANT_ID);
    expect(tenantContext.userId).toBe(USER_ID);
    expect(request.userRole).toBe('admin');
  });

  it('rejeita um refresh token usado como Bearer e não inicializa o TenantContext', async () => {
    jwtServiceMock.verifyAsync.mockResolvedValue({
      sub: USER_ID,
      tenantId: TENANT_ID,
      role: 'admin',
      type: 'refresh',
      tv: 0,
      sst: 1,
    });
    const { context } = contextWith({ authorization: 'Bearer refresh-token' });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(tenantContext.isInitialized).toBe(false);
  });

  it('rejeita um JWT assinado mas sem o campo type', async () => {
    jwtServiceMock.verifyAsync.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, role: 'admin' });
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
});
