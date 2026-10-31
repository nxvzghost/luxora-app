# BACKUP_ISOLADO — backup do banco com identidade própria (`luxora-backup`)

**Status:** Preparado, **não instalado e não validado em servidor real**. Nenhum servidor foi contratado, nenhum usuário Linux foi criado, nada existe em `/etc/luxora-backup` nem em `/opt/luxora-backup`, e o systemd nunca leu estas unidades num host de verdade. Tudo abaixo é o roteiro esperado, conferido por testes com dependências simuladas (seção "O que foi provado e o que depende da VPS").
**Complementa:** [DEPLOY_RUNBOOK.md](DEPLOY_RUNBOOK.md) ("Backup externo cifrado", "Agendamento e alertas do backup"), [PREPARACAO_SERVIDOR_HOMOLOGACAO.md](PREPARACAO_SERVIDOR_HOMOLOGACAO.md) (item 9) e [MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md) (restauração).

## O desenho

O backup automático **não usa o usuário `deploy`, o grupo `docker` nem os segredos da aplicação**. O `pg_dump` roda no host, como o usuário `luxora-backup`, e se conecta ao Postgres do compose pelo loopback.

| Peça | Como é |
|---|---|
| Postgres | O container do compose publica a porta **somente em `127.0.0.1:15432`** (`POSTGRES_BACKUP_PORT`). Nunca em `0.0.0.0`; o firewall não precisa abrir nada |
| Role do banco | `luxora_backup`: LOGIN, sem superusuário/createdb/createrole/replicação, no máximo 3 conexões, membro **somente** de `pg_read_all_data`, `BYPASSRLS`, `default_transaction_read_only=on` (trava de acidente, não a fronteira). Criada por `infra/staging/postgres-init/02-backup-role.sh` |
| Usuário Linux | `luxora-backup`: de sistema, sem shell, sem sudo, **fora do grupo `docker`**, sem acesso ao socket do Docker |
| Autenticação | Arquivo `pgpass` do usuário (`BACKUP_PG_PASSFILE`); a senha nunca vai em argumento, variável de ambiente ou log |
| Scripts | Cópia de `root:root` em `/opt/luxora-backup/scripts/`, instalada por `infra/scripts/install-backup-scripts.sh`. O serviço **não executa nada do checkout do deploy** |
| Serviços | `luxora-backup@<ambiente>.service`/`.timer` (diário, 03:30 UTC) e `luxora-backup-health@<ambiente>.service`/`.timer` (a cada hora, minuto 15), ambos `User=luxora-backup` |
| Fluxo | `pg_dump -Fc` → `gpg` (AES-256) → envio S3, tudo no host, sem Docker. `pull` (baixar e restaurar) e o `restore-drill.sh` **não** fazem parte do timer |

### Por que os scripts ficam em `/opt/luxora-backup`

O `luxora-backup` lê o banco inteiro (`BYPASSRLS`) e a credencial do armazenamento. Se executasse scripts do checkout do deploy (`/srv/luxora-app`), quem controla o `deploy` controlaria o código que roda com esse poder; e mudar só as permissões do checkout não resolve, porque o `deploy.sh`/CD refazem o checkout a cada versão e o dono do repositório pode trocar o conteúdo a qualquer momento. Por isso há uma cópia de `root:root`, sem escrita para ninguém mais, e as unidades apontam só para ela (e declaram `InaccessiblePaths=/etc/luxora /srv/luxora-app`).

Os quatro arquivos copiados se encontram pelo próprio diretório (`SCRIPTS_DIR`/`dirname`): `backup-job.sh`, `external-backup.sh`, `external-backup-health.sh` e `lib.sh`. `restore-drill.sh` e o compose **não** são copiados: só o `pull --drill`, manual, os usa.

## Quem tem o quê (arquivos, donos e modos)

