import { PlanTier } from '@domain/subscription/clinic-subscription.entity';

/**
 * Tabela de benefícios por plano — Módulo 17.
 * Fonte: tabela aprovada pelo CEO (ver também
 * `LUXORA/01 - CEO/07 - Planos e precificacao/MODELO.md`, fora deste
 * repositório). Única fonte de verdade no código — nenhum limite ou
 * liberação por plano deve ser hardcoded em outro lugar além deste arquivo.
 *
 * REGRA DE NEGÓCIO — terapeutas por plano (revisão 2026-07-18, PD-005):
 * Professional e Business são ambos de uso individual (1 terapeuta) —
 * diferem entre si só pelas outras linhas da tabela (BI, API, suporte),
 * nunca por quantidade de terapeutas. Enterprise é contratado POR CLÍNICA
 * (Tenant) — nunca compartilhado entre clínicas de um mesmo grupo — com um
 * teto comercial atual de 5 terapeutas. Esse "5" é só um valor de
 * configuração aqui, não uma regra arquitetural: mudar para outro número
 * no futuro não exige nenhum refactor, só editar este arquivo.
 *
 * Não existe (e não deve existir) herança de plano entre Tenants de uma
 * mesma organização — cada clínica tem sua própria ClinicSubscription,
 * seus próprios limites, seu próprio ciclo de cobrança. Um eventual
 * agrupador organizacional (Account) acima do Tenant, se um dia for
 * implementado, não deve carregar PlanTier nem lógica de billing — ver
 * `docs/11-Product-Decisions/PD-005-Multiunidade/`.
 *
 * PENDÊNCIAS (registradas aqui de propósito, não implementadas ainda):
 *
 * - `externalApiAccess`: infraestrutura de autenticação implementada
 *   (PD-003 — TenantApiKey, GerarApiKeyUseCase, TenantApiKeyGuard,
 *   reavaliado a cada uso). Superfície pública CONGELADA por decisão
 *   deliberada (PD-004, 2026-07-18): nenhum endpoint de negócio conectado
 *   ao guard até existir validação comercial real de um cliente/prospect
 *   pedindo isso — não é falta de tempo, é decisão de produto. Ver
 *   `docs/11-Product-Decisions/PD-004-Primeiro-Endpoint-da-API/`.
 * - `multiUnit`: não existe como conceito no banco (Tenant é 1:1 com uma
 *   clínica, sem tabela de unidades). Liberar/bloquear por plano exigiria
 *   decidir o modelo de dados primeiro — decisão de arquitetura já tomada
 *   em PD-005 (Account como agrupador puramente organizacional, sem
 *   billing), mas a entidade em si ainda não foi construída. Não
 *   implementado.
 * - `advancedReporting` / `executiveDashboard`: nenhum dos dois existe no
 *   código (Módulo 16 - Observabilidade nunca foi implementado). Não faz
 *   sentido gatear o que não existe — ambos ficam só documentados aqui.
 *
 * O único benefício com enforcement real implementado hoje é
 * `maxTherapists`, em CadastrarTerapeutaUseCase.
 *
 * PRIORITY 5 (PD-003, CEO-DEC-002.1): 'individual' e 'completo' existem
 * como valores válidos de PlanTier, mas deliberadamente NÃO têm entrada
 * nesta tabela — CEO-DEC-002.3 reserva benefícios e limites ao Catálogo
 * Comercial Oficial, nunca a este arquivo. Mesmo o teto de 1 terapeuta do
 * Individual, já aprovado em CEO-DEC-002.4, não foi antecipado aqui — ele
 * cabe na primeira vez que o Catálogo Comercial definir a linha completa
 * do plano, não isolado. Use `getPlanBenefits()`, nunca indexação direta
 * (`PLAN_BENEFITS[plan]`), em qualquer código novo.
 */
export interface PlanBenefits {
  /** Teto de terapeutas para este plano. null = ilimitado (não usado por nenhum plano hoje; mantido para acomodar um futuro plano Corporate/Multi-Clinic sem precisar de refactor). */
  maxTherapists: number | null;
  unlimitedPatients: true;
  fullAvailabilityEngine: true;
  whatsappAiAgent: true;
  /** Enterprise recebe configuração dedicada do agente — os outros planos usam a configuração padrão. */
  whatsappDedicatedSetup: boolean;
  financialAndOverdueRoutine: true;
  multiUnit: boolean;
  advancedReporting: boolean;
  externalApiAccess: boolean;
  support: 'standard' | 'priority' | 'dedicated';
  assistedOnboarding: boolean;
  weeklyStrategicConsulting: boolean;
  executiveDashboard: boolean;
}

export const PLAN_BENEFITS: Partial<Record<PlanTier, PlanBenefits>> = {
  professional: {
    maxTherapists: 1,
    unlimitedPatients: true,
    fullAvailabilityEngine: true,
    whatsappAiAgent: true,
    whatsappDedicatedSetup: false,
    financialAndOverdueRoutine: true,
    multiUnit: false,
    advancedReporting: false,
    externalApiAccess: false,
    support: 'standard',
    assistedOnboarding: false,
    weeklyStrategicConsulting: false,
    executiveDashboard: false,
  },
  business: {
    // Uso individual, igual ao Professional — Business se diferencia pelas
    // demais linhas (BI, API, suporte), nunca por quantidade de terapeutas.
    maxTherapists: 1,
    unlimitedPatients: true,
    fullAvailabilityEngine: true,
    whatsappAiAgent: true,
    whatsappDedicatedSetup: false,
    financialAndOverdueRoutine: true,
    multiUnit: false,
    advancedReporting: true,
    externalApiAccess: true,
    support: 'priority',
    assistedOnboarding: false,
    weeklyStrategicConsulting: false,
    executiveDashboard: false,
  },
  enterprise: {
    // Teto comercial atual, por clínica (nunca compartilhado entre Tenants
    // de um mesmo grupo) — valor de configuração, não arquitetural.
    maxTherapists: 5,
    unlimitedPatients: true,
    fullAvailabilityEngine: true,
    whatsappAiAgent: true,
    whatsappDedicatedSetup: true,
    financialAndOverdueRoutine: true,
    multiUnit: true,
    advancedReporting: true,
    externalApiAccess: true,
    support: 'dedicated',
    assistedOnboarding: true,
    weeklyStrategicConsulting: true,
    executiveDashboard: true,
  },
  // 'individual' e 'completo': deliberadamente ausentes — ver nota acima.
};

/**
 * Ponto único de leitura de PLAN_BENEFITS — nunca indexar a constante
 * diretamente fora deste arquivo. Lança erro explícito para planos ainda
 * sem benefícios configurados ('individual'/'completo', Priority 5) em vez
 * de deixar o acesso falhar silenciosamente com `undefined`.
 */
export function getPlanBenefits(plan: PlanTier): PlanBenefits {
  const benefits = PLAN_BENEFITS[plan];
  if (!benefits) {
    throw new Error(
      `Benefícios do plano "${plan}" ainda não configurados no Catálogo Comercial Oficial da Luxora.`,
    );
  }
  return benefits;
}
