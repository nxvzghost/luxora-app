import type { Metadata } from 'next';
import { fontClassNames } from './fonts';
import './globals.css';
import { QueryProvider } from '@/lib/query-provider';
import { AuthGuard } from '@/components/auth-guard';

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
