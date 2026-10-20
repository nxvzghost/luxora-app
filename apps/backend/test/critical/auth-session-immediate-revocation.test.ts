import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { INestApplication, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import IORedis from 'ioredis';
import { PrismaClient, UserRole } from '@prisma/client';
import { AuthService } from '@api/auth/auth.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';
import {
  SessionStateCache,
  SESSION_STATE_TTL_SECONDS,
  sessionStateKey,
} from '@infrastructure/auth/session-state.cache';
import { bootstrapTestApp } from './support/bootstrap-app';
import { createDedicatedFixture, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * [CRÍTICO — ADR-0067] Revogação imediata do access token (A-17).
 *
 * Antes, o `JwtAuthGuard` conferia só a assinatura e o prazo: depois de sair,
 * de ser desativado ou de ter o papel trocado, o access token já emitido
 * continuava valendo por até 15 minutos. Agora ele carrega a versão de sessão
 * e o guard compara versão e papel com o estado vigente do usuário, guardado
 * no Redis e relido do banco quando falta.
 *
 * Tudo contra Postgres real (role de aplicação, RLS) e Redis real. Um segundo
 * app, com o cache apontado para um Redis fora do ar, prova que a revogação
 * continua imediata lendo do banco.
 */

/** O mesmo cache, com o Redis apontado para uma porta onde nada responde. */
@Injectable()
class RedisDownSessionStateCache extends SessionStateCache {
  constructor(clientProvider: PrismaClientProvider) {
    super(clientProvider);
  }

  protected createRedisClient(): IORedis {
    return new IORedis('redis://127.0.0.1:1', {
      connectTimeout: 200,
      commandTimeout: 200,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
  }
}

/**
 * O mesmo cache, com a leitura do banco pausada entre ler e devolver: é uma
 * releitura "atrasada", que leu o estado antes de uma revogação e só grava
 * depois dela — a corrida entre duas gravações do mesmo usuário.
 */
@Injectable()
class PausedReadSessionStateCache extends SessionStateCache {
  readDone!: Promise<void>;
  release!: () => void;
  private markRead!: () => void;
  private gate!: Promise<void>;

  constructor(clientProvider: PrismaClientProvider) {
    super(clientProvider);
    this.readDone = new Promise((resolve) => (this.markRead = resolve));
    this.gate = new Promise((resolve) => (this.release = resolve));
  }

  protected async readDatabase(tenantId: string, userId: string) {
    const stored = await super.readDatabase(tenantId, userId);
    this.markRead();
    await this.gate;
    return stored;
  }
}

let app: INestApplication;
let redisDownApp: INestApplication;
let fixturePrisma: PrismaClient;
let fixture: DedicatedFixture;
let jwtService: JwtService;
let redis: IORedis;

interface LoggedUser {
  userId: string;
  email: string;
  password: string;
  role: UserRole;
  accessToken: string;
  refreshToken: string;
}

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

const http = (target: INestApplication = app) => request(target.getHttpServer());
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function login(email: string, password: string, target: INestApplication = app) {
  const res = await http(target).post('/api/v1/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return { accessToken: res.body.accessToken as string, refreshToken: res.body.refreshToken as string };
}

/** Um terapeuta só pode ter um usuário: cada usuário terapeuta, e cada troca de papel, ganha o seu. */
async function createTherapist(): Promise<string> {
  const therapist = await fixturePrisma.therapist.create({
    data: { tenantId: fixture.tenantId, name: `Terapeuta — ADR0067 ${randomUUID()}`, specialty: 'Psicologia' },
  });
  fixture.therapistIds.push(therapist.id);
  return therapist.id;
}

async function createUserAndLogin(role: UserRole = UserRole.admin, target: INestApplication = app): Promise<LoggedUser> {
  const password = 'revogacao-imediata-2026';
  const email = `${role}-${randomUUID()}@revogacao.luxora.dev`;
  const user = await fixturePrisma.user.create({
    data: {
      tenantId: fixture.tenantId,
      email,
      passwordHash: await AuthService.hashPassword(password),
      role,
      ...(role === UserRole.therapist ? { therapistId: await createTherapist() } : {}),
    },
  });
  fixture.userIds.push(user.id);
  return { userId: user.id, email, password, role, ...(await login(email, password, target)) };
}

const listUsers = (token: string, target: INestApplication = app) => http(target).get('/api/v1/users').set(bearer(token));
const logout = (refreshToken: string, target: INestApplication = app) =>
  http(target).post('/api/v1/auth/logout').send({ refreshToken });

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();
  app = await bootstrapTestApp();
  redisDownApp = await bootstrapTestApp({
    overrides: [{ provide: SessionStateCache, useClass: RedisDownSessionStateCache }],
  });
  jwtService = app.get(JwtService, { strict: false });
  redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  fixture = await createDedicatedFixture(fixturePrisma, 'ADR0067', { withActiveSubscription: true });
});

afterAll(async () => {
  if (fixture) {
    const keys = await redis.keys(`${sessionStateKey(fixture.tenantId, '')}*`);
    if (keys.length > 0) await redis.del(...keys);
  }
  await redis?.quit();
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await fixturePrisma.$disconnect();
  await redisDownApp?.close();
  await app?.close();
});

describe('[CRÍTICO — ADR-0067] Revogação imediata do access token', () => {
  it('sair recusa na hora o access token em uso, não só o refresh token', async () => {
    const user = await createUserAndLogin();
    expect((await listUsers(user.accessToken)).status).toBe(200);

    expect((await logout(user.refreshToken)).status).toBe(204);

    const after = await listUsers(user.accessToken);
    expect(after.status).toBe(401);
    expect(JSON.stringify(after.body)).toContain('Sessão encerrada ou alterada');
  });

  it('desativar recusa na hora; reativar não ressuscita o token antigo; um login novo funciona', async () => {
    const admin = await createUserAndLogin();
    const target = await createUserAndLogin();
    expect((await listUsers(target.accessToken)).status).toBe(200);

    const deactivate = await http().post(`/api/v1/users/${target.userId}/deactivate`).set(bearer(admin.accessToken));
    expect(deactivate.status).toBe(200);
    expect((await listUsers(target.accessToken)).status).toBe(401);

    const reactivate = await http().post(`/api/v1/users/${target.userId}/reactivate`).set(bearer(admin.accessToken));
    expect(reactivate.status).toBe(200);
    expect((await listUsers(target.accessToken)).status).toBe(401);

    const again = await login(target.email, target.password);
    expect((await listUsers(again.accessToken)).status).toBe(200);
  });

  it('trocar o papel recusa na hora o token com o papel antigo; renovar devolve o papel novo, que já vale', async () => {
    const admin = await createUserAndLogin();
    const target = await createUserAndLogin(UserRole.admin);

    // Controle: como administrador, a criação de usuário passa pelo RBAC e para na validação do corpo.
    expect((await http().post('/api/v1/users').set(bearer(target.accessToken)).send({})).status).toBe(400);

    const update = await http()
      .patch(`/api/v1/users/${target.userId}`)
      .set(bearer(admin.accessToken))
      .send({ role: 'therapist', therapistId: await createTherapist() });
    expect(update.status).toBe(200);

    // O token de administrador já emitido não passa mais em rota nenhuma.
    expect((await http().post('/api/v1/users').set(bearer(target.accessToken)).send({})).status).toBe(401);
    expect((await listUsers(target.accessToken)).status).toBe(401);

    // A troca de papel não encerra a sessão: renovar funciona e traz o papel novo.
    const renewed = await http().post('/api/v1/auth/refresh').send({ refreshToken: target.refreshToken });
    expect(renewed.status).toBe(200);
    expect(decodePayload(renewed.body.accessToken).role).toBe('therapist');
    expect((await listUsers(renewed.body.accessToken)).status).toBe(200);
    expect((await http().post('/api/v1/users').set(bearer(renewed.body.accessToken)).send({})).status).toBe(403);
  });

  it('access token sem versão de sessão (emitido antes desta ADR) é recusado; o mesmo com a versão vigente passa', async () => {
    const user = await createUserAndLogin();
    const base = { sub: user.userId, tenantId: fixture.tenantId, role: 'admin', type: 'access' };

    const legacy = await jwtService.signAsync(base, { expiresIn: '15m' });
    expect((await listUsers(legacy)).status).toBe(401);

    const current = await jwtService.signAsync({ ...base, tv: 0 }, { expiresIn: '15m' });
    expect((await listUsers(current)).status).toBe(200);
  });

  it('access token com um papel que o usuário não tem, mesmo assinado com a chave certa, é recusado', async () => {
    const therapist = await createUserAndLogin(UserRole.therapist);
    const elevated = await jwtService.signAsync(
      { sub: therapist.userId, tenantId: fixture.tenantId, role: 'admin', type: 'access', tv: 0 },
      { expiresIn: '15m' },
    );
    expect((await listUsers(elevated)).status).toBe(401);
    expect((await listUsers(therapist.accessToken)).status).toBe(200);
  });

  it('access token de um usuário apontando para outra clínica é recusado (a RLS esconde o usuário)', async () => {
    const user = await createUserAndLogin();
    const forged = await jwtService.signAsync(
      { sub: user.userId, tenantId: randomUUID(), role: 'admin', type: 'access', tv: 0 },
      { expiresIn: '15m' },
    );
    expect((await listUsers(forged)).status).toBe(401);
  });

  describe('o estado no Redis', () => {
    it('é gravado na primeira requisição, com prazo de no máximo 60 s, e sobrescrito em sair e desativar', async () => {
      const admin = await createUserAndLogin();
      const user = await createUserAndLogin();
      const key = sessionStateKey(fixture.tenantId, user.userId);
      await redis.del(key);

      expect((await listUsers(user.accessToken)).status).toBe(200);
      expect(await redis.get(key)).toBe('0:admin');
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(SESSION_STATE_TTL_SECONDS);

      expect((await logout(user.refreshToken)).status).toBe(204);
      expect(await redis.get(key)).toBe('1:admin');

      // A desativação incrementa a versão de novo; o desativado guarda a versão, para a escrita continuar monotônica.
      const deactivate = await http().post(`/api/v1/users/${user.userId}/deactivate`).set(bearer(admin.accessToken));
      expect(deactivate.status).toBe(200);
      expect(await redis.get(key)).toBe('2:inactive');
    });

    it('é consultado antes do banco; sem a entrada, o banco decide', async () => {
      const user = await createUserAndLogin();
      const key = sessionStateKey(fixture.tenantId, user.userId);

      // Uma entrada que diz "versão 5" recusa o token de versão 0, embora o banco diga 0.
      await redis.set(key, '5:admin', 'EX', SESSION_STATE_TTL_SECONDS);
      expect((await listUsers(user.accessToken)).status).toBe(401);

      await redis.del(key);
      expect((await listUsers(user.accessToken)).status).toBe(200);
      expect(await redis.get(key)).toBe('0:admin');
    });

    it('uma entrada ilegível é ignorada e substituída pelo que o banco diz', async () => {
      const user = await createUserAndLogin();
      const key = sessionStateKey(fixture.tenantId, user.userId);
      await redis.set(key, 'lixo', 'EX', SESSION_STATE_TTL_SECONDS);

      expect((await listUsers(user.accessToken)).status).toBe(200);
    });
  });

  describe('corrida: uma releitura antiga gravada depois da revogação', () => {
    it('depois de sair, a releitura atrasada com a versão anterior não volta ao cache e o token continua recusado', async () => {
      const user = await createUserAndLogin();
      const key = sessionStateKey(fixture.tenantId, user.userId);
      expect((await listUsers(user.accessToken)).status).toBe(200);
      expect(await redis.get(key)).toBe('0:admin');

      const late = new PausedReadSessionStateCache(app.get(PrismaClientProvider, { strict: false }));
      try {
        const pending = late.refresh(fixture.tenantId, user.userId);
        await late.readDone; // leu a versão 0 do banco e parou antes de gravar

        expect((await logout(user.refreshToken)).status).toBe(204);
        expect(await redis.get(key)).toBe('1:admin');

        late.release();
        await pending; // tenta gravar "0:admin" por cima de "1:admin"

        expect(await redis.get(key)).toBe('1:admin');
        expect((await listUsers(user.accessToken)).status).toBe(401);
      } finally {
        late.release();
        await late.onModuleDestroy();
      }
    });

    it('depois de desativar, a releitura atrasada com o usuário ainda ativo não volta ao cache', async () => {
      const admin = await createUserAndLogin();
      const target = await createUserAndLogin();
      const key = sessionStateKey(fixture.tenantId, target.userId);
      expect((await listUsers(target.accessToken)).status).toBe(200);

      const late = new PausedReadSessionStateCache(app.get(PrismaClientProvider, { strict: false }));
      try {
        const pending = late.refresh(fixture.tenantId, target.userId);
        await late.readDone; // leu "versão 0, ativo"

        const deactivate = await http().post(`/api/v1/users/${target.userId}/deactivate`).set(bearer(admin.accessToken));
        expect(deactivate.status).toBe(200);
        expect(await redis.get(key)).toBe('1:inactive');

        late.release();
        await pending;

        expect(await redis.get(key)).toBe('1:inactive');
        expect((await listUsers(target.accessToken)).status).toBe(401);
      } finally {
        late.release();
        await late.onModuleDestroy();
      }
    });

    it('a mesma versão continua sobrescrevendo: é assim que a troca de papel e a reativação chegam ao cache', async () => {
      const user = await createUserAndLogin();
      const key = sessionStateKey(fixture.tenantId, user.userId);
      await redis.set(key, '0:therapist', 'EX', SESSION_STATE_TTL_SECONDS);

      await app.get(SessionStateCache).refresh(fixture.tenantId, user.userId);

      expect(await redis.get(key)).toBe('0:admin');
      expect((await listUsers(user.accessToken)).status).toBe(200);
    });
  });

  describe('com o Redis fora do ar', () => {
    it('a sessão vigente continua valendo e sair continua recusando o access token na hora (lido do banco)', async () => {
      const user = await createUserAndLogin(UserRole.admin, redisDownApp);
      expect((await listUsers(user.accessToken, redisDownApp)).status).toBe(200);

      expect((await logout(user.refreshToken, redisDownApp)).status).toBe(204);
      expect((await listUsers(user.accessToken, redisDownApp)).status).toBe(401);
    });

    it('desativar continua recusando na hora', async () => {
      const admin = await createUserAndLogin(UserRole.admin, redisDownApp);
      const target = await createUserAndLogin(UserRole.admin, redisDownApp);

      const deactivate = await http(redisDownApp)
        .post(`/api/v1/users/${target.userId}/deactivate`)
        .set(bearer(admin.accessToken));
      expect(deactivate.status).toBe(200);
      expect((await listUsers(target.accessToken, redisDownApp)).status).toBe(401);
    });
  });
});
