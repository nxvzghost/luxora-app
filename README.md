# Luxora

"Tecnologia que ilumina decisões."

Plataforma operacional para clínicas de saúde mental — automação de agenda, cobrança e follow-up via agente de IA no WhatsApp, com o terapeuta sempre no centro da decisão clínica.

## Status

**Módulos 1–18 implementados** (Fundação, Domain, Auth, Multi-Tenant, Pacientes, Clínica/Terapeuta, Agenda, API, Financeiro, Auditoria, WhatsApp, IA, Follow-up/Inadimplência, Automações, Frontend, Assinatura+Asaas, Motor de Disponibilidade Fase 1).

`pnpm build`, `pnpm lint` e `pnpm test:unit` rodam limpos na raiz do monorepo (302/302 testes unitários do backend, 24/24 Testes Críticos + 1 skip documentado). Validado de ponta a ponta contra Postgres/Redis reais e contra o frontend rodando de verdade no navegador — ver "Setup local" abaixo.

**✅ PD-001 — Motor de Disponibilidade, Fase 1 (Módulo 18) implementada**: documentação completa em [`docs/11-Product-Decisions/PD-001-Motor-de-Disponibilidade/`](./docs/11-Product-Decisions/PD-001-Motor-de-Disponibilidade/) e [`ADR-0040`](./docs/02-Arquitetura/ADRs/ADR-0040-motor-disponibilidade-bounded-context.md). Novo Bounded Context `Availability` (`AvailabilityCalendar` — Aggregate Root, 1 por Terapeuta, `windows` com duração de sessão própria por janela), com tabela dedicada (`availability_calendar`, RLS ativa) substituindo o antigo `Therapist.availability`. As 4 violações confirmadas na análise arquitetural foram corrigidas: `AgendarConsultaUseCase`, `RemarcarConsultaUseCase` e `CriarAgendamentoRecorrenteUseCase` agora consultam `VerificarDisponibilidadeUseCase` (o gate central do Motor) antes de criar/alterar um Appointment, recusando com `SLOT_NOT_AVAILABLE` quando o horário não está livre; `IntentActionRouter` (IA) herda a proteção automaticamente, por construção, sem precisar de nenhuma mudança própria. Fases 2–4 (Exceções/Recorrência → Assistente conversacional → Importação externa) continuam **não iniciadas**, cada uma aguardando aprovação própria de escopo.

**Bug de segurança real encontrado e corrigido nesta validação**: a aplicação conectava ao Postgres como o usuário `postgres` (superusuário do container oficial). O Postgres ignora Row-Level Security incondicionalmente para superusuários — nem `FORCE ROW LEVEL SECURITY` muda isso — e os Repositories deste projeto dependem 100% de RLS para isolar dados por Tenant (nenhum WHERE tenant_id explícito nas queries). Na prática, qualquer clínica autenticada conseguia ler dados de qualquer outra clínica, silenciosamente, sem nenhum erro. Corrigido criando uma role de aplicação (`luxora_app`) sem privilégio de superusuário — ver [`infra/docker/postgres-init/01-app-role.sql`](./infra/docker/postgres-init/01-app-role.sql).

## Arquitetura

**🏛️ Marco 1 — Arquitetura de Domínio do Vertex concluída (WhatsApp como interface oficial do paciente)**: documentação completa em [`docs/ARCHITECTURE_MILESTONE.md`](./docs/ARCHITECTURE_MILESTONE.md). Decisão de produto formalizada em arquitetura de domínio: o painel web serve à clínica, o WhatsApp é a jornada oficial do paciente, ambos sobre o mesmo backend e domínio. Introduz o Aggregate `Contact` (identidade de comunicação, distinto de `Patient` — vínculo clínico), modelado e testado contra 15 cenários reais de operação clínica (responsável falando por dependente, casal com telefone compartilhado, troca de número, entre outros) antes de qualquer implementação. Documentação completa em [`docs/01-Domain/06-Decisoes-de-Dominio-WhatsApp.md`](./docs/01-Domain/06-Decisoes-de-Dominio-WhatsApp.md) a [`13-Process-Managers.md`](./docs/01-Domain/13-Process-Managers.md), decisões formais em [`ADR-0041`](./docs/02-Arquitetura/ADRs/ADR-0041-whatsapp-interface-oficial-do-paciente.md) a [`ADR-0046`](./docs/02-Arquitetura/ADRs/ADR-0046-ambiguidades-resolvidas-antes-de-acao-clinica.md). Decisões congeladas — qualquer alteração exige nova ADR.

