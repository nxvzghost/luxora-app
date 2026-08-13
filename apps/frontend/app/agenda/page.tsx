'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest, ApiError } from '@/lib/api-client/client';
import { useAuthStore } from '@/lib/stores/auth.store';
import { SideNav } from '@/components/ui/side-nav';
import { Button } from '@/components/ui/button';
import { useConfirmAppointment, useCancelAppointment } from '@/lib/api-client/appointments.hooks';

interface Appointment {
  id: string;
  patientId: string;
  therapistId: string;
  scheduledAt: string;
  state: string;
  recurring: boolean;
}

const STATE_LABELS: Record<string, string> = {
  Criada: 'Criado',
  Reservada: 'Reservado',
  Confirmada: 'Confirmado',
  ReagendamentoSolicitado: 'Reagendamento solicitado',
  Reagendada: 'Reagendado',
  Cancelada: 'Cancelado',
};

/**
 * AgendaPage — Módulo 15.
 * Fonte: 06-UX/03-Fluxo-Agendamento.md.
 *
 * DÍVIDA: lista simples por enquanto, não uma visão de calendário
 * completa (semana/mês) como o fluxo original imaginava.
 */
export default function AgendaPage() {
  const token = useAuthStore((s) => s.accessToken);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['appointments-today'],
    queryFn: () => {
      const from = new Date().toISOString();
      const to = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      return apiRequest<{ data: Appointment[] }>(`/appointments?from=${from}&to=${to}`, { token });
    },
    enabled: !!token,
  });
  const confirmAppointment = useConfirmAppointment();
  const cancelAppointment = useCancelAppointment();
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleConfirm(id: string) {
    setActionError(null);
    try {
      await confirmAppointment.mutateAsync(id);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Não foi possível confirmar a consulta.');
    }
  }

  async function handleCancel(id: string) {
    setActionError(null);
    try {
      await cancelAppointment.mutateAsync(id);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Não foi possível cancelar a consulta.');
    }
  }

  return (
    <div style={{ display: 'flex' }}>
      <SideNav />
      <main style={{ flex: 1, padding: '2.5rem' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', margin: '0 0 1.5rem' }}>
          Agenda
        </h1>

        {isLoading && <p style={{ color: 'var(--sage)' }}>Carregando...</p>}
        {isError && (
          <p style={{ color: 'var(--danger)', fontSize: '0.875rem' }} role="alert">
            Não foi possível carregar a agenda. Tente novamente.
          </p>
        )}
        {!isLoading && !isError && (data?.data.length ?? 0) === 0 && (
          <p style={{ color: 'var(--sage)' }}>Nenhuma consulta nos próximos dias.</p>
        )}
        {actionError && (
          <p style={{ color: 'var(--danger)', fontSize: '0.875rem' }} role="alert">
            {actionError}
          </p>
        )}

        <ul style={{ listStyle: 'none', padding: 0 }}>
          {data?.data.map((appt) => {
            const isConfirming = confirmAppointment.isPending && confirmAppointment.variables === appt.id;
            const isCancelling = cancelAppointment.isPending && cancelAppointment.variables === appt.id;
            const canConfirm = appt.state !== 'Confirmada' && appt.state !== 'Cancelada';
            const canCancel = appt.state !== 'Cancelada';

            return (
              <li
                key={appt.id}
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
                <span>{new Date(appt.scheduledAt).toLocaleString('pt-BR')}</span>
                <span
                  style={{
                    fontSize: '0.8125rem',
                    fontWeight: 600,
                    padding: '0.25rem 0.625rem',
                    borderRadius: '999px',
                    background: appt.state === 'Confirmada' ? 'var(--success)' : 'var(--gold-soft)',
                    color: appt.state === 'Confirmada' ? '#fff' : 'var(--forest-ink)',
                  }}
                >
                  {STATE_LABELS[appt.state] ?? appt.state}
                </span>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {canConfirm && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={isConfirming || isCancelling}
                      onClick={() => handleConfirm(appt.id)}
                    >
                      {isConfirming ? 'Confirmando...' : 'Confirmar'}
                    </Button>
                  )}
                  {canCancel && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={isConfirming || isCancelling}
                      onClick={() => handleCancel(appt.id)}
                    >
                      {isCancelling ? 'Cancelando...' : 'Cancelar'}
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
