'use client';

import { useState } from 'react';
import { SideNav } from '@/components/ui/side-nav';
import { Button } from '@/components/ui/button';
import { useTherapists, useCreateTherapist } from '@/lib/api-client/therapists.hooks';
import { ApiError } from '@/lib/api-client/client';

/**
 * TerapeutasPage — Fase 9.5 (AD-029). Listagem + criação apenas —
 * edição, disponibilidade e exceções ficam fora de escopo.
 */
export default function TerapeutasPage() {
  const { data, isLoading, isError } = useTherapists();
  const createTherapist = useCreateTherapist();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createTherapist.mutateAsync({ name, specialty: specialty || undefined });
      setName('');
      setSpecialty('');
      setShowForm(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível cadastrar o terapeuta.');
    }
  }

  return (
    <div style={{ display: 'flex' }}>
      <SideNav />
      <main style={{ flex: 1, padding: '2.5rem', maxWidth: '720px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', margin: 0 }}>Terapeutas</h1>
          <Button onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancelar' : 'Novo terapeuta'}</Button>
        </div>

        {showForm && (
          <form
            onSubmit={handleSubmit}
            style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '1.5rem', marginBottom: '1.5rem' }}
          >
            <input placeholder="Nome" required value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
            <input placeholder="Especialidade" value={specialty} onChange={(e) => setSpecialty(e.target.value)} style={inputStyle} />
            {error && (
              <p style={{ color: 'var(--danger)', fontSize: '0.8125rem' }} role="alert">
                {error}
              </p>
            )}
            <Button type="submit" disabled={createTherapist.isPending}>
              {createTherapist.isPending ? 'Salvando...' : 'Cadastrar'}
            </Button>
          </form>
        )}

        {isLoading && <p style={{ color: 'var(--sage)' }}>Carregando...</p>}
        {isError && (
          <p style={{ color: 'var(--danger)', fontSize: '0.875rem' }} role="alert">
            Não foi possível carregar os terapeutas. Tente novamente.
          </p>
        )}
        {!isLoading && !isError && (data?.data.length ?? 0) === 0 && <p style={{ color: 'var(--sage)' }}>Nenhum terapeuta cadastrado ainda.</p>}

        <ul style={{ listStyle: 'none', padding: 0 }}>
          {data?.data.map((therapist) => (
            <li
              key={therapist.id}
              style={{
                padding: '1rem',
                background: '#fff',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                marginBottom: '0.5rem',
              }}
            >
              <p style={{ margin: 0, fontWeight: 600 }}>{therapist.name}</p>
              {therapist.specialty && <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--sage)' }}>{therapist.specialty}</p>}
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
