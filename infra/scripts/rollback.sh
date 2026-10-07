#!/usr/bin/env bash
# Luxora — rollback manual da aplicação para a versão anterior.
# (Tarefa 04 da auditoria. Ver docs/07-Infra/DEPLOY_RUNBOOK.md.)
#
#   infra/scripts/rollback.sh --env-file /caminho/staging.env [--to <tag>] [--notes "motivo"]
#
# Troca só a imagem da aplicação; não roda migration nenhuma e não toca no
# banco. Funciona porque toda migration precisa ser compatível com a versão
# anterior (expand/contract). Se a versão nova já escreveu dados que a
# anterior não entende, o caminho é uma migration de correção — não este script.
#
# Sem --to, volta para a versão que estava no ar antes do último deploy.
#
# Saída: 0 = versão anterior no ar · 2 = não ficou pronta (a que falhou foi mantida parada).

# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ENV_FILE=""; TARGET=""; NOTES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --to) TARGET="$2"; shift 2 ;;
    --notes) NOTES="$2"; shift 2 ;;
    *) die "argumento desconhecido: $1" ;;
  esac
done
init_environment

CURRENT="$(state_get current-version)"
TARGET="${TARGET:-$(state_get previous-version)}"
[ -n "$TARGET" ] || die "não há versão anterior registrada; informe --to <tag>"
[ "$TARGET" != "$CURRENT" ] || die "a versão $TARGET já é a atual"
require_image "$BACKEND_IMAGE_REPO:$TARGET"

log "rollback em $APP_ENVIRONMENT: $CURRENT → $TARGET"
switch_backend "$TARGET"
if ! wait_ready "$TARGET" || ! smoke_test; then
  record_history rollback "$TARGET" failed "$NOTES"
  die "a versão $TARGET não ficou pronta — INTERVENÇÃO MANUAL" 2
fi

record_history rollback "$TARGET" success "$NOTES"
state_set previous-version "$CURRENT"
state_set current-version "$TARGET"
log "rollback concluído: $TARGET no ar em $APP_ENVIRONMENT"
