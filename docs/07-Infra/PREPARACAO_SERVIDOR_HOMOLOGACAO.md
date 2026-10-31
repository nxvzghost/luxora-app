# PREPARACAO_SERVIDOR_HOMOLOGACAO — checklist do servidor de homologação

**Status:** Preparação — checklist para quando o servidor existir. **Nenhum servidor foi contratado**, e a escolha entre servidor próprio e Railway continua pendente ([00-Provedor-e-Custos.md](00-Provedor-e-Custos.md)). Este checklist vale para o caminho de servidor próprio acessado por SSH, que é o que o CD e os scripts de `infra/` já suportam. Nada aqui foi executado.
**Complementa:** [DEPLOY_RUNBOOK.md](DEPLOY_RUNBOOK.md) (deploy, rollback, proxy, backup externo, monitoramento) e [ENTRADA_CLINICA_PILOTO.md](ENTRADA_CLINICA_PILOTO.md).

Pressupostos: Ubuntu 24.04 LTS, acesso inicial de administrador fornecido pelo provedor, repositório público no GitHub. Os comandos são o roteiro esperado; cada um ainda precisa ser conferido no servidor real.

## Antes de acessar o servidor

- [ ] Domínio e os dois nomes de host definidos (API e painel). Eles viram `PUBLIC_API_HOST` e `PUBLIC_PANEL_HOST`.
- [ ] Impressão digital da chave SSH do servidor anotada pelo console do provedor (para conferir o `known_hosts`, abaixo).
- [ ] Decidido se as imagens do GHCR ficam públicas ou privadas (privadas exigem um `docker login ghcr.io` no servidor).
- [ ] Chave de cifragem do backup gerada, com uma cópia guardada **fora do servidor e fora do armazenamento dos backups**, sob a guarda de quem foi decidido (DEPLOY_RUNBOOK, "Backup externo cifrado").

## 1. Sistema

- [ ] Sistema atualizado: `sudo apt update && sudo apt upgrade`.
- [ ] Fuso e relógio: `timedatectl` mostra o relógio sincronizado (o deploy grava horários em UTC no `history.jsonl`).
- [ ] Atualizações de segurança automáticas (`unattended-upgrades`): decidir se ficam ligadas e se o servidor pode reiniciar sozinho.

**Concluído quando:** `apt list --upgradable` vazio e `timedatectl` com `System clock synchronized: yes`.

## 2. Usuário de deploy

- [ ] Usuário dedicado, sem senha: `sudo adduser --disabled-password --gecos "" deploy`.
- [ ] No grupo `docker` (depois do item 5): `sudo usermod -aG docker deploy`. Atenção: o grupo `docker` equivale a acesso de administrador ao servidor; é o mesmo poder que o CD precisa para rodar o `deploy.sh`.
- [ ] Sem `sudo` para o usuário de deploy, salvo decisão em contrário.

**Concluído quando:** `id deploy` mostra o grupo `docker` e `sudo -l -U deploy` não lista permissões.

## 3. SSH

- [ ] Um par de chaves **só para o CD**, gerado fora do servidor (`ssh-keygen -t ed25519 -C luxora-cd-staging`). A pública vai para `/home/deploy/.ssh/authorized_keys` (permissões 700 na pasta, 600 no arquivo); a privada vai só para o segredo `STAGING_SSH_KEY` do GitHub.
- [ ] Acesso de administrador por chave própria, separada da do CD.
- [ ] Só depois de testar o login por chave do `deploy` e do administrador: `PasswordAuthentication no` e `PermitRootLogin no` em `/etc/ssh/sshd_config.d/`, e `sudo systemctl reload ssh`.
- [ ] `known_hosts` do CD: `ssh-keyscan -t ed25519 <host>` conferido contra a impressão digital anotada antes. O resultado vai para o segredo `STAGING_SSH_KNOWN_HOSTS`. O CD nunca aceita a chave do host às cegas.

**Concluído quando:** `ssh deploy@<host> true` funciona com a chave do CD; um login por senha é recusado; `ssh root@<host>` é recusado.

## 4. Firewall

