# DEPLOY_RUNBOOK — Build, deploy, rollback e operação

**Status:** Oficial — procedimento operacional da Tarefa 04 da auditoria de 04/10/2026 (Deploy e operação).
**Decisões que o sustentam:** [ADR-0060](../02-Arquitetura/ADRs/ADR-0060-deploy-e-operacao.md).
**Complementa:** [13-Deploy.md](../02-Arquitetura/13-Deploy.md) (estratégia) e [MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md) (migrations, backup e restauração).

## O que existe e o que foi provado

| Peça | Onde | Provado |
|---|---|---|
| Imagem do backend (runtime) | `infra/docker/Dockerfile.backend` | Build a partir de um checkout limpo, sem cache; container sobe, responde e encerra com SIGTERM |
| Imagem do job de migrations | mesmo Dockerfile, `--target migrate` | Aplica as 19 migrations num banco vazio, com a credencial admin |
| Imagem do painel | `infra/docker/Dockerfile.frontend` | Build limpo; a tela de login responde |
| Pilha de homologação | `infra/staging/docker-compose.yml` | Sobe inteira nesta máquina e no runner do CI |
| Deploy com rollback automático | `infra/scripts/deploy.sh` | Versão quebrada implantada de propósito: a anterior volta sozinha |
| Rollback manual | `infra/scripts/rollback.sh` | Volta para a versão anterior, banco intacto |
| Ensaio de restauração | `infra/scripts/restore-drill.sh` | Backup restaurado num banco descartável, com a RLS conferida |
| Ensaio completo | `infra/tests/rehearsal.sh` | 68 verificações, executado localmente |

**Não provado:** nada disso rodou em um host de homologação de verdade, porque ele não existe. O job `deploy-rehearsal` do CI e o workflow de CD foram validados na sintaxe (`actionlint`) e pelos mesmos scripts executados localmente, mas ainda não rodaram no GitHub (não houve push).

## Versões e imagens

- **A tag da imagem é a versão**, e a versão é o commit curto (`git rev-parse --short HEAD`). Ela fica gravada na imagem (`APP_VERSION`) e aparece em `GET /api/v1/health`, em todo log e em todo span.
- Uma tag publicada nunca é sobrescrita. Corrigir é publicar outra versão.
- O painel embute a URL da API no build (`NEXT_PUBLIC_API_URL`): existe uma imagem do painel **por ambiente**.

```bash
bash infra/scripts/build-images.sh --version "$(git rev-parse --short HEAD)" --api-url https://api-staging.exemplo.com.br/api/v1
```

O `.dockerignore` da raiz tira do contexto todo `.env`, `node_modules` e `dist`. O ensaio confere que nenhuma imagem carrega arquivo `.env`.

## Arquivo de ambiente

Um arquivo por ambiente, **fora do repositório**, gerado com segredos aleatórios:

```bash
bash infra/scripts/generate-env.sh /etc/luxora/staging.env staging
```

Depois preencha só `FRONTEND_URL` e, quando existirem, as chaves de teste de Anthropic e Asaas. O modelo comentado está em `infra/staging/.env.staging.example`; os scripts recusam um arquivo que ainda tenha `troque-este-valor`, e a aplicação também.

Duas credenciais de banco, com papéis diferentes:

| Variável | Quem usa | Para quê |
|---|---|---|
| `POSTGRES_ADMIN_PASSWORD` | job de migrations, backup, restauração | DDL e manutenção. Nunca entra no container da aplicação |
| `POSTGRES_APP_PASSWORD` | a aplicação (role `luxora_app`) | Runtime. Role sem superusuário: é o que faz a Row-Level Security valer |

`NODE_ENV` é sempre `production` em homologação e produção; o que distingue os dois é `APP_ENV` (`staging` / `production`).

## Deploy

```bash
bash infra/scripts/deploy.sh --env-file /etc/luxora/staging.env --version <tag> [--frontend-version <tag>] [--notes "motivo"]
```

Cada etapa é um portão — se falha, as seguintes não rodam:

| # | Etapa | Se falhar |
|---|---|---|
| 1 | Backup do banco (`pg_dump`, conferido com `pg_restore --list`) | Nada foi alterado. Sai com código 3 |
| 2 | Migrations, com a credencial admin (`prisma migrate deploy`) | A aplicação continua na versão anterior. Código 3 |
| 3 | Troca da aplicação para a versão nova | — |
| 4 | Readiness da versão nova (`/health/ready` 200 **e** `/health` com a versão certa) | **Rollback automático.** Código 1 |
| 5 | Smoke test (um login inexistente: passa pela validação, consulta o banco com a role de runtime, volta 401) | **Rollback automático.** Código 1 |
| 6 | Registro do deploy | — |

