'use client';

import { useState } from 'react';
import { PageShell, rowStyle } from '@/components/ui/page-shell';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorMessage, Loading } from '@/components/ui/feedback';
import { useMarkNotificationRead, useNotifications } from '@/lib/api-client/notifications.hooks';
import { describeApiError } from '@/lib/api-client/errors';

/**
 * NotificacoesPage — Tarefa 05 da auditoria. Mostra as notificações
 * internas que a API já gera (hoje, pagamento com valor divergente) e
 * permite marcá-las como lidas. Nenhum canal externo, nenhuma regra nova.
 */
export default function NotificacoesPage() {
  const { data, isLoading, isError, error } = useNotifications();
  const markRead = useMarkNotificationRead();
  const [actionError, setActionError] = useState<string | null>(null);
  const notifications = data?.data ?? [];

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
                  {new Date(notification.createdAt).toLocaleString('pt-BR')}
                  {!unread && ' · lida'}
                </p>
              </div>
              {unread && (
                <Button type="button" variant="ghost" disabled={marking} onClick={() => handleMarkRead(notification.id)}>
                  {marking ? 'Marcando...' : 'Marcar como lida'}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </PageShell>
  );
}
