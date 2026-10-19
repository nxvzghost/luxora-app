import { BillingCycle, PlanTier, PrismaClient, SubscriptionStatus } from '@prisma/client';
import { isIanaTimeZoneName } from '../domain/shared/time-zone';

/**
 * Provisionamento da clínica piloto — A-16 da auditoria (19/10/2026,
 * decisão do responsável pelo produto: entrada manual e documentada, sem
 * cobrança de assinatura). Roteiro completo em
 * docs/07-Infra/ENTRADA_CLINICA_PILOTO.md.
 *
 * Nenhuma rota cria clínica, e quase toda rota exige assinatura ativa. O
 * fluxo de assinatura pela Asaas nunca foi validado em produção e passa
 * número e CVV do cartão pelo backend. Para o piloto, a clínica entra por
 * aqui, em uma transação só:
 *
 * - a clínica (tenant), com o nome informado — recusado se já existir outra
 *   com o mesmo nome, sem diferenciar maiúsculas;
 * - as configurações, com o fuso validado pela base IANA (padrão
 *   America/Sao_Paulo) e o resto nos padrões;
 * - as configurações de IA, nos padrões;
 * - uma assinatura de CORTESIA: ativa, sem nenhum vínculo com a Asaas (sem
 *   cliente nem assinatura lá), então nenhum webhook de cobrança a altera;
 * - o registro na auditoria (`ClinicaProvisionadaParaPiloto`, ator sistema).
 *
 * O administrador NÃO é criado aqui: a própria pessoa o cria pela rota que já
 * existe, `POST /api/v1/users/bootstrap-admin`, escolhendo a senha — este
 * script nunca vê nem imprime senha. Usa a conexão da aplicação
 * (DATABASE_URL, sob RLS), como o seed.
 *
 * Uso, na máquina de desenvolvimento:
 *   pnpm --filter @luxora/backend provision:pilot --nome "Clínica Exemplo" [--fuso America/Sao_Paulo] [--plano enterprise]
 * e, na imagem de produção (só dist/):
 *   node dist/cli/provisionar-clinica-piloto.js --nome "Clínica Exemplo"
 */

export interface ProvisionarClinicaPilotoInput {
  name?: string;
  timeZone?: string;
  plan?: string;
}

export interface ProvisionarClinicaPilotoResult {
  tenantId: string;
  name: string;
  plan: PlanTier;
  timeZone: string;
}

/** Entrada recusada: nada foi gravado. */
export class ProvisionamentoRecusadoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisionamentoRecusadoError';
  }
}

const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';
/** Enterprise: até 5 terapeutas por clínica (PLAN_BENEFITS). O piloto não deve esbarrar no limite de 1 terapeuta. */
const DEFAULT_PLAN = PlanTier.enterprise;

export async function provisionarClinicaPiloto(
  prisma: PrismaClient,
  input: ProvisionarClinicaPilotoInput,
): Promise<ProvisionarClinicaPilotoResult> {
  const name = input.name?.trim() ?? '';
  if (name.length < 3) {
    throw new ProvisionamentoRecusadoError('Informe o nome da clínica (--nome), com pelo menos 3 caracteres.');
  }
  const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE;
  if (!isIanaTimeZoneName(timeZone)) {
    throw new ProvisionamentoRecusadoError(`Fuso inválido: "${timeZone}". Use o nome exato da base IANA, como ${DEFAULT_TIME_ZONE}.`);
  }
  const plans = Object.values(PlanTier) as string[];
  const plan = (input.plan ?? DEFAULT_PLAN) as PlanTier;
  if (!plans.includes(plan)) {
    throw new ProvisionamentoRecusadoError(`Plano inválido: "${input.plan}". Use um destes: ${plans.join(', ')}.`);
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.tenant.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, deletedAt: null } });
    if (existing) {
      throw new ProvisionamentoRecusadoError(`Já existe uma clínica com o nome "${existing.name}" (id ${existing.id}). Nada foi criado.`);
    }

    const tenant = await tx.tenant.create({ data: { name } });
    // As tabelas abaixo estão sob RLS: a clínica da transação é a recém-criada (mesmo recurso do seed).
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
    await tx.clinicSettings.create({ data: { tenantId: tenant.id, timeZone } });
    await tx.aiSettings.create({ data: { tenantId: tenant.id } });
    await tx.clinicSubscription.create({
      data: { tenantId: tenant.id, plan, billingCycle: BillingCycle.monthly, status: SubscriptionStatus.active },
    });
    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        actorType: 'system',
        action: 'ClinicaProvisionadaParaPiloto',
        entityType: 'Tenant',
        entityId: tenant.id,
        payload: { plan, timeZone, cortesia: true },
        result: 'success',
      },
    });

    return { tenantId: tenant.id, name, plan, timeZone };
  });
}

function parseArgs(argv: readonly string[]): Record<string, string | true> {
  const args: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const USAGE = [
  'Uso: provisionar-clinica-piloto --nome "Nome da Clínica" [--fuso America/Sao_Paulo] [--plano enterprise]',
  'Cria a clínica, as configurações e uma assinatura de cortesia, sem cobrança. Roteiro: docs/07-Infra/ENTRADA_CLINICA_PILOTO.md',
  '',
].join('\n');

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.ajuda || args.help) {
    process.stdout.write(USAGE);
    return;
  }
  const text = (value: string | true | undefined) => (typeof value === 'string' ? value : undefined);

  const prisma = new PrismaClient();
  try {
    const result = await provisionarClinicaPiloto(prisma, { name: text(args.nome), timeZone: text(args.fuso), plan: text(args.plano) });
    process.stdout.write(
      [
        'Clínica provisionada para o piloto, sem cobrança de assinatura.',
        `  id da clínica: ${result.tenantId}`,
        `  nome: ${result.name}`,
        `  plano: ${result.plan} (cortesia, sem vínculo com a Asaas)`,
        `  fuso: ${result.timeZone}`,
        'Próximo passo: o administrador da clínica cria o próprio acesso em POST /api/v1/users/bootstrap-admin,',
        '  com { "tenantId": "<id acima>", "email": "...", "password": "..." }. A senha é escolhida por ele.',
        '',
      ].join('\n'),
    );
  } catch (err) {
    if (err instanceof ProvisionamentoRecusadoError) {
      process.stderr.write(`${err.message}\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

// Só como comando: importado (pelos testes, por exemplo), nada roda.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void main();
}
