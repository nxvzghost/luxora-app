/**
 * Seed de desenvolvimento — Luxora
 * Fonte: docs/09-Testes/00-Estrategia-de-Testes.md, seção "Dados de teste"
 *
 * Regra: TODO ambiente de desenvolvimento tem múltiplos Tenants desde o
 * início — nenhum teste deve ser escrito assumindo "só existe uma clínica
 * no banco". Isso força que testes de isolamento multi-tenant sejam a
 * regra, não a exceção.
 *
 * AD-033: com RLS genuinamente ativa (ver prisma/migrations/20260723190000_enable_rls),
 * toda escrita em tabela multi-tenant exige app.tenant_id definido na sessão
 * — a policy tenant_isolation rejeita o INSERT sem isso (current_setting
 * retorna NULL, tenant_id = NULL nunca é verdadeiro). Este script roda fora
 * do NestJS, então não tem acesso a PrismaService.forTenant() (o mecanismo
 * de produção) — withTenantContext() abaixo replica o mesmo efeito (SET
 * LOCAL, escopado à transação do chamador), mas via set_config(), que é uma
 * função SQL normal e aceita bind parameter — nunca concatena o tenantId
 * na query, diferente de PrismaService.forTenant() (que usa
 * $executeRawUnsafe com interpolação, mitigado lá por validação de formato
 * UUID antes — não alterado aqui, fora do escopo desta correção).
 *
 * Nunca usa superusuário nem desabilita RLS — respeita o mesmo modelo de
 * segurança usado em produção.
 */
import {
  PrismaClient,
  Prisma,
  BillingPolicy,
  UserRole,
  PatientState,
  PlanTier,
  BillingCycle,
  SubscriptionStatus,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const SEED_PASSWORD = 'luxora-dev-2026'; // apenas ambiente de desenvolvimento — nunca usado em produção

/**
 * Centraliza o mecanismo de contexto de RLS — único ponto do script que
 * define app.tenant_id. `tx` precisa já ser uma transação aberta pelo
 * chamador (SET LOCAL/set_config(..., true) só tem efeito dentro de uma
 * transação); `tenantId` vai como bind parameter do template tag do
 * Prisma, nunca concatenado na string SQL.
 */
async function withTenantContext<T>(
  tx: Prisma.TransactionClient,
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
  return fn();
}

async function main() {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 12);

  // Tenant A — clínica com política padrão por sessão. Uma única transação
  // cobre a criação do Tenant e de todos os dados que dependem dele —
  // isolamento e rollback parcial garantidos por Tenant (AD-033).
  const tenantA = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({ data: { name: 'Clínica Teste A' } });

    return withTenantContext(tx, tenant.id, async () => {
      await tx.clinicSettings.create({
        data: { tenantId: tenant.id, defaultBillingPolicy: BillingPolicy.per_session },
      });
      await tx.aiSettings.create({ data: { tenantId: tenant.id } });

      const therapist = await tx.therapist.create({
        data: { tenantId: tenant.id, name: 'Terapeuta A1', specialty: 'Psicologia' },
      });

      // AvailabilityCalendar (ADR-0040 / PD-001) — sem isso, o Motor de
      // Disponibilidade recusa QUALQUER criação de Appointment para este
      // terapeuta (nenhum módulo, nem teste, tem atalho para furar o Motor).
      // Janela ampla nos 7 dias da semana para não colidir com test/critical/
      // support/unique-slot.ts, que gera horário aleatório (dia/hora/minuto
      // quaisquer) só para evitar SESSION_CONFLICT entre arquivos concorrentes —
      // não representa a agenda real de uma clínica.
      await tx.availabilityCalendar.create({
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

      // Email GLOBALMENTE único (ADR-0024) — nunca reaproveitar entre Tenants,
      // nem no seed, para não mascarar um bug real de unicidade.
      await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: 'admin@clinica-a.luxora.dev',
          passwordHash,
          role: UserRole.admin,
        },
      });
      await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: 'terapeuta-a1@clinica-a.luxora.dev',
          passwordHash,
          role: UserRole.therapist,
          therapistId: therapist.id,
        },
      });

      // Assinatura ativa só para o Tenant A — de propósito, não por descuido.
      // SubscriptionAccessGuard (Módulo 17) bloqueia toda rota (exceto login e a
      // própria tela de assinatura) quando não há ClinicSubscription com acesso
      // ativo — sem isso aqui, nenhuma rota de Paciente/Agenda/Financeiro seria
      // testável localmente. Tenant B fica deliberadamente sem assinatura, para
      // exercitar o caminho bloqueado (SUBSCRIPTION_INACTIVE) sem precisar de
      // um segundo cenário de seed.
      //
      // plan: enterprise (não professional/business) — desde a implementação do
      // limite de terapeutas por plano (Módulo 17, PLAN_BENEFITS), Professional
      // e Business permitem só 1 terapeuta (uso individual, PD-002); só
      // Enterprise permite mais de 1 (teto de 5, por clínica). Tenant A é
      // compartilhado por vários arquivos de test/critical rodando em
      // paralelo, alguns criando terapeutas próprios além do "Terapeuta A1"
      // seedado — nunca fez sentido modelá-lo como clínica solo. Nenhum teste
      // depende do Tenant A ser especificamente 'professional' ou 'business'.
      await tx.clinicSubscription.create({
        data: {
          tenantId: tenant.id,
          plan: PlanTier.enterprise,
          billingCycle: BillingCycle.monthly,
          status: SubscriptionStatus.active,
        },
      });

      await tx.patient.createMany({
        data: [
          { tenantId: tenant.id, name: 'Paciente A1 (por sessão)', phone: '+5541900000001', state: PatientState.Ativo },
          {
            tenantId: tenant.id,
            name: 'Paciente A2 (mensal)',
            phone: '+5541900000002',
            state: PatientState.Ativo,
            billingPolicyOverride: BillingPolicy.monthly,
          },
          {
            tenantId: tenant.id,
            name: 'Paciente A3 (semanal)',
            phone: '+5541900000003',
            state: PatientState.Ativo,
            billingPolicyOverride: BillingPolicy.weekly,
          },
        ],
      });

      return { id: tenant.id, therapistId: therapist.id };
    });
  });

  // Tenant B — segunda clínica, para validar isolamento (nunca deixar só 1 Tenant no seed)
  const tenantB = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({ data: { name: 'Clínica Teste B' } });

    return withTenantContext(tx, tenant.id, async () => {
      await tx.clinicSettings.create({
        data: { tenantId: tenant.id, defaultBillingPolicy: BillingPolicy.per_session },
      });
      await tx.aiSettings.create({ data: { tenantId: tenant.id } });

      await tx.therapist.create({
        data: { tenantId: tenant.id, name: 'Terapeuta B1', specialty: 'Psicanálise' },
      });

      await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: 'admin@clinica-b.luxora.dev', // e-mail diferente do Tenant A — valida ADR-0024
          passwordHash,
          role: UserRole.admin,
        },
      });

      await tx.patient.create({
        data: { tenantId: tenant.id, name: 'Paciente B1', phone: '+5541900000099', state: PatientState.Ativo },
      });

      return { id: tenant.id };
    });
  });

  // eslint-disable-next-line no-console
  console.log('Seed de desenvolvimento concluído: 2 Tenants, 3 Users, dado suficiente para testes de isolamento e autenticação.');
  // eslint-disable-next-line no-console
  console.log({ tenantA: tenantA.id, tenantB: tenantB.id, therapistA: tenantA.therapistId, senhaDeTeste: SEED_PASSWORD });
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
