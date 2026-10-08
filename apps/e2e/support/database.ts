import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ADMIN_DATABASE_URL, assertDisposableDatabase } from './env';

/**
 * Preparação e limpeza dos dados de cada teste.
 *
 * Cada teste ganha uma clínica só sua (clínica, assinatura ativa, terapeuta,
 * pacientes e usuários), criada direto no banco descartável e removida ao
 * fim — passe ou falhe. Nada é compartilhado entre testes, então a ordem de
 * execução não importa e eles podem rodar em paralelo.
 *
 * O que é AÇÃO de negócio (disponibilidade, consulta, cobrança, pagamento)
 * nunca é feito aqui: isso os testes fazem pela tela.
 *
 * O client do Prisma e o bcrypt são os do próprio backend, carregados da
 * pasta dele — sem cópia do schema nem dependência duplicada.
 */
const backendRequire = createRequire(path.resolve(__dirname, '../../backend/package.json'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- o tipo real vive no pacote do backend
const { PrismaClient } = backendRequire('@prisma/client') as { PrismaClient: new (options: unknown) => any };
const bcrypt = backendRequire('bcrypt') as { hash(password: string, rounds: number): Promise<string> };

/** Senha de todos os usuários de teste. Existe só no banco descartável. */
export const TEST_PASSWORD = 'senha-de-teste-e2e-2026';

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

export interface TestClinic {
  tenantId: string;
  name: string;
  admin: TestUser;
  therapistUser: TestUser;
  therapist: { id: string; name: string };
  patients: Array<{ id: string; name: string }>;
}

export interface CreateClinicOptions {
  /** Já grava horários de atendimento (todos os dias, 08:00–18:00, sessões de 50 min) para o teste não depender da tela de Disponibilidade. */
  withAvailability?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let passwordHash: Promise<string> | undefined;

function prisma() {
  if (!client) {
    assertDisposableDatabase(ADMIN_DATABASE_URL);
    client = new PrismaClient({ datasources: { db: { url: ADMIN_DATABASE_URL } } });
  }
  return client;
}

export async function createClinic(options: CreateClinicOptions = {}): Promise<TestClinic> {
  const db = prisma();
  const tag = randomUUID().slice(0, 8);
  // Custo baixo de propósito: é uma senha de teste, e a suíte cria uma clínica por teste.
  passwordHash ??= bcrypt.hash(TEST_PASSWORD, 4);
  const hash = await passwordHash;

  const tenant = await db.tenant.create({ data: { name: `Clínica E2E ${tag}` } });
  await db.clinicSettings.create({ data: { tenantId: tenant.id } });
  await db.clinicSubscription.create({ data: { tenantId: tenant.id, plan: 'professional', billingCycle: 'monthly', status: 'active' } });

  const therapist = await db.therapist.create({ data: { tenantId: tenant.id, name: `Dra. Helena Prado ${tag}`, specialty: 'Psicologia' } });
  const patients = [];
  for (const [index, name] of [`Ana Souza ${tag}`, `Bruno Lima ${tag}`].entries()) {
    // Telefones fictícios (faixa 5541 90000-xxxx), só para preencher o cadastro.
    const patient = await db.patient.create({ data: { tenantId: tenant.id, name, phone: `+55419000${String(index).padStart(5, '0')}`, state: 'Ativo' } });
    patients.push({ id: patient.id, name });
  }

  const admin = await db.user.create({ data: { tenantId: tenant.id, email: `admin-${tag}@e2e.luxora.test`, passwordHash: hash, role: 'admin' } });
  const therapistUser = await db.user.create({
    data: { tenantId: tenant.id, email: `terapeuta-${tag}@e2e.luxora.test`, passwordHash: hash, role: 'therapist', therapistId: therapist.id },
  });

  if (options.withAvailability) {
    await db.availabilityCalendar.create({
      data: {
        tenantId: tenant.id,
        therapistId: therapist.id,
        windows: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startTime: '08:00', endTime: '18:00', sessionDurationMinutes: 50 })),
      },
    });
  }

  return {
    tenantId: tenant.id,
    name: tenant.name,
    admin: { id: admin.id, email: admin.email, password: TEST_PASSWORD },
    therapistUser: { id: therapistUser.id, email: therapistUser.email, password: TEST_PASSWORD },
    therapist: { id: therapist.id, name: therapist.name },
    patients,
  };
}

/** Desativa um usuário como o painel faz: o acesso acaba e os refresh tokens já emitidos deixam de valer. */
export async function deactivateUser(userId: string): Promise<void> {
  await prisma().user.update({ where: { id: userId }, data: { deletedAt: new Date(), tokenVersion: { increment: 1 } } });
}

/**
 * Apaga tudo o que pertence à clínica do teste, dos filhos para os pais.
 * Sempre pelo id da clínica criada aqui — nunca uma condição mais ampla.
 */
export async function removeClinic(tenantId: string): Promise<void> {
  const db = prisma();
  const where = { where: { tenantId } };
  const models = [
    'payment',
    'billingSession',
    'billing',
    'session',
    'appointment',
    'recurringBlock',
    'clinicHoliday',
    'availabilityCalendar',
    'notification',
    'auditLog',
    'message',
    'inboxEntry',
    'conversation',
    'messageLog',
    'contactPatientAssociation',
    'contact',
    'whatsAppIntegration',
    'tenantApiKey',
    'aiSettings',
    'user',
    'clinicSubscription',
    'clinicSettings',
    'patient',
    'therapist',
  ];
  for (const model of models) {
    await db[model].deleteMany(where);
  }
  await db.tenant.delete({ where: { id: tenantId } });
}

/** Quantas clínicas de teste ainda existem — usado para provar que a suíte não deixa nada para trás. */
export async function countTestClinics(): Promise<number> {
  return prisma().tenant.count({ where: { name: { startsWith: 'Clínica E2E ' } } });
}

export async function disconnect(): Promise<void> {
  if (client) await client.$disconnect();
  client = undefined;
}
