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
# mode: "normal", ou "degraded" quando a versão no ar não tem uma capacidade
# que o banco exige (K2-a; ver "Capacidades" abaixo).
record_history() {
  local action="$1" version="$2" result="$3" notes="${4:-}" mode="${5:-normal}"
  local actor="${DEPLOY_ACTOR:-$(id -un 2>/dev/null || echo desconhecido)}"
  notes="${notes//\\/\\\\}"; notes="${notes//\"/\\\"}"
  printf '{"timestamp":"%s","environment":"%s","action":"%s","version":"%s","previous":"%s","result":"%s","mode":"%s","actor":"%s","notes":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$APP_ENVIRONMENT" "$action" "$version" "$(state_get current-version)" "$result" "$mode" "$actor" "$notes" \
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

# ---- Capacidades (K2-a — ADR-0069, seção 3.7; docs/07-Infra/MIGRATION_RUNBOOK.md)
# A imagem declara o que sabe fazer no rótulo luxora.capabilities. O banco
# declara o que exige na tabela deployment_requirement, preenchida pelas
# migrations. O estado requirement-active guarda o que este ambiente já
# exigiu: se o banco deixar de declarar (backup anterior restaurado sem
# migrations), os scripts recusam subir qualquer versão antes de reaplicá-las.
# Leitura do banco que falha recusa a operação; nunca vale como "sem exigência".

# Restrições (validadas) que acompanham billing-eligibility-v1.
K2A_CONSTRAINTS="billing_eligibility_protocol_fkey billing_legacy_or_protocol_check billing_session_billing_patient_fkey billing_session_session_patient_fkey billing_session_legacy_or_patient_check"

db_query() { # sql [banco]
  compose exec -T postgres psql -U postgres -d "${2:-$DATABASE_NAME}" -v ON_ERROR_STOP=1 -tAq -c "$1"
}

image_capabilities() {
  local labels
  labels="$(docker image inspect -f '{{ index .Config.Labels "luxora.capabilities" }}' "$1" 2>/dev/null)" || return 1
  [ "$labels" != "<no value>" ] || labels=""
  echo "${labels//,/ }"
}

# Capacidades exigidas pelo banco, separadas por espaço (vazio: nenhuma).
db_required_capabilities() { # [banco]
  local exists
  exists="$(db_query "select to_regclass('public.deployment_requirement') is not null" "${1:-}")" || return 1
  [ "$exists" = "t" ] || return 0
  db_query "select coalesce(string_agg(capability, ' ' order by capability), '') from deployment_requirement" "${1:-}"
}

# Das capacidades pedidas, as que não estão na lista dada (sem repetição).
missing_from() { # "lista" pedidas...
  local have=" $1 " need missing=" "
  shift
  for need in "$@"; do
    case "$have$missing" in *" $need "*) ;; *) missing="$missing$need " ;; esac
  done
  missing="${missing# }"; echo "${missing% }"
}

# Das capacidades pedidas, as que estão na lista dada.
present_in() { # "lista" pedidas...
  local have=" $1 " need found=""
  shift
  for need in "$@"; do
    case "$have" in *" $need "*) found="$found $need" ;; esac
  done
  echo "${found# }"
}

# Proteções do K2-a que faltam no banco: restrições ausentes ou não
# validadas, e privilégios do papel da aplicação que as contornariam.
db_missing_protections() { # [banco]
  local constraints
  # shellcheck disable=SC2086  # lista separada por espaço
  constraints="$(printf "'%s'," $K2A_CONSTRAINTS)"
  db_query "
    with expected(name) as (select unnest(array[${constraints%,}])),
    privileges(name, granted) as (values
      ('privilegio:billing.legacy_billing', has_column_privilege('luxora_app', 'public.billing', 'legacy_billing', 'INSERT,UPDATE')),
      ('privilegio:billing.eligibility_protocol', has_column_privilege('luxora_app', 'public.billing', 'eligibility_protocol', 'UPDATE')),
      ('privilegio:billing_session.legacy_link', has_column_privilege('luxora_app', 'public.billing_session', 'legacy_link', 'INSERT,UPDATE')),
      ('privilegio:billing_session.patient_id', has_column_privilege('luxora_app', 'public.billing_session', 'patient_id', 'UPDATE')),
      ('privilegio:billing_eligibility_protocol', has_table_privilege('luxora_app', 'public.billing_eligibility_protocol', 'INSERT,DELETE,TRUNCATE')
                                                   or has_column_privilege('luxora_app', 'public.billing_eligibility_protocol', 'name', 'UPDATE')),
      ('privilegio:deployment_requirement', has_table_privilege('luxora_app', 'public.deployment_requirement', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')))
    select coalesce(string_agg(name, ' ' order by name), '') from (
      select e.name from expected e
       where not exists (select 1 from pg_constraint c
                          where c.connamespace = 'public'::regnamespace and c.conname = e.name and c.convalidated)
      union all
      select name from privileges where granted) missing" "${1:-}"
}

# Confere o banco em uso contra a exigência já registrada neste ambiente e
# contra as proteções. Preenche REQUIRED_CAPABILITIES; se algo falta,
# devolve 1 com o motivo em CAPABILITY_PROBLEM.
check_database_protections() {
  local required lost missing
  CAPABILITY_PROBLEM=""; REQUIRED_CAPABILITIES=""
  required="$(db_required_capabilities)" || { CAPABILITY_PROBLEM="não foi possível ler as exigências do banco"; return 1; }
  # shellcheck disable=SC2046  # lista separada por espaço
  lost="$(missing_from "$required" $(state_get requirement-active))"
  if [ -n "$lost" ]; then
    CAPABILITY_PROBLEM="este ambiente já exigia '$lost' e o banco não declara mais (backup anterior restaurado sem migrations?); rode deploy.sh com uma versão que tenha a capacidade, que reaplica as migrations antes de subir a aplicação"
    return 1
  fi
  case " $required " in
    *" billing-eligibility-v1 "*)
      missing="$(db_missing_protections)" || { CAPABILITY_PROBLEM="não foi possível conferir as proteções do banco"; return 1; }
      [ -z "$missing" ] || { CAPABILITY_PROBLEM="o banco exige billing-eligibility-v1 mas faltam proteções: $missing"; return 1; }
      ;;
  esac
  REQUIRED_CAPABILITIES="$required"
}
