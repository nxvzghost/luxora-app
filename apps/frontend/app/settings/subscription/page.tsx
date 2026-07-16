'use client';

import { useState } from 'react';
import { SideNav } from '@/components/ui/side-nav';
import { Button } from '@/components/ui/button';
import { PlanCard } from '@/components/ui/plan-card';
import {
  useSubscription,
  useCreateSubscription,
  useAttachCreditCard,
  PlanTier,
  BillingCycle,
} from '@/lib/api-client/subscription.hooks';
import { ApiError } from '@/lib/api-client/client';

/**
 * SubscriptionPage — Módulo 17. Checkout "modelo Netflix" (ADR-0037):
 * tudo dentro do próprio app, nunca redirecionamento externo.
 *
 * DÍVIDA REGISTRADA: o número do cartão passa por este formulário direto
 * para o endpoint do Backend, que repassa à Asaas na mesma chamada — nunca
 * fica em nenhuma variável de estado após o envio, nunca é logado. O ideal
 * de mercado seria tokenizar o cartão direto no navegador via SDK da
 * própria Asaas (nunca trafegar o número pelo nosso próprio Backend, nem
 * de passagem) — não implementado neste MVP por prazo, documentado aqui
 * como próximo passo de segurança antes de operar com cartão em escala.
 */
