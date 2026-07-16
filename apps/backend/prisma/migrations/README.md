# Migrations

Esta pasta está **intencionalmente vazia** neste commit.

## Por quê

A migration inicial real (com timestamp gerado automaticamente pelo Prisma) só pode ser criada rodando `prisma migrate dev --name init` contra um banco de dados real — algo que não é possível fazer no ambiente em que o Módulo 1 foi escrito (sem acesso de rede/banco).

## O que fazer antes de considerar o Módulo 1 encerrado

1. Rodar `pnpm --filter @luxora/backend exec prisma migrate dev --name init` localmente, contra um Postgres real (Docker local ou Railway de desenvolvimento) — isso gera a primeira pasta aqui dentro, com todas as tabelas de `schema.prisma`.
2. Seguir o processo documentado no topo de `../rls/enable-rls.sql` para aplicar a Row-Level Security como uma segunda migration, na ordem correta.
3. Só então rodar `infra/scripts/seed-dev.ts` e os Testes Críticos (`test/critical/`).

Não gerar essa migration manualmente ou com timestamp inventado — deixar o Prisma CLI gerar o timestamp real evita qualquer risco de ordenação incorreta entre ambientes.
