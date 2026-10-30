#!/usr/bin/env bash
# Luxora — backup externo cifrado do banco e recuperação para o ensaio de restauração.
# (A-12. Procedimento e variáveis: docs/07-Infra/DEPLOY_RUNBOOK.md, "Backup externo cifrado".)
#
#   external-backup.sh check --env-file F
#   external-backup.sh push  --env-file F
#   external-backup.sh pull  --env-file F --object <chave> [--sha256 <hex>] (--output <arquivo> | --drill)
#
# check  Confere a configuração e as ferramentas. Não acessa a rede nem o banco.
# push   pg_dump -> cifragem -> envio, com nome único. O dump NUNCA existe em claro
#        no disco: vai do pg_dump direto para o gpg. O pg_dump e o pg_restore rodam NO
#        HOST (clientes PostgreSQL), conectados ao banco por BACKUP_PG_* com um papel
#        de backup: push e check não usam Docker. A cópia cifrada é decifrada de
#        novo, em fluxo, para conferir que o dump é válido, antes do envio. Depois do
#        envio confere o tamanho do objeto (desligável: BACKUP_VERIFY_AFTER_UPLOAD=0,
#        para credencial só de escrita).
# pull   Baixa o objeto, decifra para um arquivo temporário protegido, confere o dump
#        e entrega o resultado: em --output (arquivo novo, permissão 600, cuja guarda
#        passa a ser de quem pediu) ou em --drill, que roda o restore-drill.sh existente
#        (restaura num banco descartável e confere a RLS) e apaga o arquivo em claro ao
#        terminar.
#
# Não apaga nem rotaciona nada no armazenamento e não agenda nada: a retenção
# depende da decisão J-4. Sem provedor, bucket, endpoint ou credencial fixos:
# tudo vem do arquivo de ambiente (BACKUP_*). Dependências no host: bash, curl 7.75
# ou mais novo (--aws-sigv4), gpg e sha256sum; para push e check, também pg_dump e
# pg_restore (clientes PostgreSQL, da mesma versão principal do servidor); só o pull
# precisa de docker (com o plugin compose), pelo restore-drill.sh.
#
# Conexão do push (arquivo de ambiente; nada disso vai para a linha de comando):
#   BACKUP_PG_HOST, BACKUP_PG_PORT, BACKUP_PG_USER   endereço e papel de backup
#   BACKUP_PG_PASSFILE     caminho de um arquivo no formato pgpass do libpq
#                          (host:porta:banco:usuário:senha), permissão 600 ou 400 e
#                          dono = quem executa o backup. A senha só existe nele.
#   BACKUP_PG_SSLMODE      opcional (padrão prefer): disable, allow, prefer, require,
#                          verify-ca ou verify-full
# O banco vem de POSTGRES_DB. Variáveis PG* herdadas do ambiente do processo (como
# PGPASSWORD) são descartadas: só vale o que está no arquivo de ambiente.
# Cifragem: gpg simétrico, AES-256, com checagem de integridade; a chave é lida de
# um arquivo (BACKUP_ENCRYPTION_PASSPHRASE_FILE), nunca da linha de comando.

# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

COMMAND="${1:-}"
case "$COMMAND" in
  check|push|pull) shift ;;
  *) die "uso: external-backup.sh check|push|pull --env-file <arquivo> [...] (ver o cabeçalho do script)" ;;
esac

ENV_FILE=""; OBJECT=""; OUTPUT=""; DRILL=0; EXPECTED_SHA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --object) OBJECT="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --drill) DRILL=1; shift ;;
    --sha256) EXPECTED_SHA="$2"; shift 2 ;;
    *) die "argumento desconhecido: $1" ;;
  esac
done
init_environment

DRILL_SCRIPT="${LUXORA_RESTORE_DRILL_SCRIPT:-$SCRIPTS_DIR/restore-drill.sh}"
TMP=""; GPGHOME=""

