'use client';

import { usePatients, useBillings } from '@/lib/api-client/dashboard.hooks';
import { StatCard } from '@/components/ui/stat-card';
import { SideNav } from '@/components/ui/side-nav';
import { formatCurrencyBRL } from '@/lib/format-currency';

/**
 * DashboardPage — Módulo 15.
 * Fonte: 02 - CTO/clinicos/docs/06-UX/02-Fluxo-Dashboard.md.
 *
 * Composto a partir dos endpoints reais já existentes (GET /patients,
 * GET /billings) — não há um endpoint dedicado GET /dashboard/summary
 * ainda (dívida registrada no README deste módulo).
 */
export default function DashboardPage() {
  const { data: patientsData, isLoading: loadingPatients } = usePatients();
  const { data: billingsData, isLoading: loadingBillings } = useBillings();

  const activePatients = patientsData?.data.filter((p) => p.state === 'Ativo').length ?? 0;
  const overdueBillings = billingsData?.data.filter((b) => b.state === 'atrasada' || b.state === 'Atrasada').length ?? 0;
  const totalPending = billingsData?.data
    .filter((b) => b.state !== 'quitada' && b.state !== 'Quitada')
    .reduce((sum, b) => sum + b.amount, 0);

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

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
          <StatCard label="Pacientes ativos" value={loadingPatients ? '—' : activePatients} tone="gold" />
          <StatCard label="Cobranças em atraso" value={loadingBillings ? '—' : overdueBillings} />
          <StatCard
            label="Total a receber"
            value={loadingBillings ? '—' : formatCurrencyBRL(totalPending ?? 0)}
          />
        </div>

        <section style={{ marginTop: '2.5rem' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.375rem', fontWeight: 500 }}>
            Pacientes recentes
          </h2>
          {loadingPatients && <p style={{ color: 'var(--sage)' }}>Carregando...</p>}
          {!loadingPatients && (patientsData?.data.length ?? 0) === 0 && (
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
