#!/usr/bin/env bash
# Luxora — deploy de uma versão, com rollback automático.
# (Tarefa 04 da auditoria. Passo a passo e decisões: docs/07-Infra/DEPLOY_RUNBOOK.md.)
#
#   infra/scripts/deploy.sh --env-file /caminho/staging.env --version <tag> [--frontend-version <tag>]
#                           [--allow-degraded --notes "justificativa"]
#
# Ordem, a mesma do MIGRATION_RUNBOOK ("CI/CD Integration"). Cada etapa é um
# portão: se falha, as seguintes não rodam.
#   0. capacidades                falhou → nada foi alterado
#   1. backup do banco            falhou → nada foi alterado
#   2. migrations (credencial admin)  falhou → a aplicação continua na versão anterior
#      e proteções do banco          falhou → idem
#   3. troca da aplicação
#   4. readiness da versão nova   falhou → ROLLBACK AUTOMÁTICO para a anterior
#   5. smoke test                 falhou → ROLLBACK AUTOMÁTICO para a anterior
#   6. registro do deploy
#
# O rollback troca só a aplicação. O banco não volta: por isso toda migration
# precisa ser compatível com a versão anterior (expand/contract).
#
# Capacidades (K2-a — ver lib.sh e o MIGRATION_RUNBOOK; ADR-0069, seção 9.4):
# a versão implantada precisa ter tudo o que o banco exige e tudo o que este
# ambiente já exigiu. Rollback automático para uma anterior a que falte alguma:
#   - no deploy que introduz a exigência (o ambiente ainda não a tinha):
#     volta, em modo degradado e registrado — a versão nova não chegou a
#     atender, e parar a aplicação seria pior;
#   - depois que uma versão com a capacidade já ficou no ar: recusado, com a
#     aplicação parada, a menos que o deploy tenha sido chamado com
#     --allow-degraded e uma justificativa em --notes.
#
# Saída: 0 = versão nova no ar · 1 = falhou e a anterior foi restaurada ·
#        2 = falhou e NÃO foi possível restaurar (ou o retorno foi recusado) ·
#        3 = falhou ou foi recusado antes de tocar a aplicação.

# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

VERSION=""; FRONTEND_VERSION=""; ENV_FILE=""; NOTES=""; ALLOW_DEGRADED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --frontend-version) FRONTEND_VERSION="$2"; shift 2 ;;
    --notes) NOTES="$2"; shift 2 ;;
    --allow-degraded) ALLOW_DEGRADED=1; shift ;;
    *) die "argumento desconhecido: $1" ;;
  esac
done
[ -n "$VERSION" ] || die "informe a versão com --version <tag>"
[ "$ALLOW_DEGRADED" -eq 0 ] || [ -n "$NOTES" ] || die "--allow-degraded exige a justificativa em --notes" 3
init_environment

PREVIOUS="$(state_get current-version)"
ACTIVE_BEFORE="$(state_get requirement-active)"
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

# 0. capacidades
IMAGE_CAPABILITIES="$(image_capabilities "$BACKEND_IMAGE_REPO:$VERSION")" || die "não foi possível ler as capacidades da imagem $VERSION" 3
if ! DB_REQUIRED="$(db_required_capabilities)"; then
  record_history deploy "$VERSION" refused-capability "não foi possível ler as exigências do banco"
  die "não foi possível ler as exigências do banco — nada foi alterado" 3
fi
# shellcheck disable=SC2086  # listas separadas por espaço
LACKING="$(missing_from "$IMAGE_CAPABILITIES" $DB_REQUIRED $ACTIVE_BEFORE)"
if [ -n "$LACKING" ]; then
  record_history deploy "$VERSION" refused-capability "a versão não tem: $LACKING"
  die "a versão $VERSION não tem a capacidade '$LACKING', que o banco exige ou este ambiente já exigiu — nada foi alterado. Voltar a uma versão assim é rollback degradado: rollback.sh --allow-degraded (MIGRATION_RUNBOOK)" 3
fi

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
if ! check_database_protections; then
  record_history deploy "$VERSION" failed-protections "$CAPABILITY_PROBLEM"
  die "depois das migrations: $CAPABILITY_PROBLEM — a aplicação não foi trocada" 3