| Caminho | Dono | Modo | Conteúdo | Quem lê |
|---|---|---|---|---|
| `/etc/luxora/staging.env` | `deploy` | 600 | Ambiente da aplicação **e** as senhas do banco (`POSTGRES_ADMIN_PASSWORD`, `POSTGRES_APP_PASSWORD`, `POSTGRES_BACKUP_PASSWORD`, JWT, chaves das integrações) | `deploy` (e root, uma vez, para gerar o pgpass). **Nunca o `luxora-backup`** |
| `/etc/luxora-backup/` | `root:luxora-backup` | 750 | Pasta de configuração do backup | `luxora-backup` (leitura e passagem; não grava) |
| `/etc/luxora-backup/staging.env` | `root:luxora-backup` | 640 | Só a configuração do backup (modelo: `infra/staging/.env.backup.example`) | `luxora-backup` |
| `/etc/luxora-backup/backup.pgpass` | `luxora-backup` | 400 | `127.0.0.1:15432:<banco>:luxora_backup:<senha>` | `luxora-backup` |
| `/etc/luxora-backup/backup-passphrase` | `luxora-backup` | 400 | Chave de cifragem (24+ caracteres; cópia **fora do servidor**) | `luxora-backup` |
| `/opt/luxora-backup/scripts/` | `root:root` | 755 (arquivos 755; `MANIFEST.sha256` e `VERSION` 644) | Os scripts do backup | executa: `luxora-backup`; grava: só root |
| `/var/lib/luxora-backup/<ambiente>/` | `luxora-backup` | 700 | Estado: `last-external-backup`, `history.jsonl`, `alerts.jsonl`, `backup-job/`, `tmp/` | `luxora-backup` |
| `/etc/systemd/system/luxora-backup*` | `root:root` | 644 | As unidades | systemd |

Separação dos segredos, em uma frase: **o que a aplicação e o deploy sabem** (`/etc/luxora/staging.env`) e **o que o backup sabe** (`/etc/luxora-backup/*`) não se misturam. A única senha que existe nos dois lados é a da role `luxora_backup`, copiada uma vez para o pgpass por `install-backup-pgpass.sh`. O `backup-job.sh` recusa (saída 20 no backup e 13 na verificação, sem usar o notificador do arquivo) um arquivo de ambiente que: não seja de root nem do usuário que executa, tenha escrita para o grupo ou qualquer acesso para outros, ou contenha **qualquer um** destes com valor: `POSTGRES_ADMIN_PASSWORD`, `POSTGRES_APP_PASSWORD`, `POSTGRES_BACKUP_PASSWORD`, `JWT_SECRET`, `WHATSAPP_TOKEN_ENCRYPTION_KEY`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `ASAAS_WEBHOOK_TOKEN`, `ASAAS_API_KEY`, `ANTHROPIC_API_KEY`, `AUTOMATION_API_KEY`, `METRICS_ACCESS_TOKEN`.

### Variáveis do backup (`/etc/luxora-backup/staging.env`)

| Variável | O que é |
|---|---|
| `APP_ENV`, `POSTGRES_DB` | ambiente e banco (os mesmos da aplicação) |
| `BACKUP_PG_HOST` | `127.0.0.1` |
| `BACKUP_PG_PORT` | igual a `POSTGRES_BACKUP_PORT` da aplicação (padrão `15432`) |
| `BACKUP_PG_USER` | `luxora_backup` |
| `BACKUP_PG_PASSFILE` | caminho do pgpass (dono `luxora-backup`, 400 ou 600, sem link simbólico, não vazio) |
| `BACKUP_PG_SSLMODE` | opcional, padrão `prefer`. **O Postgres do compose não tem TLS:** `require`, `verify-ca` e `verify-full` fariam a conexão falhar. `disable` e `prefer` servem no loopback |
| `BACKUP_S3_*`, `BACKUP_ENCRYPTION_PASSPHRASE_FILE`, `BACKUP_VERIFY_AFTER_UPLOAD` | armazenamento e cifragem (ver DEPLOY_RUNBOOK) |
| `BACKUP_MAX_AGE_HOURS`, `BACKUP_ALERT_*` | verificação de idade e alertas (opcionais) |

## O que a role `luxora_backup` pode e não pode

Pode: conectar ao banco da aplicação; `USAGE` nos schemas e `SELECT` em tabelas, views e sequências (por `pg_read_all_data`); ler todas as linhas de todas as clínicas (**`BYPASSRLS` é indispensável**: sem ele o `pg_dump` falha ou sai incompleto nas tabelas com RLS forçada, e é por isso que o arquivo `pgpass` e a chave de cifragem precisam de proteção forte).

Não pode: escrever em nada (nenhum `INSERT/UPDATE/DELETE/TRUNCATE/DDL`, nem `nextval`), criar objetos, roles ou bancos, mudar a própria configuração, ser membro de `pg_write_all_data`/`pg_monitor`/`luxora_app`/admin. A trava `default_transaction_read_only=on` só evita acidente (a própria sessão pode desligá-la); a fronteira é a falta de privilégio, conferida por `infra/tests/backup-role-test.sh`.

Limitações conhecidas:

