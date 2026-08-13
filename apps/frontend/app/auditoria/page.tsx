'use client';

import { SideNav } from '@/components/ui/side-nav';
import { useAuditLog } from '@/lib/api-client/audit.hooks';

const ACTOR_LABELS: Record<string, string> = {
  user: 'Usuário',
  ai_agent: 'IA',
  system: 'Sistema',
};

/**
 * AuditoriaPage — Fase 9.5 (AD-029). Somente leitura, sem paginação,
 * filtros, ordenação ou mutações.
 *
 * Dívida registrada: `AuditLogEntry` (contrato do backend) não expõe
 * data/hora do evento — limitação do contrato HTTP, não desta tela.
 */
export default function AuditoriaPage() {
  const { data, isLoading, isError } = useAuditLog();

  return (
    <div style={{ display: 'flex' }}>
      <SideNav />
      <main style={{ flex: 1, padding: '2.5rem' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', marginBottom: '1.5rem' }}>Auditoria</h1>

        {isLoading && <p style={{ color: 'var(--sage)' }}>Carregando...</p>}
        {isError && (
          <p style={{ color: 'var(--danger)', fontSize: '0.875rem' }} role="alert">
            Não foi possível carregar a auditoria. Tente novamente.
          </p>
        )}
        {!isLoading && !isError && (data?.data.length ?? 0) === 0 && <p style={{ color: 'var(--sage)' }}>Nenhum registro de auditoria ainda.</p>}

        <ul style={{ listStyle: 'none', padding: 0 }}>
          {data?.data.map((entry) => (
            <li
              key={entry.id}
              style={{
                padding: '1rem',
                background: '#fff',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                marginBottom: '0.5rem',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <p style={{ margin: 0, fontWeight: 600 }}>{entry.action}</p>
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    padding: '0.2rem 0.5rem',
                    borderRadius: '999px',
                    background: entry.result === 'success' ? 'var(--success)' : 'var(--danger)',
                    color: '#fff',
                  }}
                >
                  {entry.result === 'success' ? 'Sucesso' : 'Falha'}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--sage)' }}>
                {ACTOR_LABELS[entry.actorType] ?? entry.actorType} · {entry.entityType} ({entry.entityId})
              </p>
              {entry.payload && (
                <pre
                  style={{
                    marginTop: '0.5rem',
                    padding: '0.625rem',
                    background: 'var(--paper)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '0.75rem',
                    overflowX: 'auto',
                  }}
                >
                  {JSON.stringify(entry.payload, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
