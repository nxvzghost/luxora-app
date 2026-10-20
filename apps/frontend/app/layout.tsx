import type { Metadata } from 'next';
import { fontClassNames } from './fonts';
import './globals.css';
import { QueryProvider } from '@/lib/query-provider';
import { AuthGuard } from '@/components/auth-guard';

// ADR-0067 — a Content-Security-Policy usa um nonce novo a cada requisição
// (middleware.ts). Uma página gerada no build teria os scripts do Next sem
// esse nonce, e o navegador os bloquearia: todas são renderizadas na hora.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Luxora — Tecnologia que ilumina decisões',
  description: 'Plataforma operacional para clínicas de saúde mental.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={fontClassNames}>
      <body>
        <QueryProvider>
          <AuthGuard>{children}</AuthGuard>
        </QueryProvider>
      </body>
    </html>
  );
}
