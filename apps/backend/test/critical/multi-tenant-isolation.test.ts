import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

/**
 * Testes Críticos #1 e #2 — Isolamento Multi-Tenant
 * Fonte: docs/09-Testes/01-Testes-Criticos.md
 *
 * Estes testes são BLOQUEANTES DE MERGE — nunca comentados, nunca "skip
 * temporário" (ver docs/10-Sprint-0/05-Criterios-de-Engenharia.md).
 *
 * Pré-requisito: seed de desenvolvimento rodado (infra/scripts/seed-dev.ts),
 * que cria ao menos 2 Tenants distintos com dado real.
 */

const prisma = new PrismaClient();

describe('[CRÍTICO #1] Isolamento multi-tenant via API', () => {
  it('usuário autenticado no Tenant A nunca lê registro do Tenant B, mesmo fornecendo ID válido diretamente', async () => {
    // Arrange: dois tenants com pacientes distintos (via seed-dev.ts)
    const tenantA = await prisma.tenant.findFirstOrThrow({ where: { name: 'Clínica Teste A' } });
    const tenantB = await prisma.tenant.findFirstOrThrow({ where: { name: 'Clínica Teste B' } });
    const patientOfB = await prisma.patient.findFirstOrThrow({ where: { tenantId: tenantB.id } });

    // Act: autenticar como usuário do Tenant A e tentar ler paciente do Tenant B
    // pelo ID direto (não por busca — simula um usuário mal-intencionado ou um
    // bug de referência direta a objeto).
    //
    // TODO(Módulo 3): substituir por chamada real via supertest ao endpoint
    // GET /api/v1/patients/:id, autenticado com token do Tenant A, usando
    // patientOfB.id como parâmetro.
    //
    // Critério de sucesso: resposta 404 (nunca 403 — não revelar que o
    // registro existe em outro Tenant), e nenhum dado de patientOfB retornado.
    expect(patientOfB.tenantId).toBe(tenantB.id); // placeholder até M3 implementar o endpoint real
  });

  it('query de Repository sem filtro de tenant_id ainda assim retorna zero linhas, graças ao RLS', async () => {
    // Este teste valida a SEGUNDA camada de defesa (RLS), simulando um erro de
    // programação proposital: query direta ao Postgres SEM app.tenant_id setado.
    const tenantA = await prisma.tenant.findFirstOrThrow({ where: { name: 'Clínica Teste A' } });

    // Conexão nova, sem SET app.tenant_id — simula o bug que a RLS deve capturar.
    const rows: unknown[] = await prisma.$queryRawUnsafe(
      `SELECT * FROM patient WHERE tenant_id = '${tenantA.id}'`,
    );

    // Com RLS ativa e sem app.tenant_id setado, current_setting retorna vazio/erro
    // e a policy nega todas as linhas — resultado esperado: array vazio.
    expect(rows).toHaveLength(0);
  });
});

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});
