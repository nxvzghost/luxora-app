import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import { vi } from 'vitest';

/**
 * Espera das consultas assíncronas (`findBy*`, `waitFor`): 3 s, em vez do
 * padrão de 1 s da Testing Library — Tarefa 06 da auditoria (fechamento).
 *
 * O primeiro teste de cada arquivo de tela paga a primeira renderização
 * (jsdom, React, a página inteira). Em uma máquina momentaneamente lenta
 * isso passou de 1 s uma vez, na réplica local do CI: o teste desistiu com a
 * tela ainda em "Carregando...", sem nada de errado no painel. Nenhuma
 * asserção muda — o que tem de aparecer continua tendo de aparecer; só há
 * mais tempo para isso. Fica abaixo do limite de 5 s por teste do Vitest,
 * para o erro continuar sendo o da consulta, que mostra a tela.
 */
configure({ asyncUtilTimeout: 3000 });

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