Também disponível: [`docs/ARCHITECTURE_AUDIT_REPORT.md`](./docs/ARCHITECTURE_AUDIT_REPORT.md) (auditoria técnica completa da Sprint 3) e [`docs/SPRINT_4_EXECUTION_PLAN.md`](./docs/SPRINT_4_EXECUTION_PLAN.md) (plano de execução derivado do backlog priorizado da auditoria).

## Documentação

Toda a documentação técnica está em [`docs/`](./docs) e é a fonte oficial da verdade do projeto — atualizada junto com o código, nunca depois. Pontos de partida:

- [`docs/10-Sprint-0/`](./docs/10-Sprint-0) — auditoria final, plano técnico, arquitetura física, stack, critérios de engenharia
- [`docs/00-PRD/`](./docs/00-PRD) — requisitos funcionais e não funcionais
- [`docs/01-Domain/`](./docs/01-Domain) — entidades, relacionamentos, Linguagem Ubíqua, Marco 1 (WhatsApp/Contact)
- [`docs/02-Arquitetura/`](./docs/02-Arquitetura) — princípios, ADRs, Motor Operacional
- [`docs/09-Testes/01-Testes-Criticos.md`](./docs/09-Testes/01-Testes-Criticos.md) — os 16 testes que bloqueiam merge
- [`docs/11-Product-Decisions/`](./docs/11-Product-Decisions) — decisões de produto com impacto arquitetural direto (categoria nova; gera ADRs como consequência)

## Setup local

Pré-requisitos: Node.js 20+, pnpm (via `corepack enable` ou `npm install -g pnpm`), um daemon Docker compatível.

**Windows — ambiente oficial: WSL2, ponta a ponta — não só o Docker.** O repositório de trabalho inteiro (código, `node_modules`, Git) reside nativamente dentro do WSL2, em filesystem `ext4` (ex.: `/root/luxora-app` ou `~/luxora-app`) — **não** em `/mnt/c/Users/...` (Windows, acessado via DrvFs). Todo comando abaixo (`pnpm`, `git`, `docker`, `prisma`, testes) roda de dentro de uma shell WSL2; o VS Code é aberto de dentro do WSL2 (`cd ~/luxora-app && code .`, modo **Remote-WSL**), nunca apontando para um caminho `\\wsl.localhost\...`/`\\wsl$\...` de um VS Code do lado Windows. Decisão e evidências completas (medições de performance, ~94x de diferença entre DrvFs e ext4 para carregamento de módulos Node) em [`ADR-0048`](./docs/02-Arquitetura/ADRs/ADR-0048-repositorio-ext4-wsl2.md). O Docker especificamente já rodava nativo no WSL2 desde [`ADR-0047`](./docs/02-Arquitetura/ADRs/ADR-0047-docker-engine-nativo-wsl2.md), não Docker Desktop — motivado por continuidade do projeto (o Docker Desktop apresentou um defeito reprodutível de inicialização sem causa raiz identificada), não por limitação do Docker Desktop em si. Procedimento completo de instalação do Docker Engine, do zero:

