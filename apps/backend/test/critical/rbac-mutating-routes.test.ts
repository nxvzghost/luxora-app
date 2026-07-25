import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { PrismaClient, UserRole, PlanTier } from '@prisma/client';
import request from 'supertest';
import { bootstrapTestApp } from './support/bootstrap-app';
import { uniqueSlot } from './support/unique-slot';
import { createDedicatedFixture, createDedicatedUserAndLogin, cleanupDedicatedFixture, DedicatedFixture } from './support/dedicated-fixture';

/**
 * AD-003 — cobertura de RBAC para as 21 rotas mutantes que ganharam
 * RolesGuard/@Roles nesta AD (docs/02-Arquitetura/16-Politica-RBAC.md é a
 * fonte de verdade da política; este arquivo só valida o comportamento).
 *
 * Um único Tenant dedicado, com 3 Users reais (admin/therapist/super_admin —
 * AD-003 estendeu createDedicatedUserAndLogin() para aceitar `role`),
 * reaproveitado por todas as rotas — mesmo racional de consolidação de pool
 * de conexão já estabelecido pela AD-034.
 *
 * Cada rota valida, no mínimo (requisito do Design Review aprovado):
 *   - papel permitido → sucesso (2xx);
 *   - papel proibido → 403;
 *   - super_admin → sucesso (2xx).
 * Rotas com dois papéis permitidos (`admin`+`therapist`) não têm um terceiro
 * papel humano "proibido" para testar — só existem 3 papéis no sistema
 * (UserRole: admin/therapist/super_admin) e os 3 já têm acesso a essas
 * rotas. Nesses casos, testam-se as duas permissões + super_admin; a
 * ausência de um caso "proibido" ali é uma limitação do domínio (só 3
 * papéis existem), não uma lacuna de cobertura.
 */

let app: INestApplication;
let fixturePrisma: PrismaClient;
let fixture: DedicatedFixture;
let adminToken: string;
let therapistToken: string;
let superAdminToken: string;
/**
 * Terapeuta dedicado exclusivamente à Etapa 3 (Billing/Payment) — NUNCA o
 * fixture.therapistId principal, porque os testes de Etapa 2
 * (PUT /therapists/:id/availability) sobrescrevem a AvailabilityCalendar
 * do terapeuta principal para uma janela estreita (ex.: só quarta-feira
 * 08:00-12:00), incompatível com uniqueSlot() (dia/hora aleatórios). Um
 * terapeuta próprio, com calendário amplo nunca tocado por outra Etapa,
 * evita esse acoplamento entre etapas.
 */
let billingTherapistId: string;

function toSuperuserUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = 'postgres';
  url.password = 'postgres';
  return url.toString();
}

/**
 * Pré-requisito de dados para os testes de BillingController/PaymentController
 * (Etapa 3) — cria Appointment + confirma (gera Session) via adminToken.
 * AppointmentsController ainda não tem RolesGuard nesta etapa (Etapa 5,
 * pendente), então qualquer token válido serve só para montar o cenário;
 * a rota sob teste em cada caso usa o token do papel sendo validado.
 */
async function createConfirmedSession(): Promise<string> {
  const apptRes = await request(app.getHttpServer())
    .post('/api/v1/appointments')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ patientId: fixture.patientId, therapistId: billingTherapistId, scheduledAt: uniqueSlot(), modality: 'presencial' });
  expect(apptRes.status).toBe(201);
  fixture.appointmentIds.push(apptRes.body.id);

  const confirmRes = await request(app.getHttpServer())
    .post(`/api/v1/appointments/${apptRes.body.id}/confirm`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(confirmRes.status).toBe(201);

  const session = await fixturePrisma.session.findUniqueOrThrow({ where: { appointmentId: apptRes.body.id } });
  fixture.sessionIds.push(session.id);
  return session.id;
}

/**
 * Pré-requisito de dados para os testes de PatientsController (Etapa 4) —
 * deactivate/reactivate/discharge exigem o Paciente num estado de partida
 * específico (Ativo ou Inativo — ver patientTransitions em
 * domain/patient/patient.entity.ts). Um Paciente dedicado por chamada
 * (nunca fixture.patientId, nunca reaproveitado entre testes) evita que uma
 * transição de estado feita por um teste (ex.: admin) invalide a
 * pré-condição do próximo (ex.: therapist) — exatamente o compartilhamento
 * de estado entre testes que esta etapa pediu para evitar.
 */
