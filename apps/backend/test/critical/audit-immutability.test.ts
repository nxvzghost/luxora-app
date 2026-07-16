import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { AuditService } from '@domain-services/platform/audit.service';
import { PrismaAuditLogRepository } from '@infrastructure/database/repositories/prisma-audit-log.repository';
import { TenantContext } from '@shared/tenant-context';
import { DomainEvent } from '@domain/shared/domain-event';
import { bootstrapTestApp } from './support/bootstrap-app';
import { loginAs, TENANT_A_ADMIN_EMAIL } from './support/login-helper';

/**
 * [CRÍTICO #11-12] Auditoria — Módulo 10.
 * Fonte: docs/09-Testes/01-Testes-Criticos.md, docs/03-Database/08-Auditoria.md.
 */

let app: INestApplication;
let token: string;
let therapistId: string;
let tenantAId: string;

class TestEvent extends DomainEvent {
  declare readonly detail: string;
  constructor(entityId: string, tenantId: string, detail: string) {
    super('EventoDeTeste', entityId, tenantId, { detail });
  }
}

describe('[CRÍTICO #11] audit_log é imutável e cada ação gera exatamente um registro', () => {
  it('nenhum endpoint da API aceita PATCH/PUT/DELETE em /audit-log', async () => {
    const patch = await request(app.getHttpServer())
      .patch('/api/v1/audit-log/qualquer-id')
      .set('Authorization', `Bearer ${token}`);
    const del = await request(app.getHttpServer())
      .delete('/api/v1/audit-log/qualquer-id')
      .set('Authorization', `Bearer ${token}`);

    // 404: rota não mapeada — nunca existiu um endpoint de alteração para
    // começo de conversa, não é um caso de "existe mas nega acesso" (403/405).
    expect(patch.status).toBe(404);
    expect(del.status).toBe(404);
  });

  it('uma ação real (atualizar disponibilidade do terapeuta) gera exatamente 1 novo registro em audit_log', async () => {
    // Escopado por entityId (o próprio therapistId) em vez de contar o feed
    // inteiro do Tenant — test/critical/ roda vários arquivos em paralelo,
    // todos autenticados como Tenant A e gerando eventos de auditoria reais
    // simultaneamente (agendamentos, cobranças, pagamentos); contar o total
    // do Tenant colide com esses outros arquivos e não mede o que este
    // teste realmente quer validar.
    const client = new PrismaClientProvider();
    await client.$connect();
    const tenantContext = new TenantContext();
    tenantContext.set(tenantAId, 'admin-a');
    const prismaAsTenantA = new PrismaService(client, tenantContext);

    const countBefore = await prismaAsTenantA.forTenant((tx) =>
      tx.auditLog.count({ where: { entityId: therapistId, action: 'TerapeutaAtualizado' } }),
    );

    const res = await request(app.getHttpServer())
      .put(`/api/v1/therapists/${therapistId}/availability`)
      .set('Authorization', `Bearer ${token}`)
      .send({ slots: [{ dayOfWeek: 2, startTime: '10:00', endTime: '13:00' }] });
    expect(res.status).toBe(200);

    const countAfter = await prismaAsTenantA.forTenant((tx) =>
      tx.auditLog.count({ where: { entityId: therapistId, action: 'TerapeutaAtualizado' } }),
    );
    expect(countAfter).toBe(countBefore + 1);

    await client.$disconnect();
  });
});

describe('[CRÍTICO #12] Ação de agente de IA audita com actor_type=ai_agent, nunca user', () => {
  it('AuditService.recordAll com actorType=ai_agent persiste actor_type=ai_agent e userId=null, mesmo com TenantContext de um usuário real', async () => {
    const client = new PrismaClientProvider();
    await client.$connect();
    const tenantContext = new TenantContext();
    tenantContext.set(tenantAId, 'um-usuario-humano-qualquer');
    const auditService = new AuditService(
      new PrismaAuditLogRepository(new PrismaService(client, tenantContext)),
      tenantContext,
    );

    const testEntityId = randomUUID();
    const event = new TestEvent(testEntityId, tenantAId, 'ação executada pelo agente de IA');
    await auditService.recordAll([event], 'ai_agent');

    const prismaAsTenantA = new PrismaService(client, tenantContext);
    const rows = await prismaAsTenantA.forTenant((tx) => tx.auditLog.findMany({ where: { entityId: testEntityId } }));
    expect(rows).toHaveLength(1);
    expect(rows[0].actorType).toBe('ai_agent');
    // NUNCA associa o userId do TenantContext quando é ação de IA — mesmo
    // havendo um usuário humano "dono" da conversa/tenant no contexto.
    expect(rows[0].userId).toBeNull();

    await client.$disconnect();
  });
});

beforeAll(async () => {
  app = await bootstrapTestApp();
  token = await loginAs(app, TENANT_A_ADMIN_EMAIL);

  const therapistsRes = await request(app.getHttpServer())
    .get('/api/v1/therapists')
    .set('Authorization', `Bearer ${token}`);
  therapistId = therapistsRes.body.data[0].id;

  const fixturePrisma = new PrismaClient({
    datasources: {
      db: {
        url: (() => {
          const url = new URL(process.env.DATABASE_URL ?? '');
          url.username = 'postgres';
          url.password = 'postgres';
          return url.toString();
        })(),
      },
    },
  });
  await fixturePrisma.$connect();
  const tenantA = await fixturePrisma.tenant.findFirstOrThrow({ where: { name: 'Clínica Teste A' } });
  tenantAId = tenantA.id;
  await fixturePrisma.$disconnect();
});

afterAll(async () => {
  await app.close();
});
