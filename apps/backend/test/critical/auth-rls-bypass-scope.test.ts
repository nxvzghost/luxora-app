import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { TenantContext } from '@shared/tenant-context';

/**
 * [CRÍTICO #17] Bypass de RLS do login é restrito e não vaza — Módulo 04.
 *
 * Valida a política `auth_lookup_by_email` (apps/backend/prisma/rls/enable-rls.sql):
 * o bypass de RLS usado no login NUNCA deve vazar para nenhuma outra
 * consulta — é ativado apenas dentro da transação de
 * PrismaService.forAuthLookup(), nunca globalmente.
 *
 * Antes desta implementação, os dois testes eram `expect(true).toBe(true)`
 * — placeholders nunca validados contra Postgres real.
 */

const client = new PrismaClientProvider();

// Arrange-only: luxora_app (role real de aplicação) está sujeita a RLS —
// mesmo motivo documentado em multi-tenant-isolation.test.ts. O fixture
// precisa enxergar o admin do Tenant B para montar o cenário, então usa o
// superusuário só para isso; as asserções em si continuam usando a role
// real via `client`/PrismaService.
function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}
const fixturePrisma = new PrismaClient({
  datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } },
});

let tenantAId: string;
let tenantBId: string;
let tenantBAdminEmail: string;

describe('[CRÍTICO #17] Bypass de RLS do login é restrito e não vaza', () => {
  it('uma transação comum (forTenant) nunca ativa app.bypass_tenant_check', async () => {
    const tenantContextA = new TenantContext();
    tenantContextA.set(tenantAId, 'user-a');
    const prismaAsTenantA = new PrismaService(client, tenantContextA);

    // auth_lookup_by_email existe na tabela user, mas só é avaliada como
    // true quando app.bypass_tenant_check = 'true' — forTenant() nunca
    // seta isso. Buscar o admin do Tenant B a partir de uma transação do
    // Tenant A deve retornar null, mesmo a policy de bypass existindo.
    const found = await prismaAsTenantA.forTenant((tx) =>
      tx.user.findFirst({ where: { email: tenantBAdminEmail } }),
    );
    expect(found).toBeNull();
  });

  it('SET LOCAL é escopado à transação — não persiste entre requisições no pool de conexões', async () => {
    const tenantContextA = new TenantContext();
    tenantContextA.set(tenantAId, 'user-a');
    const prismaAsTenantA = new PrismaService(client, tenantContextA);

    // 1) forAuthLookup() ativa o bypass DENTRO da própria transação — e
    // consegue enxergar o admin do Tenant B a partir daqui, exatamente
    // como o fluxo de login precisa.
    const foundDuringAuthLookup = await prismaAsTenantA.forAuthLookup((tx) =>
      tx.user.findFirst({ where: { email: tenantBAdminEmail } }),
    );
    expect(foundDuringAuthLookup).not.toBeNull();
    expect(foundDuringAuthLookup?.tenantId).toBe(tenantBId);

    // 2) Uma transação forTenant() SEGUINTE, potencialmente reaproveitando
    // a mesma conexão do pool que acabou de rodar forAuthLookup(), não pode
    // continuar enxergando o admin do Tenant B — SET LOCAL é escopado à
    // transação anterior, não sobrevive a ela.
    const foundAfterAuthLookup = await prismaAsTenantA.forTenant((tx) =>
      tx.user.findFirst({ where: { email: tenantBAdminEmail } }),
    );
    expect(foundAfterAuthLookup).toBeNull();
  });
});

beforeAll(async () => {
  await client.$connect();
  await fixturePrisma.$connect();
  const tenantA = await fixturePrisma.tenant.findFirstOrThrow({ where: { name: 'Clínica Teste A' } });
  const tenantB = await fixturePrisma.tenant.findFirstOrThrow({ where: { name: 'Clínica Teste B' } });
  const adminB = await fixturePrisma.user.findFirstOrThrow({ where: { tenantId: tenantB.id, role: 'admin' } });
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;
  tenantBAdminEmail = adminB.email;
});

afterAll(async () => {
  await client.$disconnect();
  await fixturePrisma.$disconnect();
});