async function createPatientWithState(state: 'Ativo' | 'Inativo', label: string): Promise<string> {
  const patient = await fixturePrisma.patient.create({
    data: { tenantId: fixture.tenantId, name: `Paciente RBAC — ${label}`, phone: '11988887777', state },
  });
  fixture.patientIds.push(patient.id);
  return patient.id;
}

/**
 * Pré-requisito de dados para os testes de reschedule/cancel/confirm
 * (Etapa 5) — cria um Appointment novo (estado 'Reservada' logo após
 * AgendarConsultaUseCase, ver domain/appointment/appointment.entity.ts) via
 * adminToken só para montar o cenário; a rota sob teste em cada caso usa o
 * token do papel sendo validado. Usa billingTherapistId (calendário amplo,
 * nunca mutado por nenhuma etapa) — nunca fixture.therapistId, estreitado
 * pela Etapa 2.
 */
async function createAppointment(): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/appointments')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ patientId: fixture.patientId, therapistId: billingTherapistId, scheduledAt: uniqueSlot(), modality: 'presencial' });
  expect(res.status).toBe(201);
  fixture.appointmentIds.push(res.body.id);
  return res.body.id;
}

beforeAll(async () => {
  fixturePrisma = new PrismaClient({ datasources: { db: { url: toSuperuserUrl(process.env.DATABASE_URL ?? '') } } });
  await fixturePrisma.$connect();

  app = await bootstrapTestApp();

  fixture = await createDedicatedFixture(fixturePrisma, 'RBAC', {
    withActiveSubscription: true,
    withAvailabilityCalendar: true,
    withClinicSettings: true,
  });
  // Plano padrão da fixture é 'professional' (maxTherapists: 1) — a fixture
  // já nasce com 1 terapeuta, e os testes de RBAC de TherapistsController
  // (Etapa 2) precisam poder criar mais 2 via POST /therapists com
  // sucesso (admin e super_admin). 'enterprise' (maxTherapists: 5) dá
  // margem suficiente sem esbarrar no teto do plano — não é uma regra de
  // RBAC, é um pré-requisito de negócio não relacionado a papel.
  await fixturePrisma.clinicSubscription.update({
    where: { tenantId: fixture.tenantId },
    data: { plan: PlanTier.enterprise },
  });
  adminToken = await createDedicatedUserAndLogin(fixturePrisma, app, fixture, 'RBAC', UserRole.admin);
  therapistToken = await createDedicatedUserAndLogin(fixturePrisma, app, fixture, 'RBAC', UserRole.therapist);
  superAdminToken = await createDedicatedUserAndLogin(fixturePrisma, app, fixture, 'RBAC', UserRole.super_admin);

  // Terapeuta + calendário dedicados à Etapa 3 — ver comentário de
  // billingTherapistId acima. Calendário amplo (todos os dias, 00:00-23:59)
  // nunca é tocado pelos testes de Etapa 2 (que só mexem em fixture.therapistId).
  const billingTherapist = await fixturePrisma.therapist.create({
    data: { tenantId: fixture.tenantId, name: 'Terapeuta Dedicado RBAC — Billing/Payment', specialty: 'Psicologia' },
  });
  fixture.therapistIds.push(billingTherapist.id);
  billingTherapistId = billingTherapist.id;
  await fixturePrisma.availabilityCalendar.create({
    data: {
      tenantId: fixture.tenantId,
      therapistId: billingTherapistId,
      windows: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        dayOfWeek,
        startTime: '00:00',
        endTime: '23:59',
        sessionDurationMinutes: 60,
      })),
    },
  });
});