export default function SubscriptionPage() {
  const { data: subscription, isLoading, isError } = useSubscription();
  const createSubscription = useCreateSubscription();
  const attachCard = useAttachCreditCard();

  const [plan, setPlan] = useState<PlanTier>('professional');
  const [billingCycle, setBillingCycle] = useState<BillingCycle>('monthly');
  const [billingType, setBillingType] = useState<'CREDIT_CARD' | 'PIX'>('CREDIT_CARD');
  const [clinicName, setClinicName] = useState('');
  const [clinicEmail, setClinicEmail] = useState('');
  const [clinicCpfCnpj, setClinicCpfCnpj] = useState('');
  const [card, setCard] = useState({ holderName: '', number: '', expiryMonth: '', expiryYear: '', ccv: '' });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const hasSubscription = !isLoading && !isError && subscription;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createSubscription.mutateAsync({
        plan,
        billingCycle,
        clinicName,
        clinicEmail,
        clinicCpfCnpj,
        billingType,
      });

      if (billingType === 'CREDIT_CARD') {
        await attachCard.mutateAsync({
          ...card,
          holderEmail: clinicEmail,
          holderCpfCnpj: clinicCpfCnpj,
        });
      }

      setSuccess(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível processar a assinatura.');
    }
  }

  if (hasSubscription) {
    return (
      <div style={{ display: 'flex' }}>
        <SideNav />
        <main style={{ flex: 1, padding: '2.5rem', maxWidth: '480px' }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem' }}>Sua assinatura</h1>
          <div style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '1.5rem' }}>
            <p style={{ margin: 0, color: 'var(--sage)', fontSize: '0.8125rem' }}>Plano</p>
            <p style={{ margin: '0.25rem 0 1rem', fontSize: '1.25rem', fontWeight: 700 }}>{subscription.plan}</p>
            <p style={{ margin: 0, color: 'var(--sage)', fontSize: '0.8125rem' }}>Status</p>
            <p
              style={{
                display: 'inline-block',
                marginTop: '0.25rem',
                padding: '0.25rem 0.625rem',
                borderRadius: '999px',
                fontSize: '0.8125rem',
                fontWeight: 600,
                background: subscription.status === 'Active' || subscription.status === 'Trialing' ? 'var(--success)' : 'var(--danger)',
                color: '#fff',
              }}
            >
              {subscription.status}
            </p>
          </div>
        </main>
      </div>
    );
  }

  if (success) {
    return (
      <div style={{ display: 'flex' }}>
        <SideNav />
        <main style={{ flex: 1, padding: '2.5rem' }}>
          <p style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem' }}>Assinatura criada! 😊</p>
          <p style={{ color: 'var(--sage)' }}>
            {billingType === 'PIX'
              ? 'Assim que o pagamento PIX for confirmado, seu acesso é liberado automaticamente.'
              : 'Seu cartão foi registrado. O acesso é liberado assim que o primeiro pagamento for confirmado.'}
          </p>
        </main>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex' }}>
      <SideNav />
      <main style={{ flex: 1, padding: '2.5rem', maxWidth: '640px' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', marginBottom: '0.25rem' }}>Escolha seu plano</h1>
        <p style={{ color: 'var(--sage)', marginTop: 0, marginBottom: '2rem' }}>
          Tudo dentro do app — sem boleto, sem chave PIX pra copiar.
        </p>

        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
          <Button variant={billingCycle === 'monthly' ? 'primary' : 'ghost'} onClick={() => setBillingCycle('monthly')} type="button">
            Mensal
          </Button>
          <Button variant={billingCycle === 'yearly' ? 'primary' : 'ghost'} onClick={() => setBillingCycle('yearly')} type="button">
            Anual (10% off)
          </Button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
          {(['professional', 'business', 'enterprise'] as PlanTier[]).map((p) => (
            <PlanCard key={p} plan={p} billingCycle={billingCycle} selected={plan === p} onSelect={() => setPlan(p)} />
          ))}
        </div>

        <form onSubmit={handleSubmit}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem', fontWeight: 500 }}>Dados da clínica</h2>
          <input placeholder="Nome da clínica" required value={clinicName} onChange={(e) => setClinicName(e.target.value)} style={inputStyle} />
          <input placeholder="E-mail" type="email" required value={clinicEmail} onChange={(e) => setClinicEmail(e.target.value)} style={inputStyle} />
          <input placeholder="CPF ou CNPJ" required value={clinicCpfCnpj} onChange={(e) => setClinicCpfCnpj(e.target.value)} style={inputStyle} />

          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem', fontWeight: 500, marginTop: '1.5rem' }}>
            Forma de pagamento
          </h2>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
            <Button variant={billingType === 'CREDIT_CARD' ? 'primary' : 'ghost'} type="button" onClick={() => setBillingType('CREDIT_CARD')}>
              Cartão de crédito
            </Button>
            <Button variant={billingType === 'PIX' ? 'primary' : 'ghost'} type="button" onClick={() => setBillingType('PIX')}>
              PIX
            </Button>
          </div>

          {billingType === 'PIX' && (
            <p style={{ fontSize: '0.8125rem', color: 'var(--sage)', marginBottom: '1rem' }}>
              PIX recorrente pede confirmação a cada ciclo — vamos te lembrar perto da renovação.
            </p>
          )}

          {billingType === 'CREDIT_CARD' && (
            <>
              <input placeholder="Nome no cartão" required value={card.holderName} onChange={(e) => setCard({ ...card, holderName: e.target.value })} style={inputStyle} />
              <input placeholder="Número do cartão" required value={card.number} onChange={(e) => setCard({ ...card, number: e.target.value })} style={inputStyle} />
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input placeholder="MM" required value={card.expiryMonth} onChange={(e) => setCard({ ...card, expiryMonth: e.target.value })} style={{ ...inputStyle, width: '80px' }} />
                <input placeholder="AAAA" required value={card.expiryYear} onChange={(e) => setCard({ ...card, expiryYear: e.target.value })} style={{ ...inputStyle, width: '100px' }} />
                <input placeholder="CVV" required value={card.ccv} onChange={(e) => setCard({ ...card, ccv: e.target.value })} style={{ ...inputStyle, width: '80px' }} />
              </div>
            </>
          )}

          {error && (
            <p style={{ color: 'var(--danger)', fontSize: '0.8125rem', marginTop: '0.75rem' }} role="alert">
              {error}
            </p>
          )}

          <Button type="submit" disabled={createSubscription.isPending} style={{ width: '100%', marginTop: '1.5rem' }}>
            {createSubscription.isPending ? 'Processando...' : 'Assinar agora'}
          </Button>
        </form>
      </main>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.625rem 0.75rem',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)',
  fontSize: '0.9375rem',
  fontFamily: 'var(--font-body)',
  marginBottom: '0.625rem',
};
