'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRole, useSignOut, type Role } from '@/lib/session';
import { useUnreadNotificationCount } from '@/lib/api-client/notifications.hooks';

/**
 * `only` restringe o item a um perfil — as rotas da API por trás dessas
 * telas são só de admin, e mostrar o link a quem vai receber "sem
 * permissão" só confunde. Sem perfil identificado, todos aparecem: quem
 * decide o acesso é sempre o backend.
 */
const links: Array<{ href: string; label: string; only?: Role }> = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/agenda', label: 'Agenda' },
  { href: '/disponibilidade', label: 'Disponibilidade' },
  { href: '/pacientes', label: 'Pacientes' },
  { href: '/terapeutas', label: 'Terapeutas' },
  { href: '/financeiro', label: 'Financeiro' },
  { href: '/notificacoes', label: 'Notificações' },
  { href: '/usuarios', label: 'Usuários', only: 'admin' },
  { href: '/auditoria', label: 'Auditoria', only: 'admin' },
  { href: '/configuracoes', label: 'Configurações' },
  { href: '/settings/subscription', label: 'Assinatura', only: 'admin' },
];

export function SideNav() {
  const pathname = usePathname();
  const role = useRole();
  const signOut = useSignOut();
  const { data: unread } = useUnreadNotificationCount();
  const unreadCount = unread?.count ?? 0;

  return (
    <nav
      aria-label="Principal"
      style={{
        width: '220px',
        borderRight: '1px solid var(--border)',
        padding: '1.5rem 1rem',
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <p style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', color: 'var(--forest)', margin: '0 0 2rem 0.5rem' }}>
        Luxora
      </p>
      {links
        .filter((link) => !link.only || !role || link.only === role)
        .map((link) => {
          const active = pathname === link.href;
          const showBadge = link.href === '/notificacoes' && unreadCount > 0;
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? 'page' : undefined}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '0.625rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                fontSize: '0.9375rem',
                fontWeight: 600,
                marginBottom: '0.25rem',
                color: active ? 'var(--paper)' : 'var(--ink)',
                background: active ? 'var(--forest)' : 'transparent',
              }}
            >
              {link.label}
              {showBadge && (
                <span
                  aria-label={`${unreadCount} não lidas`}
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    padding: '0.05rem 0.45rem',
                    borderRadius: '999px',
                    background: 'var(--gold)',
                    color: 'var(--forest-ink)',
                  }}
                >
                  {unreadCount}
                </span>
              )}
            </Link>
          );
        })}

      <button
        type="button"
        onClick={() => void signOut()}
        style={{
          marginTop: 'auto',
          padding: '0.625rem 0.75rem',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border)',
          background: 'transparent',
          color: 'var(--forest)',
          fontFamily: 'var(--font-body)',
          fontSize: '0.9375rem',
          fontWeight: 600,
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        Sair
      </button>
    </nav>
  );
}
