import { describe, it, expect, vi } from 'vitest';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '@api/auth/roles.guard';

function mockContext(userRole: string | undefined, requiredRoles: string[] | undefined) {
  const reflector = { getAllAndOverride: vi.fn().mockReturnValue(requiredRoles) } as unknown as Reflector;
  const guard = new RolesGuard(reflector);
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ userRole }),
    }),
  } as unknown as ExecutionContext;
  return { guard, context };
}

describe('RolesGuard', () => {
  it('libera acesso quando o endpoint não declara @Roles()', () => {
    const { guard, context } = mockContext('therapist', undefined);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('libera acesso quando o role do usuário está entre os permitidos', () => {
    const { guard, context } = mockContext('admin', ['admin']);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('bloqueia acesso quando o role do usuário não está entre os permitidos', () => {
    const { guard, context } = mockContext('therapist', ['admin']);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('super_admin sempre passa, mesmo fora da lista de roles exigidos', () => {
    const { guard, context } = mockContext('super_admin', ['admin']);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('lança erro se userRole não estiver presente na requisição (JwtAuthGuard não rodou)', () => {
    const { guard, context } = mockContext(undefined, ['admin']);
    expect(() => guard.canActivate(context)).toThrow(/JwtAuthGuard deve rodar antes/);
  });
});
