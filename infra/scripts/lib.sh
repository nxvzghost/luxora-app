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
# Restrições (validadas) que acompanham appointment-outcome-v1 (K2-b): o
# congelamento da consulta com desfecho, a elegibilidade do vínculo e da
# sessão, e a coerência do desfecho, da comunicação e das decisões.
K2B_CONSTRAINTS="appointment_outcome_freeze_fkey appointment_outcome_closing_notice_fkey appointment_notice_appointment_fkey appointment_decision_outcome_fkey appointment_rescheduled_from_fkey billing_session_session_eligibility_fkey session_billing_eligibility_check session_void_check billing_session_required_eligibility_check billing_session_legacy_or_eligibility_check appointment_outcome_state_check appointment_outcome_no_show_decision_check appointment_outcome_no_show_decided_check appointment_outcome_late_notice_decision_check appointment_outcome_late_notice_decided_check appointment_outcome_closing_notice_check appointment_outcome_closing_timing_check appointment_notice_actor_check appointment_notice_reference_check appointment_notice_timing_check appointment_notice_limit_check appointment_notice_review_check appointment_decision_reason_check"
# Restrições (validadas) que acompanham appointment-ai-confirmation-v1 (K11):
# o desfecho de autoria da IA só existe para cancelamento ou remarcação
# ligados ao pedido e à resposta `confirma` dele, da mesma consulta e da mesma
# conversa, recebida antes do início.
K11_CONSTRAINTS="appointment_notice_request_check appointment_notice_reply_check appointment_notice_conversation_fkey appointment_notice_confirms_fkey appointment_outcome_actor_check appointment_outcome_request_fkey appointment_outcome_confirmation_fkey"

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

# Proteções da K2-b que faltam no banco: restrições ausentes ou não
# validadas, a política restritiva de congelamento, a RLS das tabelas novas e
# os privilégios do papel da aplicação que as contornariam (apagar desfecho,
# reescrever o retrato, a comunicação ou as decisões, marcar vínculo como legado).
db_missing_k2b_protections() { # [banco]
  local constraints
  # shellcheck disable=SC2086  # lista separada por espaço
  constraints="$(printf "'%s'," $K2B_CONSTRAINTS)"
  db_query "
    with expected(name) as (select unnest(array[${constraints%,}])),
    privileges(name, granted) as (values
      ('privilegio:appointment_outcome.apagar', has_table_privilege('luxora_app', 'public.appointment_outcome', 'DELETE,TRUNCATE')),
      ('privilegio:appointment_outcome.retrato', has_column_privilege('luxora_app', 'public.appointment_outcome', 'state_at_outcome', 'UPDATE')
                                                  or has_column_privilege('luxora_app', 'public.appointment_outcome', 'scheduled_at_at_outcome', 'UPDATE')
                                                  or has_column_privilege('luxora_app', 'public.appointment_outcome', 'modality_at_outcome', 'UPDATE')
                                                  or has_column_privilege('luxora_app', 'public.appointment_outcome', 'appointment_id', 'UPDATE')
                                                  or has_column_privilege('luxora_app', 'public.appointment_outcome', 'tenant_id', 'UPDATE')
                                                  or has_column_privilege('luxora_app', 'public.appointment_outcome', 'outcome_recorded_by_user_id', 'UPDATE')),
      ('privilegio:appointment_notice.apagar', has_table_privilege('luxora_app', 'public.appointment_notice', 'DELETE,TRUNCATE')),
      ('privilegio:appointment_notice.horarios', has_column_privilege('luxora_app', 'public.appointment_notice', 'reference_time', 'UPDATE')
                                                  or has_column_privilege('luxora_app', 'public.appointment_notice', 'recorded_at', 'UPDATE')
                                                  or has_column_privilege('luxora_app', 'public.appointment_notice', 'received_at', 'UPDATE')
                                                  or has_column_privilege('luxora_app', 'public.appointment_notice', 'timing', 'UPDATE')
                                                  or has_column_privilege('luxora_app', 'public.appointment_notice', 'requested_by', 'UPDATE')),
      ('privilegio:appointment_decision', has_table_privilege('luxora_app', 'public.appointment_decision', 'DELETE,TRUNCATE')
                                          or has_column_privilege('luxora_app', 'public.appointment_decision', 'reason', 'UPDATE')
                                          or has_column_privilege('luxora_app', 'public.appointment_decision', 'decision', 'UPDATE')),
      ('privilegio:billing_session.legacy_eligibility_link', has_column_privilege('luxora_app', 'public.billing_session', 'legacy_eligibility_link', 'INSERT,UPDATE')),
      ('politica:appointment_frozen_after_outcome', not exists (select 1 from pg_policy p
                                                                 where p.polrelid = 'public.appointment'::regclass and p.polname = 'appointment_frozen_after_outcome'
                                                                   and not p.polpermissive and p.polcmd = 'w')),
      ('rls:tabelas-do-desfecho', (select count(*) from pg_class c
                                    where c.relnamespace = 'public'::regnamespace
                                      and c.relname in ('appointment_outcome', 'appointment_notice', 'appointment_decision')
                                      and c.relrowsecurity and c.relforcerowsecurity) <> 3))
    select coalesce(string_agg(name, ' ' order by name), '') from (
      select e.name from expected e
       where not exists (select 1 from pg_constraint c
                          where c.connamespace = 'public'::regnamespace and c.conname = e.name and c.convalidated)
      union all
      select name from privileges where granted) missing" "${1:-}"
}