- **Objetos grandes (Large Objects) não são suportados.** O Luxora não os usa. O `02-backup-role.sh` **aborta, sem criar nem alterar nada**, se o banco tiver qualquer objeto grande, e revoga de `PUBLIC` e da role a criação de novos (só no banco de `POSTGRES_DB`). Um objeto grande sem permissão de leitura derrubaria o `pg_dump` no meio do arquivo.
- A role pode criar tabelas **temporárias** (herdado de `PUBLIC`; somem com a sessão). Decisão consciente.
- O dump não carrega roles: um banco restaurado precisa que `luxora_app` e `luxora_backup` já existam (o `01-` e o `02-` os criam num volume novo).
- Num Postgres gerenciado (fora do compose), a role precisa ser criada à mão com o mesmo conjunto de atributos; nada disso foi desenhado nem testado para esse caminho.

## Ativar a role num volume PostgreSQL já inicializado (sem apagar nem recriar o volume)

A imagem oficial só executa os scripts de `postgres-init/` na **primeira** inicialização do volume. Num volume que já existe, nada acontece sozinho: siga os passos abaixo. Eles **não** apagam dados: o volume nomeado (`postgres_data`) é preservado. **Nunca** use `docker compose down -v` nem `docker volume rm` para isto.

1. Como `deploy`, no checkout já no commit que contém a E2 (ou posterior), acrescente as duas variáveis ao ambiente da aplicação **sem exibir o valor** (a senha gerada tem 48 caracteres hexadecimais):

   ```bash
   grep -q '^POSTGRES_BACKUP_PASSWORD=' /etc/luxora/staging.env && echo "já existe — não repita" || \
     printf 'POSTGRES_BACKUP_PASSWORD=%s\nPOSTGRES_BACKUP_PORT=15432\n' "$(openssl rand -hex 24)" >> /etc/luxora/staging.env
   stat -c '%a %U' /etc/luxora/staging.env   # continua 600 deploy
   ```

2. Recrie **só o container** do Postgres para ele receber a variável e publicar a porta (ou deixe o próximo `deploy.sh` fazer isso). O volume continua. Há uma pausa de alguns segundos no banco (a readiness da API fica 503 nesse intervalo); faça fora do horário de uso:

   ```bash
   docker compose -p luxora-staging --env-file /etc/luxora/staging.env -f infra/staging/docker-compose.yml up -d --no-deps --force-recreate postgres
   ```

3. Rode o script da role dentro do container (idempotente: pode ser repetido; atualiza atributos e senha):

   ```bash
   docker compose -p luxora-staging --env-file /etc/luxora/staging.env -f infra/staging/docker-compose.yml exec -T postgres bash /docker-entrypoint-initdb.d/02-backup-role.sh
   ```

   Se o banco tiver objetos grandes, o script aborta com uma mensagem e nada é criado; remova-os ou implemente o suporte antes de seguir.

4. Confira a role (só consulta; nada é alterado) e a porta:

   ```bash
   bash infra/tests/backup-role-test.sh --container "$(docker compose -p luxora-staging --env-file /etc/luxora/staging.env -f infra/staging/docker-compose.yml ps -q postgres)" --db luxora_staging
   sudo ss -tlnp | grep 15432     # só 127.0.0.1:15432
   ```

   **Concluído quando:** o teste termina com `0 falharam` e a porta 15432 aparece somente em `127.0.0.1`. Num banco com dados, a linha "leitura sob RLS forçada" compara o total de linhas lido pela role com o do administrador.

Num volume **novo**, nada disso é necessário: o `02-backup-role.sh` roda sozinho na primeira inicialização, desde que `POSTGRES_BACKUP_PASSWORD` (16+ caracteres) esteja no ambiente (o `generate-env.sh` já a gera).

**Troca da senha da role:** gere outra senha no ambiente da aplicação, repita os passos 2 (se necessário) e 3, e refaça o pgpass com `--force` (item 5 abaixo). Os timers não precisam ser reiniciados.

## Instalação no servidor (roteiro; cada passo precisa de autorização própria)

Pré-requisitos: itens 1 a 8 do [checklist do servidor](PREPARACAO_SERVIDOR_HOMOLOGACAO.md) concluídos; a role ativada (seção acima); um **commit conferido**: o hash completo (40 caracteres) de um commit com o CI verde, visto por você no GitHub. Pacotes no host: `postgresql-client-16` (a mesma versão principal do servidor, `postgres:16`), `curl` 7.75 ou mais novo, `gpg`, `coreutils` e `git`.

1. **Usuário e pasta de configuração** (root):

   ```bash
   sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin luxora-backup
   sudo install -d -m 0750 -o root -g luxora-backup /etc/luxora-backup
   id luxora-backup      # só o grupo luxora-backup: sem docker, sem sudo
   ```

