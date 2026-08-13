import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

/**
 * Mock global de next/navigation — Fase 9.2 (AD-014). Componentes de
 * página usam SideNav (usePathname) e, em alguns casos, useRouter; fora de
 * uma árvore real do App Router (que testes de componente com
 * @testing-library/react não montam), essas hooks não têm contexto e
 * quebram todo teste que renderize qualquer página. Mock único aqui evita
 * repetir em cada arquivo de teste.
 */
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
  }),
}));
