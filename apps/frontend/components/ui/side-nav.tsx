'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const links = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/agenda', label: 'Agenda' },
  { href: '/pacientes', label: 'Pacientes' },
  { href: '/financeiro', label: 'Financeiro' },
  { href: '/configuracoes', label: 'Configurações' },
  { href: '/settings/subscription', label: 'Assinatura' },
];

export function SideNav() {
  const pathname = usePathname();
  return (
    <nav
      style={{
        width: '220px',
        borderRight: '1px solid var(--border)',
        padding: '1.5rem 1rem',
        minHeight: '100vh',
      }}
    >
      <p style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', color: 'var(--forest)', margin: '0 0 2rem 0.5rem' }}>
        Luxora
      </p>
      {links.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            style={{
              display: 'block',
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
          </Link>
        );
      })}
    </nav>
  );
}