2. **Clone de root, fora do checkout do deploy** (a origem do que será instalado). O instalador **recusa** uma origem que não seja de `root:root` e sem escrita para grupo/outros, e um HEAD que não seja o commit informado:

   ```bash
   sudo -i
   git clone https://github.com/nxvzghost/luxora-app.git /root/luxora-install    # repetições: git -C /root/luxora-install fetch
   cd /root/luxora-install && git checkout --detach <COMMIT-COMPLETO>
   ```

3. **Instalar os scripts** (como root, no clone acima):

   ```bash
   bash infra/scripts/install-backup-scripts.sh --expect-commit <COMMIT-COMPLETO>
   bash infra/scripts/install-backup-scripts.sh --verify --expect-commit <COMMIT-COMPLETO>
   ```

   Resultado: `/opt/luxora-backup/scripts/` com os quatro scripts, `MANIFEST.sha256` e `VERSION`, tudo `root:root`. A versão anterior, se havia, fica em `scripts.prev/` (uma só).

4. **Arquivo de ambiente do backup** (a partir do modelo do mesmo commit) e edição no servidor:

   ```bash
   sudo install -m 0640 -o root -g luxora-backup infra/staging/.env.backup.example /etc/luxora-backup/staging.env
   sudoedit /etc/luxora-backup/staging.env     # substitua todos os "troque-este-valor"; nada de segredo da aplicação aqui
   ```

5. **pgpass** (a senha é lida do ambiente da aplicação e gravada para o `luxora-backup`, sem ser exibida):

   ```bash
   sudo bash infra/scripts/install-backup-pgpass.sh --app-env /etc/luxora/staging.env       # troca de senha: acrescente --force
   ```

6. **Chave de cifragem** (já gerada e guardada fora do servidor; cole o conteúdo e termine com Ctrl-D — não passe pelo histórico do shell nem por chat):

   ```bash
   sudo sh -c 'umask 277 && cat > /etc/luxora-backup/backup-passphrase' && sudo chown luxora-backup:luxora-backup /etc/luxora-backup/backup-passphrase
   ```

7. **Conferir a configuração como o `luxora-backup`** (não acessa rede nem banco):

   ```bash
   sudo -u luxora-backup env LUXORA_STATE_DIR=/tmp/luxora-check bash /opt/luxora-backup/scripts/external-backup.sh check --env-file /etc/luxora-backup/staging.env
   sudo rm -rf /tmp/luxora-check
   ```

   (O estado real é criado pelo systemd. Este passo usa um estado descartável.)

8. **Unidades** (do mesmo clone de root):

   ```bash
   sudo install -m 0644 -o root -g root infra/systemd/luxora-backup@.service infra/systemd/luxora-backup@.timer \
     infra/systemd/luxora-backup-health@.service infra/systemd/luxora-backup-health@.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemd-analyze verify /etc/systemd/system/luxora-backup@staging.service /etc/systemd/system/luxora-backup-health@staging.service
   ```

9. **Primeiro backup manual, pelo próprio serviço** (roda exatamente como o timer, com o endurecimento do systemd; só então confirme que o objeto apareceu no armazenamento):

   ```bash
   sudo systemctl start luxora-backup@staging.service
   systemctl status luxora-backup@staging.service --no-pager
   journalctl -u luxora-backup@staging.service --no-pager --since '10 minutes ago'
   ```

   Um `pull --drill` do objeto enviado, como `deploy` e com a credencial de leitura (DEPLOY_RUNBOOK, "Backup externo cifrado"), prova que o backup abre.

10. **Ligar os timers** (só depois dos passos 7 a 9 terem passado):

    ```bash
    sudo systemctl enable --now luxora-backup@staging.timer luxora-backup-health@staging.timer
    systemctl list-timers 'luxora-backup*'
    ```

Também: journal persistente (`/var/log/journal` existe ou `Storage=persistent`) e o canal de alerta (notificador instalado, por exemplo, em `/opt/luxora-backup/notify/`, `root:root`, sem escrita para grupo/outros, e `BACKUP_ALERT_NOTIFIER` no arquivo de ambiente do backup).

## Operação

| Para quê | Comando |
|---|---|
| Próxima e última execução | `systemctl list-timers 'luxora-backup*'` |
| Resultado da última execução | `systemctl status luxora-backup@staging.service` e `systemctl show luxora-backup@staging.service -p Result -p ExecMainStatus` |
| Logs | `journalctl -u luxora-backup@staging.service --since '2 days ago'` (e `luxora-backup-health@...`) |
| Alertas, estado e histórico | `sudo tail -n 20 /var/lib/luxora-backup/staging/alerts.jsonl`, `sudo cat /var/lib/luxora-backup/staging/backup-job/*.state`, `sudo tail -n 5 /var/lib/luxora-backup/staging/history.jsonl` |
| A instalação dos scripts continua íntegra? | `sudo bash /root/luxora-install/infra/scripts/install-backup-scripts.sh --verify` |
| Idade do último backup agora | `sudo systemctl start luxora-backup-health@staging.service` e o log dela |

