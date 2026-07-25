import { PlanTier } from '@/lib/api-client/subscription.hooks';
import { formatCurrencyBRL } from '@/lib/format-currency';

// Preços oficiais mensais — precisam bater com MONTHLY_PRICE_BRL em
// apps/backend/src/domain/subscription/clinic-subscription.entity.ts.
// Bug real corrigido: enterprise estava em 2990, deveria ser 2490.
const PLAN_LABELS: Record<PlanTier, { name: string; monthlyPrice: number; tagline: string }> = {
  professional: { name: 'Professional', monthlyPrice: 597, tagline: 'Ideal para o profissional solo.' },
  business: { name: 'Business', monthlyPrice: 997, tagline: 'Para o profissional autônomo que quer mais: relatórios e integrações.' },
  enterprise: { name: 'Enterprise', monthlyPrice: 2490, tagline: 'Estrutura completa por clínica, com equipe e suporte dedicado.' },
};

// Benefícios exibidos por plano — precisam bater com PLAN_BENEFITS em
// apps/backend/src/domain-services/subscription/plan-benefits.ts (fonte
// única de verdade; nenhum limite real é decidido aqui, só exibido).
//
// Professional e Business são ambos de uso individual (1 terapeuta) — regra
// de negócio confirmada em PD-002. Enterprise é contratado por clínica, com
// teto comercial atual de 5 terapeutas (valor configurável, não fixo).
const PLAN_FEATURE_LIST: Record<PlanTier, string[]> = {
  professional: [
    '1 terapeuta (uso individual)',
    'Pacientes ilimitados',
    'Agenda com Motor de Disponibilidade completo',
    'Agente de IA no WhatsApp',
    'Financeiro + régua de inadimplência',
    'Suporte padrão',
  ],
  business: [
    '1 terapeuta (uso individual)',
    'Pacientes ilimitados',
    'Agenda com Motor de Disponibilidade completo',
    'Agente de IA no WhatsApp',
    'Financeiro + régua de inadimplência',
    'Relatórios / BI avançado',
    'Acesso à API para integrações externas',
    'Suporte prioritário',
  ],
  enterprise: [
    'Até 5 terapeutas por clínica',
    'Pacientes ilimitados',
    'Agenda com Motor de Disponibilidade completo',
    'Agente de IA no WhatsApp (configuração dedicada)',
    'Financeiro + régua de inadimplência',
    'Relatórios / BI avançado',
    'Acesso à API para integrações externas',
    'Suporte dedicado',
    'Implantação + migração de dados assistida',
    'Consultoria estratégica semanal',
    'Dashboard executivo',
  ],
};

export function PlanCard({
  plan,
  billingCycle,
  selected,
  onSelect,
}: {
  plan: PlanTier;
  billingCycle: 'monthly' | 'yearly';
  selected: boolean;
  onSelect: () => void;
}) {
  const info = PLAN_LABELS[plan];
  const features = PLAN_FEATURE_LIST[plan];
  const price = billingCycle === 'monthly' ? info.monthlyPrice : info.monthlyPrice * 12 * 0.9;
  const priceLabel = billingCycle === 'monthly' ? `${formatCurrencyBRL(price)}/mês` : `${formatCurrencyBRL(price)}/ano`;

  return (
    <button
      onClick={onSelect}
      className={selected ? 'luxora-glow' : undefined}
      style={{
        textAlign: 'left',
        cursor: 'pointer',
        padding: '1.5rem',
        borderRadius: 'var(--radius-lg)',
        border: selected ? '2px solid var(--gold)' : '1px solid var(--border)',
        background: '#fff',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div style={{ position: 'relative', zIndex: 1 }}>
        {plan === 'professional' && (
          <span
            style={{
              fontSize: '0.6875rem',
              fontWeight: 700,
              color: 'var(--gold)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Mais popular
          </span>
        )}
        <p style={{ fontFamily: 'var(--font-display)', fontSize: '1.375rem', margin: '0.25rem 0 0', color: 'var(--forest)' }}>
          {info.name}
        </p>
        <p style={{ fontSize: '1.5rem', fontWeight: 700, margin: '0.5rem 0' }}>{priceLabel}</p>
        {billingCycle === 'yearly' && (
          <p style={{ fontSize: '0.75rem', color: 'var(--success)', margin: 0 }}>10% de desconto aplicado</p>
        )}
        <p style={{ fontSize: '0.8125rem', color: 'var(--sage)', marginTop: '0.75rem' }}>{info.tagline}</p>
        <ul style={{ listStyle: 'none', margin: '1rem 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {features.map((feature) => (
            <li key={feature} style={{ fontSize: '0.8125rem', color: 'var(--forest)', display: 'flex', gap: '0.5rem' }}>
              <span style={{ color: 'var(--gold)' }}>✓</span>
              {feature}
            </li>
          ))}
        </ul>
      </div>
    </button>
  );
}
