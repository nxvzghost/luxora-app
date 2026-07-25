import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { bootstrapTestApp } from './support/bootstrap-app';
import { uniqueSlot } from './support/unique-slot';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * [CRÍTICO #10] Conflito de Agenda — Módulo 07, ADR-0028.
 * Fonte: docs/09-Testes/01-Testes-Criticos.md.
 *
 * "Duas requisições concorrentes de agendamento para o mesmo horário
 * resultam em exatamente uma reserva bem-sucedida e uma resposta de
 * conflito — teste de concorrência real, não apenas sequencial."
 *
 * Duas camadas de defesa agora, não uma só (ADR-0040, PD-001):
 * 1. VerificarDisponibilidadeUseCase (o Motor) — pega o conflito ANTES de
 *    tentar salvar, sempre que já existir um Appointment ativo commitado no
 *    momento da consulta (SLOT_NOT_AVAILABLE).
 * 2. O índice único parcial do Postgres
 *    (prisma/rls/unique-active-appointment.sql) — pega o que restar da
 *    corrida entre requisições que passaram pelo Motor "ao mesmo tempo",
 *    antes de qualquer uma delas commitar (SESSION_CONFLICT).
 * Qual das duas camadas pega cada tentativa perdedora depende do timing
 * real da corrida — não determinístico entre execuções. A garantia que
 * importa (e que este teste prova, disparando N requisições de verdade em
 * paralelo via Promise.all, não uma simulação sequencial) é: exatamente 1
 * sucesso, todas as outras rejeitadas com 409 por uma das duas camadas,
 * nunca uma dupla reserva real.
 *
 * Infraestrutura de teste (Etapa 1 da correção de estabilidade da Suíte
 * Crítica): Tenant/Terapeuta/Paciente dedicados, não mais o "Terapeuta A1"
 * seedado compartilhado com outros arquivos — elimina o acúmulo indefinido
 * de Appointment que causava colisões 409 crescentes ao longo da sessão.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let fixture: DedicatedFixture;

describe('[CRÍTICO #10] N requisições concorrentes para o mesmo horário: exatamente 1 sucesso', () => {
  it('5 tentativas paralelas de agendar o mesmo slot resultam em 1 Reservada e 4 rejeições por conflito', async () => {
    const scheduledAt = uniqueSlot();
    const attempts = 5;

    const responses = await Promise.all(
      Array.from({ length: attempts }, () =>
        request(app.getHttpServer())
          .post('/api/v1/appointments')
          .set('Authorization', `Bearer ${fixture.token}`)
          .send({ patientId: fixture.patientId, therapistId: fixture.therapistId, scheduledAt, modality: 'presencial' }),
      ),
    );

    const successes = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);

    for (const success of successes) {
      fixture.appointmentIds.push(success.body.id);
    }

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(attempts - 1);
    for (const conflict of conflicts) {
      // SLOT_NOT_AVAILABLE (Motor, ADR-0040) ou SESSION_CONFLICT (índice
      // único do banco, ADR-0028) — qual delas pega cada tentativa perdedora
      // depende do timing real da corrida, ver comentário do describe acima.
      expect(['SLOT_NOT_AVAILABLE', 'SESSION_CONFLICT']).toContain(conflict.body.error.code);
    }
  });
});

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({
    datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } },
  });
  await fixturePrisma.$connect();

  app = await bootstrapTestApp();
  fixture = await createDedicatedFixture(fixturePrisma, 'CRIT10', {
    withActiveSubscription: true,
    withAvailabilityCalendar: true,
  });
  await createDedicatedUserAndLogin(fixturePrisma, app, fixture, 'CRIT10');
});

afterAll(async () => {
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await fixturePrisma.$disconnect();
  await app.close();
});
