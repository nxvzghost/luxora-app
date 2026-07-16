import { INestApplication } from '@nestjs/common';
import request from 'supertest';

export const SEED_PASSWORD = 'luxora-dev-2026';
export const TENANT_A_ADMIN_EMAIL = 'admin@clinica-a.luxora.dev';
export const TENANT_B_ADMIN_EMAIL = 'admin@clinica-b.luxora.dev';

export async function loginAs(app: INestApplication, email: string, password = SEED_PASSWORD): Promise<string> {
  const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`Login falhou para ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken;
}
