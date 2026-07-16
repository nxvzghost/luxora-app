import { PlanTier } from '@/lib/api-client/subscription.hooks';
import { formatCurrencyBRL } from '@/lib/format-currency';

// Preços oficiais mensais — precisam bater com MONTHLY_PRICE_BRL em
// apps/backend/src/domain/subscription/clinic-subscription.entity.ts.
// Bug real corrigido: enterprise estava em 2990, deveria ser 2490.
const PLAN_LABELS: Record<PlanTier, { name: string; monthlyPrice: number; tagline: string }> = {
  professional: { name: 'Professional', monthlyPrice: 597, tagline: 'Tudo liberado, sem limitação escondida.' },
  business: { name: 'Business', monthlyPrice: 997, tagline: 'Para clínicas com equipe.' },
  enterprise: { name: 'Enterprise', monthlyPrice: 2490, tagline: 'Implantação personalizada e consultoria semanal.' },
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
      </div>
    </button>
  );
}
