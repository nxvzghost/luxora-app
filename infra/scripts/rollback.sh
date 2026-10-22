#!/usr/bin/env bash
# Luxora — rollback manual da aplicação para a versão anterior.
# (Tarefa 04 da auditoria. Ver docs/07-Infra/DEPLOY_RUNBOOK.md.)
#
#   infra/scripts/rollback.sh --env-file /caminho/staging.env [--to <tag>] [--notes "motivo"]
#                             [--allow-degraded --notes "justificativa"]
#
# Troca só a imagem da aplicação; não roda migration nenhuma e não toca no
# banco. Funciona porque toda migration precisa ser compatível com a versão
# anterior (expand/contract). Se a versão nova já escreveu dados que a
# anterior não entende, o caminho é uma migration de correção — não este script.
#
# Sem --to, volta para a versão que estava no ar antes do último deploy. Com
# --to igual à versão atual, só religa essa versão se ela não estiver no ar
# (por exemplo, depois de um rollback automático recusado pelo deploy.sh).
#
# Capacidades (K2-a — ver lib.sh e o MIGRATION_RUNBOOK): recusa voltar se o
# banco não tiver as proteções que exige, ou se tiver deixado de exigir o que
# este ambiente já exigia (backup restaurado sem migrations — o caminho aí é
# deploy.sh). Recusa também uma versão sem alguma capacidade que o banco
# exige; com --allow-degraded e a justificativa em --notes, volta mesmo assim
# e registra o retorno como degradado.
#
# Saída: 0 = versão anterior no ar · 2 = não ficou pronta (a que falhou foi mantida parada) ·
#        3 = recusado antes de tocar a aplicação.

# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ENV_FILE=""; TARGET=""; NOTES=""; ALLOW_DEGRADED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --to) TARGET="$2"; shift 2 ;;
    --notes) NOTES="$2"; shift 2 ;;
    --allow-degraded) ALLOW_DEGRADED=1; shift ;;
    *) die "argumento desconhecido: $1" ;;
  esac
done
init_environment

CURRENT="$(state_get current-version)"
TARGET="${TARGET:-$(state_get previous-version)}"
[ -n "$TARGET" ] || die "não há versão anterior registrada; informe --to <tag>"
[ "$TARGET" != "$CURRENT" ] || [ "$(running_version)" != "$TARGET" ] || die "a versão $TARGET já é a atual e está no ar"
require_image "$BACKEND_IMAGE_REPO:$TARGET"

# Capacidades (K2-a)
if ! check_database_protections; then
  record_history rollback "$TARGET" refused-protections "$CAPABILITY_PROBLEM"
  die "rollback recusado: $CAPABILITY_PROBLEM" 3
fi
# shellcheck disable=SC2086  # lista separada por espaço
LACKING="$(missing_from "$(image_capabilities "$BACKEND_IMAGE_REPO:$TARGET" || true)" $REQUIRED_CAPABILITIES)"
MODE=normal
if [ -n "$LACKING" ]; then
  if [ "$ALLOW_DEGRADED" -eq 0 ] || [ -z "$NOTES" ]; then
    record_history rollback "$TARGET" refused-capability "a versão não tem: $LACKING${NOTES:+; $NOTES}"
    die "rollback recusado: a versão $TARGET não tem a capacidade '$LACKING' que o banco exige. Para voltar mesmo assim, em modo degradado (o banco recusa o que ela não sabe fazer — MIGRATION_RUNBOOK): --allow-degraded --notes \"justificativa\"" 3
  fi
  MODE=degraded
  log "MODO DEGRADADO: $TARGET não tem '$LACKING' (justificativa: $NOTES)"
fi

log "rollback em $APP_ENVIRONMENT: ${CURRENT:-nenhuma} → $TARGET"
switch_backend "$TARGET"
if ! wait_ready "$TARGET" || ! smoke_test; then
  record_history rollback "$TARGET" failed "$NOTES" "$MODE"
  die "a versão $TARGET não ficou pronta — INTERVENÇÃO MANUAL" 2
fi

record_history rollback "$TARGET" success "$NOTES" "$MODE"
[ "$TARGET" = "$CURRENT" ] || state_set previous-version "$CURRENT"
state_set current-version "$TARGET"
log "rollback concluído: $TARGET no ar em $APP_ENVIRONMENT${LACKING:+ (MODO DEGRADADO: sem $LACKING)}"
