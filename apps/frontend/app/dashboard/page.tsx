'use client';

import { usePatients } from '@/lib/api-client/dashboard.hooks';
import { useDashboardSummary } from '@/lib/api-client/dashboard-summary.hooks';
import { StatCard } from '@/components/ui/stat-card';
import { SideNav } from '@/components/ui/side-nav';
import { formatCurrencyBRL } from '@/lib/format-currency';

/**
 * DashboardPage — Epic 11 (AD-019).
 * Fonte: 02 - CTO/clinicos/docs/06-UX/02-Fluxo-Dashboard.md.
 *
 * Os 3 indicadores agora vêm de GET /dashboard/summary (agregação real no
 * backend, sem filter/reduce client-side). usePatients() segue em uso
 * apenas para "Pacientes recentes", que não é um indicador agregado.
 */
export default function DashboardPage() {
  const { data: summary, isLoading: loadingSummary, isError: errorSummary } = useDashboardSummary();
  const { data: patientsData, isLoading: loadingPatients, isError: errorPatients } = usePatients();
  const hasError = errorSummary || errorPatients;

  return (
    <div style={{ display: 'flex' }}>
      <SideNav />
      <main style={{ flex: 1, padding: '2.5rem' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', margin: '0 0 0.25rem' }}>
          Bom dia. 😊
        </h1>
        <p style={{ color: 'var(--sage)', marginTop: 0, marginBottom: '2rem' }}>
          Aqui está o resumo da sua clínica hoje.
        </p>

        {hasError && (
          <p style={{ color: 'var(--danger)', fontSize: '0.875rem', marginBottom: '1.5rem' }} role="alert">
            Não foi possível carregar todos os dados do resumo. Tente novamente.
          </p>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
          <StatCard label="Pacientes ativos" value={loadingSummary ? '—' : summary?.activePatients ?? 0} tone="gold" />
          <StatCard label="Cobranças em atraso" value={loadingSummary ? '—' : summary?.overdueBillings ?? 0} />
          <StatCard
            label="Total a receber"
            value={loadingSummary ? '—' : formatCurrencyBRL(summary?.totalPending ?? 0)}
          />
        </div>

        <section style={{ marginTop: '2.5rem' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.375rem', fontWeight: 500 }}>
            Pacientes recentes
          </h2>
          {loadingPatients && <p style={{ color: 'var(--sage)' }}>Carregando...</p>}
          {!loadingPatients && !errorPatients && (patientsData?.data.length ?? 0) === 0 && (
            <p style={{ color: 'var(--sage)' }}>Nenhum paciente cadastrado ainda.</p>
          )}
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {patientsData?.data.slice(0, 5).map((patient) => (
              <li
                key={patient.id}
                style={{
                  padding: '0.875rem 1rem',
                  background: '#fff',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  marginBottom: '0.5rem',
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <span>{patient.name}</span>
                <span style={{ color: 'var(--sage)', fontSize: '0.8125rem' }}>{patient.state}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
