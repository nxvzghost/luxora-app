import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AutomationApiKeyGuard } from '@api/automations/automation-api-key.guard';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function mockContext(headerKey?: string) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers: { 'x-automation-api-key': headerKey } }) }),
  } as unknown as ExecutionContext;
}

describe('AutomationApiKeyGuard', () => {
  const originalEnv = process.env.AUTOMATION_API_KEY;

  beforeEach(() => {
    process.env.AUTOMATION_API_KEY = 'segredo-de-teste';
  });

  afterEach(() => {
    process.env.AUTOMATION_API_KEY = originalEnv;
  });

  it('permite acesso com a API key correta', () => {
    const guard = new AutomationApiKeyGuard();
    expect(guard.canActivate(mockContext('segredo-de-teste'))).toBe(true);
  });

  it('rejeita com API key incorreta', () => {
    const guard = new AutomationApiKeyGuard();
    expect(() => guard.canActivate(mockContext('errada'))).toThrow(UnauthorizedException);
  });

  it('rejeita quando nenhuma key é fornecida', () => {
    const guard = new AutomationApiKeyGuard();
    expect(() => guard.canActivate(mockContext(undefined))).toThrow(UnauthorizedException);
  });
});

/**
 * Teste de aceite do ADR-0021 (fronteira Motor Operacional ↔ n8n),
 * automatizado pela primeira vez neste módulo — o Teste Crítico #13
 * era só um processo manual até agora.
 */
describe('AutomationsController — teste de aceite do ADR-0021', () => {
  it('nenhum handler do controller tem lógica de negócio própria (delega ao Use Case)', () => {
    const source = readFileSync(
      join(__dirname, '../../../../src/api/automations/automations.controller.ts'),
      'utf-8',
    );
    const handlerBodies = source.match(/async \w+\([^)]*\)\s*{([^}]*)}/g) ?? [];
    expect(handlerBodies.length).toBeGreaterThan(0);
    for (const handler of handlerBodies) {
      expect(handler).toMatch(/this\.\w+\.execute\(/);
      expect(handler).not.toMatch(/\bif\s*\(|\bfor\s*\(|\bswitch\s*\(/);
    }
  });
});