Código 2 significa que a versão nova falhou **e** a anterior não pôde ser restaurada (ou não existia, no primeiro deploy): exige intervenção manual.

O estado fica ao lado do arquivo de ambiente, em `luxora-deploy-state/`: versão atual, versão anterior, backups e `history.jsonl` — uma linha por evento, com versão, data, responsável, ambiente, resultado e observações (a auditoria exigida em 13-Deploy.md).

### Limite conhecido: há uma pausa na troca

Com uma instância só, a troca derruba a versão antiga antes de a nova ficar pronta: alguns segundos sem atendimento. No ensaio, a versão nova ficou pronta em 2 a 5 segundos. Deploy sem pausa exige duas instâncias atrás de um balanceador, que é o que o provedor gerenciado faz — e é para isso que a readiness existe.

## Rollback

```bash
bash infra/scripts/rollback.sh --env-file /etc/luxora/staging.env [--to <tag>] [--notes "motivo"]
```

Troca **só a imagem da aplicação**. Não roda migration e não toca no banco.

Isso só é seguro porque toda migration precisa ser compatível com a versão anterior da aplicação (expand/contract, em [MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md), "Estratégia de rollback"). Uma migration que remove ou renomeia algo que a versão anterior usa quebra o rollback — ela vai em um deploy próprio, depois de nenhuma versão em uso depender da estrutura antiga.

Se a versão nova já gravou dados que a anterior não entende, o caminho é uma migration de correção, não este script. Restaurar o backup é o último recurso e perde o que foi gravado depois dele.

## Restauração de backup

```bash
bash infra/scripts/restore-drill.sh --env-file /etc/luxora/staging.env [--backup <arquivo.dump>]
```

Restaura num banco descartável do mesmo servidor, confere e apaga. Nunca restaura por cima do banco em uso. Reprova se as tabelas voltarem sem a RLS forçada ou sem o histórico de migrations.

Os backups do deploy ficam no disco do próprio host: servem para desfazer um deploy, **não** são a política de backup do ambiente. Cópia fora do host e retenção continuam pendentes (dependem do provedor).

## Sondas de saúde

| Rota | Pergunta | Consulta | Uso |
|---|---|---|---|
| `GET /api/v1/health` | O processo está de pé? | Nada | Liveness: se falhar, reinicia o container |
| `GET /api/v1/health/ready` | Pode receber tráfego? | Postgres (`SELECT 1`) e Redis (`PING`), 2 s cada | Readiness: se falhar, tira a instância do balanceamento |

A readiness responde 503 com `{"status":"not_ready","checks":{"database":"up|down","redis":"up|down"}}` — nunca host, usuário ou mensagem de erro. Durante o encerramento responde 503 `shutting_down` desde o SIGTERM.

Nunca apontar o liveness para `/health/ready`: uma queda do banco reiniciaria a aplicação em laço. No ensaio, com Redis e depois Postgres parados, a aplicação ficou não pronta, **não reiniciou** e voltou sozinha quando a dependência voltou.

**Encerramento:** o container recebe SIGTERM e tem 90 s (`stop_grace_period`) para terminar o job em andamento das filas. No ensaio, sem job em andamento, terminou em 2 s com código 0.

## Observabilidade

Sem serviço pago nenhum. O que existe:

**Logs.** Em produção, uma linha JSON por registro em stdout/stderr: `timestamp`, `level`, `service`, `version`, `environment`, `context`, `message` e, quando existem, `correlationId`, `traceId`, `spanId` e `stack`. Qualquer coletor lê isso sem configuração. `LOG_FORMAT` (`json`/`text`) e `LOG_LEVEL` (`fatal`, `error`, `warn`, `log`, `debug`, `verbose`) sobrepõem o padrão.

**Traces.** Decididos pelas variáveis padrão do OpenTelemetry:

| Configuração | Resultado |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` definido | Spans exportados por OTLP (http/protobuf) |
| Produção sem endpoint | Nada é exportado |
| Desenvolvimento sem endpoint | Spans no console, como antes |

O compose de homologação traz um coletor OpenTelemetry opcional (`--profile observability`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318`), que hoje só imprime o que recebe. O destino real (Tempo, Jaeger ou um serviço gerenciado) entra em `infra/staging/otel-collector.yaml`, sem mudar a aplicação. As sondas de saúde e a coleta de métricas não geram trace.