fi
# shellcheck disable=SC2086  # lista separada por espaço
LACKING="$(missing_from "$IMAGE_CAPABILITIES" $REQUIRED_CAPABILITIES)"
if [ -n "$LACKING" ]; then
  record_history deploy "$VERSION" failed-capability "as migrations passaram a exigir: $LACKING"
  die "as migrations da versão $VERSION passaram a exigir '$LACKING', que a própria imagem não declara — a aplicação não foi trocada" 3
fi
# A partir daqui o banco exige o que exige, mesmo que a troca falhe: é o que
# permite reconhecer depois um backup anterior restaurado sem migrations.
state_set requirement-active "$REQUIRED_CAPABILITIES"

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
  # Sem rótulo legível, a anterior conta como sem capacidade nenhuma.
  # shellcheck disable=SC2086  # lista separada por espaço
  PREVIOUS_LACKING="$(missing_from "$(image_capabilities "$BACKEND_IMAGE_REPO:$PREVIOUS" || true)" $REQUIRED_CAPABILITIES)"
  MODE=normal
  if [ -n "$PREVIOUS_LACKING" ]; then
    # shellcheck disable=SC2086  # lista separada por espaço
    ALREADY_ACTIVE="$(present_in "$ACTIVE_BEFORE" $PREVIOUS_LACKING)"
    if [ -n "$ALREADY_ACTIVE" ] && [ "$ALLOW_DEGRADED" -eq 0 ]; then
      compose stop backend >/dev/null 2>&1 || true
      record_history deploy "$VERSION" rollback-refused "$FAILURE; a anterior $PREVIOUS não tem: $ALREADY_ACTIVE"
      die "$FAILURE; a versão anterior $PREVIOUS não tem a capacidade '$ALREADY_ACTIVE', que este ambiente já exigia, e o rollback automático foi recusado — aplicação PARADA. Para voltar a ela em modo degradado: rollback.sh --to $PREVIOUS --allow-degraded --notes \"justificativa\"" 2
    fi
    MODE=degraded
    log "MODO DEGRADADO: a anterior $PREVIOUS não tem '$PREVIOUS_LACKING'${NOTES:+ (justificativa: $NOTES)}"
  fi
  log "ROLLBACK AUTOMÁTICO para $PREVIOUS"
  switch_backend "$PREVIOUS"
  if wait_ready "$PREVIOUS"; then
    record_history deploy "$VERSION" rolled-back "$FAILURE${NOTES:+; $NOTES}" "$MODE"
    die "$FAILURE; a versão $PREVIOUS foi restaurada e está pronta${PREVIOUS_LACKING:+ (MODO DEGRADADO: sem $PREVIOUS_LACKING)}" 1
  fi
  record_history deploy "$VERSION" rollback-failed "$FAILURE" "$MODE"
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

# Proxy HTTPS (Caddy): só quando o ambiente informa os dois endereços públicos.
# Não depende da versão da aplicação (acha backend e frontend pelo nome do serviço)
# e o certificado depende do DNS: uma falha aqui não desfaz um deploy que deu certo.
# Com os endereços informados, o proxy também exige ACME_EMAIL (conta do Let's Encrypt);
# sem ele, ou com um valor fora do formato, o proxy não é iniciado e o aviso diz por quê.
ACME_EMAIL_RE='^[^][:space:]@"{}\\]+@[^][:space:]@"{}\\]+\.[^][:space:]@"{}\\]+$'
if [ -n "$(env_get PUBLIC_API_HOST)" ] && [ -n "$(env_get PUBLIC_PANEL_HOST)" ]; then
  if ! [[ "$(env_get ACME_EMAIL)" =~ $ACME_EMAIL_RE ]]; then
    log "AVISO: ACME_EMAIL ausente ou inválido no arquivo de ambiente; o proxy HTTPS não foi iniciado e a aplicação segue no ar no loopback do host"
  else
    log "proxy HTTPS (Caddy)"
    if compose --profile proxy up -d --no-deps caddy >/dev/null; then
      # Recarrega o Caddyfile do checkout atual (o arquivo é montado, e o compose não percebe a mudança).
      compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
        || log "AVISO: o Caddy não recarregou a configuração; confira os logs do serviço caddy"
    else
      log "AVISO: o proxy HTTPS não subiu; a aplicação segue no ar no loopback do host"
    fi
  fi
fi

log "6/6 deploy concluído: $VERSION no ar em $APP_ENVIRONMENT (anterior: ${PREVIOUS:-nenhuma})"