Códigos de saída e eventos de alerta: DEPLOY_RUNBOOK, "Agendamento e alertas do backup".

**Atualizar os scripts:** `git -C /root/luxora-install fetch && git -C /root/luxora-install checkout --detach <NOVO-COMMIT>`, depois o passo 3. O instalador recusa instalar com um serviço do backup ativo (evita misturar versões); rode fora de 03:30 UTC e do minuto 15 de cada hora. **Voltar atrás:** `cd /opt/luxora-backup && sudo mv scripts scripts.ruim && sudo mv scripts.prev scripts`, e confira com `--verify`. **Atualizar as unidades:** copie de novo (passo 8), `daemon-reload`, e os timers seguem.

## Recuperação e restauração

- **Restauração (ensaio):** `external-backup.sh pull --object <chave> --drill`, como `deploy`, com o ambiente de leitura (credencial só de leitura, fora do servidor) — usa Docker e o `restore-drill.sh`; **não** faz parte do timer nem do `luxora-backup`.
- **Restauração real:** [MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md), "Restauração no ambiente real". O dump não traz roles; o banco de destino precisa ter `luxora_app` e `luxora_backup` (o `01-` e o `02-` de um volume novo). O dump traz as revogações de criação de objetos grandes.
- **Servidor desligado na hora do backup:** `Persistent=true` roda a execução perdida ao ligar (comportamento do systemd; ainda não visto num servidor).
- **Estado perdido** (`/var/lib/luxora-backup/<ambiente>`): o systemd o recria vazio; a verificação acusa "ausente" até o próximo backup; o histórico anterior só existe no que foi enviado ao armazenamento.
- **pgpass perdido ou senha trocada:** refaça com `install-backup-pgpass.sh --force` (passo 5).
- **Scripts instalados alterados ou com dono errado:** `--verify` acusa; reinstale a partir do clone de root.
- **Chave de cifragem perdida:** não há recuperação. Por isso a cópia fora do servidor é pré-requisito.

## O que foi provado e o que depende da VPS

**Provado (testes locais e no CI, com dependências simuladas):** conteúdo e contrato das unidades (usuário, sem Docker, endurecimento, estado, caminhos); validação do arquivo de ambiente e recusa de segredos da aplicação; cadeia `backup-job.sh` → `external-backup.sh` → `pg_dump`/gpg/envio sem nenhuma chamada ao Docker; execução como usuário sem privilégios (`nobody`, só como root); instalador (origem confiável, commit, blobs, modos, troca, `--verify`, reinstalação, `scripts.prev`); gerador do pgpass; o modelo do ambiente do backup contra o `external-backup.sh check`; atributos e privilégios da role num PostgreSQL 16 real (`backup-role-test.sh`, também no ensaio do CI).

**Depende da VPS (nada disso foi visto):**

- O systemd real: ler as unidades, criar o `StateDirectory` com o dono certo, aplicar `ProtectSystem=strict`, `InaccessiblePaths`, `RestrictAddressFamilies` e `CapabilityBoundingSet=` vazio sem impedir o `gpg`, o `curl` ou o `pg_dump`; `systemd-analyze verify`; `Persistent=true`; `StateDirectory` com `%i`.
- A conexão real do host ao container (`127.0.0.1:15432` → bridge do Docker) com autenticação **SCRAM** (o `pg_hba` da imagem usa `trust` no loopback do próprio container e SCRAM para as demais origens); `sslmode` sem TLS.
- O `pg_dump`/`pg_restore` reais (cliente 16 contra servidor 16), o envio e a conferência no armazenamento S3 real (a assinatura `--aws-sigv4` aceita pelo provedor) e o `pull --drill`.
- Os caminhos fixos (`/opt/luxora-backup`, `/etc/luxora-backup`, `/var/lib/luxora-backup`) e a ordem dos passos num Ubuntu 24.04 de verdade (`useradd`, `install`, `git clone` como root, `sudoedit`).
- A pausa real ao recriar o container do Postgres e o tempo em que a API fica 503.
- O notificador e o canal de alerta (nenhum existe); o monitor externo de "sinal de vida".
- Retenção (J-4), cadência do `pull --drill` e a política de rotação das chaves.