afterAll(async () => {
  // AvailabilityCalendar de billingTherapistId não é rastreado por
  // fixture.calendarId (esse já aponta para o calendário do
  // fixture.therapistId principal) — sem FK cascade (schema.prisma:188-202),
  // precisa ser apagado explicitamente antes de cleanupDedicatedFixture()
  // tentar apagar billingTherapistId (via fixture.therapistIds), senão viola FK.
  await fixturePrisma.availabilityCalendar.deleteMany({ where: { therapistId: billingTherapistId } });
  // RecurringBlock (Etapa 5) tem FK própria para patientId/therapistId, sem
  // cascade (schema.prisma:231-250) — mesma razão do AvailabilityCalendar
  // acima: apagar antes de cleanupDedicatedFixture() tentar apagar
  // fixture.patientId/billingTherapistId, senão viola FK. Escopado por
  // patientId, um id conhecido e exclusivo desta fixture.
  await fixturePrisma.recurringBlock.deleteMany({ where: { patientId: fixture.patientId } });
  await cleanupDedicatedFixture(fixturePrisma, fixture);
  await fixturePrisma.$disconnect();
  await app?.close();
});

describe('AD-003 — ClinicController RBAC (admin only)', () => {
  it('PATCH /clinic — admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/v1/clinic')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Clínica RBAC Renomeada' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Clínica RBAC Renomeada');
  });

  it('PATCH /clinic — therapist: 403', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/v1/clinic')
      .set('Authorization', `Bearer ${therapistToken}`)
      .send({ name: 'Não deveria funcionar' });
    expect(res.status).toBe(403);
  });

  it('PATCH /clinic — super_admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/v1/clinic')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ name: 'Clínica RBAC — super_admin' });
    expect(res.status).toBe(200);
  });

  it('PUT /clinic/policies — admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/clinic/policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ defaultBillingPolicy: 'weekly' });
    expect(res.status).toBe(200);
    expect(res.body.defaultBillingPolicy).toBe('weekly');
  });

  it('PUT /clinic/policies — therapist: 403', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/clinic/policies')
      .set('Authorization', `Bearer ${therapistToken}`)
      .send({ defaultBillingPolicy: 'monthly' });
    expect(res.status).toBe(403);
  });

  it('PUT /clinic/policies — super_admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/clinic/policies')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ defaultBillingPolicy: 'per_session' });
    expect(res.status).toBe(200);
  });

  it('PUT /clinic/payment-info — admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/clinic/payment-info')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ pixKey: 'rbac-admin@luxora.dev', payeeName: 'Clínica RBAC' });
    expect(res.status).toBe(200);
    expect(res.body.pixKey).toBe('rbac-admin@luxora.dev');
  });

  it('PUT /clinic/payment-info — therapist: 403', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/clinic/payment-info')
      .set('Authorization', `Bearer ${therapistToken}`)
      .send({ pixKey: 'nao-deveria@luxora.dev' });
    expect(res.status).toBe(403);
  });

  it('PUT /clinic/payment-info — super_admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/clinic/payment-info')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ pixKey: 'rbac-superadmin@luxora.dev' });
    expect(res.status).toBe(200);
  });
});