**Métricas.** `GET /metrics` (Prometheus), com `X-Metrics-Token`. Já existia (AD-016).

**Limites que continuam:** `TenantID` e `UserID` não saem automaticamente nos logs; chamadas feitas com `fetch` (Meta, Anthropic, Asaas) e as queries do Prisma não geram span (ADR-0051); não há alerta nem painel configurado.

## CI/CD

| Onde | O que faz | Depende de |
|---|---|---|
| CI, job `deploy-rehearsal` | Constrói as três imagens e roda o ensaio completo a cada push e PR | Nada externo |
| CD, job `publish` (acionado à mão) | Build, ensaio como portão e publicação das imagens no GHCR | Só o `GITHUB_TOKEN` do próprio job |
| CD, job `deploy-staging` | Roda `deploy.sh` no host, por SSH | **Host de homologação, que não existe.** Fica pulado até `STAGING_DEPLOY_ENABLED=true` |

Para ligar o `deploy-staging`, no repositório do GitHub:

- variáveis: `STAGING_DEPLOY_ENABLED=true`, `STAGING_REPO_DIR` (checkout do repositório no host), `STAGING_ENV_FILE` (caminho do arquivo de ambiente no host);
- ambiente `staging` com os segredos `STAGING_SSH_HOST`, `STAGING_SSH_USER`, `STAGING_SSH_KEY` e `STAGING_SSH_KNOWN_HOSTS`;
- no host: Docker com compose, `curl`, o checkout do repositório e, se as imagens do GHCR forem privadas, um `docker login ghcr.io` feito uma vez.

Produção não tem job: entra depois de a homologação estar em uso, com aprovação obrigatória.

## Se o provedor for o Railway

[00-Provedor-e-Custos.md](00-Provedor-e-Custos.md) registra o Railway como escolha. Nenhuma conta foi criada — isso gera custo e depende de autorização. O que se reaproveita lá:

| Aqui | No Railway |
|---|---|
| Imagens do GHCR | Serviço criado a partir da imagem, pela tag da versão |
| Job `migrate` | Comando de pré-deploy do serviço, com a URL admin do banco gerenciado |
| `/api/v1/health/ready` | Caminho de healthcheck do serviço: a versão nova só recebe tráfego depois de pronta |
| `rollback.sh` | Reimplantar a versão anterior (pela tag) |
| Postgres e Redis do compose | Os gerenciados do provedor; a role `luxora_app` é criada uma vez pelo admin |
| `stop_grace_period: 90s` | Tempo de drenagem do serviço |

Este mapeamento **não foi validado**: é a leitura da documentação, sem conta para testar.

## Pontos de atenção para dimensionar

- **Conexões com o banco.** A aplicação abre 16 conexões logo após subir. `PrismaClientProvider` está declarado em 15 módulos, e cada declaração cria um cliente com pool próprio (o padrão do Prisma é `2 × CPUs + 1` por pool). Num Postgres pequeno, com limite baixo de conexões, isso pesa. Mitigação sem mudar código: `?connection_limit=N` na `DATABASE_URL`. A correção de verdade (um provider só, compartilhado) fica fora desta tarefa.
- **Imagem do job de migrations: 1,45 GB.** É o estágio de build inteiro. Serve para um job que roda uma vez por deploy; pode ser enxugada depois.
- **Uma instância só.** Não há alta disponibilidade nesta pilha.

## Como repetir o ensaio

```bash
VERSION="$(git rev-parse --short HEAD)"
bash infra/scripts/build-images.sh --version "$VERSION" --api-url http://localhost:13000/api/v1
bash infra/tests/rehearsal.sh --backend-version "$VERSION" --frontend-version "$VERSION"
```

Usa um projeto compose próprio, com volumes próprios, e apaga tudo ao final. O Postgres e o Redis de desenvolvimento não são tocados. Não chama Meta, Anthropic nem Asaas.

## Documentos relacionados

- [ADR-0060](../02-Arquitetura/ADRs/ADR-0060-deploy-e-operacao.md) — as decisões.
- [MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md) — migrations, backup e restauração.
- [AUTOMACOES_AGENDADOR.md](AUTOMACOES_AGENDADOR.md) — como o agendador deverá chamar as automações, e o que falta.
- [13-Deploy.md](../02-Arquitetura/13-Deploy.md) e [00-Provedor-e-Custos.md](00-Provedor-e-Custos.md).
