import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaClient, UserRole } from '@prisma/client';
import { AuthService } from '@api/auth/auth.service';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * [CRÍTICO — ADR-0056] Sessão revogável (Fase 2 da auditoria, risco R4).
 *
 * Tudo contra Postgres real, com a role de aplicação sujeita a RLS: a
 * revogação depende de `user.token_version` e de a leitura do usuário no
 * refresh ser escopada ao Tenant do próprio token — nada disso é provado por
 * um mock.
 *
 * Cobre: refresh de usuário ativo, refresh de usuário desativado, logout com
 * efeito no servidor, reuso de refresh token revogado, concorrência,
 * refresh token usado como access token e tokens forjados/antigos.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let fixture: DedicatedFixture;
let jwtService: JwtService;
let otherTenantId: string;

interface LoggedUser {
  userId: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

const http = () => request(app.getHttpServer());
const nowInSeconds = () => Math.floor(Date.now() / 1000);

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

async function login(email: string, password: string) {
  const res = await http().post('/api/v1/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return { accessToken: res.body.accessToken as string, refreshToken: res.body.refreshToken as string };
}

async function createUserAndLogin(role: UserRole = UserRole.admin): Promise<LoggedUser> {
  const password = 'sessao-dedicada-2026';
  const email = `${role}-${randomUUID()}@sessao.luxora.dev`;
  const user = await fixturePrisma.user.create({
    data: { tenantId: fixture.tenantId, email, passwordHash: await AuthService.hashPassword(password), role },
  });
  fixture.userIds.push(user.id);
  return { userId: user.id, email, password, ...(await login(email, password)) };
}

const refresh = (refreshToken: string) => http().post('/api/v1/auth/refresh').send({ refreshToken });
const logout = (refreshToken: string) => http().post('/api/v1/auth/logout').send({ refreshToken });

async function tokenVersionOf(userId: string): Promise<number> {
  const user = await fixturePrisma.user.findUniqueOrThrow({ where: { id: userId } });
  return user.tokenVersion;
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  app = await bootstrapTestApp();
  jwtService = app.get(JwtService, { strict: false });
  fixture = await createDedicatedFixture(fixturePrisma, 'ADR0056', { withActiveSubscription: true });
  const otherTenant = await fixturePrisma.tenant.create({ data: { name: `Tenant Dedicado — ADR0056 outro ${randomUUID()}` } });
  otherTenantId = otherTenant.id;
});

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  if (otherTenantId) {
    await fixturePrisma.tenant.delete({ where: { id: otherTenantId } });
  }
  await fixturePrisma.$disconnect();
  await app?.close();
});