describe('AD-003 — TherapistsController RBAC (admin only)', () => {
  it('POST /therapists — admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/therapists')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Terapeuta RBAC — admin', specialty: 'Psicologia' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Terapeuta RBAC — admin');
    fixture.therapistIds.push(res.body.id);
  });

  it('POST /therapists — therapist: 403', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/therapists')
      .set('Authorization', `Bearer ${therapistToken}`)
      .send({ name: 'Não deveria funcionar', specialty: 'Psicologia' });
    expect(res.status).toBe(403);
  });

  it('POST /therapists — super_admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/therapists')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ name: 'Terapeuta RBAC — super_admin', specialty: 'Psicologia' });
    expect(res.status).toBe(201);
    fixture.therapistIds.push(res.body.id);
  });

  it('PATCH /therapists/:id — admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/therapists/${fixture.therapistId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Terapeuta Dedicado RBAC — renomeado admin' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Terapeuta Dedicado RBAC — renomeado admin');
  });

  it('PATCH /therapists/:id — therapist: 403', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/therapists/${fixture.therapistId}`)
      .set('Authorization', `Bearer ${therapistToken}`)
      .send({ name: 'Não deveria funcionar' });
    expect(res.status).toBe(403);
  });

  it('PATCH /therapists/:id — super_admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/therapists/${fixture.therapistId}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ name: 'Terapeuta Dedicado RBAC — renomeado super_admin' });
    expect(res.status).toBe(200);
  });

  it('PUT /therapists/:id/availability — admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .put(`/api/v1/therapists/${fixture.therapistId}/availability`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ windows: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00', sessionDurationMinutes: 50 }] });
    expect(res.status).toBe(200);
    expect(res.body.therapistId).toBe(fixture.therapistId);
  });

  it('PUT /therapists/:id/availability — therapist: 403', async () => {
    const res = await request(app.getHttpServer())
      .put(`/api/v1/therapists/${fixture.therapistId}/availability`)
      .set('Authorization', `Bearer ${therapistToken}`)
      .send({ windows: [{ dayOfWeek: 2, startTime: '08:00', endTime: '12:00', sessionDurationMinutes: 50 }] });
    expect(res.status).toBe(403);
  });

  it('PUT /therapists/:id/availability — super_admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .put(`/api/v1/therapists/${fixture.therapistId}/availability`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ windows: [{ dayOfWeek: 3, startTime: '08:00', endTime: '12:00', sessionDurationMinutes: 50 }] });
    expect(res.status).toBe(200);
  });
});

describe('AD-003 — BillingController RBAC (admin only)', () => {
  it('POST /billings — admin: sucesso', async () => {
    const sessionId = await createConfirmedSession();
    const res = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ patientId: fixture.patientId, amount: 300, dueDate: '2026-12-01', sessionIds: [sessionId] });
    expect(res.status).toBe(201);
    fixture.billingIds.push(res.body.id);
  });

  it('POST /billings — therapist: 403', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${therapistToken}`)
      .send({ patientId: fixture.patientId, amount: 100, dueDate: '2026-12-01', sessionIds: ['00000000-0000-0000-0000-000000000000'] });
    expect(res.status).toBe(403);
  });

  it('POST /billings — super_admin: sucesso', async () => {
    const sessionId = await createConfirmedSession();
    const res = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ patientId: fixture.patientId, amount: 300, dueDate: '2026-12-01', sessionIds: [sessionId] });
    expect(res.status).toBe(201);
    fixture.billingIds.push(res.body.id);
  });

  it('POST /billings/:id/send — admin: sucesso', async () => {
    const sessionId = await createConfirmedSession();
    const billingRes = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ patientId: fixture.patientId, amount: 150, dueDate: '2026-12-01', sessionIds: [sessionId] });
    expect(billingRes.status).toBe(201);
    fixture.billingIds.push(billingRes.body.id);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/billings/${billingRes.body.id}/send`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(201);
  });

  it('POST /billings/:id/send — therapist: 403', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/billings/00000000-0000-0000-0000-000000000000/send')
      .set('Authorization', `Bearer ${therapistToken}`);
    expect(res.status).toBe(403);
  });

  it('POST /billings/:id/send — super_admin: sucesso', async () => {
    const sessionId = await createConfirmedSession();
    const billingRes = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ patientId: fixture.patientId, amount: 150, dueDate: '2026-12-01', sessionIds: [sessionId] });
    expect(billingRes.status).toBe(201);
    fixture.billingIds.push(billingRes.body.id);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/billings/${billingRes.body.id}/send`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(201);
  });
});

