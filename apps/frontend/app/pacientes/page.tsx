'use client';

import { useState } from 'react';
import { SideNav } from '@/components/ui/side-nav';
import { Button } from '@/components/ui/button';
import { usePatients, useCreatePatient } from '@/lib/api-client/dashboard.hooks';
import { ApiError } from '@/lib/api-client/client';

const STATE_LABELS: Record<string, string> = {
  Ativo: 'Ativo',
  Inativo: 'Inativo',
  Alta: 'Alta',
};

/**
 * PacientesPage — Módulo 15 (revisão geral, tela que faltava).
 * Fonte: 06-UX/04-Fluxo-Pacientes.md.
 */
export default function PacientesPage() {
  const { data, isLoading, isError } = usePatients();
  const createPatient = useCreatePatient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createPatient.mutateAsync({ name, phone });
      setName('');
      setPhone('');
      setShowForm(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível cadastrar o paciente.');
    }
  }

  return (
    <div style={{ display: 'flex' }}>
      <SideNav />
      <main style={{ flex: 1, padding: '2.5rem', maxWidth: '720px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', margin: 0 }}>Pacientes</h1>
          <Button onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancelar' : 'Novo paciente'}</Button>
        </div>

        {showForm && (
          <form
            onSubmit={handleSubmit}
            style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '1.5rem', marginBottom: '1.5rem' }}
          >
            <input placeholder="Nome" required value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
            <input placeholder="Telefone (WhatsApp)" required value={phone} onChange={(e) => setPhone(e.target.value)} style={inputStyle} />
            {error && (
              <p style={{ color: 'var(--danger)', fontSize: '0.8125rem' }} role="alert">
                {error}
              </p>
            )}
            <Button type="submit" disabled={createPatient.isPending}>
              {createPatient.isPending ? 'Salvando...' : 'Cadastrar'}
            </Button>
          </form>
        )}

        {isLoading && <p style={{ color: 'var(--sage)' }}>Carregando...</p>}
        {isError && (
          <p style={{ color: 'var(--danger)', fontSize: '0.875rem' }} role="alert">
            Não foi possível carregar os pacientes. Tente novamente.
          </p>
        )}
        {!isLoading && !isError && (data?.data.length ?? 0) === 0 && <p style={{ color: 'var(--sage)' }}>Nenhum paciente cadastrado ainda.</p>}

        <ul style={{ listStyle: 'none', padding: 0 }}>
          {data?.data.map((patient) => (
            <li
              key={patient.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '1rem',
                background: '#fff',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                marginBottom: '0.5rem',
              }}
            >
              <div>
                <p style={{ margin: 0, fontWeight: 600 }}>{patient.name}</p>
                <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--sage)' }}>{patient.phone}</p>
              </div>
              <span
                style={{
                  fontSize: '0.8125rem',
                  fontWeight: 600,
                  padding: '0.25rem 0.625rem',
                  borderRadius: '999px',
                  background: patient.state === 'Ativo' ? 'var(--success)' : 'var(--gold-soft)',
                  color: patient.state === 'Ativo' ? '#fff' : 'var(--forest-ink)',
                }}
              >
                {STATE_LABELS[patient.state] ?? patient.state}
              </span>
            </li>
          ))}
        </ul>
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