describe('[CRÍTICO — ADR-0056] Sessão revogável', () => {
  describe('refresh', () => {
    it('usuário ativo renova a sessão e o novo access token funciona numa rota protegida', async () => {
      const user = await createUserAndLogin();

      const res = await refresh(user.refreshToken);
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.refreshToken).toEqual(expect.any(String));

      const protectedRes = await http().get('/api/v1/users').set('Authorization', `Bearer ${res.body.accessToken}`);
      expect(protectedRes.status).toBe(200);
    });

    it('o refresh token NÃO autentica requisição — não é aceito como Bearer em rota protegida', async () => {
      const user = await createUserAndLogin();

      const withRefresh = await http().get('/api/v1/users').set('Authorization', `Bearer ${user.refreshToken}`);
      expect(withRefresh.status).toBe(401);

      // Controle: o access token do mesmo login funciona na mesma rota.
      const withAccess = await http().get('/api/v1/users').set('Authorization', `Bearer ${user.accessToken}`);
      expect(withAccess.status).toBe(200);
    });

    it('o access token NÃO renova a sessão', async () => {
      const user = await createUserAndLogin();
      const res = await refresh(user.accessToken);
      expect(res.status).toBe(401);
    });

    it('token com assinatura adulterada é recusado', async () => {
      const user = await createUserAndLogin();
      const tampered = `${user.refreshToken.slice(0, -4)}AAAA`;
      expect((await refresh(tampered)).status).toBe(401);
    });

    it('o papel alterado no banco passa a valer no próximo refresh, em vez do papel copiado do token antigo', async () => {
      const admin = await createUserAndLogin();
      const target = await createUserAndLogin(UserRole.admin);
      expect(decodePayload(target.accessToken).role).toBe('admin');

      const update = await http()
        .patch(`/api/v1/users/${target.userId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ role: 'therapist', therapistId: fixture.therapistId });
      expect(update.status).toBe(200);

      const res = await refresh(target.refreshToken);
      expect(res.status).toBe(200);
      expect(decodePayload(res.body.accessToken).role).toBe('therapist');
      expect(decodePayload(res.body.refreshToken).role).toBe('therapist');
    });

    it('dois refresh simultâneos com o mesmo token renovam ambos (o refresh token não é de uso único)', async () => {
      const user = await createUserAndLogin();
      const [a, b] = await Promise.all([refresh(user.refreshToken), refresh(user.refreshToken)]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(await tokenVersionOf(user.userId)).toBe(0);
    });
  });

  describe('logout', () => {
    it('revoga no servidor: o refresh token usado e todos os emitidos antes deixam de renovar', async () => {
      const user = await createUserAndLogin();
      const renewed = await refresh(user.refreshToken);
      expect(renewed.status).toBe(200);
      const secondRefreshToken = renewed.body.refreshToken as string;

      const logoutRes = await logout(secondRefreshToken);
      expect(logoutRes.status).toBe(204);
      expect(await tokenVersionOf(user.userId)).toBe(1);

      // Reuso de refresh token revogado: tanto o que foi enviado no logout
      // quanto o anterior (de outro "dispositivo") são recusados.
      expect((await refresh(secondRefreshToken)).status).toBe(401);
      expect((await refresh(user.refreshToken)).status).toBe(401);
    });

    it('depois do logout, um novo login abre uma sessão nova que renova normalmente', async () => {
      const user = await createUserAndLogin();
      expect((await logout(user.refreshToken)).status).toBe(204);

      const again = await login(user.email, user.password);
      expect(decodePayload(again.refreshToken).tv).toBe(1);
      expect((await refresh(again.refreshToken)).status).toBe(200);
    });

    it('é idempotente: repetir o logout com o mesmo token não incrementa a versão de novo', async () => {
      const user = await createUserAndLogin();
      expect((await logout(user.refreshToken)).status).toBe(204);
      expect((await logout(user.refreshToken)).status).toBe(204);
      expect(await tokenVersionOf(user.userId)).toBe(1);
    });

    it('dois logouts simultâneos com o mesmo token incrementam a versão uma única vez', async () => {
      const user = await createUserAndLogin();
      const [a, b] = await Promise.all([logout(user.refreshToken), logout(user.refreshToken)]);
      expect(a.status).toBe(204);
      expect(b.status).toBe(204);
      expect(await tokenVersionOf(user.userId)).toBe(1);
    });

    it('token inválido responde 204 sem efeito; corpo sem refreshToken responde 400', async () => {
      expect((await logout('isto-nao-e-um-jwt')).status).toBe(204);
      expect((await http().post('/api/v1/auth/logout').send({})).status).toBe(400);
    });

    it('um access token enviado ao logout não revoga nada', async () => {
      const user = await createUserAndLogin();
      expect((await logout(user.accessToken)).status).toBe(204);
      expect(await tokenVersionOf(user.userId)).toBe(0);
      expect((await refresh(user.refreshToken)).status).toBe(200);
    });
  });

  describe('usuário desativado', () => {
    it('não renova a sessão; reativado, os refresh tokens antigos continuam revogados', async () => {
      const admin = await createUserAndLogin();
      const target = await createUserAndLogin();

      const deactivate = await http()
        .post(`/api/v1/users/${target.userId}/deactivate`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(deactivate.status).toBe(200);
      expect((await refresh(target.refreshToken)).status).toBe(401);

      const reactivate = await http()
        .post(`/api/v1/users/${target.userId}/reactivate`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(reactivate.status).toBe(200);

      // A desativação incrementou a versão de sessão: o token antigo não volta a valer.
      expect((await refresh(target.refreshToken)).status).toBe(401);

      // Um login novo, com o usuário de novo ativo, funciona normalmente.
      const again = await login(target.email, target.password);
      expect((await refresh(again.refreshToken)).status).toBe(200);
    });
  });

  describe('refresh tokens forjados com a chave correta, mas com sessão inválida', () => {
    it('token que aponta para outro Tenant não renova (o usuário não é visível fora do próprio Tenant)', async () => {
      const user = await createUserAndLogin();
      const forged = await jwtService.signAsync(
        { sub: user.userId, tenantId: otherTenantId, role: 'admin', type: 'refresh', tv: 0, sst: nowInSeconds() },
        { expiresIn: '7d' },
      );
      expect((await refresh(forged)).status).toBe(401);
    });

    it('token no formato antigo, sem versão de sessão, não renova', async () => {
      const user = await createUserAndLogin();
      const legacy = await jwtService.signAsync(
        { sub: user.userId, tenantId: fixture.tenantId, role: 'admin', type: 'refresh' },
        { expiresIn: '7d' },
      );
      expect((await refresh(legacy)).status).toBe(401);
    });

    it('sessão iniciada há mais tempo que a duração máxima não renova, mesmo com o token ainda válido', async () => {
      const user = await createUserAndLogin();
      const stale = await jwtService.signAsync(
        { sub: user.userId, tenantId: fixture.tenantId, role: 'admin', type: 'refresh', tv: 0, sst: nowInSeconds() - 31 * 86_400 },
        { expiresIn: '7d' },
      );
      expect((await refresh(stale)).status).toBe(401);

      // Controle: a mesma forja com a sessão recente renova — prova que o 401 acima vem da idade da sessão.
      const fresh = await jwtService.signAsync(
        { sub: user.userId, tenantId: fixture.tenantId, role: 'admin', type: 'refresh', tv: 0, sst: nowInSeconds() },
        { expiresIn: '7d' },
      );
      expect((await refresh(fresh)).status).toBe(200);
    });
  });
});
