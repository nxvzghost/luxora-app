#!/usr/bin/env bash
# Luxora — deploy de uma versão, com rollback automático.
# (Tarefa 04 da auditoria. Passo a passo e decisões: docs/07-Infra/DEPLOY_RUNBOOK.md.)
#
#   infra/scripts/deploy.sh --env-file /caminho/staging.env --version <tag> [--frontend-version <tag>]
#
# Ordem, a mesma do MIGRATION_RUNBOOK ("CI/CD Integration"). Cada etapa é um
# portão: se falha, as seguintes não rodam.
#   1. backup do banco            falhou → nada foi alterado
#   2. migrations (credencial admin)  falhou → a aplicação continua na versão anterior
#   3. troca da aplicação
#   4. readiness da versão nova   falhou → ROLLBACK AUTOMÁTICO para a anterior
#   5. smoke test                 falhou → ROLLBACK AUTOMÁTICO para a anterior
#   6. registro do deploy
#
# O rollback troca só a aplicação. O banco não volta: por isso toda migration
# precisa ser compatível com a versão anterior (expand/contract).
#
# Saída: 0 = versão nova no ar · 1 = falhou e a anterior foi restaurada ·
#        2 = falhou e NÃO foi possível restaurar · 3 = falhou antes de tocar a aplicação.

# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

VERSION=""; FRONTEND_VERSION=""; ENV_FILE=""; NOTES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --frontend-version) FRONTEND_VERSION="$2"; shift 2 ;;
    --notes) NOTES="$2"; shift 2 ;;
    *) die "argumento desconhecido: $1" ;;
  esac
done
[ -n "$VERSION" ] || die "informe a versão com --version <tag>"
init_environment

PREVIOUS="$(state_get current-version)"
log "deploy em $APP_ENVIRONMENT: versão $VERSION (atual: ${PREVIOUS:-nenhuma}) — projeto $PROJECT"

require_image "$BACKEND_IMAGE_REPO:$VERSION"
require_image "$BACKEND_MIGRATE_IMAGE_REPO:$VERSION"
[ -z "$FRONTEND_VERSION" ] || require_image "$FRONTEND_IMAGE_REPO:$FRONTEND_VERSION"

log "infraestrutura de dados"
compose up -d --wait postgres redis >/dev/null
# O coletor do próprio compose só sobe quando o ambiente aponta para ele.
case "$(env_get OTEL_EXPORTER_OTLP_ENDPOINT)" in
  *otel-collector*) compose --profile observability up -d otel-collector >/dev/null ;;
esac

# 1. backup
BACKUP_FILE="$STATE_DIR/backups/$(date -u +%Y%m%dT%H%M%SZ)-antes-de-$VERSION.dump"
log "1/6 backup do banco"
if ! compose exec -T postgres pg_dump -U postgres -Fc "$DATABASE_NAME" > "$BACKUP_FILE" || [ ! -s "$BACKUP_FILE" ] \
   || ! compose exec -T postgres pg_restore --list < "$BACKUP_FILE" >/dev/null; then
  rm -f "$BACKUP_FILE"
  record_history deploy "$VERSION" failed-backup "$NOTES"
  die "backup falhou — nada foi alterado" 3
fi
chmod 600 "$BACKUP_FILE"
state_set last-backup "$BACKUP_FILE"

# 2. migrations
log "2/6 migrations (credencial admin)"
if ! BACKEND_MIGRATE_IMAGE="$BACKEND_MIGRATE_IMAGE_REPO:$VERSION" compose --profile tools run --rm migrate; then
  record_history deploy "$VERSION" failed-migration "$NOTES"
  die "migration falhou — a aplicação continua na versão ${PREVIOUS:-anterior}; ver 'Estratégia de rollback' no MIGRATION_RUNBOOK" 3
fi

# 3–5. troca, readiness e smoke
log "3/6 troca da aplicação para $VERSION"
switch_backend "$VERSION"
log "4/6 aguardando readiness (até ${READY_TIMEOUT_SECONDS}s)"
FAILURE=""
if ! wait_ready "$VERSION"; then
  FAILURE="a versão $VERSION não ficou pronta"
else
  log "5/6 smoke test"
  smoke_test || FAILURE="o smoke test da versão $VERSION falhou"
fi

if [ -n "$FAILURE" ]; then
  log "FALHA: $FAILURE"
  compose logs --no-color --tail 15 backend 2>/dev/null | sed 's/^/    | /' || true
  if [ -z "$PREVIOUS" ]; then
    compose stop backend >/dev/null 2>&1 || true
    record_history deploy "$VERSION" failed-no-previous "$FAILURE"
    die "$FAILURE; não há versão anterior para restaurar (primeiro deploy) — aplicação parada" 2
  fi
  log "ROLLBACK AUTOMÁTICO para $PREVIOUS"
  switch_backend "$PREVIOUS"
  if wait_ready "$PREVIOUS"; then
    record_history deploy "$VERSION" rolled-back "$FAILURE"
    die "$FAILURE; a versão $PREVIOUS foi restaurada e está pronta" 1
  fi
  record_history deploy "$VERSION" rollback-failed "$FAILURE"
  die "$FAILURE; e a versão $PREVIOUS também não ficou pronta — INTERVENÇÃO MANUAL" 2
fi

# 6. registro
record_history deploy "$VERSION" success "$NOTES"
[ -z "$PREVIOUS" ] || [ "$PREVIOUS" = "$VERSION" ] || state_set previous-version "$PREVIOUS"
state_set current-version "$VERSION"

if [ -n "$FRONTEND_VERSION" ]; then
  log "painel: versão $FRONTEND_VERSION"
  FRONTEND_IMAGE="$FRONTEND_IMAGE_REPO:$FRONTEND_VERSION" BACKEND_IMAGE="$BACKEND_IMAGE_REPO:$VERSION" \
    compose --profile frontend up -d --no-deps frontend >/dev/null
  state_set current-frontend-version "$FRONTEND_VERSION"
fi

log "6/6 deploy concluído: $VERSION no ar em $APP_ENVIRONMENT (anterior: ${PREVIOUS:-nenhuma})"