# Proteções do K11 (appointment-ai-confirmation-v1): as restrições validadas
# e os privilégios que deixariam a aplicação reescrever a autoria do desfecho
# ou a confirmação (o pedido e a resposta são só inseridos).
db_missing_k11_protections() { # [banco]
  local constraints
  # shellcheck disable=SC2086  # lista separada por espaço
  constraints="$(printf "'%s'," $K11_CONSTRAINTS)"
  db_query "
    with expected(name) as (select unnest(array[${constraints%,}])),
    privileges(name, granted) as (values
      ('privilegio:appointment_outcome.autoria', has_column_privilege('luxora_app', 'public.appointment_outcome', 'outcome_recorded_by_actor_type', 'UPDATE')
                                                 or has_column_privilege('luxora_app', 'public.appointment_outcome', 'confirmation_notice_id', 'UPDATE')
                                                 or has_column_privilege('luxora_app', 'public.appointment_outcome', 'confirmation_answer', 'UPDATE')
                                                 or has_column_privilege('luxora_app', 'public.appointment_outcome', 'closing_requested_action', 'UPDATE')),
      ('privilegio:appointment_notice.confirmacao', has_column_privilege('luxora_app', 'public.appointment_notice', 'confirms_notice_id', 'UPDATE')
                                                    or has_column_privilege('luxora_app', 'public.appointment_notice', 'confirmation_answer', 'UPDATE')
                                                    or has_column_privilege('luxora_app', 'public.appointment_notice', 'awaits_confirmation', 'UPDATE')
                                                    or has_column_privilege('luxora_app', 'public.appointment_notice', 'requested_action', 'UPDATE')
                                                    or has_column_privilege('luxora_app', 'public.appointment_notice', 'asked_scheduled_at', 'UPDATE')))
    select coalesce(string_agg(name, ' ' order by name), '') from (
      select e.name from expected e
       where not exists (select 1 from pg_constraint c
                          where c.connamespace = 'public'::regnamespace and c.conname = e.name and c.convalidated)
      union all
      select name from privileges where granted) missing" "${1:-}"
}

# Proteções que faltam para as capacidades exigidas (lista separada por espaço).
db_missing_required_protections() { # "capacidades" [banco]
  local missing="" found
  case " $1 " in
    *" billing-eligibility-v1 "*) found="$(db_missing_protections "${2:-}")" || return 1; missing="$found" ;;
  esac
  case " $1 " in
    *" appointment-outcome-v1 "*) found="$(db_missing_k2b_protections "${2:-}")" || return 1; missing="${missing:+$missing }$found" ;;
  esac
  case " $1 " in
    *" appointment-ai-confirmation-v1 "*) found="$(db_missing_k11_protections "${2:-}")" || return 1; missing="${missing:+$missing }$found" ;;
  esac
  echo "${missing% }"
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
  missing="$(db_missing_required_protections "$required")" || { CAPABILITY_PROBLEM="não foi possível conferir as proteções do banco"; return 1; }
  [ -z "$missing" ] || { CAPABILITY_PROBLEM="o banco exige '$required' mas faltam proteções: $missing"; return 1; }
  REQUIRED_CAPABILITIES="$required"
}