cleanup() {
  local rc=$?
  if [ -n "$GPGHOME" ] && [ -d "$GPGHOME" ]; then
    gpgconf --homedir "$GPGHOME" --kill gpg-agent >/dev/null 2>&1 || true
    rm -rf "$GPGHOME"
  fi
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then
    # Nada em claro sobra: o que existir no diretório temporário é sobrescrito e removido.
    if command -v shred >/dev/null 2>&1; then find "$TMP" -type f -exec shred -u {} + >/dev/null 2>&1 || true; fi
    rm -rf "$TMP"
  fi
  return "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---- configuração (sem imprimir segredo, nunca) --------------------------------

cfg_escape() { local v="$1"; v="${v//\\/\\\\}"; v="${v//\"/\\\"}"; printf '%s' "$v"; }

load_config() {
  local missing="" name
  for name in BACKUP_S3_ENDPOINT BACKUP_S3_REGION BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY BACKUP_ENCRYPTION_PASSPHRASE_FILE; do
    [ -n "$(env_get "$name")" ] || missing="$missing $name"
  done
  [ -z "$missing" ] || die "variáveis ausentes no arquivo de ambiente:$missing" 3

  S3_ENDPOINT="$(env_get BACKUP_S3_ENDPOINT)"; S3_ENDPOINT="${S3_ENDPOINT%/}"
  S3_REGION="$(env_get BACKUP_S3_REGION)"
  S3_BUCKET="$(env_get BACKUP_S3_BUCKET)"
  S3_PREFIX="$(env_get BACKUP_S3_PREFIX luxora)"; S3_PREFIX="${S3_PREFIX%/}"
  S3_KEY_ID="$(env_get BACKUP_S3_ACCESS_KEY_ID)"
  S3_SECRET="$(env_get BACKUP_S3_SECRET_ACCESS_KEY)"
  PASS_FILE="$(env_get BACKUP_ENCRYPTION_PASSPHRASE_FILE)"
  VERIFY_AFTER_UPLOAD="$(env_get BACKUP_VERIFY_AFTER_UPLOAD 1)"

  case "$S3_ENDPOINT" in
    https://*) ;;
    http://*) [ "$(env_get BACKUP_S3_ALLOW_INSECURE_HTTP 0)" = "1" ] || die "BACKUP_S3_ENDPOINT precisa ser https:// (http só com BACKUP_S3_ALLOW_INSECURE_HTTP=1, para teste local)" 3 ;;
    *) die "BACKUP_S3_ENDPOINT precisa começar com https://" 3 ;;
  esac
  [[ "$S3_REGION" =~ ^[a-z0-9-]+$ ]] || die "BACKUP_S3_REGION inválida" 3
  [[ "$S3_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "BACKUP_S3_BUCKET inválido" 3
  [[ "$S3_PREFIX" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] || die "BACKUP_S3_PREFIX inválido (letras, números, ponto, hífen, sublinhado e barras; sem barra no início)" 3
  case "$S3_PREFIX" in *..*) die "BACKUP_S3_PREFIX não pode conter .." 3 ;; esac

  [ -f "$PASS_FILE" ] && [ -r "$PASS_FILE" ] || die "arquivo da chave de cifragem não encontrado ou ilegível: $PASS_FILE" 3
  local mode; mode="$(stat -c %a "$PASS_FILE")"
  case "$mode" in 400|600) ;; *) die "o arquivo da chave de cifragem tem permissão $mode — use 600 ou 400" 3 ;; esac
  [ "$(wc -c < "$PASS_FILE")" -ge 24 ] || die "a chave de cifragem é curta demais (mínimo de 24 caracteres)" 3
}

require_tools() { # push|pull — pg_dump e pg_restore só para o push; docker só para o pull
  local tool
  for tool in curl gpg sha256sum mktemp stat; do
    command -v "$tool" >/dev/null 2>&1 || die "ferramenta ausente no host: $tool" 3
  done
  case "${1:-}" in
    push) for tool in pg_dump pg_restore; do
            command -v "$tool" >/dev/null 2>&1 || die "ferramenta ausente no host: $tool (cliente PostgreSQL)" 3
          done ;;
    pull) command -v docker >/dev/null 2>&1 || die "ferramenta ausente no host: docker" 3 ;;
    *) die "require_tools: comando desconhecido" 3 ;;
  esac
  local major minor
  read -r major minor < <(curl --version | sed -n '1s/^curl \([0-9]*\)\.\([0-9]*\).*/\1 \2/p')
  { [ "${major:-0}" -gt 7 ] || { [ "${major:-0}" -eq 7 ] && [ "${minor:-0}" -ge 75 ]; }; } \
    || die "curl 7.75 ou mais novo é necessário (--aws-sigv4); encontrado: ${major:-?}.${minor:-?}" 3
}

# ---- conexão com o PostgreSQL (push e check) ---------------------------------------------

