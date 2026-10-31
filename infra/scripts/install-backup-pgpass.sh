#!/usr/bin/env bash
# Luxora — cria o arquivo de senhas do PostgreSQL (pgpass) do usuário de backup, sem exibir a senha.
#
#   sudo bash infra/scripts/install-backup-pgpass.sh --app-env /etc/luxora/staging.env \
#        [--dest /etc/luxora-backup/backup.pgpass] [--owner luxora-backup] [--force]
#
# Lê POSTGRES_BACKUP_PASSWORD, POSTGRES_BACKUP_PORT (padrão 15432) e POSTGRES_DB do arquivo de ambiente
# da aplicação e grava UMA linha no formato do libpq (host:porta:banco:usuário:senha) para a role
# luxora_backup em 127.0.0.1, com dono = o usuário de backup e modo 0400, que é o que o
# external-backup.sh exige (BACKUP_PG_PASSFILE). A senha nunca vai para a tela, para um argumento de
# processo nem para o log; não sobrescreve um arquivo existente sem --force (troca de senha: rodar a
# role de novo e este script com --force). Este é o único passo em que root toca no arquivo de ambiente
# da aplicação; o usuário luxora-backup nunca o lê.
#
# Teste: LUXORA_INSTALL_TEST=1 deixa rodar sem root e sem chown (usado por
# infra/tests/install-backup-scripts-test.sh). Nunca use no servidor.

set -euo pipefail
die() { echo "ERRO: $*" >&2; exit "${2:-1}"; }

APP_ENV_FILE=""; DEST=/etc/luxora-backup/backup.pgpass; OWNER=luxora-backup; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --app-env) [ $# -ge 2 ] || die "--app-env sem valor" 64; APP_ENV_FILE="$2"; shift 2 ;;
    --dest) [ $# -ge 2 ] || die "--dest sem valor" 64; DEST="$2"; shift 2 ;;
    --owner) [ $# -ge 2 ] || die "--owner sem valor" 64; OWNER="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) die "argumento desconhecido: $1 (ver o cabeçalho do script)" 64 ;;
  esac
done
[ -n "$APP_ENV_FILE" ] || die "informe o arquivo de ambiente da aplicação com --app-env" 64

TEST_MODE="${LUXORA_INSTALL_TEST:-0}"
if [ "$TEST_MODE" != 1 ]; then
  [ "$(id -u)" -eq 0 ] || die "precisa rodar como root (sudo): lê o ambiente da aplicação e entrega o arquivo ao usuário de backup" 77
  id -u "$OWNER" >/dev/null 2>&1 || die "o usuário $OWNER não existe — crie-o antes (docs/07-Infra/BACKUP_ISOLADO.md)"
fi
[[ "$OWNER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "--owner inválido"
[[ "$DEST" =~ ^/[A-Za-z0-9._/-]+$ ]] && [[ "$DEST" != *..* ]] || die "--dest precisa ser um caminho absoluto simples"
[ -f "$APP_ENV_FILE" ] && [ -r "$APP_ENV_FILE" ] || die "arquivo de ambiente não encontrado ou ilegível: $APP_ENV_FILE"
[ ! -L "$DEST" ] || die "$DEST é um link simbólico"
[ -d "$(dirname "$DEST")" ] || die "a pasta de $DEST não existe (crie /etc/luxora-backup antes)"
if [ -e "$DEST" ] && [ "$FORCE" -ne 1 ]; then die "$DEST já existe — use --force para trocar (a senha antiga deixa de valer quando a role for atualizada)"; fi

get() { # nome -> último valor, sem aspas
  local line value
  line="$(grep -E "^$1=" "$APP_ENV_FILE" | tail -n 1 || true)"
  value="${line#*=}"; value="${value%\"}"; value="${value#\"}"
  printf '%s' "$value"
}
PW="$(get POSTGRES_BACKUP_PASSWORD)"; PORT="$(get POSTGRES_BACKUP_PORT)"; PORT="${PORT:-15432}"; DB="$(get POSTGRES_DB)"; DB="${DB:-luxora_staging}"
[ -n "$PW" ] || die "POSTGRES_BACKUP_PASSWORD ausente em $APP_ENV_FILE (acrescente-a e ative a role antes)"
[ "$PW" != "troque-este-valor" ] || die "POSTGRES_BACKUP_PASSWORD ainda é o valor de modelo"
# Só letras e números: ':' e '\' quebrariam o formato do pgpass; o 02-backup-role.sh também exige 16+.
[[ "$PW" =~ ^[A-Za-z0-9]{16,}$ ]] || die "POSTGRES_BACKUP_PASSWORD precisa ter 16 ou mais letras/números (a gerada por generate-env.sh serve)"
{ [[ "$PORT" =~ ^[0-9]{1,5}$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ]; } || die "POSTGRES_BACKUP_PORT inválida"
[[ "$DB" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || die "POSTGRES_DB inválido"

umask 077
TMPF="$(mktemp "$(dirname "$DEST")/.pgpass.XXXXXX")"
trap 'rm -f "$TMPF"' EXIT
printf '127.0.0.1:%s:%s:luxora_backup:%s\n' "$PORT" "$DB" "$PW" > "$TMPF"
chmod 0400 "$TMPF"
[ "$TEST_MODE" = 1 ] || chown "$OWNER:$(id -gn "$OWNER")" "$TMPF"
mv -f "$TMPF" "$DEST"; trap - EXIT
echo "arquivo de senhas gravado: $DEST (modo $(stat -c %a "$DEST"), dono $(stat -c %U "$DEST")) para luxora_backup@127.0.0.1:$PORT/$DB. Nenhum valor foi exibido."