- [ ] Entrada só em 22 (SSH), 80 e 443 (Caddy): no firewall do provedor, no `ufw` do host, ou nos dois.
- [ ] Se usar `ufw`: as portas publicadas pelo Docker passam por fora das regras do `ufw`. Na pilha de homologação isso só atinge o Caddy (80 e 443, que devem ficar abertas mesmo); a API e o painel são publicados apenas no loopback (`127.0.0.1`); o **Postgres é publicado somente em `127.0.0.1:15432`** (para o `pg_dump` do backup; nunca em `0.0.0.0`) e o Redis não é publicado.
- [ ] Se possível, restringir a 22 a endereços conhecidos. Os runners do GitHub usam endereços variáveis, então restringir a 22 pode impedir o CD; decidir antes.

**Concluído quando:** de fora do servidor, só 22, 80 e 443 respondem (`nc -zv <host> <porta>` para as portas 5432, 6379, 13000, 13001 e 15432 falha); `sudo ss -tlnp` mostra 13000, 13001 e 15432 só em `127.0.0.1`.

## 5. Docker e ferramentas

- [ ] Docker Engine e o plugin compose pelo repositório oficial da Docker (não o pacote `docker.io` da distribuição, para ter o `docker compose`).
- [ ] `curl` 7.75 ou mais novo (o backup externo usa `--aws-sigv4`), `gpg`, `sha256sum` (coreutils) e `git`.
- [ ] Clientes PostgreSQL **16** no host (`postgresql-client-16`, a mesma versão principal do `postgres:16` do compose): o `pg_dump` do backup roda no host, sem Docker.

**Concluído quando:** como `deploy`, `docker compose version`, `curl --version`, `gpg --version`, `sha256sum --version` e `git --version` respondem, e `docker ps` funciona sem `sudo`; `pg_dump --version` e `pg_restore --version` mostram a versão 16.

## 6. Checkout do repositório

- [ ] Pasta do repositório, por exemplo `/srv/luxora-app`, do usuário `deploy`: `sudo install -d -o deploy -g deploy /srv/luxora-app` e, como `deploy`, `git clone https://github.com/nxvzghost/luxora-app.git /srv/luxora-app`.
- [ ] Esse caminho vira a variável `STAGING_REPO_DIR` do GitHub. A cada deploy o CD faz `git fetch` do commit e `git checkout --detach` nele: os scripts e o compose vêm do mesmo commit das imagens. Não editar arquivos nessa pasta à mão (o checkout seguinte os sobrescreve ou falha).

**Concluído quando:** `git -C /srv/luxora-app status` limpo, como `deploy`.

## 7. Arquivo de ambiente

- [ ] Pasta só do `deploy`: `sudo install -d -m 700 -o deploy -g deploy /etc/luxora`. O estado do deploy (`luxora-deploy-state/`, com versões, backups e `history.jsonl`) é criado ao lado do arquivo de ambiente, então essa pasta precisa ser gravável pelo `deploy`.
- [ ] Gerado como `deploy`: `bash infra/scripts/generate-env.sh /etc/luxora/staging.env staging`. Preencher `FRONTEND_URL` (`https://` + o host do painel), `PUBLIC_API_HOST`, `PUBLIC_PANEL_HOST` e, quando existirem, as chaves **de teste** (Anthropic, Asaas sandbox). Nunca chave de produção.
- [ ] Permissão 600, dono `deploy`. Fora do repositório e fora de qualquer backup que não seja cifrado.
- [ ] Esse caminho vira a variável `STAGING_ENV_FILE` do GitHub.
- [ ] Este arquivo é **só da aplicação e do deploy**. As variáveis do backup (`BACKUP_S3_*`, `BACKUP_ENCRYPTION_PASSPHRASE_FILE`, `BACKUP_PG_*`) **não ficam aqui**: vão para `/etc/luxora-backup/staging.env` (item 9), com outro dono e outro usuário. Aqui ficam só `POSTGRES_BACKUP_PASSWORD` e `POSTGRES_BACKUP_PORT`, que o compose entrega ao container do Postgres (o `generate-env.sh` as gera).

**Concluído quando:** `stat -c '%a %U' /etc/luxora/staging.env` mostra `600 deploy`; `grep -c troque-este-valor /etc/luxora/staging.env` mostra `0`.

## 8. GitHub

