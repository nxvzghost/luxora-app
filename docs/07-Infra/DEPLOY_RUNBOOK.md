# DEPLOY_RUNBOOK — Build, deploy, rollback e operação

**Status:** Oficial — procedimento operacional da Tarefa 04 da auditoria de 04/10/2026 (Deploy e operação).
**Decisões que o sustentam:** [ADR-0060](../02-Arquitetura/ADRs/ADR-0060-deploy-e-operacao.md).
**Complementa:** [13-Deploy.md](../02-Arquitetura/13-Deploy.md) (estratégia) e [MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md) (migrations, backup e restauração).

## O que existe e o que foi provado

| Peça | Onde | Provado |
|---|---|---|
| Imagem do backend (runtime) | `infra/docker/Dockerfile.backend` | Build a partir de um checkout limpo, sem cache; container sobe, responde e encerra com SIGTERM |
| Imagem do job de migrations | mesmo Dockerfile, `--target migrate` | Aplica as 20 migrations num banco vazio, com a credencial admin |
| Imagem do painel | `infra/docker/Dockerfile.frontend` | Build limpo; a tela de login responde; as licenças das fontes são servidas em `/licencas/` e guardadas em `/app/licenses/fonts/` |
| Pilha de homologação | `infra/staging/docker-compose.yml` | Sobe inteira nesta máquina e no runner do CI |
| Deploy com rollback automático | `infra/scripts/deploy.sh` | Versão quebrada implantada de propósito: a anterior volta sozinha |
| Rollback manual | `infra/scripts/rollback.sh` | Volta para a versão anterior, banco intacto |
| Ensaio de restauração | `infra/scripts/restore-drill.sh` | Backup restaurado num banco descartável, com a RLS conferida |
| Ensaio completo | `infra/tests/rehearsal.sh` | 78 verificações, executado localmente (68 até 12/10/2026; as 10 novas conferem, nas imagens de verdade, que o token de verificação do webhook não chega ao coletor de traces e que as licenças das fontes acompanham o painel) |

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
bash infra/scripts/deploy.sh --env-file /etc/luxora/staging.env --version <tag> [--frontend-version <tag>] [--notes "motivo"] [--allow-degraded --notes "justificativa"]
```

Cada etapa é um portão — se falha, as seguintes não rodam:

| # | Etapa | Se falhar |
|---|---|---|
| 0 | Capacidades: a imagem tem tudo o que o banco exige e o que o ambiente já exigiu (K2-a) | Nada foi alterado. Código 3 |
| 1 | Backup do banco (`pg_dump`, conferido com `pg_restore --list`) | Nada foi alterado. Sai com código 3 |
| 2 | Migrations, com a credencial admin (`prisma migrate deploy`), e conferência das proteções que o banco exige | A aplicação continua na versão anterior. Código 3 |
| 3 | Troca da aplicação para a versão nova | — |
| 4 | Readiness da versão nova (`/health/ready` 200 **e** `/health` com a versão certa) | **Rollback automático.** Código 1 |
| 5 | Smoke test (um login inexistente: passa pela validação, consulta o banco com a role de runtime, volta 401) | **Rollback automático.** Código 1 |
| 6 | Registro do deploy | — |

Código 2 significa que a versão nova falhou **e** a anterior não pôde ser restaurada (ou não existia, no primeiro deploy): exige intervenção manual. Também é o código quando a anterior não tem uma capacidade que o ambiente já exigia: o rollback automático é recusado e a aplicação fica parada, a menos que o deploy tenha sido chamado com `--allow-degraded` e uma justificativa. No deploy que introduz a exigência, o rollback automático volta em modo degradado, registrado ([MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md), "Exigência de versão e retorno degradado").

O estado fica ao lado do arquivo de ambiente, em `luxora-deploy-state/`: versão atual, versão anterior, exigência ativa (`requirement-active`), backups e `history.jsonl` — uma linha por evento, com versão, data, responsável, ambiente, resultado, modo (`normal` ou `degraded`) e observações (a auditoria exigida em 13-Deploy.md).

### Limite conhecido: há uma pausa na troca

Com uma instância só, a troca derruba a versão antiga antes de a nova ficar pronta: alguns segundos sem atendimento. No ensaio, a versão nova ficou pronta em 2 a 5 segundos. Deploy sem pausa exige duas instâncias atrás de um balanceador, que é o que o provedor gerenciado faz — e é para isso que a readiness existe.

## Rollback

```bash
bash infra/scripts/rollback.sh --env-file /etc/luxora/staging.env [--to <tag>] [--notes "motivo"] [--allow-degraded --notes "justificativa"]
```

Troca **só a imagem da aplicação**. Não roda migration e não toca no banco.

Recusa, com código 3 e sem tocar na aplicação, o destino sem uma capacidade que o banco exige (com `--allow-degraded` e justificativa, volta e registra o retorno como degradado), e qualquer destino quando o banco não tem as proteções que exige ou deixou de exigir o que o ambiente já exigia — o caminho aí é `deploy.sh` ([MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md), "Exigência de versão e retorno degradado").

Isso só é seguro porque toda migration precisa ser compatível com a versão anterior da aplicação (expand/contract, em [MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md), "Estratégia de rollback"). Uma migration que remove ou renomeia algo que a versão anterior usa quebra o rollback — ela vai em um deploy próprio, depois de nenhuma versão em uso depender da estrutura antiga.

Se a versão nova já gravou dados que a anterior não entende, o caminho é uma migration de correção, não este script. Restaurar o backup é o último recurso e perde o que foi gravado depois dele.

## Restauração de backup

```bash
bash infra/scripts/restore-drill.sh --env-file /etc/luxora/staging.env [--backup <arquivo.dump>]
```

Restaura num banco descartável do mesmo servidor, confere e apaga. Nunca restaura por cima do banco em uso. Reprova se as tabelas voltarem sem a RLS forçada ou sem o histórico de migrations, ou se o backup exigir uma capacidade (a do K2-a, `billing-eligibility-v1`, a da K2-b, `appointment-outcome-v1`, ou a do K11, `appointment-ai-confirmation-v1`) sem as restrições, a política e os privilégios que a acompanham. Um backup anterior à exigência do ambiente passa, com aviso: restaurado de verdade, ele pede `deploy.sh` antes de subir a aplicação (procedimento em [MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md), "Procedimento de restauração de backup").

Os backups do deploy ficam no disco do próprio host: servem para desfazer um deploy, **não** são a política de backup do ambiente. Cópia fora do host e retenção continuam pendentes (dependem do provedor).

## Proxy HTTPS (Caddy)

O serviço `caddy` do compose (perfil `proxy`, config em `infra/staging/Caddyfile`) é a única peça com portas públicas (80 e 443). A API e o painel continuam publicados só no loopback do host e o Caddy os alcança pelo nome do serviço (`backend:3000`, `frontend:3001`). O `deploy.sh` sobe o proxy no fim do deploy, e **só** se o arquivo de ambiente tiver `PUBLIC_API_HOST` e `PUBLIC_PANEL_HOST`; sem eles nada muda. Uma falha do proxy (por exemplo, DNS ainda não propagado) vira aviso e não desfaz o deploy.

**Estado: configurado, não testado.** Nenhuma imagem do Caddy foi baixada nem o proxy foi iniciado; o HTTPS só vale depois de testado no servidor real.

| O que fornecer ao contratar o VPS | Onde |
|---|---|
| Nome de host da API (ex.: `api-staging.<domínio>`) | `PUBLIC_API_HOST` no arquivo de ambiente |
| Nome de host do painel | `PUBLIC_PANEL_HOST` (e a origem em `FRONTEND_URL`, `https://` + o mesmo host) |
| DNS: registros A (e AAAA, se houver IPv6) dos dois hosts para o IP do servidor, propagados **antes** do primeiro deploy com proxy | no provedor de DNS |
| Firewall do servidor: 22, 80 e 443 | no provedor ou no host |
| `api_url` do CD | `https://<PUBLIC_API_HOST>/api/v1` |

