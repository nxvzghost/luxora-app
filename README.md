# Luxora

"Tecnologia que ilumina decisões."

Plataforma operacional para clínicas de saúde mental — automação de agenda, cobrança e follow-up via agente de IA no WhatsApp, com o terapeuta sempre no centro da decisão clínica.

## Status

**Módulos 1–17 implementados** (Fundação, Domain, Auth, Multi-Tenant, Pacientes, Clínica/Terapeuta, Agenda, API, Financeiro, Auditoria, WhatsApp, IA, Follow-up/Inadimplência, Automações, Frontend, Assinatura+Asaas).

`pnpm build`, `pnpm lint` e `pnpm test:unit` rodam limpos na raiz do monorepo (274/274 testes unitários do backend). Validado de ponta a ponta contra Postgres/Redis reais: migrations, RLS, seed, boot do backend, login via API e os 4 Testes Críticos de isolamento multi-tenant — ver "Setup local" abaixo.

**Bug de segurança real encontrado e corrigido nesta validação**: a aplicação conectava ao Postgres como o usuário `postgres` (superusuário do container oficial). O Postgres ignora Row-Level Security incondicionalmente para superusuários — nem `FORCE ROW LEVEL SECURITY` muda isso — e os Repositories deste projeto dependem 100% de RLS para isolar dados por Tenant (nenhum WHERE tenant_id explícito nas queries). Na prática, qualquer clínica autenticada conseguia ler dados de qualquer outra clínica, silenciosamente, sem nenhum erro. Corrigido criando uma role de aplicação (`luxora_app`) sem privilégio de superusuário — ver [`infra/docker/postgres-init/01-app-role.sql`](./infra/docker/postgres-init/01-app-role.sql).

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

`DATABASE_URL` e `REDIS_URL` do `.env.example` já batem com as portas expostas pelo `docker-compose.yml` deste repositório (`localhost:5432` / `localhost:6379`, banco `luxora_dev`) — não precisa alterar para rodar localmente. **`DATABASE_URL` usa a role `luxora_app`, nunca `postgres`** — ver aviso de segurança em "Status" acima. Troque `JWT_SECRET` por uma string aleatória longa. `ASAAS_API_KEY`, `ANTHROPIC_API_KEY` etc. podem ficar em branco: só dão erro quando o fluxo específico que os usa for chamado. Detalhe completo de cada variável: [`CONFIGURACAO_AMBIENTE.md`](./CONFIGURACAO_AMBIENTE.md).

Este `.env` é lido tanto pelo Prisma CLI quanto pelo NestJS a partir do diretório onde o comando roda (`apps/backend`), não da raiz do monorepo — copie (ou symlink) o mesmo arquivo para `apps/backend/.env` também:

```bash
cp .env apps/backend/.env
```

### 3. Subir Postgres e Redis

```bash
docker compose up -d
```

Isso sobe só a infraestrutura de dados (Postgres 16 + Redis 7) — backend e frontend rodam fora do Docker, via `pnpm dev` (passo 6). Na primeira inicialização (volume vazio), o Postgres também roda automaticamente `infra/docker/postgres-init/01-app-role.sql`, criando a role `luxora_app` sem privilégio de superusuário. Se você já tinha um volume de um `docker-compose up` anterior a essa correção, a role não existe ainda — aplique manualmente:

```bash
docker compose exec -T postgres psql -U postgres -d luxora_dev -v ON_ERROR_STOP=1 < infra/docker/postgres-init/01-app-role.sql
```

Confirme que os dois serviços estão saudáveis:

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

Backend sobe em `http://localhost:3000` (rota de saúde: `GET /api/v1/health` — todo endpoint usa o prefixo `/api/v1`), frontend em `http://localhost:3001` ou `3002` — o terminal mostra a porta exata.

Credenciais de teste (criadas pelo seed): `admin@clinica-a.luxora.dev` / `admin@clinica-b.luxora.dev`, senha `luxora-dev-2026`. Só o Tenant A tem assinatura ativa no seed — de propósito, para poder testar tanto o caminho liberado quanto o bloqueado (`SUBSCRIPTION_INACTIVE`) sem precisar de um segundo cenário.

### 7. Validar que o ambiente está de pé

```bash
pnpm build         # backend + frontend compilam sem erro
pnpm lint          # inclui a regra de fronteira de Clean Architecture (boundaries/element-types)
pnpm test:unit     # 274 testes, não depende de banco
pnpm --filter @luxora/backend test:critical   # precisa do Postgres/Redis do passo 3 — 15 dos 16 Testes Críticos documentados em docs/09-Testes/01-Testes-Criticos.md (o #13 é revisão de processo, não automatizável; o #3, cache multi-tenant, é `describe.skip` documentado — não existe camada de cache neste código ainda)
```

Existe também `pnpm --filter @luxora/backend test:manual` — chama a API real de **produção** da Asaas (a Luxora não tem conta sandbox). Nunca roda sozinho, nunca em CI, só quando você decide validar o ambiente real com sua própria `ASAAS_API_KEY`. Ver [`apps/backend/test/manual/README.md`](./apps/backend/test/manual/README.md).

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
