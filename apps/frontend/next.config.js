const path = require('node:path');

// Tarefa 04 da auditoria — só o build da imagem (infra/docker/Dockerfile.frontend)
// define NEXT_OUTPUT=standalone. Sem a variável, `pnpm dev`, `next build` e
// `next start` continuam exatamente como antes.
const standalone = process.env.NEXT_OUTPUT === 'standalone';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Tarefa 07 da auditoria — todo arquivo de fonte servido pelo painel aponta
  // para a sua licença (lib/font-licenses.ts). Em /_next/static/media ficam
  // só as fontes; o cabeçalho não muda nada do que o navegador desenha.
  async headers() {
    return [
      {
        source: '/_next/static/media/:arquivo*',
        headers: [{ key: 'Link', value: '</licencas/fontes.txt>; rel="license"' }],
      },
    ];
  },
  ...(standalone
    ? {
        output: 'standalone',
        // Monorepo pnpm: as dependências reais ficam no node_modules da raiz.
        // Sem isto o Next rastreia só apps/frontend e o servidor sobe sem elas.
        outputFileTracingRoot: path.join(__dirname, '../../'),
      }
    : {}),
};

module.exports = nextConfig;
