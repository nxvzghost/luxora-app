'use client';

import { SideNav } from '@/components/ui/side-nav';

/** Moldura das telas novas da Tarefa 05: navegação lateral, título e a área de ações do topo. */
export function PageShell(props: { title: string; actions?: React.ReactNode; maxWidth?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex' }}>
      <SideNav />
      <main style={{ flex: 1, padding: '2.5rem', maxWidth: props.maxWidth }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', margin: 0 }}>{props.title}</h1>
          {props.actions}
        </div>
        {props.children}
      </main>
    </div>
  );
}

export const cardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)',
  padding: '1.5rem',
  marginBottom: '1.5rem',
};

export const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '1rem',
  padding: '1rem',
  background: '#fff',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  marginBottom: '0.5rem',
};

export const sectionTitleStyle: React.CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: '1.25rem',
  fontWeight: 500,
  margin: '0 0 0.75rem',
};

export const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.8125rem',
  fontWeight: 600,
  marginBottom: '0.375rem',
  marginTop: '0.875rem',
};

export const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.625rem 0.75rem',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)',
  fontSize: '0.9375rem',
  fontFamily: 'var(--font-body)',
  background: '#fff',
};

export const hintStyle: React.CSSProperties = { fontSize: '0.8125rem', color: 'var(--sage)', margin: '0.25rem 0 0' };
