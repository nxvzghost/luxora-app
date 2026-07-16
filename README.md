# Luxora

"Tecnologia que ilumina decisões."

Plataforma operacional para clínicas de saúde mental — automação de agenda, cobrança e follow-up via agente de IA no WhatsApp, com o terapeuta sempre no centro da decisão clínica.

## Status

**Módulos 1–17 implementados** (Fundação, Domain, Auth, Multi-Tenant, Pacientes, Clínica/Terapeuta, Agenda, API, Financeiro, Auditoria, WhatsApp, IA, Follow-up/Inadimplência, Automações, Frontend, Assinatura+Asaas). Nunca rodado contra ambiente real (sem banco/rede no ambiente onde foi construído) — ver `COMECE_AQUI.md` para o primeiro setup real.

## Documentação

Toda a documentação técnica está em [`docs/`](./docs) e é a fonte oficial da verdade do projeto — atualizada junto com o código, nunca depois. Pontos de partida:

- [`docs/10-Sprint-0/`](./docs/10-Sprint-0) — auditoria final, plano técnico, arquitetura física, stack, critérios de engenharia
- [`docs/00-PRD/`](./docs/00-PRD) — requisitos funcionais e não funcionais
- [`docs/01-Domain/`](./docs/01-Domain) — entidades, relacionamentos, Linguagem Ubíqua
- [`docs/02-Arquitetura/`](./docs/02-Arquitetura) — princípios, ADRs, Motor Operacional
- [`docs/09-Testes/01-Testes-Criticos.md`](./docs/09-Testes/01-Testes-Criticos.md) — os 16 testes que bloqueiam merge

## Setup local

```bash
pnpm install
cp .env.example .env    # preencher com valores locais
pnpm --filter @luxora/backend exec prisma migrate dev --name init
# em seguida, aplicar RLS conforme apps/backend/prisma/rls/enable-rls.sql
pnpm --filter @luxora/backend seed
pnpm dev
```

## Princípios não-negociáveis (resumo — ver docs/02-Arquitetura/00-Principios-Arquiteturais.md)

- O Domínio é o centro do sistema — nada mais impõe regra a ele.
- A IA nunca decide sozinha.
- Toda regra pertence ao Domínio, nunca a Controller, rota ou workflow n8n.
- Toda tabela multi-tenant tem RLS ativa desde a primeira migration.
- Nenhum PR é aprovado sem os Testes Críticos passando.