describe('AD-003 — PaymentController RBAC (admin only)', () => {
  it('POST /payments — admin: sucesso', async () => {
    const sessionId = await createConfirmedSession();
    const billingRes = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ patientId: fixture.patientId, amount: 200, dueDate: '2026-12-01', sessionIds: [sessionId] });
    expect(billingRes.status).toBe(201);
    fixture.billingIds.push(billingRes.body.id);

    const res = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `rbac-admin-${Date.now()}-${Math.random()}`)
      .send({ billingId: billingRes.body.id, amount: 200 });
    expect(res.status).toBe(201);
    fixture.paymentIds.push(res.body.id);
  });

  it('POST /payments — therapist: 403', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${therapistToken}`)
      .set('Idempotency-Key', `rbac-therapist-${Date.now()}`)
      .send({ billingId: '00000000-0000-0000-0000-000000000000', amount: 100 });
    expect(res.status).toBe(403);
  });

  it('POST /payments — super_admin: sucesso', async () => {
    const sessionId = await createConfirmedSession();
    const billingRes = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ patientId: fixture.patientId, amount: 200, dueDate: '2026-12-01', sessionIds: [sessionId] });
    expect(billingRes.status).toBe(201);
    fixture.billingIds.push(billingRes.body.id);

    const res = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .set('Idempotency-Key', `rbac-superadmin-${Date.now()}-${Math.random()}`)
      .send({ billingId: billingRes.body.id, amount: 200 });
    expect(res.status).toBe(201);
    fixture.paymentIds.push(res.body.id);
  });

  it('POST /payments/:id/refund — admin: sucesso', async () => {
    const sessionId = await createConfirmedSession();
    const billingRes = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ patientId: fixture.patientId, amount: 250, dueDate: '2026-12-01', sessionIds: [sessionId] });
    expect(billingRes.status).toBe(201);
    fixture.billingIds.push(billingRes.body.id);

    const paymentRes = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `rbac-refund-setup-admin-${Date.now()}`)
      .send({ billingId: billingRes.body.id, amount: 250 });
    expect(paymentRes.status).toBe(201);
    fixture.paymentIds.push(paymentRes.body.id);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/payments/${paymentRes.body.id}/refund`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(201);
  });

  it('POST /payments/:id/refund — therapist: 403', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/payments/00000000-0000-0000-0000-000000000000/refund')
      .set('Authorization', `Bearer ${therapistToken}`);
    expect(res.status).toBe(403);
  });

  it('POST /payments/:id/refund — super_admin: sucesso', async () => {
    const sessionId = await createConfirmedSession();
    const billingRes = await request(app.getHttpServer())
      .post('/api/v1/billings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ patientId: fixture.patientId, amount: 250, dueDate: '2026-12-01', sessionIds: [sessionId] });
    expect(billingRes.status).toBe(201);
    fixture.billingIds.push(billingRes.body.id);

    const paymentRes = await request(app.getHttpServer())
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', `rbac-refund-setup-superadmin-${Date.now()}`)
      .send({ billingId: billingRes.body.id, amount: 250 });
    expect(paymentRes.status).toBe(201);
    fixture.paymentIds.push(paymentRes.body.id);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/payments/${paymentRes.body.id}/refund`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(201);
  });
});

describe('AD-003 — PatientsController RBAC (admin + therapist)', () => {
  it('POST /patients — admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Paciente RBAC — criado por admin', phone: '11977776666' });
    expect(res.status).toBe(201);
    fixture.patientIds.push(res.body.id);
  });

  it('POST /patients — therapist: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${therapistToken}`)
      .send({ name: 'Paciente RBAC — criado por therapist', phone: '11977776667' });
    expect(res.status).toBe(201);
    fixture.patientIds.push(res.body.id);
  });

  it('POST /patients — super_admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ name: 'Paciente RBAC — criado por super_admin', phone: '11977776668' });
    expect(res.status).toBe(201);
    fixture.patientIds.push(res.body.id);
  });

  it('PATCH /patients/:id — admin: sucesso', async () => {
    const patientId = await createPatientWithState('Ativo', 'PATCH admin');
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/patients/${patientId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Paciente RBAC — renomeado admin' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Paciente RBAC — renomeado admin');
  });

  it('PATCH /patients/:id — therapist: sucesso', async () => {
    const patientId = await createPatientWithState('Ativo', 'PATCH therapist');
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/patients/${patientId}`)
      .set('Authorization', `Bearer ${therapistToken}`)
      .send({ name: 'Paciente RBAC — renomeado therapist' });
    expect(res.status).toBe(200);
  });

  it('PATCH /patients/:id — super_admin: sucesso', async () => {
    const patientId = await createPatientWithState('Ativo', 'PATCH super_admin');
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/patients/${patientId}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ name: 'Paciente RBAC — renomeado super_admin' });
    expect(res.status).toBe(200);
  });

  it('POST /patients/:id/deactivate — admin: sucesso', async () => {
    const patientId = await createPatientWithState('Ativo', 'deactivate admin');
    const res = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientId}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(201);
    expect(res.body.state).toBe('Inativo');
  });

  it('POST /patients/:id/deactivate — therapist: sucesso', async () => {
    const patientId = await createPatientWithState('Ativo', 'deactivate therapist');
    const res = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientId}/deactivate`)
      .set('Authorization', `Bearer ${therapistToken}`);
    expect(res.status).toBe(201);
  });

  it('POST /patients/:id/deactivate — super_admin: sucesso', async () => {
    const patientId = await createPatientWithState('Ativo', 'deactivate super_admin');
    const res = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientId}/deactivate`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(201);
  });

  it('POST /patients/:id/reactivate — admin: sucesso', async () => {
    const patientId = await createPatientWithState('Inativo', 'reactivate admin');
    const res = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientId}/reactivate`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(201);
    expect(res.body.state).toBe('Ativo');
  });

  it('POST /patients/:id/reactivate — therapist: sucesso', async () => {
    const patientId = await createPatientWithState('Inativo', 'reactivate therapist');
    const res = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientId}/reactivate`)
      .set('Authorization', `Bearer ${therapistToken}`);
    expect(res.status).toBe(201);
  });

  it('POST /patients/:id/reactivate — super_admin: sucesso', async () => {
    const patientId = await createPatientWithState('Inativo', 'reactivate super_admin');
    const res = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientId}/reactivate`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(201);
  });

  it('POST /patients/:id/discharge — admin: sucesso', async () => {
    const patientId = await createPatientWithState('Ativo', 'discharge admin');
    const res = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientId}/discharge`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(201);
    expect(res.body.state).toBe('Alta');
  });

  it('POST /patients/:id/discharge — therapist: sucesso', async () => {
    const patientId = await createPatientWithState('Ativo', 'discharge therapist');
    const res = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientId}/discharge`)
      .set('Authorization', `Bearer ${therapistToken}`);
    expect(res.status).toBe(201);
  });

  it('POST /patients/:id/discharge — super_admin: sucesso', async () => {
    const patientId = await createPatientWithState('Ativo', 'discharge super_admin');
    const res = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientId}/discharge`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(201);
  });
});

describe('AD-003 — AppointmentsController RBAC (admin + therapist)', () => {
  it('POST /appointments — admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/appointments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ patientId: fixture.patientId, therapistId: billingTherapistId, scheduledAt: uniqueSlot(), modality: 'presencial' });
    expect(res.status).toBe(201);
    fixture.appointmentIds.push(res.body.id);
  });

  it('POST /appointments — therapist: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/appointments')
      .set('Authorization', `Bearer ${therapistToken}`)
      .send({ patientId: fixture.patientId, therapistId: billingTherapistId, scheduledAt: uniqueSlot(), modality: 'presencial' });
    expect(res.status).toBe(201);
    fixture.appointmentIds.push(res.body.id);
  });

  it('POST /appointments — super_admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/appointments')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ patientId: fixture.patientId, therapistId: billingTherapistId, scheduledAt: uniqueSlot(), modality: 'presencial' });
    expect(res.status).toBe(201);
    fixture.appointmentIds.push(res.body.id);
  });

  it('PATCH /appointments/:id/reschedule — admin: sucesso', async () => {
    const appointmentId = await createAppointment();
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/appointments/${appointmentId}/reschedule`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ newScheduledAt: uniqueSlot() });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('Reagendada');
  });

  it('PATCH /appointments/:id/reschedule — therapist: sucesso', async () => {
    const appointmentId = await createAppointment();
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/appointments/${appointmentId}/reschedule`)
      .set('Authorization', `Bearer ${therapistToken}`)
      .send({ newScheduledAt: uniqueSlot() });
    expect(res.status).toBe(200);
  });

  it('PATCH /appointments/:id/reschedule — super_admin: sucesso', async () => {
    const appointmentId = await createAppointment();
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/appointments/${appointmentId}/reschedule`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ newScheduledAt: uniqueSlot() });
    expect(res.status).toBe(200);
  });

  it('POST /appointments/:id/cancel — admin: sucesso', async () => {
    const appointmentId = await createAppointment();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/appointments/${appointmentId}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(201);
    expect(res.body.state).toBe('Cancelada');
  });

  it('POST /appointments/:id/cancel — therapist: sucesso', async () => {
    const appointmentId = await createAppointment();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/appointments/${appointmentId}/cancel`)
      .set('Authorization', `Bearer ${therapistToken}`);
    expect(res.status).toBe(201);
  });

  it('POST /appointments/:id/cancel — super_admin: sucesso', async () => {
    const appointmentId = await createAppointment();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/appointments/${appointmentId}/cancel`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(201);
  });

  it('POST /appointments/:id/confirm — admin: sucesso', async () => {
    const appointmentId = await createAppointment();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/appointments/${appointmentId}/confirm`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(201);
    expect(res.body.state).toBe('Confirmada');
    // Confirmar gera uma Session como efeito colateral (ver
    // ConfirmarConsultaUseCase) — precisa ser rastreada em
    // fixture.sessionIds, senão bloqueia o deleteMany de appointmentIds no
    // cleanup por FK (session_appointment_id_fkey), descoberto ao rodar.
    const session = await fixturePrisma.session.findUniqueOrThrow({ where: { appointmentId } });
    fixture.sessionIds.push(session.id);
  });

  it('POST /appointments/:id/confirm — therapist: sucesso', async () => {
    const appointmentId = await createAppointment();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/appointments/${appointmentId}/confirm`)
      .set('Authorization', `Bearer ${therapistToken}`);
    expect(res.status).toBe(201);
    const session = await fixturePrisma.session.findUniqueOrThrow({ where: { appointmentId } });
    fixture.sessionIds.push(session.id);
  });

  it('POST /appointments/:id/confirm — super_admin: sucesso', async () => {
    const appointmentId = await createAppointment();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/appointments/${appointmentId}/confirm`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(201);
    const session = await fixturePrisma.session.findUniqueOrThrow({ where: { appointmentId } });
    fixture.sessionIds.push(session.id);
  });

  it('POST /appointments/recurring — admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/appointments/recurring')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        patientId: fixture.patientId,
        therapistId: billingTherapistId,
        firstScheduledAt: uniqueSlot(),
        modality: 'presencial',
        occurrences: 2,
        intervalDays: 7,
      });
    expect(res.status).toBe(201);
    res.body.data.forEach((a: { id: string }) => fixture.appointmentIds.push(a.id));
  });

  it('POST /appointments/recurring — therapist: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/appointments/recurring')
      .set('Authorization', `Bearer ${therapistToken}`)
      .send({
        patientId: fixture.patientId,
        therapistId: billingTherapistId,
        firstScheduledAt: uniqueSlot(),
        modality: 'presencial',
        occurrences: 2,
        intervalDays: 7,
      });
    expect(res.status).toBe(201);
    res.body.data.forEach((a: { id: string }) => fixture.appointmentIds.push(a.id));
  });

  it('POST /appointments/recurring — super_admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/appointments/recurring')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        patientId: fixture.patientId,
        therapistId: billingTherapistId,
        firstScheduledAt: uniqueSlot(),
        modality: 'presencial',
        occurrences: 2,
        intervalDays: 7,
      });
    expect(res.status).toBe(201);
    res.body.data.forEach((a: { id: string }) => fixture.appointmentIds.push(a.id));
  });
});

describe('AD-003 — RecurringBlocksController RBAC (admin + therapist)', () => {
  it('POST /recurring-blocks — admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/recurring-blocks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        patientId: fixture.patientId,
        therapistId: billingTherapistId,
        firstOccurrence: uniqueSlot(),
        intervalDays: 7,
        modality: 'presencial',
        renewalMode: 'automatic',
      });
    expect(res.status).toBe(201);
  });

  it('POST /recurring-blocks — therapist: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/recurring-blocks')
      .set('Authorization', `Bearer ${therapistToken}`)
      .send({
        patientId: fixture.patientId,
        therapistId: billingTherapistId,
        firstOccurrence: uniqueSlot(),
        intervalDays: 7,
        modality: 'presencial',
        renewalMode: 'automatic',
      });
    expect(res.status).toBe(201);
  });

  it('POST /recurring-blocks — super_admin: sucesso', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/recurring-blocks')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        patientId: fixture.patientId,
        therapistId: billingTherapistId,
        firstOccurrence: uniqueSlot(),
        intervalDays: 7,
        modality: 'presencial',
        renewalMode: 'automatic',
      });
    expect(res.status).toBe(201);
  });
});
