'use client';

import Link from 'next/link';
import { useQueries } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client/client';
import { isNotFound } from '@/lib/api-client/errors';
import { useAuthStore } from '@/lib/stores/auth.store';
import { useClinic } from '@/lib/api-client/clinic.hooks';
import { useTherapists } from '@/lib/api-client/therapists.hooks';
import { usePatients } from '@/lib/api-client/dashboard.hooks';
import { useUsers } from '@/lib/api-client/users.hooks';
import type { AvailabilityCalendar } from '@/lib/api-client/availability.hooks';
import { cardStyle, hintStyle, sectionTitleStyle } from '@/components/ui/page-shell';

type StepState = 'done' | 'todo' | 'unknown';

/**
 * OnboardingChecklist — Tarefa 05 da auditoria. O mínimo para uma clínica
 * preparar o sistema para um piloto: uma lista do que falta configurar, com
 * o link de cada tela. Não é um assistente e não guarda nada — cada item é
 * calculado, na hora, a partir do que a API já devolve.
 *
 * Aparece só para admin (as telas de configuração são dele) e some quando
 * tudo o que dá para conferir está pronto. Se algum dado não carregar, não
 * mostra nada: a lista é uma ajuda, não pode virar mais um erro na tela.
 */
export function OnboardingChecklist() {
  const token = useAuthStore((s) => s.accessToken);
  const clinic = useClinic();
  const therapists = useTherapists();
  const patients = usePatients();
  const users = useUsers();
  const therapistIds = (therapists.data?.data ?? []).map((therapist) => therapist.id);

  const calendars = useQueries({
    queries: therapistIds.map((therapistId) => ({
      queryKey: ['availability-calendar', therapistId],
      queryFn: async (): Promise<AvailabilityCalendar> => {
        try {
          return await apiRequest<AvailabilityCalendar>(`/therapists/${therapistId}/availability/calendar`, { token });
        } catch (error) {
          if (isNotFound(error)) return { therapistId, windows: [], exceptions: [] };
          throw error;
        }
      },
      enabled: !!token,
      retry: false,
    })),
  });

  const loaded = [clinic, therapists, patients, users].every((query) => query.isSuccess) && calendars.every((query) => query.isSuccess);
  if (!loaded) return null;

  const steps: Array<{ label: string; detail: string; href: string; state: StepState }> = [
    {
      label: 'Dados de recebimento',
      detail: 'Chave PIX e nome do beneficiário, usados na mensagem de cobrança.',
      href: '/configuracoes',
      state: clinic.data?.pixKey && clinic.data?.payeeName ? 'done' : 'todo',
    },
    { label: 'Terapeutas', detail: 'Quem atende na clínica.', href: '/terapeutas', state: therapistIds.length > 0 ? 'done' : 'todo' },
    {
      label: 'Horários de atendimento',
      detail: 'Sem eles, a agenda não oferece horário nenhum.',
      href: '/disponibilidade',
      state: calendars.some((query) => (query.data?.windows.length ?? 0) > 0) ? 'done' : 'todo',
    },
    {
      label: 'Acesso da equipe',
      detail: 'Um usuário para cada pessoa que vai usar o painel.',
      href: '/usuarios',
      state: (users.data?.data.filter((user) => user.isActive).length ?? 0) > 1 ? 'done' : 'todo',
    },
    {
      label: 'WhatsApp da clínica',
      detail: 'Canal por onde saem cobranças e avisos. Não dá para conferir daqui se já está conectado.',
      href: '/configuracoes',
      state: 'unknown',
    },
    { label: 'Pacientes', detail: 'Cadastro de quem é atendido.', href: '/pacientes', state: (patients.data?.data.length ?? 0) > 0 ? 'done' : 'todo' },
  ];

  const pending = steps.filter((step) => step.state === 'todo').length;
  if (pending === 0) return null;
  const checkable = steps.filter((step) => step.state !== 'unknown').length;

  return (
    <section style={{ ...cardStyle, marginTop: '2rem' }} aria-label="Primeiros passos">
      <h2 style={sectionTitleStyle}>Primeiros passos</h2>
      <p style={{ ...hintStyle, marginTop: 0, marginBottom: '0.75rem' }}>
        {checkable - pending} de {checkable} prontos. Depois disso, a primeira consulta já pode ser marcada na Agenda.
      </p>
      <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {steps.map((step) => (
          <li key={step.label} style={{ display: 'flex', gap: '0.75rem', alignItems: 'baseline', padding: '0.375rem 0' }}>
            <span aria-hidden="true" style={{ width: '1.25rem', color: step.state === 'done' ? 'var(--success)' : 'var(--sage)' }}>
              {step.state === 'done' ? '✓' : step.state === 'todo' ? '○' : '?'}
            </span>
            <span>
              <Link href={step.href} style={{ fontWeight: 600, textDecoration: 'underline' }}>
                {step.label}
              </Link>
              <span style={{ fontSize: '0.8125rem', color: 'var(--sage)' }}>
                {' '}
                — {step.state === 'done' ? 'pronto' : step.state === 'todo' ? 'falta fazer' : 'confira'}. {step.detail}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
