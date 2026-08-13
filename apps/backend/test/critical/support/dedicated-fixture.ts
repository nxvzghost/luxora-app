import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { PrismaClient, PlanTier, BillingCycle, SubscriptionStatus, UserRole } from '@prisma/client';
import { AuthService } from '@api/auth/auth.service';
import { loginAs } from './login-helper';

/**
 * PD-001 Fase 2 — Etapa 1 de correção da infraestrutura da Suíte Crítica.
 *
 * Elimina o compartilhamento do terapeuta seedado ("Terapeuta A1") entre
 * appointment-concurrency.test.ts, appointment-savemany-transactional.test.ts,
 * billing-aggregation.test.ts, inadimplencia.test.ts (CRÍTICO #15) e
 * payment-idempotency.test.ts (CRÍTICO #8) — causa raiz identificada do
 * crescimento de colisões 409 ao longo da sessão (1094 Appointments
 * acumulados no mesmo terapeuta, sem limpeza entre execuções).
 *
 * Mesmo padrão já usado e validado em recurring-block-materialization.test.ts
 * (C3), recurring-block-management.test.ts (C4) e recurring-blocks-api.test.ts
 * (C5): Tenant/Therapist/Patient dedicados, criados e destruídos na própria
 * execução do arquivo.
 */

export interface DedicatedFixture {
  tenantId: string;
  /** Terapeuta principal, criado por createDedicatedFixture() — sempre o primeiro elemento de therapistIds. */
  therapistId: string;
  /** Paciente principal, criado por createDedicatedFixture() — sempre o primeiro elemento de patientIds. */
  patientId: string;
  subscriptionId?: string;
  calendarId?: string;
  /** AD-003 — id do ClinicSettings, quando options.withClinicSettings é usado. ClinicController exige a linha existir (ClinicNotFoundError caso contrário). */
  clinicSettingsId?: string;
  /** Último User criado por createDedicatedUserAndLogin() — mantido por compatibilidade com testes existentes que só precisam de um usuário admin. */
  userId?: string;
  /** Token do último User criado por createDedicatedUserAndLogin(). */
  token?: string;
  // Ids capturados no momento da criação de cada registro dinâmico durante
  // os testes — cleanupDedicatedFixture() apaga exclusivamente estes ids,
  // nunca uma condição ampla por tenantId. Quem cria um Appointment/Session/
  // Billing/Payment/Therapist extra é responsável por dar push aqui antes do
  // teste terminar.
  //
  // AD-034: therapistIds é uma coleção (não um "therapistId2"/"extraTherapistId"
  // ad hoc) — qualquer teste que precise de mais de um terapeuta no mesmo
  // Tenant dedicado usa esta mesma estrutura, escalando para N terapeutas
  // sem exigir mudança em cleanupDedicatedFixture() nem em nenhum outro teste.
  therapistIds: string[];
  // AD-003 (Etapa 4) — mesma justificativa de therapistIds: testes de RBAC
  // de PatientsController precisam de Pacientes dedicados em estados
  // específicos (Ativo/Inativo) para exercitar deactivate/reactivate/
  // discharge sem reaproveitar (e corromper o estado de) o patientId
  // principal usado por outras Etapas/arquivos.
  patientIds: string[];
  // AD-003: mesma justificativa de therapistIds — testes de RBAC precisam
  // de mais de um User (papéis diferentes) no mesmo Tenant dedicado.
  // userId/token acima continuam apontando para o último User criado
  // (compatibilidade com os 8 arquivos existentes que só usam um usuário
  // admin); userIds é quem cleanupDedicatedFixture() de fato usa para apagar
  // todos os Users criados, não só o último.
  userIds: string[];
  appointmentIds: string[];
  sessionIds: string[];
  billingIds: string[];
  paymentIds: string[];
}

export interface CreateDedicatedFixtureOptions {
  /** Necessária para passar por SubscriptionAccessGuard — arquivos que fazem requisição HTTP real precisam disto. */
  withActiveSubscription?: boolean;
  /** Necessária para o Motor de Disponibilidade aprovar qualquer horário — arquivos que testam o Repository puro (sem Motor) não precisam. */
  withAvailabilityCalendar?: boolean;
  /** Necessária para ClinicController (GET/PATCH/policies/payment-info) — ConsultarClinicaUseCase lança ClinicNotFoundError sem esta linha. */
  withClinicSettings?: boolean;
}

/**
 * Cria Tenant + Therapist + Patient exclusivos desta execução. `label` vira
 * parte do nome dos registros, só para facilitar inspeção manual do banco
 * se necessário — não tem efeito funcional.
 */