load_pg_config() {
  # Só vale o arquivo de ambiente: nada de senha ou destino herdado do processo.
  unset PGPASSWORD PGSERVICE PGSERVICEFILE PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGOPTIONS PGSSLMODE PGPASSFILE
  local missing="" name
  for name in BACKUP_PG_HOST BACKUP_PG_PORT BACKUP_PG_USER BACKUP_PG_PASSFILE; do
    [ -n "$(env_get "$name")" ] || missing="$missing $name"
  done
  [ -z "$missing" ] || die "variáveis ausentes no arquivo de ambiente:$missing" 3
  PG_HOST="$(env_get BACKUP_PG_HOST)"
  PG_PORT="$(env_get BACKUP_PG_PORT)"
  PG_USER="$(env_get BACKUP_PG_USER)"
  PG_PASSFILE="$(env_get BACKUP_PG_PASSFILE)"
  PG_SSLMODE="$(env_get BACKUP_PG_SSLMODE prefer)"

  # Valores restritos: nada que vire opção do pg_dump ou string de conexão.
  [[ "$PG_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$ ]] || die "BACKUP_PG_HOST inválido" 3
  { [[ "$PG_PORT" =~ ^[0-9]{1,5}$ ]] && [ "$PG_PORT" -ge 1 ] && [ "$PG_PORT" -le 65535 ]; } || die "BACKUP_PG_PORT inválida (1 a 65535)" 3
  [[ "$PG_USER" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || die "BACKUP_PG_USER inválido (letras, números e sublinhado)" 3
  [[ "$DATABASE_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || die "POSTGRES_DB inválido para o backup (letras, números e sublinhado)" 3
  case "$PG_SSLMODE" in disable|allow|prefer|require|verify-ca|verify-full) ;; *) die "BACKUP_PG_SSLMODE inválido" 3 ;; esac

  [ ! -L "$PG_PASSFILE" ] || die "o arquivo de senhas do PostgreSQL não pode ser um link simbólico: $PG_PASSFILE" 3
  [ -f "$PG_PASSFILE" ] && [ -r "$PG_PASSFILE" ] || die "arquivo de senhas do PostgreSQL (BACKUP_PG_PASSFILE) não encontrado ou ilegível: $PG_PASSFILE" 3
  local mode owner
  mode="$(stat -c %a "$PG_PASSFILE")"; owner="$(stat -c %u "$PG_PASSFILE")"
  case "$mode" in 400|600) ;; *) die "o arquivo de senhas do PostgreSQL tem permissão $mode — use 600 ou 400" 3 ;; esac
  [ "$owner" = "$(id -u)" ] || die "o arquivo de senhas do PostgreSQL não pertence ao usuário que executa o backup" 3
  [ -s "$PG_PASSFILE" ] || die "o arquivo de senhas do PostgreSQL está vazio" 3
}

# O dump em formato custom sai no stdout. A senha vem só do PGPASSFILE (libpq); --no-password
# impede qualquer pergunta e nada de segredo aparece na linha de comando ou no ambiente.
pg_dump_stream() {
  PGPASSFILE="$PG_PASSFILE" PGSSLMODE="$PG_SSLMODE" PGCONNECT_TIMEOUT=20 \
    pg_dump --host "$PG_HOST" --port "$PG_PORT" --username "$PG_USER" --dbname "$DATABASE_NAME" --no-password -Fc
}

# ---- armazenamento S3 ------------------------------------------------------------

# A chave vai por stdin (-K -), nunca na linha de comando, onde o ps a mostraria.
s3_curl() {
  printf 'user = "%s:%s"\n' "$(cfg_escape "$S3_KEY_ID")" "$(cfg_escape "$S3_SECRET")" \
    | curl --silent --show-error --connect-timeout 20 --aws-sigv4 "aws:amz:$S3_REGION:s3" -K - "$@"
}
object_url() { printf '%s/%s/%s' "$S3_ENDPOINT" "$S3_BUCKET" "$1"; }

S3_STATUS=""
s3_put() { # arquivo chave -> 0 se o armazenamento aceitou (HTTP 2xx)
  local file="$1" key="$2" sha rc=0
  sha="$(sha256sum "$file" | cut -d' ' -f1)"
  S3_STATUS="$(s3_curl --max-time 3600 --retry 2 --retry-delay 3 \
    -H "x-amz-content-sha256: $sha" -H 'Content-Type: application/octet-stream' \
    -T "$file" -o /dev/null -w '%{http_code}' "$(object_url "$key")")" || rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  case "$S3_STATUS" in 2??) return 0 ;; *) return 1 ;; esac
}
s3_head_length() { # chave -> imprime o Content-Length
  local key="$1" rc=0
  S3_STATUS="$(s3_curl --max-time 60 -I -o "$TMP/head.txt" -w '%{http_code}' "$(object_url "$key")")" || rc=$?
  [ "$rc" -eq 0 ] || return 1
  case "$S3_STATUS" in 2??) ;; *) return 1 ;; esac
  awk 'tolower($1)=="content-length:" { gsub("\r", "", $2); print $2 }' "$TMP/head.txt" | tail -n 1
}
s3_get() { # chave destino
  local key="$1" dest="$2" rc=0
  S3_STATUS="$(s3_curl --max-time 3600 --retry 2 --retry-delay 3 -o "$dest" -w '%{http_code}' "$(object_url "$key")")" || rc=$?
  [ "$rc" -eq 0 ] || return "$rc"
  case "$S3_STATUS" in 200) return 0 ;; *) return 1 ;; esac
}

