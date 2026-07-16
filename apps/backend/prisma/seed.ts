/**
 * Seed de desenvolvimento — Luxora
 * Fonte: docs/09-Testes/00-Estrategia-de-Testes.md, seção "Dados de teste"
 *
 * Regra: TODO ambiente de desenvolvimento tem múltiplos Tenants desde o
 * início — nenhum teste deve ser escrito assumindo "só existe uma clínica
 * no banco". Isso força que testes de isolamento multi-tenant sejam a
 * regra, não a exceção.
 */
import { PrismaClient, BillingPolicy, UserRole, PatientState, PlanTier, BillingCycle, SubscriptionStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const SEED_PASSWORD = 'luxora-dev-2026'; // apenas ambiente de desenvolvimento — nunca usado em produção

async function main() {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 12);

  // Tenant A — clínica com política padrão por sessão
  const tenantA = await prisma.tenant.create({
    data: {
      name: 'Clínica Teste A',
      clinicSettings: {
        create: { defaultBillingPolicy: BillingPolicy.per_session },
      },
      aiSettings: { create: {} },
    },
  });

  const therapistA = await prisma.therapist.create({
    data: { tenantId: tenantA.id, name: 'Terapeuta A1', specialty: 'Psicologia' },
  });

  // Email GLOBALMENTE único (ADR-0024) — nunca reaproveitar entre Tenants,
  // nem no seed, para não mascarar um bug real de unicidade.
  await prisma.user.create({
    data: {
      tenantId: tenantA.id,
      email: 'admin@clinica-a.luxora.dev',
      passwordHash,
      role: UserRole.admin,
    },
  });
  await prisma.user.create({
    data: {
      tenantId: tenantA.id,
      email: 'terapeuta-a1@clinica-a.luxora.dev',
      passwordHash,
      role: UserRole.therapist,
      therapistId: therapistA.id,
    },
  });

  // Assinatura ativa só para o Tenant A — de propósito, não por descuido.
  // SubscriptionAccessGuard (Módulo 17) bloqueia toda rota (exceto login e a
  // própria tela de assinatura) quando não há ClinicSubscription com acesso
  // ativo — sem isso aqui, nenhuma rota de Paciente/Agenda/Financeiro seria
  // testável localmente. Tenant B fica deliberadamente sem assinatura, para
  // exercitar o caminho bloqueado (SUBSCRIPTION_INACTIVE) sem precisar de
  // um segundo cenário de seed.
  await prisma.clinicSubscription.create({
    data: {
      tenantId: tenantA.id,
      plan: PlanTier.professional,
      billingCycle: BillingCycle.monthly,
      status: SubscriptionStatus.active,
    },
  });

  await prisma.patient.createMany({
    data: [
      { tenantId: tenantA.id, name: 'Paciente A1 (por sessão)', phone: '+5541900000001', state: PatientState.Ativo },
      {
        tenantId: tenantA.id,
        name: 'Paciente A2 (mensal)',
        phone: '+5541900000002',
        state: PatientState.Ativo,
        billingPolicyOverride: BillingPolicy.monthly,
      },
      {
        tenantId: tenantA.id,
        name: 'Paciente A3 (semanal)',
        phone: '+5541900000003',
        state: PatientState.Ativo,
        billingPolicyOverride: BillingPolicy.weekly,
      },
    ],
  });

  // Tenant B — segunda clínica, para validar isolamento (nunca deixar só 1 Tenant no seed)
  const tenantB = await prisma.tenant.create({
    data: {
      name: 'Clínica Teste B',
      clinicSettings: {
        create: { defaultBillingPolicy: BillingPolicy.per_session },
      },
      aiSettings: { create: {} },
    },
  });

  await prisma.therapist.create({
    data: { tenantId: tenantB.id, name: 'Terapeuta B1', specialty: 'Psicanálise' },
  });

  await prisma.user.create({
    data: {
      tenantId: tenantB.id,
      email: 'admin@clinica-b.luxora.dev', // e-mail diferente do Tenant A — valida ADR-0024
      passwordHash,
      role: UserRole.admin,
    },
  });

  await prisma.patient.create({
    data: { tenantId: tenantB.id, name: 'Paciente B1', phone: '+5541900000099', state: PatientState.Ativo },
  });

  // eslint-disable-next-line no-console
  console.log('Seed de desenvolvimento concluído: 2 Tenants, 3 Users, dado suficiente para testes de isolamento e autenticação.');
  // eslint-disable-next-line no-console
  console.log({ tenantA: tenantA.id, tenantB: tenantB.id, therapistA: therapistA.id, senhaDeTeste: SEED_PASSWORD });
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