```bash
# 1. dentro da distro WSL2 (ex.: wsl -d Ubuntu)
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME || echo noble) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

Se a distro rodar uma versão do Ubuntu mais nova do que o repositório da Docker já publica, use o codename da última LTS suportada (`noble`, 24.04) — os pacotes funcionam normalmente.

Depois, no lado Windows, crie `C:\Users\<seu-usuário>\.wslconfig`:

```ini
[wsl2]
vmIdleTimeout=-1
localhostForwarding=true
```

Sem isso, a VM do WSL2 se desliga por ociosidade quando nenhuma sessão está anexada, derrubando o `dockerd` e os containers do projeto junto. Aplique com `wsl --shutdown` e reabra a distro. Para desenvolvimento contínuo, mantenha uma sessão WSL2 aberta durante o trabalho — na prática, isso já acontece naturalmente se você seguir a recomendação acima de manter o VS Code aberto em modo Remote-WSL.

A partir daqui, **todos** os comandos abaixo — não só `docker`/`docker compose`, mas também `pnpm`, `git` e `prisma` dos passos 1 a 6 — devem ser executados de dentro de uma shell WSL2, a partir do diretório onde o repositório vive nativamente em ext4 (ex.: `~/luxora-app`). Um cliente Docker no Windows configurado via `DOCKER_HOST` continua funcionando só para os comandos `docker`/`docker compose` especificamente, mas não substitui rodar o restante do projeto (pnpm/git/prisma/testes) dentro do WSL2 — ver [`ADR-0048`](./docs/02-Arquitetura/ADRs/ADR-0048-repositorio-ext4-wsl2.md).

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

**Windows**: se `docker compose` falhar dizendo que o daemon não está acessível, confirme que está rodando o comando de dentro de um shell WSL2 (não PowerShell/CMD direto) e que o serviço está ativo (`sudo systemctl status docker` dentro da distro) — ver procedimento completo no início desta seção e [`ADR-0047`](./docs/02-Arquitetura/ADRs/ADR-0047-docker-engine-nativo-wsl2.md).

### 4. Migrations (schema + RLS + índice de concorrência, tudo automático)

```bash
pnpm --filter @luxora/backend exec prisma migrate deploy
```

Isso aplica as migrations versionadas a partir de `apps/backend/prisma/migrations/` — schema completo **e** Row-Level Security nas 15 tabelas multi-tenant **e** o índice único de concorrência de agenda, tudo em um único passo desde a migration `enable_rls` ([`ADR-0002`/AD-002](./docs/PLANO_DE_EXECUCAO.md), formalizada em 23/07/2026). Não há mais passo manual de RLS — os scripts em `apps/backend/prisma/rls/` são mantidos só como referência histórica, o conteúdo real já está nas migrations. Gere o Prisma Client depois:

```bash
pnpm --filter @luxora/backend exec prisma generate
```

### 5. Seed e execução

```bash
pnpm --filter @luxora/backend seed
pnpm dev
```

**Conhecido (AD-033, backlog aberto):** `prisma/seed.ts` hoje falha com `new row violates row-level security policy` — o script cria o primeiro registro de um Tenant sem antes definir `app.tenant_id` na sessão, e agora que a RLS está genuinamente ativa por padrão (ver passo 4), isso é rejeitado. Não é um problema do seu ambiente; é um bug real já registrado, ainda não corrigido. Enquanto isso, popular dados de teste manualmente ou aguardar a correção do AD-033.

Backend sobe em `http://localhost:3000` (rota de saúde: `GET /api/v1/health` — todo endpoint usa o prefixo `/api/v1`), frontend em `http://localhost:3001` ou `3002` — o terminal mostra a porta exata.

Credenciais de teste (criadas pelo seed, quando funcionar): `admin@clinica-a.luxora.dev` / `admin@clinica-b.luxora.dev`, senha `luxora-dev-2026`. Só o Tenant A tem assinatura ativa no seed — de propósito, para poder testar tanto o caminho liberado quanto o bloqueado (`SUBSCRIPTION_INACTIVE`) sem precisar de um segundo cenário.

### 6. Validar que o ambiente está de pé

```bash
pnpm build         # backend + frontend compilam sem erro
pnpm lint          # inclui a regra de fronteira de Clean Architecture (boundaries/element-types)
pnpm test:unit     # 302 testes, não depende de banco
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
