'use client';

import { useState } from 'react';
import { PageShell, rowStyle } from '@/components/ui/page-shell';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, EmptyState, ErrorMessage, Loading, SuccessMessage } from '@/components/ui/feedback';
import { type NotificationItem, useMarkNotificationRead, useNotifications } from '@/lib/api-client/notifications.hooks';
import { useResendBilling } from '@/lib/api-client/billing.hooks';
import { useRole } from '@/lib/session';
import { describeApiError } from '@/lib/api-client/errors';
import { useClinicTimeZone } from '@/lib/api-client/clinic.hooks';
import { formatInZone } from '@/lib/clinic-time';

/**
 * NotificacoesPage — Tarefa 05 da auditoria. Mostra as notificações
 * internas que a API já gera (hoje, pagamento com valor divergente) e
 * permite marcá-las como lidas. Nenhum canal externo, nenhuma regra nova.
 *
 * ADR-0066 — o aviso de falha de envio ou de entrega de uma cobrança traz o
 * botão "Reenviar cobrança" (só para o administrador, como na API).
 */
const BILLING_FAILURE_TYPES = ['whatsapp_send_failed', 'whatsapp_delivery_failed'];

function canResend(notification: NotificationItem): boolean {
  return notification.readAt === null && notification.entityType === 'Billing' && !!notification.entityId && BILLING_FAILURE_TYPES.includes(notification.type);
}

export default function NotificacoesPage() {
  const { data, isLoading, isError, error } = useNotifications();
  const markRead = useMarkNotificationRead();
  // AD-039 — a hora do aviso é mostrada na hora da clínica.
  const { timeZone } = useClinicTimeZone();
  const [actionError, setActionError] = useState<string | null>(null);
  const isAdmin = useRole() === 'admin';
  const resendBilling = useResendBilling();
  const [toResend, setToResend] = useState<NotificationItem | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const notifications = data?.data ?? [];

  async function handleResend() {
    if (!toResend?.entityId) return;
    setResendError(null);
    try {
      await resendBilling.mutateAsync(toResend.entityId);
      setSuccess('Cobrança reenviada. Se falhar de novo, um aviso novo aparece aqui.');
      setToResend(null);
    } catch (err) {
      setResendError(describeApiError(err, 'Não foi possível reenviar a cobrança.'));
    }
  }

  async function handleMarkRead(id: string) {
    setActionError(null);
    try {
      await markRead.mutateAsync(id);
    } catch (err) {
      setActionError(describeApiError(err, 'Não foi possível marcar a notificação como lida.'));
    }
  }

  return (
    <PageShell title="Notificações" maxWidth="760px">
      {isLoading && <Loading />}
      {isError && <ErrorMessage>{describeApiError(error, 'Não foi possível carregar as notificações.')}</ErrorMessage>}
      {!isLoading && !isError && notifications.length === 0 && (
        <EmptyState>Nenhuma notificação. Os avisos da clínica aparecem aqui quando houver algo para conferir.</EmptyState>
      )}
      <ErrorMessage>{actionError}</ErrorMessage>
      <SuccessMessage>{success}</SuccessMessage>

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {notifications.map((notification) => {
          const unread = notification.readAt === null;
          const marking = markRead.isPending && markRead.variables === notification.id;
          return (
            <li key={notification.id} style={{ ...rowStyle, borderLeft: unread ? '4px solid var(--gold)' : rowStyle.border }}>
              <div>
                <p style={{ margin: 0, fontWeight: unread ? 700 : 600 }}>{notification.title}</p>
                <p style={{ margin: '0.25rem 0', fontSize: '0.9375rem' }}>{notification.message}</p>
                <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--sage)' }}>
                  {formatInZone(notification.createdAt, { dateStyle: 'short', timeStyle: 'medium' }, timeZone)}
                  {!unread && ' · lida'}
                </p>
              </div>
              {unread && (
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {isAdmin && canResend(notification) && (
                    <Button
                      type="button"
                      onClick={() => {
                        setSuccess(null);
                        setResendError(null);
                        setToResend(notification);
                      }}
                    >
                      Reenviar cobrança
                    </Button>
                  )}
                  <Button type="button" variant="ghost" disabled={marking} onClick={() => handleMarkRead(notification.id)}>
                    {marking ? 'Marcando...' : 'Marcar como lida'}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {toResend && (
        <ConfirmDialog
          title="Reenviar a cobrança pelo WhatsApp?"
          description={
            <>
              A mesma mensagem de cobrança vai de novo para o paciente, e este aviso é dado por tratado. Reenvie depois de corrigir o
              motivo do aviso — por exemplo, reconectar o WhatsApp. Se o motivo foi a janela de 24 horas, a mensagem só chega depois que o
              paciente escrever para a clínica. O reenvio fica registrado no seu usuário.
            </>
          }
          confirmLabel="Reenviar"
          busyLabel="Reenviando..."
          busy={resendBilling.isPending}
          error={resendError}
          onConfirm={handleResend}
          onCancel={() => setToResend(null)}
        />
      )}
    </PageShell>
  );
}
