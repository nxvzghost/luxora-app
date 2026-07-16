# Luxora

"Tecnologia que ilumina decisões."

Plataforma operacional para clínicas de saúde mental — automação de agenda, cobrança e follow-up via agente de IA no WhatsApp, com o terapeuta sempre no centro da decisão clínica.

## Status

**Módulos 1–17 implementados** (Fundação, Domain, Auth, Multi-Tenant, Pacientes, Clínica/Terapeuta, Agenda, API, Financeiro, Auditoria, WhatsApp, IA, Follow-up/Inadimplência, Automações, Frontend, Assinatura+Asaas).

`pnpm build`, `pnpm lint` e `pnpm test:unit` rodam limpos na raiz do monorepo (274/274 testes unitários do backend). `test:critical` e `test:integration` exigem Postgres/Redis reais — ver "Setup local" abaixo.

## Documentação

Toda a documentação técnica está em [`docs/`](./docs) e é a fonte oficial da verdade do projeto — atualizada junto com o código, nunca depois. Pontos de partida:

- [`docs/10-Sprint-0/`](./docs/10-Sprint-0) — auditoria final, plano técnico, arquitetura física, stack, critérios de engenharia
- [`docs/00-PRD/`](./docs/00-PRD) — requisitos funcionais e não funcionais
- [`docs/01-Domain/`](./docs/01-Domain) — entidades, relacionamentos, Linguagem Ubíqua
- [`docs/02-Arquitetura/`](./docs/02-Arquitetura) — princípios, ADRs, Motor Operacional
- [`docs/09-Testes/01-Testes-Criticos.md`](./docs/09-Testes/01-Testes-Criticos.md) — os 16 testes que bloqueiam merge

## Setup local

Pré-requisitos: Node.js 20+, pnpm (via `corepack enable` ou `npm install -g pnpm`), Docker Desktop.

### 1. Instalar dependências

```bash
pnpm install
```

Se o pnpm reclamar que não encontrou pacotes do workspace, confira se `pnpm-workspace.yaml` existe na raiz — é ele (não o campo `workspaces` do `package.json`) que o pnpm usa para reconhecer `apps/*` e `packages/*`.

### 2. Variáveis de ambiente

```bash
cp .env.example .env
```

`DATABASE_URL` e `REDIS_URL` do `.env.example` já batem com as portas expostas pelo `docker-compose.yml` deste repositório (`localhost:5432` / `localhost:6379`, banco `luxora_dev`) — não precisa alterar para rodar localmente. Troque `JWT_SECRET` por uma string aleatória longa. `ASAAS_API_KEY`, `ANTHROPIC_API_KEY` etc. podem ficar em branco: só dão erro quando o fluxo específico que os usa for chamado. Detalhe completo de cada variável: [`CONFIGURACAO_AMBIENTE.md`](./CONFIGURACAO_AMBIENTE.md).

### 3. Subir Postgres e Redis

```bash
docker compose up -d
```

Isso sobe só a infraestrutura de dados (Postgres 16 + Redis 7) — backend e frontend rodam fora do Docker, via `pnpm dev` (passo 6). Confirme que os dois serviços estão saudáveis:

```bash
docker compose ps
```

**Windows**: Docker Desktop usa WSL2 como backend. Se `docker compose` falhar dizendo que o daemon não está acessível, rode como Administrador `wsl --install`, reinicie a máquina e abra o Docker Desktop uma vez antes de tentar de novo.

### 4. Migrations

```bash
pnpm --filter @luxora/backend exec prisma migrate dev --name init
```

Isso cria as tabelas a partir de `apps/backend/prisma/schema.prisma` e gera o Prisma Client.

### 5. Row-Level Security (RLS) — passo manual

O Prisma não roda isso sozinho; aplique direto no Postgres depois da migration:

```bash
docker compose exec -T postgres psql -U postgres -d luxora_dev < apps/backend/prisma/rls/enable-rls.sql
docker compose exec -T postgres psql -U postgres -d luxora_dev < apps/backend/prisma/rls/unique-active-appointment.sql
```

### 6. Seed e execução

```bash
pnpm --filter @luxora/backend seed
pnpm dev
```

Backend sobe em `http://localhost:3000` (rota de saúde: `GET /health`), frontend em `http://localhost:3001` ou `3002` — o terminal mostra a porta exata.

### 7. Validar que o ambiente está de pé

```bash
pnpm build         # backend + frontend compilam sem erro
pnpm lint          # inclui a regra de fronteira de Clean Architecture (boundaries/element-types)
pnpm test:unit     # 274 testes, não depende de banco
pnpm --filter @luxora/backend test:critical   # os 16 Testes Críticos — precisa do Postgres do passo 3
```

### Parar os serviços

```bash
docker compose down          # mantém os dados (volume nomeado)
docker compose down -v       # apaga também os dados do Postgres
```

## Princípios não-negociáveis (resumo — ver docs/02-Arquitetura/00-Principios-Arquiteturais.md)

- O Domínio é o centro do sistema — nada mais impõe regra a ele.
- A IA nunca decide sozinha.
- Toda regra pertence ao Domínio, nunca a Controller, rota ou workflow n8n.
- Toda tabela multi-tenant tem RLS ativa desde a primeira migration.
- Nenhum PR é aprovado sem os Testes Críticos passando.
