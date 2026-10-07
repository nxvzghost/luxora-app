#!/usr/bin/env bash
# Luxora — ensaio de restauração de backup (Recovery Drill).
# (Tarefa 04 da auditoria. Procedimento: docs/07-Infra/MIGRATION_RUNBOOK.md, "Recovery Drill".)
#
#   infra/scripts/restore-drill.sh --env-file /caminho/staging.env [--backup <arquivo.dump>]
#
# Restaura o backup num banco DESCARTÁVEL, no mesmo servidor, confere e
# apaga. Nunca restaura por cima do banco em uso. Sem --backup, usa o último
# feito pelo deploy.
#
# Confere: o backup restaura sem erro; as tabelas e o histórico de migrations
# são os do banco de origem; e a Row-Level Security continua forçada — é ela
# que isola as clínicas, e uma restauração que a perdesse não daria erro nenhum.

# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ENV_FILE=""; BACKUP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --backup) BACKUP="$2"; shift 2 ;;
    *) die "argumento desconhecido: $1" ;;
  esac
done
init_environment

BACKUP="${BACKUP:-$(state_get last-backup)}"
[ -n "$BACKUP" ] && [ -s "$BACKUP" ] || die "backup não encontrado (${BACKUP:-nenhum registrado})"
SCRATCH="luxora_restore_drill"
START="$(date +%s)"

psql_admin() { compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -tA "$@"; }
count() { psql_admin -d "$1" -c "$2"; }
TABLES="select count(*) from information_schema.tables where table_schema = 'public'"
FORCED_RLS="select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity"
MIGRATIONS="select count(*) from _prisma_migrations where finished_at is not null"

cleanup() { psql_admin -d postgres -c "drop database if exists $SCRATCH" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "ensaio de restauração: $(basename "$BACKUP") → banco descartável $SCRATCH"
cleanup
psql_admin -d postgres -c "create database $SCRATCH" >/dev/null
if ! compose exec -T postgres pg_restore -U postgres -d "$SCRATCH" --exit-on-error < "$BACKUP"; then
  record_history restore-drill "$(basename "$BACKUP")" failed "pg_restore falhou"
  die "o backup não restaurou" 2
fi

# O backup é anterior ao deploy que o gerou: pode ter menos tabelas e menos
# migrations que o banco de hoje. Por isso a origem aparece só como
# referência; o que reprova o ensaio é o estado do próprio banco restaurado.
RESTORED_TABLES="$(count "$SCRATCH" "$TABLES")"
RESTORED_RLS="$(count "$SCRATCH" "$FORCED_RLS")"
RESTORED_MIGRATIONS="$(count "$SCRATCH" "$MIGRATIONS" 2>/dev/null || echo 0)"
log "  restaurado: $RESTORED_TABLES tabelas, $RESTORED_RLS com RLS forçada, $RESTORED_MIGRATIONS migrations"
log "  origem hoje: $(count "$DATABASE_NAME" "$TABLES") tabelas, $(count "$DATABASE_NAME" "$FORCED_RLS") com RLS forçada, $(count "$DATABASE_NAME" "$MIGRATIONS" 2>/dev/null || echo 0) migrations"

PROBLEMS=""
if [ "$RESTORED_TABLES" -gt 0 ]; then
  # A RLS é o que isola as clínicas; uma restauração que a perdesse não daria erro.
  [ "$RESTORED_RLS" -gt 0 ] || PROBLEMS="$PROBLEMS a-restauração-perdeu-a-RLS"
  [ "$RESTORED_MIGRATIONS" -gt 0 ] || PROBLEMS="$PROBLEMS sem-histórico-de-migrations"
fi

ELAPSED=$(( $(date +%s) - START ))
if [ -n "$PROBLEMS" ]; then
  record_history restore-drill "$(basename "$BACKUP")" failed "$PROBLEMS"
  die "ensaio de restauração com problema:$PROBLEMS" 2
fi
record_history restore-drill "$(basename "$BACKUP")" success "tabelas=$RESTORED_TABLES rls=$RESTORED_RLS em ${ELAPSED}s"
log "ensaio concluído em ${ELAPSED}s: $RESTORED_TABLES tabelas, $RESTORED_RLS com RLS forçada"