- [ ] Ambiente `staging` com os segredos `STAGING_SSH_HOST`, `STAGING_SSH_USER` (`deploy`), `STAGING_SSH_KEY` e `STAGING_SSH_KNOWN_HOSTS`.
- [ ] Variáveis `STAGING_REPO_DIR`, `STAGING_ENV_FILE` e, por último, `STAGING_DEPLOY_ENABLED=true`.
- [ ] Imagens privadas: `docker login ghcr.io` uma vez, como `deploy`, com um token só de leitura de pacotes.

**Concluído quando:** os nomes aparecem nas configurações do repositório. O primeiro deploy pelo CD é uma etapa à parte, com autorização própria.

## 9. Backup com identidade própria e agendamento (só depois do primeiro deploy e do envio manual)

**Preparado, não instalado nem validado em servidor.** O roteiro completo, com os comandos em ordem, os donos e modos e o que depende do servidor, está em [BACKUP_ISOLADO.md](BACKUP_ISOLADO.md); detalhes de agendamento e alertas: DEPLOY_RUNBOOK, "Agendamento e alertas do backup". O isolamento não é mais uma pendência de decisão: o backup roda como o usuário `luxora-backup`, sem Docker, com a role `luxora_backup` e com scripts de `root:root`.

- [ ] **Role no banco:** `02-backup-role.sh` executado (volume novo: sozinho; volume existente: pelo procedimento do BACKUP_ISOLADO.md, sem apagar o volume) e `bash infra/tests/backup-role-test.sh --container <postgres>` com `0 falharam`; porta 15432 só em `127.0.0.1`.
- [ ] **Usuário e pasta:** `luxora-backup` criado (de sistema, sem shell, sem sudo, fora do grupo `docker`) e `/etc/luxora-backup` (`root:luxora-backup`, 750).
- [ ] **Scripts de root:** clone feito por root, commit conferido e `install-backup-scripts.sh --expect-commit <hash>` seguido de `--verify`; `/opt/luxora-backup/scripts` é `root:root`.
- [ ] **Configuração do backup:** `/etc/luxora-backup/staging.env` (a partir de `infra/staging/.env.backup.example`, `root:luxora-backup`, 640, sem nenhum segredo da aplicação), pgpass (`install-backup-pgpass.sh`) e arquivo da chave de cifragem (`luxora-backup`, 400), com uma cópia da chave **fora do servidor**.
- [ ] `external-backup.sh check` como `luxora-backup` passa (sem rede nem banco).
- [ ] Unidades copiadas de um clone de root para `/etc/systemd/system/` (dono root, 644), `systemd-analyze verify` sem erro.
- [ ] **Primeiro envio real pelo próprio serviço** (`systemctl start luxora-backup@staging.service`) passou, o objeto apareceu no armazenamento e um `pull --drill` dele (como `deploy`, com a credencial de leitura) passou.
- [ ] Só então `systemctl enable --now luxora-backup@staging.timer luxora-backup-health@staging.timer`.
- [ ] Journal persistente (`/var/log/journal` existe ou `Storage=persistent`).
- [ ] Canal de alerta decidido, **notificador** escrito e instalado (dono root, sem escrita para grupo ou outros, por exemplo em `/opt/luxora-backup/notify/`) e `BACKUP_ALERT_NOTIFIER` no arquivo de ambiente do backup. Sem isso, o log diz `ALERTA NÃO ENVIADO` e a conferência é manual.
- [ ] Falha forçada e atraso forçado num ambiente de teste com pasta de estado própria, com os horários da falha e do aviso registrados (roteiro no runbook).

**Concluído quando:** `id luxora-backup` não mostra `docker` nem `sudo`; `install-backup-scripts.sh --verify` passa; `systemctl list-timers 'luxora-backup*'` mostra os dois timers com a próxima execução, o primeiro backup agendado apareceu no armazenamento e o aviso de uma falha forçada chegou ao canal.

## Depois do checklist

Seguem, nesta ordem e cada um com autorização própria: DNS dos dois hosts, primeiro deploy pelo CD com o Caddy e o HTTPS conferidos, rollback real, backup externo real com `pull --drill`, agendamento do backup (item 9), monitoramento externo e alertas disparados de propósito (DEPLOY_RUNBOOK, seções correspondentes), e o roteiro da clínica piloto.
