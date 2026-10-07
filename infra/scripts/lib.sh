#!/usr/bin/env bash
# Luxora — funções comuns de deploy.sh, rollback.sh e restore-drill.sh.
# (Tarefa 04 da auditoria. Não é executado direto: os scripts o incluem.)
#
# Dependências no host: bash, docker (com o plugin compose) e curl.

set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${LUXORA_COMPOSE_FILE:-$SCRIPTS_DIR/../staging/docker-compose.yml}"

# Repositórios das imagens. Num registro: ghcr.io/<dono>/luxora-backend etc.
BACKEND_IMAGE_REPO="${BACKEND_IMAGE_REPO:-luxora-backend}"
BACKEND_MIGRATE_IMAGE_REPO="${BACKEND_MIGRATE_IMAGE_REPO:-${BACKEND_IMAGE_REPO}-migrate}"
FRONTEND_IMAGE_REPO="${FRONTEND_IMAGE_REPO:-luxora-frontend}"

READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-120}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
die() { echo "ERRO: $*" >&2; exit "${2:-1}"; }

# Lê uma variável do arquivo de ambiente (KEY=valor, com ou sem aspas).
env_get() {
  local name="$1" default="${2:-}" line value
  line="$(grep -E "^${name}=" "$ENV_FILE" | tail -n 1 || true)"
  if [ -z "$line" ]; then echo "$default"; return; fi
  value="${line#*=}"
  value="${value%\"}"; value="${value#\"}"
  echo "${value:-$default}"
}

# Prepara ENV_FILE, PROJECT, STATE_DIR e os endereços. Chamar depois de ler os argumentos.
init_environment() {
  [ -n "${ENV_FILE:-}" ] || die "informe o arquivo de ambiente com --env-file"
  [ -f "$ENV_FILE" ] || die "arquivo de ambiente não encontrado: $ENV_FILE"
  ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"

  if grep -qE '=troque-este-valor' "$ENV_FILE"; then
    die "o arquivo de ambiente ainda tem valores de modelo (troque-este-valor) — gere um com infra/scripts/generate-env.sh"
  fi

  APP_ENVIRONMENT="$(env_get APP_ENV staging)"
  PROJECT="${LUXORA_PROJECT:-luxora-$APP_ENVIRONMENT}"
  STATE_DIR="${LUXORA_STATE_DIR:-$(dirname "$ENV_FILE")/luxora-deploy-state}"
  BACKEND_URL="http://127.0.0.1:$(env_get BACKEND_PORT 13000)"
  # shellcheck disable=SC2034  # usada pelos scripts que incluem este arquivo
  DATABASE_NAME="$(env_get POSTGRES_DB luxora_staging)"
  mkdir -p "$STATE_DIR/backups"
  chmod 700 "$STATE_DIR" "$STATE_DIR/backups"
}

compose() {
  docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

state_get() { cat "$STATE_DIR/$1" 2>/dev/null || true; }
state_set() { printf '%s\n' "$2" > "$STATE_DIR/$1"; }

# Registro de auditoria do deploy (docs/02-Arquitetura/13-Deploy.md, "Auditoria"):
# versão, data, responsável, ambiente, resultado, observações. Uma linha JSON por evento.
record_history() {
  local action="$1" version="$2" result="$3" notes="${4:-}"
  local actor="${DEPLOY_ACTOR:-$(id -un 2>/dev/null || echo desconhecido)}"
  notes="${notes//\\/\\\\}"; notes="${notes//\"/\\\"}"
  printf '{"timestamp":"%s","environment":"%s","action":"%s","version":"%s","previous":"%s","result":"%s","actor":"%s","notes":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$APP_ENVIRONMENT" "$action" "$version" "$(state_get current-version)" "$result" "$actor" "$notes" \
    >> "$STATE_DIR/history.jsonl"
}

http_status() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@" 2>/dev/null || echo 000
}

running_version() {
  curl -s --max-time 5 "$BACKEND_URL/api/v1/health" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'
}

# Espera a versão indicada responder "ready". Devolve 1 se o prazo estourar.
wait_ready() {
  local version="$1" deadline=$(( $(date +%s) + READY_TIMEOUT_SECONDS ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ "$(http_status "$BACKEND_URL/api/v1/health/ready")" = "200" ] && [ "$(running_version)" = "$version" ]; then
      return 0
    fi
    # Container que morreu (ou está em laço de reinício) não vai ficar pronto:
    # não vale esperar o prazo todo.
    if [ "$(compose ps -a --status exited --status dead --status restarting -q backend 2>/dev/null | wc -l)" -gt 0 ]; then
      return 1
    fi
    sleep 2
  done
  return 1
}

# Smoke pós-deploy: uma requisição que passa pela validação, consulta o
# banco com a role de runtime e volta 401 — "o container subiu" não basta
# (docs/07-Infra/MIGRATION_RUNBOOK.md). Não cria nem altera nada.
smoke_test() {
  local status
  status="$(http_status -X POST -H 'Content-Type: application/json' \
    -d '{"email":"smoke-deploy@luxora.invalid","password":"senha-inexistente-0000"}' "$BACKEND_URL/api/v1/auth/login")"
  [ "$status" = "401" ] || { log "smoke: login com credencial inexistente devolveu $status (esperado 401)"; return 1; }
}

switch_backend() {
  local version="$1"
  BACKEND_IMAGE="$BACKEND_IMAGE_REPO:$version" compose up -d --no-deps backend >/dev/null
}

require_image() {
  docker image inspect "$1" >/dev/null 2>&1 || docker pull "$1" >/dev/null 2>&1 || die "imagem não encontrada: $1"
}