Pontos de atenção:

- O Caddy pede e renova o certificado (Let's Encrypt) sozinho. Sem DNS apontando para o servidor, a emissão falha e tenta de novo; os logs saem de `docker compose -p luxora-<ambiente> logs caddy`. Sem e-mail ACME configurado, os avisos de expiração não chegam a ninguém (a renovação é automática).
- Certificados e configuração ficam nos volumes `caddy_data` e `caddy_config`. Não apague esses volumes: pedir tudo de novo pode bater no limite de emissões do Let's Encrypt.
- `/metrics` responde 404 pelo proxy; para coletar métricas use o loopback do host (`BACKEND_PORT`).
- Não há log de acesso no proxy, de propósito: a verificação do webhook da Meta leva o token na query string.
- A API usa `trust proxy = 1`: o Caddy é o único salto na frente dela.
- Mudou o `Caddyfile`? O próximo `deploy.sh` recarrega a configuração; fora de um deploy: `docker compose -p luxora-<ambiente> --env-file <arquivo> -f infra/staging/docker-compose.yml exec caddy caddy reload --config /etc/caddy/Caddyfile`.

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

- **Conexões com o banco.** Desde 22/10/2026 a aplicação tem um único cliente Prisma, declarado só no `DatabaseModule` global, e abre **uma** conexão logo após subir; o ensaio de deploy confere esse número. Antes eram 17 clientes, um por módulo que declarava `PrismaClientProvider`, cada um com pool próprio (17 conexões no ensaio; o CI `39737046589` esgotou as conexões do Postgres na Suíte Crítica). O pool único é usado por toda a aplicação, e o tamanho dele é o `connection_limit` da `DATABASE_URL`; sem o parâmetro, vale o padrão do Prisma, `2 × CPUs físicas + 1`, para o processo inteiro. **Ainda não dimensionado:** falta conhecer o `max_connections` do Postgres contratado e a carga esperada. Ao definir, somar as conexões de todos os processos do backend, do job de migrations e das ferramentas de administração, e deixar folga abaixo do limite. Com um pool pequeno demais, as requisições esperam na fila e, passado o `pool_timeout` (padrão de 10 s), falham com `P2024`.
- **Redis no caminho de autenticação (ADR-0067).** Cada requisição autenticada lê o estado de sessão do usuário no Redis. Com o Redis fora do ar a API continua atendendo: o estado passa a ser lido do banco a cada requisição, e o log registra a troca uma vez. A readiness já acusa o Redis fora do ar.
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
