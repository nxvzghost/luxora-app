import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * AD-001 — CRUD de `User` via API real (Postgres). Cobre também os dois
 * pontos de segurança exigidos: `role: 'super_admin'` nunca é aceito pela
 * API, e um usuário desativado nunca consegue logar (reaproveitando
 * `AuthService.login()`, sem nenhuma mudança nele).
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let fixture: DedicatedFixture;
let adminToken: string;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  app = await bootstrapTestApp();
  fixture = await createDedicatedFixture(fixturePrisma, 'AD001CRUD', { withActiveSubscription: true });
  adminToken = await createDedicatedUserAndLogin(fixturePrisma, app, fixture, 'AD001CRUD');
});

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await fixturePrisma.$disconnect();
  await app?.close();
});

describe('[AD-001] CRUD de usuários', () => {
  it('GET /users exige autenticação (401 sem token)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/users');
    expect(res.status).toBe(401);
  });

  it('rejeita role: "super_admin" no corpo da requisição — nunca chega a criar nada', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: `escalada-${Date.now()}@clinica.dev`, password: 'senha-forte-123456', role: 'super_admin' });
    expect(res.status).toBe(400);
  });

  it('cria, lista, atualiza, desativa e reativa um usuário admin — ciclo completo via API real', async () => {
    const email = `usuario-crud-${Date.now()}@clinica.dev`;
    const password = 'senha-forte-crud-2026';

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email, password, role: 'admin' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.role).toBe('admin');
    expect(createRes.body.passwordHash).toBeUndefined();
    const newUserId = createRes.body.id as string;
    fixture.userIds.push(newUserId);

    const listRes = await request(app.getHttpServer()).get('/api/v1/users').set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.some((u: { id: string }) => u.id === newUserId)).toBe(true);

    const updateRes = await request(app.getHttpServer())
      .patch(`/api/v1/users/${newUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'therapist', therapistId: fixture.therapistId });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.role).toBe('therapist');
    expect(updateRes.body.therapistId).toBe(fixture.therapistId);

    const deactivateRes = await request(app.getHttpServer())
      .post(`/api/v1/users/${newUserId}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(deactivateRes.status).toBe(200);
    expect(deactivateRes.body.isActive).toBe(false);

    // Usuário desativado não consegue mais logar — reaproveita
    // AuthService.login() (deletedAt já era checado lá antes desta AD).
    const loginBlockedRes = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
    expect(loginBlockedRes.status).toBe(401);

    const reactivateRes = await request(app.getHttpServer())
      .post(`/api/v1/users/${newUserId}/reactivate`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(reactivateRes.status).toBe(200);
    expect(reactivateRes.body.isActive).toBe(true);

    // Reativado, o login volta a funcionar normalmente.
    const loginRestoredRes = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
    expect(loginRestoredRes.status).toBe(200);
  });

  it('criar usuário therapist exige therapistId de um Terapeuta existente no mesmo Tenant', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: `sem-therapist-${Date.now()}@clinica.dev`, password: 'senha-forte-123456', role: 'therapist' });
    expect(res.status).toBe(400);

    const notFoundRes = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: `therapist-invalido-${Date.now()}@clinica.dev`,
        password: 'senha-forte-123456',
        role: 'therapist',
        therapistId: '00000000-0000-4000-8000-000000000000',
      });
    expect(notFoundRes.status).toBe(404);
  });

  it('rejeita e-mail duplicado com 409', async () => {
    const email = `duplicado-${Date.now()}@clinica.dev`;
    const first = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email, password: 'senha-forte-123456', role: 'admin' });
    expect(first.status).toBe(201);
    fixture.userIds.push(first.body.id);

    const second = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email, password: 'senha-forte-123456', role: 'admin' });
    expect(second.status).toBe(409);
  });
});