# ---- cifragem ---------------------------------------------------------------------

prepare_workspace() {
  umask 077
  mkdir -p "$STATE_DIR/tmp"; chmod 700 "$STATE_DIR/tmp"
  TMP="$(mktemp -d "$STATE_DIR/tmp/external-backup.XXXXXX")"
  # Diretório do gpg curto, para o caminho do socket do agente caber no limite do sistema.
  GPGHOME="$(mktemp -d "${TMPDIR:-/tmp}/luxora-gpg.XXXXXX")"
}
gpg_run() {
  gpg --homedir "$GPGHOME" --batch --yes --quiet --no-tty --pinentry-mode loopback \
    --passphrase-file "$PASS_FILE" "$@"
}
encrypt_stream() { # saída
  gpg_run --symmetric --cipher-algo AES256 --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 \
    --compress-algo none --output "$1"
}
valid_object_key() { [[ "$1" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] && [[ "$1" != *..* ]]; }

# ---- comandos ---------------------------------------------------------------------

cmd_check() {
  load_config; load_pg_config; require_tools push
  log "configuração do backup externo conferida (sem acesso à rede nem ao banco)"
  log "  destino: ${S3_ENDPOINT#*://}/$S3_BUCKET/$S3_PREFIX/$APP_ENVIRONMENT/$DATABASE_NAME/  região: $S3_REGION"
  log "  chave de cifragem: arquivo com permissão adequada; verificação após o envio: $VERIFY_AFTER_UPLOAD"
  local client=""; client="$(pg_dump --version 2>/dev/null | head -n 1)" || true
  log "  origem do dump: $PG_USER@$PG_HOST:$PG_PORT/$DATABASE_NAME (sslmode=$PG_SSLMODE); senha: arquivo pgpass com permissão adequada e dono correto"
  log "  cliente: ${client:-pg_dump (versão não identificada)}; check e push não usam Docker"
}

cmd_push() {
  load_config; load_pg_config; require_tools push; prepare_workspace
  local stamp key enc size sha
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  key="$S3_PREFIX/$APP_ENVIRONMENT/$DATABASE_NAME/$stamp-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n').dump.gpg"
  enc="$TMP/backup.dump.gpg"

  log "1/4 dump (pg_dump no host, $PG_USER@$PG_HOST:$PG_PORT) e cifragem (o dump não é gravado em claro)"
  if ! pg_dump_stream | encrypt_stream "$enc" || [ ! -s "$enc" ]; then
    record_history external-backup "$key" failed-dump "pg_dump ou cifragem falhou"
    die "o dump ou a cifragem falhou — nada foi enviado" 3
  fi

  log "2/4 conferência da cópia cifrada (decifra em fluxo e lê o dump)"
  if ! gpg_run --decrypt "$enc" | pg_restore --list >/dev/null; then
    record_history external-backup "$key" failed-verify-local "a cópia cifrada não decifra ou o dump é inválido"
    die "a cópia cifrada não decifra ou o dump é inválido — nada foi enviado" 3
  fi
  size="$(wc -c < "$enc" | tr -d ' ')"; sha="$(sha256sum "$enc" | cut -d' ' -f1)"

  log "3/4 envio ($size bytes cifrados)"
  if ! s3_put "$enc" "$key"; then
    record_history external-backup "$key" failed-upload "envio recusado ou interrompido (HTTP ${S3_STATUS:-sem resposta})"
    die "o envio falhou (HTTP ${S3_STATUS:-sem resposta}) — o backup externo NÃO existe" 3
  fi

  if [ "$VERIFY_AFTER_UPLOAD" = "1" ]; then
    log "4/4 conferência do objeto no armazenamento"
    local remote=""
    remote="$(s3_head_length "$key")" || true
    if [ "$remote" != "$size" ]; then
      record_history external-backup "$key" failed-verify-remote "tamanho remoto='${remote:-?}' esperado=$size (HTTP ${S3_STATUS:-?})"
      die "o objeto foi enviado, mas não foi possível confirmar o tamanho (remoto='${remote:-?}', esperado=$size). O objeto $key NÃO foi apagado; confira manualmente. Se a credencial é só de escrita, use BACKUP_VERIFY_AFTER_UPLOAD=0." 3
    fi
  else
    log "4/4 conferência remota desligada (BACKUP_VERIFY_AFTER_UPLOAD=0): o envio foi aceito pelo armazenamento, o tamanho não foi conferido"
  fi

  state_set last-external-backup "$key"
  record_history external-backup "$key" success "bytes=$size sha256=$sha"
  log "backup externo concluído: $key ($size bytes, sha256 $sha)"
}

cmd_pull() {
  [ -n "$OBJECT" ] || die "informe o objeto com --object" 3
  valid_object_key "$OBJECT" || die "nome de objeto inválido" 3
  if [ "$DRILL" -eq 1 ] && [ -n "$OUTPUT" ]; then die "use --output ou --drill, não os dois" 3; fi
  if [ "$DRILL" -eq 0 ] && [ -z "$OUTPUT" ]; then die "informe --output <arquivo> ou --drill" 3; fi
  if [ -n "$OUTPUT" ]; then
    [ ! -e "$OUTPUT" ] || die "$OUTPUT já existe — não sobrescrevo" 3
    [ -d "$(dirname "$OUTPUT")" ] || die "o diretório de $OUTPUT não existe" 3
  fi
  load_config; require_tools pull; prepare_workspace

  local obj="$TMP/objeto.gpg" plain
  plain="$TMP/$(basename "$OBJECT" .gpg)"

  log "1/4 download de $OBJECT"
  if ! s3_get "$OBJECT" "$obj" || [ ! -s "$obj" ]; then
    record_history external-restore "$OBJECT" failed-download "HTTP ${S3_STATUS:-sem resposta}"
    die "o download falhou (HTTP ${S3_STATUS:-sem resposta})" 3
  fi
  if [ -n "$EXPECTED_SHA" ]; then
    [ "$(sha256sum "$obj" | cut -d' ' -f1)" = "$EXPECTED_SHA" ] \
      || { record_history external-restore "$OBJECT" failed-sha256 "sha256 diferente do informado"; die "o sha256 do objeto baixado não é o informado — objeto adulterado ou outro arquivo" 3; }
  fi

  log "2/4 decifragem para arquivo temporário protegido"
  if ! gpg_run --decrypt --output "$plain" "$obj" || [ ! -s "$plain" ]; then
    record_history external-restore "$OBJECT" failed-decrypt "decifragem falhou (chave errada ou objeto adulterado)"
    die "a decifragem falhou (chave errada ou objeto adulterado)" 3
  fi

  log "3/4 conferência do dump"
  if ! compose exec -T postgres pg_restore --list < "$plain" >/dev/null; then
    record_history external-restore "$OBJECT" failed-dump "dump inválido depois de decifrar"
    die "o dump decifrado é inválido" 3
  fi

  if [ "$DRILL" -eq 1 ]; then
    log "4/4 ensaio de restauração (restore-drill.sh); o arquivo em claro é apagado ao terminar"
    local rc=0
    bash "$DRILL_SCRIPT" --env-file "$ENV_FILE" --backup "$plain" || rc=$?
    record_history external-restore "$OBJECT" "$([ "$rc" -eq 0 ] && echo success || echo failed-drill)" "restore-drill.sh saiu com $rc"
    return "$rc"
  fi
  mv "$plain" "$OUTPUT"; chmod 600 "$OUTPUT"
  record_history external-restore "$OBJECT" success "entregue em arquivo local"
  log "4/4 dump decifrado entregue em $OUTPUT (permissão 600). Ele está EM CLARO: apague-o depois de usar."
}

"cmd_$COMMAND"