export async function createDedicatedFixture(
  fixturePrisma: PrismaClient,
  label: string,
  options: CreateDedicatedFixtureOptions = {},
): Promise<DedicatedFixture> {
  const tenant = await fixturePrisma.tenant.create({
    data: { name: `Tenant Dedicado — ${label} ${randomUUID()}` },
  });

  const therapist = await fixturePrisma.therapist.create({
    data: { tenantId: tenant.id, name: `Terapeuta Dedicado — ${label} ${randomUUID()}`, specialty: 'Psicologia' },
  });

  const patient = await fixturePrisma.patient.create({
    data: { tenantId: tenant.id, name: `Paciente Dedicado — ${label} ${randomUUID()}`, phone: '11999999999' },
  });

  const fixture: DedicatedFixture = {
    tenantId: tenant.id,
    therapistId: therapist.id,
    patientId: patient.id,
    patientIds: [patient.id],
    therapistIds: [therapist.id],
    userIds: [],
    appointmentIds: [],
    sessionIds: [],
    billingIds: [],
    paymentIds: [],
  };

  if (options.withActiveSubscription) {
    const subscription = await fixturePrisma.clinicSubscription.create({
      data: {
        tenantId: tenant.id,
        plan: PlanTier.professional,
        billingCycle: BillingCycle.monthly,
        status: SubscriptionStatus.active,
      },
    });
    fixture.subscriptionId = subscription.id;
  }

  if (options.withAvailabilityCalendar) {
    const calendar = await fixturePrisma.availabilityCalendar.create({
      data: {
        tenantId: tenant.id,
        therapistId: therapist.id,
        windows: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
          dayOfWeek,
          startTime: '00:00',
          endTime: '23:59',
          sessionDurationMinutes: 60,
        })),
      },
    });
    fixture.calendarId = calendar.id;
  }

  if (options.withClinicSettings) {
    const settings = await fixturePrisma.clinicSettings.create({
      data: { tenantId: tenant.id },
    });
    fixture.clinicSettingsId = settings.id;
  }

  return fixture;
}

/**
 * Cria um User dedicado (senha real, via AuthService.hashPassword — mesmo
 * padrão já usado em recurring-blocks-api.test.ts, C5) e loga via HTTP real
 * — só para arquivos que fazem requisição HTTP de verdade e precisam de um
 * token JWT válido.
 *
 * `role` é opcional (default `admin`) — adicionado pela AD-003 para permitir
 * que um mesmo Tenant dedicado tenha Users de papéis diferentes (necessário
 * para validar RolesGuard: sucesso com o papel permitido, 403 com o papel
 * proibido, sucesso com super_admin). Todos os 8 arquivos existentes que já
 * chamam esta função com 4 argumentos continuam recebendo um User `admin`,
 * sem nenhuma mudança de comportamento.
 */
export async function createDedicatedUserAndLogin(
  fixturePrisma: PrismaClient,
  app: INestApplication,
  fixture: DedicatedFixture,
  label: string,
  role: UserRole = UserRole.admin,
): Promise<string> {
  const password = `dedicated-${label.toLowerCase()}-2026`;
  const email = `${role}-${randomUUID()}@${label.toLowerCase()}.luxora.dev`;
  const user = await fixturePrisma.user.create({
    data: {
      tenantId: fixture.tenantId,
      email,
      passwordHash: await AuthService.hashPassword(password),
      role,
    },
  });
  fixture.userId = user.id;
  fixture.userIds.push(user.id);
  fixture.token = await loginAs(app, email, password);
  return fixture.token;
}

/**
 * Apaga exclusivamente os registros cujo id foi capturado em `fixture` —
 * nunca uma condição ampla por tenantId. Ordem explícita e documentada,
 * respeitando as FKs (filhos antes dos pais):
 *
 *   Payment → BillingSession → Billing → Session → Appointment →
 *   AvailabilityCalendar → User → ClinicSubscription → Patient →
 *   Therapist → Tenant
 *
 * BillingSession é a única exceção "por relação, não por id próprio": a API
 * nunca devolve o id de uma BillingSession (é criada implicitamente por
 * POST /billings), então a única forma de removê-la sem uma consulta extra
 * de descoberta é filtrar pelo `billingId` — que É um id conhecido,
 * capturado em `fixture.billingIds` no momento da criação da Billing.
 *
 * DUAS CORREÇÕES FEITAS APÓS FALHA REAL NA IMPLEMENTAÇÃO (não presumidas —
 * descobertas ao rodar os 5 arquivos e ver `tenant.delete()`/`patient.delete()`
 * falharem por FK):
 *
 * 1. `audit_log` TEM FK para `tenant_id` — apagar o Tenant é impossível
 *    enquanto existir qualquer linha de auditoria referenciando-o. A busca
 *    original por "nunca apagar audit_log" (imutabilidade, Teste Crítico
 *    #11) precisou ser revista: aqui o delete é escopado por
 *    `fixture.tenantId` — um id conhecido, gerado e possuído exclusivamente
 *    por esta fixture (nunca compartilhado com nenhum outro Tenant) — não é
 *    a mesma coisa que um `WHERE tenantId = X` genérico contra um Tenant
 *    compartilhado, onde haveria risco real de atingir dado de outro teste.
 *
 * 2. `GerarCobrancaUseCase.execute()` (billing.use-cases.ts, produção, fora
 *    do escopo desta etapa) salva a `Billing` e só DEPOIS tenta
 *    `linkSessions()` — se a sessão já estiver cobrada, `linkSessions()`
 *    lança e a Billing já salva NUNCA é revertida (não há transação
 *    envolvendo as duas chamadas). Uma requisição rejeitada com
 *    SESSION_ALREADY_BILLED (409) ainda deixa uma `Billing` real no banco,
 *    que a API nunca devolve id nenhum para o teste rastrear (o corpo da
 *    resposta 409 só tem `{ error: {...} }`). Por isso o cleanup de Billing
 *    não pode depender só de `fixture.billingIds` — busca também por
 *    `patientId`, um id igualmente conhecido e exclusivo desta fixture
 *    (nenhum outro Patient nunca reusa este id), nunca por `tenantId` solto.
 *
 * AD-034 — RESILIÊNCIA: se beforeAll falhar antes de createDedicatedFixture()
 * retornar (ex.: bootstrapTestApp() ou uma chamada HTTP anterior lançar),
 * `fixture` nunca chega a ser atribuída no arquivo de teste — chamar este
 * cleanup com `fixture` undefined não deve lançar um erro secundário que
 * mascare a falha real do beforeAll (era exatamente isso que acontecia em
 * recurring-blocks-api.test.ts antes de migrar para este helper). Por isso
 * a função retorna cedo, silenciosamente, quando não há nada para limpar.
 */
