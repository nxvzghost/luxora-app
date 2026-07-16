import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootstrapTestApp } from './support/bootstrap-app';
import { loginAs, TENANT_A_ADMIN_EMAIL } from './support/login-helper';
import { uniqueSlot } from './support/unique-slot';

/**
 * [CRÍTICO #10] Conflito de Agenda — Módulo 07, ADR-0028.
 * Fonte: docs/09-Testes/01-Testes-Criticos.md.
 *
 * "Duas requisições concorrentes de agendamento para o mesmo horário
 * resultam em exatamente uma reserva bem-sucedida e uma resposta
 * SESSION_CONFLICT — teste de concorrência real, não apenas sequencial."
 * A defesa vive no índice único parcial do Postgres
 * (prisma/rls/unique-active-appointment.sql), não em memória — este teste
 * dispara N requisições de verdade em paralelo (Promise.all), não uma
 * simulação sequencial que nunca exercitaria a race condition real.
 */

let app: INestApplication;
let token: string;
let patientId: string;
let therapistId: string;

describe('[CRÍTICO #10] N requisições concorrentes para o mesmo horário: exatamente 1 sucesso', () => {
  it('5 tentativas paralelas de agendar o mesmo slot resultam em 1 Reservada e 4 SESSION_CONFLICT', async () => {
    const scheduledAt = uniqueSlot();
    const attempts = 5;

    const responses = await Promise.all(
      Array.from({ length: attempts }, () =>
        request(app.getHttpServer())
          .post('/api/v1/appointments')
          .set('Authorization', `Bearer ${token}`)
          .send({ patientId, therapistId, scheduledAt, modality: 'presencial' }),
      ),
    );

    const successes = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(attempts - 1);
    for (const conflict of conflicts) {
      expect(conflict.body.error.code).toBe('SESSION_CONFLICT');
    }
  });
});

beforeAll(async () => {
  app = await bootstrapTestApp();
  token = await loginAs(app, TENANT_A_ADMIN_EMAIL);

  const patientsRes = await request(app.getHttpServer())
    .get('/api/v1/patients')
    .set('Authorization', `Bearer ${token}`);
  patientId = patientsRes.body.data[0].id;

  const therapistsRes = await request(app.getHttpServer())
    .get('/api/v1/therapists')
    .set('Authorization', `Bearer ${token}`);
  therapistId = therapistsRes.body.data[0].id;
});

afterAll(async () => {
  await app.close();
});
