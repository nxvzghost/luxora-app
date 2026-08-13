'use client';

import { useState } from 'react';
import { SideNav } from '@/components/ui/side-nav';
import { StatCard } from '@/components/ui/stat-card';
import { Button } from '@/components/ui/button';
import { useBillings, usePatients } from '@/lib/api-client/dashboard.hooks';
import { useSendBilling, useRegisterPayment } from '@/lib/api-client/billing.hooks';
import { ApiError } from '@/lib/api-client/client';
import { formatCurrencyBRL } from '@/lib/format-currency';

const STATE_LABELS: Record<string, string> = {
  Pendente: 'Pendente',
  Enviada: 'Enviada',
  Atrasada: 'Atrasada',
  Quitada: 'Quitada',
  Cancelada: 'Cancelada',
};

const STATE_COLORS: Record<string, string> = {
  Quitada: 'var(--success)',
  Atrasada: 'var(--danger)',
  Enviada: 'var(--gold-soft)',
  Pendente: 'var(--border)',
};

/**
 * FinanceiroPage — Módulo 15 (revisão geral, tela que faltava).
 */
export default function FinanceiroPage() {
  const { data: billingsData, isLoading, isError: errorBillings } = useBillings();
  const { data: patientsData, isError: errorPatients } = usePatients();
  const hasError = errorBillings || errorPatients;
  const sendBilling = useSendBilling();
  const registerPayment = useRegisterPayment();
  const [actionError, setActionError] = useState<string | null>(null);

  const patientName = (patientId: string) => patientsData?.data.find((p) => p.id === patientId)?.name ?? patientId;

  async function handleSend(billingId: string) {
    setActionError(null);
    try {
      await sendBilling.mutateAsync(billingId);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Não foi possível enviar a cobrança.');
    }
  }

  async function handleRegisterPayment(billingId: string, amount: number) {
    setActionError(null);
    try {
      await registerPayment.mutateAsync({ billingId, amount });
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Não foi possível registrar o pagamento.');
    }
  }

  const total = billingsData?.data.reduce((sum, b) => sum + b.amount, 0) ?? 0;
  const received = billingsData?.data.filter((b) => b.state === 'Quitada').reduce((sum, b) => sum + b.amount, 0) ?? 0;
  const overdue = billingsData?.data.filter((b) => b.state === 'Atrasada').length ?? 0;

  return (
    <div style={{ display: 'flex' }}>
      <SideNav />
      <main style={{ flex: 1, padding: '2.5rem' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', marginBottom: '1.5rem' }}>Financeiro</h1>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
          <StatCard label="Total faturado" value={formatCurrencyBRL(total)} tone="gold" />
          <StatCard label="Recebido" value={formatCurrencyBRL(received)} />
          <StatCard label="Cobranças em atraso" value={overdue} />
        </div>

        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.375rem', fontWeight: 500 }}>Cobranças</h2>

        {isLoading && <p style={{ color: 'var(--sage)' }}>Carregando...</p>}
        {hasError && (
          <p style={{ color: 'var(--danger)', fontSize: '0.875rem' }} role="alert">
            Não foi possível carregar os dados financeiros. Tente novamente.
          </p>
        )}
        {!isLoading && !hasError && (billingsData?.data.length ?? 0) === 0 && <p style={{ color: 'var(--sage)' }}>Nenhuma cobrança gerada ainda.</p>}
        {actionError && (
          <p style={{ color: 'var(--danger)', fontSize: '0.875rem' }} role="alert">
            {actionError}
          </p>
        )}

        <ul style={{ listStyle: 'none', padding: 0 }}>
          {billingsData?.data.map((billing) => {
            const isSending = sendBilling.isPending && sendBilling.variables === billing.id;
            const isRegisteringPayment = registerPayment.isPending && registerPayment.variables?.billingId === billing.id;
            const canSend = billing.state === 'Criada';
            const canRegisterPayment = billing.state !== 'Quitada' && billing.state !== 'Cancelada';

            return (
              <li
                key={billing.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '1rem',
                  background: '#fff',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  marginBottom: '0.5rem',
                  gap: '1rem',
                }}
              >
                <div>
                  <p style={{ margin: 0, fontWeight: 600 }}>{patientName(billing.patientId)}</p>
                  <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--sage)' }}>
                    Vencimento: {new Date(billing.dueDate).toLocaleDateString('pt-BR')}
                  </p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <p style={{ margin: '0 0 0.25rem', fontWeight: 700 }}>{formatCurrencyBRL(billing.amount)}</p>
                  <span
                    style={{
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      padding: '0.2rem 0.5rem',
                      borderRadius: '999px',
                      background: STATE_COLORS[billing.state] ?? 'var(--border)',
                      color: billing.state === 'Quitada' || billing.state === 'Atrasada' ? '#fff' : 'var(--forest-ink)',
                    }}
                  >
                    {STATE_LABELS[billing.state] ?? billing.state}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {canSend && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={isSending || isRegisteringPayment}
                      onClick={() => handleSend(billing.id)}
                    >
                      {isSending ? 'Enviando...' : 'Enviar'}
                    </Button>
                  )}
                  {canRegisterPayment && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={isSending || isRegisteringPayment}
                      onClick={() => handleRegisterPayment(billing.id, billing.amount)}
                    >
                      {isRegisteringPayment ? 'Registrando...' : 'Registrar pagamento'}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </main>
    </div>
  );
}