export async function cleanupDedicatedFixture(fixturePrisma: PrismaClient, fixture: DedicatedFixture | undefined): Promise<void> {
  if (!fixture) {
    return;
  }

  // Billing: união do que foi explicitamente rastreado (fixture.billingIds)
  // com o que existir para fixture.patientId — cobre o caso de uma Billing
  // órfã deixada por uma requisição rejeitada (ver nota 2 acima). patientId
  // é um id conhecido e exclusivo da fixture, não uma busca ampla.
  const billingsForPatient = await fixturePrisma.billing.findMany({
    where: { patientId: fixture.patientId },
    select: { id: true },
  });
  const billingIds = Array.from(new Set([...fixture.billingIds, ...billingsForPatient.map((b) => b.id)]));

  if (fixture.paymentIds.length > 0) {
    await fixturePrisma.payment.deleteMany({ where: { id: { in: fixture.paymentIds } } });
  }
  if (billingIds.length > 0) {
    await fixturePrisma.billingSession.deleteMany({ where: { billingId: { in: billingIds } } });
    await fixturePrisma.billing.deleteMany({ where: { id: { in: billingIds } } });
  }
  if (fixture.sessionIds.length > 0) {
    await fixturePrisma.session.deleteMany({ where: { id: { in: fixture.sessionIds } } });
  }
  if (fixture.appointmentIds.length > 0) {
    await fixturePrisma.appointment.deleteMany({ where: { id: { in: fixture.appointmentIds } } });
  }
  if (fixture.calendarId) {
    await fixturePrisma.availabilityCalendar.delete({ where: { id: fixture.calendarId } });
  }
  // audit_log — ver nota 1 acima: escopado por fixture.tenantId, um id
  // exclusivo desta fixture, necessário pela FK audit_log_tenant_id_fkey.
  await fixturePrisma.auditLog.deleteMany({ where: { tenantId: fixture.tenantId } });
  // notification — Epic 12 (AD-021), mesma justificativa do audit_log acima:
  // notification_tenant_id_fkey é ON DELETE RESTRICT, então tenant.delete()
  // falha se sobrar qualquer Notification apontando para fixture.tenantId.
  await fixturePrisma.notification.deleteMany({ where: { tenantId: fixture.tenantId } });
  // userIds — coleção (AD-003, mesmo padrão de therapistIds): cobre todos os
  // Users criados por createDedicatedUserAndLogin() na fixture, não só o
  // último (fixture.userId/token continuam apontando pra ele, só por
  // compatibilidade de leitura).
  if (fixture.userIds.length > 0) {
    await fixturePrisma.user.deleteMany({ where: { id: { in: fixture.userIds } } });
  }
  if (fixture.subscriptionId) {
    await fixturePrisma.clinicSubscription.delete({ where: { id: fixture.subscriptionId } });
  }
  if (fixture.clinicSettingsId) {
    await fixturePrisma.clinicSettings.delete({ where: { id: fixture.clinicSettingsId } });
  }
  // patientIds — coleção (AD-003 Etapa 4, mesmo padrão de therapistIds):
  // cobre o paciente principal e qualquer paciente extra dedicado que um
  // teste tenha criado no mesmo Tenant (ex.: pacientes em estado Ativo/
  // Inativo específico para testar deactivate/reactivate/discharge).
  if (fixture.patientIds.length > 0) {
    await fixturePrisma.patient.deleteMany({ where: { id: { in: fixture.patientIds } } });
  }
  // therapistIds — coleção (ver interface acima): cobre o terapeuta
  // principal e qualquer terapeuta extra que um teste tenha criado no mesmo
  // Tenant dedicado, sem exigir um campo ad hoc por teste (AD-034).
  if (fixture.therapistIds.length > 0) {
    await fixturePrisma.therapist.deleteMany({ where: { id: { in: fixture.therapistIds } } });
  }
  await fixturePrisma.tenant.delete({ where: { id: fixture.tenantId } });
}
