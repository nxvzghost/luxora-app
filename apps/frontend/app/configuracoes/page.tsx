'use client';

import { useState, useEffect } from 'react';
import { SideNav } from '@/components/ui/side-nav';
import { Button } from '@/components/ui/button';
import { useClinic, useUpdateClinicPolicies, useUpdatePaymentInfo } from '@/lib/api-client/clinic.hooks';
import { ApiError } from '@/lib/api-client/client';

/**
 * ConfiguracoesPage — Módulo 15 (revisão geral, tela que faltava).
 */
export default function ConfiguracoesPage() {
  const { data: clinic, isLoading } = useClinic();
  const updatePolicies = useUpdateClinicPolicies();
  const updatePaymentInfo = useUpdatePaymentInfo();

  const [billingPolicy, setBillingPolicy] = useState('per_session');
  const [cancellationHours, setCancellationHours] = useState('');
  const [sessionDuration, setSessionDuration] = useState('50');
  const [pixKey, setPixKey] = useState('');
  const [payeeName, setPayeeName] = useState('');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (clinic) {
      setBillingPolicy(clinic.defaultBillingPolicy);
      setCancellationHours(clinic.cancellationHoursLimit?.toString() ?? '');
      setSessionDuration(clinic.defaultSessionDurationMinutes.toString());
      setPixKey(clinic.pixKey ?? '');
      setPayeeName(clinic.payeeName ?? '');
    }
  }, [clinic]);

  async function handleSavePolicies(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    try {
      await updatePolicies.mutateAsync({
        defaultBillingPolicy: billingPolicy,
        cancellationHoursLimit: cancellationHours ? Number(cancellationHours) : undefined,
        defaultSessionDurationMinutes: Number(sessionDuration),
      });
      setMessage({ type: 'success', text: 'Políticas salvas.' });
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof ApiError ? err.message : 'Erro ao salvar.' });
    }
  }

  async function handleSavePayment(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    try {
      await updatePaymentInfo.mutateAsync({ pixKey, payeeName });
      setMessage({ type: 'success', text: 'Dados de pagamento salvos.' });
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof ApiError ? err.message : 'Erro ao salvar.' });
    }
  }

  return (
    <div style={{ display: 'flex' }}>
      <SideNav />
      <main style={{ flex: 1, padding: '2.5rem', maxWidth: '560px' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', marginBottom: '1.5rem' }}>Configurações</h1>

        {isLoading && <p style={{ color: 'var(--sage)' }}>Carregando...</p>}

        {message && (
          <p style={{ color: message.type === 'error' ? 'var(--danger)' : 'var(--success)', fontSize: '0.875rem' }}>
            {message.text}
          </p>
        )}

        {!isLoading && (
          <>
            <section style={sectionStyle}>
              <h2 style={sectionTitleStyle}>Políticas da clínica</h2>
              <form onSubmit={handleSavePolicies}>
                <label style={labelStyle}>Política de cobrança padrão</label>
                <select value={billingPolicy} onChange={(e) => setBillingPolicy(e.target.value)} style={inputStyle}>
                  <option value="per_session">Por sessão</option>
                  <option value="weekly">Semanal</option>
                  <option value="monthly">Mensal</option>
                </select>

                <label style={labelStyle}>Limite de horas para cancelamento sem custo</label>
                <input
                  type="number"
                  placeholder="Ex: 24"
                  value={cancellationHours}
                  onChange={(e) => setCancellationHours(e.target.value)}
                  style={inputStyle}
                />

                <label style={labelStyle}>Duração padrão da sessão (minutos)</label>
                <input
                  type="number"
                  required
                  value={sessionDuration}
                  onChange={(e) => setSessionDuration(e.target.value)}
                  style={inputStyle}
                />

                <Button type="submit" disabled={updatePolicies.isPending} style={{ marginTop: '0.5rem' }}>
                  {updatePolicies.isPending ? 'Salvando...' : 'Salvar políticas'}
                </Button>
              </form>
            </section>

            <section style={sectionStyle}>
              <h2 style={sectionTitleStyle}>Dados de recebimento (PIX)</h2>
              <p style={{ fontSize: '0.8125rem', color: 'var(--sage)', marginTop: 0 }}>
                Usado no template de cobrança enviado ao paciente pelo WhatsApp.
              </p>
              <form onSubmit={handleSavePayment}>
                <label style={labelStyle}>Chave PIX</label>
                <input value={pixKey} onChange={(e) => setPixKey(e.target.value)} style={inputStyle} />

                <label style={labelStyle}>Nome do beneficiário</label>
                <input value={payeeName} onChange={(e) => setPayeeName(e.target.value)} style={inputStyle} />

                <Button type="submit" disabled={updatePaymentInfo.isPending} style={{ marginTop: '0.5rem' }}>
                  {updatePaymentInfo.isPending ? 'Salvando...' : 'Salvar dados de pagamento'}
                </Button>
              </form>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

const sectionStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)',
  padding: '1.5rem',
  marginBottom: '1.5rem',
};

const sectionTitleStyle: React.CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: '1.25rem',
  fontWeight: 500,
  marginTop: 0,
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.8125rem',
  fontWeight: 600,
  marginBottom: '0.375rem',
  marginTop: '0.875rem',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.625rem 0.75rem',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)',
  fontSize: '0.9375rem',
  fontFamily: 'var(--font-body)',
};
