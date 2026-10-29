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

Os backups do deploy ficam no disco do próprio host: servem para desfazer um deploy, **não** são a política de backup do ambiente. Cópia fora do host e retenção continuam pendentes (dependem do provedor); a preparação técnica da cópia externa cifrada está em "Backup externo cifrado", abaixo.

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

- O Caddy pede e renova o certificado (Let's Encrypt) sozinho. Sem DNS apontando para o servidor, a emissão falha e tenta de novo; os logs saem de `docker compose -p luxora-<ambiente> logs caddy`. O e-mail da conta ACME vem de `ACME_EMAIL` no arquivo de ambiente (só no servidor, nunca no repositório) e recebe os avisos de expiração; a renovação é automática. Com `PUBLIC_API_HOST` e `PUBLIC_PANEL_HOST` preenchidos, o `deploy.sh` exige um `ACME_EMAIL` com formato válido antes de iniciar o Caddy. Sem ele, ou com um valor inválido, o proxy **não é iniciado**: o deploy registra um `AVISO` e a aplicação segue no ar só no loopback do host. Sem o proxy iniciado, nenhum certificado HTTPS é emitido e nenhum aviso de expiração é enviado. Esse e os demais casos em que o proxy não é iniciado ou atualizado (o Caddy não sobe, ou não recarrega a configuração) são **sucesso parcial**: o `deploy.sh` sai com código 0, porque a aplicação já foi implantada e aprovada no readiness e no smoke, e a linha final começa com `6/6 deploy concluído PARCIALMENTE` e diz o que não foi feito. O `history.jsonl` mantém o evento `success` da aplicação e ganha um evento separado `proxy` com o resultado (`not-started`, `start-failed`, `reload-failed` ou `reloaded`) e a causa; se esse evento não puder ser gravado, a linha final avisa. Com os endereços vazios, o proxy está desativado de propósito: a linha final diz que a aplicação fica só no loopback, sem classificar como parcial. Com o proxy iniciado e a configuração recarregada, a linha final diz isso e que o certificado e o acesso por HTTPS **não** são verificados pelo script (confira DNS e a URL pública à parte). Quem lê só o resultado do CD (verde) precisa ler essa linha. Ainda não validado com o binário do Caddy nem em servidor real.
- Certificados e configuração ficam nos volumes `caddy_data` e `caddy_config`. Não apague esses volumes: pedir tudo de novo pode bater no limite de emissões do Let's Encrypt.
- `/metrics` responde 404 pelo proxy; para coletar métricas use o loopback do host (`BACKEND_PORT`).
- Não há log de acesso no proxy, de propósito: a verificação do webhook da Meta leva o token na query string.
- A API usa `trust proxy = 1`: o Caddy é o único salto na frente dela.
- Mudou o `Caddyfile`? O próximo `deploy.sh` recarrega a configuração; fora de um deploy: `docker compose -p luxora-<ambiente> --env-file <arquivo> -f infra/staging/docker-compose.yml exec caddy caddy reload --config /etc/caddy/Caddyfile`.

## Backup externo cifrado

`infra/scripts/external-backup.sh` copia o banco para um armazenamento externo compatível com S3, cifrado, e recupera a cópia para o `restore-drill.sh` existente. **Estado: implementado e testado só com um armazenamento falso local; nunca falou com um armazenamento real, não está agendado e a retenção não foi decidida (J-4).** Não apaga nem rotaciona nada.

```bash
bash infra/scripts/external-backup.sh check --env-file /etc/luxora/staging.env   # só confere a configuração; sem rede nem banco
bash infra/scripts/external-backup.sh push  --env-file /etc/luxora/staging.env   # dump, cifragem e envio
bash infra/scripts/external-backup.sh pull  --env-file <env de leitura> --object <chave> --drill   # baixa, decifra e roda o restore-drill.sh
bash infra/scripts/external-backup.sh pull  --env-file <env de leitura> --object <chave> --output /caminho/novo.dump [--sha256 <hex>]
```

**`push`**, em ordem, parando no primeiro erro (código 3, com a causa na mensagem):

1. `pg_dump -Fc` direto para o `gpg`: o dump nunca existe em claro no disco. Nome do objeto: `<prefixo>/<APP_ENV>/<banco>/<AAAAMMDDTHHMMSSZ>-<8 hex aleatórios>.dump.gpg`, único a cada execução.
2. A cópia cifrada é decifrada em fluxo e lida por `pg_restore --list`. Se não decifra ou o dump é inválido, nada é enviado.
3. Envio por `curl --aws-sigv4` (PUT), com o hash do conteúdo assinado. A chave de acesso vai por stdin, nunca na linha de comando.
4. Conferência do tamanho do objeto (HEAD). Com credencial só de escrita use `BACKUP_VERIFY_AFTER_UPLOAD=0`: o envio aceito pelo armazenamento vale, mas o tamanho não é conferido. Se o envio deu certo e a conferência falhou, o objeto **não é apagado**; a mensagem diz qual é.

Cada execução grava uma linha no `history.jsonl` (`external-backup` / `external-restore`, com o sha256 da cópia cifrada) e `last-external-backup` no estado. Os temporários ficam em `luxora-deploy-state/tmp` (permissão 700) e são sobrescritos e removidos ao terminar, inclusive em erro ou interrupção.

**`pull`** baixa o objeto, confere o `--sha256` se informado, decifra para um arquivo temporário protegido e confere o dump. Com `--drill`, passa o arquivo ao `restore-drill.sh` (restauração num banco descartável, com a conferência da RLS e das proteções do K2/K11) e apaga o arquivo em claro ao terminar; o código de saída é o do ensaio. Com `--output`, entrega o dump **em claro** num arquivo novo (permissão 600; não sobrescreve), e apagá-lo depois é de quem pediu. Um objeto adulterado ou a chave errada falham na decifragem e nada é entregue. Para restaurar de verdade (não só ensaiar) siga o procedimento de [MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md), "Restauração no ambiente real".

Variáveis no arquivo de ambiente (modelo em `infra/staging/.env.staging.example`; vazias = desligado). Para recuperar de outra máquina, use um arquivo de ambiente com credencial de leitura:

| Variável | O que é |
|---|---|
| `BACKUP_S3_ENDPOINT` | `https://` do armazenamento (endereçamento por caminho: `<endpoint>/<bucket>/<chave>`). `http://` só com `BACKUP_S3_ALLOW_INSECURE_HTTP=1`, para teste local |
| `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET` | região da assinatura e bucket |
| `BACKUP_S3_PREFIX` | prefixo das chaves (padrão `luxora`) |
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | credencial; segredo, só no arquivo de ambiente (permissão 600, fora do Git) |
| `BACKUP_ENCRYPTION_PASSPHRASE_FILE` | caminho do arquivo com a chave de cifragem (permissão 600 ou 400, 24+ caracteres) |
| `BACKUP_VERIFY_AFTER_UPLOAD` | `1` (padrão) confere o tamanho depois do envio; `0` para credencial só de escrita |

Dependências no host: bash, docker com o plugin compose, `curl` 7.75 ou mais novo, `gpg` e `sha256sum`. Nada é instalado por estes scripts; no servidor, confirme que `gpg` existe.

**Teste local:** `bash infra/tests/external-backup-test.sh` roda tudo contra um `docker` simulado e um armazenamento S3 falso em `127.0.0.1` (precisa de `node`), com dados fictícios e sem rede externa. Roda também no CI, no passo "Backup externo (armazenamento e docker simulados)" do job `deploy-rehearsal`. Ele prova o fluxo, a cifragem, a ausência de arquivo em claro e o tratamento de falhas; **não prova** que um armazenamento real aceita a assinatura nem que o `pg_dump`/`pg_restore` reais funcionam por esse caminho.

### Configuração esperada com o Cloudflare R2

O R2 é candidato, não decisão: nenhuma conta, bucket ou credencial foi criado. A configuração abaixo vem da leitura da documentação pública da Cloudflare (28/10/2026) e da leitura do script; **nada foi enviado a um R2 de verdade**.

| Variável | Valor esperado | Base |
|---|---|---|
| `BACKUP_S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, sem o bucket | Documentação da API S3 do R2 |
| `BACKUP_S3_REGION` | `auto` (o R2 também aceita vazio e `us-east-1` como apelidos; o script exige um valor não vazio) | Idem; passa na validação do script (`[a-z0-9-]`) |
| `BACKUP_S3_BUCKET` | o bucket criado para a homologação | O script monta `<endpoint>/<bucket>/<chave>`, o endereçamento por caminho que o R2 aceita |
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | o id do token e o segredo derivado dele | O segredo **só aparece uma vez**, na criação do token |
| `BACKUP_VERIFY_AFTER_UPLOAD` | `1` | A credencial de envio também lê (abaixo), então a conferência do tamanho fica ligada |

**Credenciais.** O R2 não tem permissão só de escrita: os níveis são Admin Read & Write, Admin Read only, Object Read & Write e Object Read only. Por isso:

- **Envio do backup (`external-backup.sh push`, no servidor):** token **Object Read & Write restrito ao bucket da homologação**. Ele também lê e lista os objetos desse bucket; quem tiver o arquivo de ambiente do servidor consegue baixar as cópias, que continuam cifradas.
- **Recuperação (`pull`, fora do servidor):** token **Object Read only** restrito ao mesmo bucket, guardado fora do servidor, num arquivo de ambiente de leitura usado só para recuperar.
- Nenhum token Admin no servidor.

**O que a documentação confirma:** o endereço da API, a região `auto`, o endereçamento por caminho, as operações usadas pelo script (`PutObject`, `HeadObject`, `GetObject`), o envio assinado de uma vez, sem partes (o modo usado pelo script; o envio em partes de alguns SDKs não é suportado), o limite de cerca de 5 GiB por requisição e os níveis de permissão dos tokens.

**O que só um teste real prova:**

- Se a assinatura do `curl --aws-sigv4`, com o `x-amz-content-sha256` que o script envia, é aceita pelo R2. O teste local confere o formato da autorização e o hash do corpo, mas **não recalcula a assinatura**.
- A versão do `curl` no servidor (7.75 ou mais nova).
- `pg_dump` e `pg_restore` reais por esse caminho e a restauração a partir da cópia externa (`pull --drill`).
- Se a conta exige forma de pagamento para ativar o R2, mesmo dentro da cota gratuita.
- O tamanho do dump cifrado: acima de cerca de 5 GiB o envio de uma vez falha, e o script não faz envio em partes.

Um envio (`external-backup.sh push`) seguido de uma recuperação (`external-backup.sh pull --object <chave> --drill`), no servidor, cobre os três primeiros itens.

Pendente do VPS e de decisões:

- **Armazenamento:** provedor (o R2 é candidato), bucket e credenciais. No R2 a credencial de envio também lê (acima); em outro provedor, preferir uma só de escrita para o envio (`external-backup.sh push`). O primeiro envio real é o primeiro teste de compatibilidade.
- **Chave de cifragem:** gerar, guardar uma cópia **fora do servidor** (e fora do próprio armazenamento dos backups) e decidir quem a detém. Sem ela, os backups não abrem; com ela no servidor e nada fora, perder o servidor perde tudo.
- **Retenção e exclusão:** nada é apagado; o prazo depende do J-4 e a regra de ciclo de vida pode ficar no próprio armazenamento.
- **Agendamento e alerta de falha:** não existem. O procedimento previsto está em "Backup automático e alerta de falha", abaixo.
- **Cadência do teste de restauração** a partir da cópia externa (`pull --drill`).

## Backup automático e alerta de falha

**Estado: só procedimento previsto. Nada foi implementado**: não há cron, agendador, script de alerta nem monitor configurado. Implementar exige autorização própria, depois de o servidor existir e de o primeiro envio manual do backup (`external-backup.sh push`) ter passado.

**Como o script sinaliza o resultado.** O `external-backup.sh` sai com `0` quando o backup foi enviado e conferido, e com `3` em toda falha que ele mesmo detecta (configuração, ferramenta ausente, dump inválido, envio recusado, conferência do tamanho), com a causa na mensagem. Qualquer código diferente de `0` deve ser tratado como falha. Cada execução bem-sucedida grava uma linha `external-backup` no `history.jsonl` e atualiza `last-external-backup` em `luxora-deploy-state/` (ao lado do arquivo de ambiente).

**Agendamento previsto:**

1. Um envio diário do backup (`external-backup.sh push`; não confundir com `git push`), como o usuário `deploy`, num horário de pouco uso, com o arquivo de ambiente da homologação.
2. Saída e erros num log próprio, fora do repositório, com rotação.
3. O horário, o log e a forma de agendar (cron do usuário `deploy` ou um timer do systemd) ficam decididos na implementação.

**Alerta de falha previsto:** o alerta deve disparar em dois casos, porque um agendamento que parou de rodar não gera código de saída nenhum:

- **A execução falhou** (código diferente de `0`): avisar no mesmo instante, com a mensagem de erro.
- **A execução não aconteceu:** avisar se o último backup bem-sucedido (`last-external-backup` / `history.jsonl`) tiver mais de cerca de 26 horas.

Um jeito que cobre os dois: quando o envio do backup termina com `0`, o agendamento avisa um monitor externo de "sinal de vida" (heartbeat), e o monitor alerta quando o aviso não chega no prazo. **A confirmar antes de implementar:** se o plano gratuito do serviço escolhido (o UptimeRobot é candidato) oferece esse tipo de monitor; se não oferecer, decidir entre um plano pago, outro serviço ou um envio de e-mail pelo próprio servidor.

**Como provar que funciona:** forçar uma falha (por exemplo, um `BACKUP_S3_BUCKET` inexistente num arquivo de ambiente de teste) e registrar a hora da falha e a hora em que o alerta chegou; depois, ficar um ciclo sem executar e confirmar o alerta de ausência.

**Restauração periódica:** além do backup diário, uma recuperação (`external-backup.sh pull --object <chave> --drill`) a partir da cópia externa, com cadência ainda a decidir. É ele que prova que os backups abrem.

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

## Monitoramento externo (UptimeRobot)

**Estado: só procedimento previsto.** Nenhuma conta foi criada e nenhum monitor existe. O UptimeRobot é candidato; o plano gratuito, segundo a página de preços consultada em 28/10/2026, tem 50 monitores, checagem a cada 5 minutos, alerta por e-mail e permite uso comercial. A conta é criada por quem for responsável pela homologação; nunca com credencial guardada no repositório.

**Monitores previstos**, para quando o primeiro deploy no servidor tiver o Caddy e o HTTPS conferidos (o que ainda não aconteceu):

| Monitor | Endereço | Considera fora do ar quando |
|---|---|---|
| API pronta | `https://<PUBLIC_API_HOST>/api/v1/health/ready` | A resposta não é 2xx. A readiness responde 503 quando o Postgres ou o Redis caem, e 503 `shutting_down` durante o encerramento |
| Painel | `https://<PUBLIC_PANEL_HOST>/login` | A resposta não é 2xx |

- Usar a readiness, e não o `/api/v1/health`: o liveness continua 200 com o banco fora, e o monitor deixaria de ver a queda que importa.
- Os dois endereços já são públicos pelo Caddy. A readiness não expõe host, usuário nem mensagem de erro.
- Contato de alerta: um e-mail de quem responde pela homologação, cadastrado e confirmado no próprio serviço.
- Um deploy normal pode gerar um alerta curto (há uma pausa na troca de versão; ver "Limite conhecido: há uma pausa na troca"). Com checagem a cada 5 minutos, isso é raro; não ajustar o monitor para esconder quedas.

**Como comprovar que os alertas chegam** (fora de horário de uso, com autorização):

1. Parar a API: `docker compose -p luxora-staging --env-file /etc/luxora/staging.env -f infra/staging/docker-compose.yml stop backend`.
2. Anotar a hora; esperar o e-mail de "fora do ar" do monitor da API e anotar a hora da chegada.
3. Subir de novo: o mesmo comando com `start backend`. Esperar o e-mail de volta e anotar a hora.
4. Repetir com o painel (`stop frontend` / `start frontend`).
5. Guardar no registro da homologação: horários, monitores e o tempo até cada aviso. Nunca guardar token, senha ou dado de paciente.

**Concluído quando:** os dois monitores aparecem ativos no serviço e os quatro avisos (queda e volta da API e do painel) foram recebidos e registrados.

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
- [PREPARACAO_SERVIDOR_HOMOLOGACAO.md](PREPARACAO_SERVIDOR_HOMOLOGACAO.md) — checklist do servidor de homologação, para quando ele existir.
- [AUTOMACOES_AGENDADOR.md](AUTOMACOES_AGENDADOR.md) — como o agendador deverá chamar as automações, e o que falta.
- [13-Deploy.md](../02-Arquitetura/13-Deploy.md) e [00-Provedor-e-Custos.md](00-Provedor-e-Custos.md).
