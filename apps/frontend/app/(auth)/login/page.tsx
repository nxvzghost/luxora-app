'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest, ApiError } from '@/lib/api-client/client';
import { describeApiError } from '@/lib/api-client/errors';
import { useAuthStore } from '@/lib/stores/auth.store';
import { Button } from '@/components/ui/button';

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
}

export default function LoginPage() {
  const router = useRouter();
  const setTokens = useAuthStore((s) => s.setTokens);
  const accessToken = useAuthStore((s) => s.accessToken);
  const sessionExpired = useAuthStore((s) => s.sessionExpired);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Tarefa 05 — quem já tem sessão não precisa ver o formulário de novo
  // (voltar pelo navegador, abrir /login num link antigo).
  useEffect(() => {
    if (accessToken) router.replace('/dashboard');
  }, [accessToken, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await apiRequest<LoginResponse>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      setTokens(result.accessToken, result.refreshToken);
      router.push('/dashboard');
    } catch (err) {
      // No login, 401 é senha ou e-mail errado — a frase do servidor é a certa.
      setError(
        err instanceof ApiError && err.status === 401
          ? err.message
          : describeApiError(err, 'Não foi possível entrar. Confira os dados e tente novamente.'),
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
      }}
    >
      <div
        className="luxora-glow"
        style={{
          width: '100%',
          maxWidth: '400px',
          background: '#fff',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '2.5rem',
          zIndex: 1,
        }}
      >
        <div style={{ position: 'relative', zIndex: 1 }}>
          <p
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: '1.75rem',
              margin: 0,
              color: 'var(--forest)',
            }}
          >
            Luxora
          </p>
          <p style={{ color: 'var(--sage)', fontSize: '0.875rem', marginTop: '0.25rem', marginBottom: '2rem' }}>
            Tecnologia que ilumina decisões.
          </p>

          {sessionExpired && (
            <p role="status" style={{ fontSize: '0.8125rem', background: 'var(--gold-soft)', padding: '0.625rem 0.75rem', borderRadius: 'var(--radius-sm)', marginTop: 0 }}>
              Sua sessão foi encerrada. Entre novamente para continuar.
            </p>
          )}

          <form onSubmit={handleSubmit}>
            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, marginBottom: '0.375rem' }}>
              E-mail
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={inputStyle}
            />

            <label
              style={{
                display: 'block',
                fontSize: '0.8125rem',
                fontWeight: 600,
                marginBottom: '0.375rem',
                marginTop: '1rem',
              }}
            >
              Senha
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={inputStyle}
            />

            {error && (
              <p style={{ color: 'var(--danger)', fontSize: '0.8125rem', marginTop: '0.75rem' }} role="alert">
                {error}
              </p>
            )}

            <Button type="submit" disabled={loading} style={{ width: '100%', marginTop: '1.5rem' }}>
              {loading ? 'Entrando...' : 'Entrar'}
            </Button>
          </form>
        </div>
      </div>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.625rem 0.75rem',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)',
  fontSize: '0.9375rem',
  fontFamily: 'var(--font-body)',
};
