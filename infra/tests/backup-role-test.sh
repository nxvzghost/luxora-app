#!/usr/bin/env bash
# Luxora — teste da role de backup luxora_backup (postgres-init/02-backup-role.sh).
#
#   bash infra/tests/backup-role-test.sh --container <contêiner do postgres> [--db <banco>]
#
# Consulta um PostgreSQL REAL já inicializado com o 02-backup-role.sh (o do ensaio de deploy:
# rehearsal.sh passa o contêiner do compose) e confere atributos, participações, configurações
# e privilégios da role. Somente leitura: nenhuma tabela, linha ou privilégio é criado ou
# alterado. As provas de negação usam o catálogo (has_*_privilege) e, onde há tentativa real,
# comandos que não alteram nada nem se o privilégio existisse (INSERT ... LIMIT 0, DELETE ... WHERE false).
# Não depende de default_transaction_read_only: a fronteira de segurança é a falta de privilégio.
#
# Não usa senha: o psql entra pelo socket local do contêiner, que a imagem oficial aceita sem
# senha. Por isso este teste NÃO prova a autenticação por senha (SCRAM) — essa só vale pela
# rede, e é validada na VPS. Nenhuma senha é lida, impressa ou passada em argumento.

set -uo pipefail

CONTAINER=""; DB="luxora_staging"
while [ $# -gt 0 ]; do
  case "$1" in
    --container) CONTAINER="$2"; shift 2 ;;
    --db) DB="$2"; shift 2 ;;
    *) echo "argumento desconhecido: $1" >&2; exit 2 ;;
  esac
done
[ -n "$CONTAINER" ] || { echo "uso: backup-role-test.sh --container <contêiner do postgres> [--db <banco>]" >&2; exit 2; }
docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true \
  || { echo "o contêiner do postgres não está rodando: $CONTAINER" >&2; exit 2; }

PASS=0; FAIL=0; SKIP=0
ok() { PASS=$((PASS + 1)); echo "  ok      $1"; }
ko() { FAIL=$((FAIL + 1)); echo "  FALHOU  $1"; }
equal() { if [ "$2" = "$3" ]; then ok "$1"; else ko "$1 (esperado: $2 · obtido: ${3:-<vazio>})"; fi; }

# Como administrador (catálogo) e como a própria luxora_backup (sessão real, sem senha).
q_admin() { docker exec -i "$CONTAINER" psql -X -q -tA -v ON_ERROR_STOP=1 -U postgres -d "$DB" -c "$1" 2>&1; }
# O segundo argumento, se houver, roda como um segundo -c, em outra transação (um SET anterior vale para ele).
q_backup() { docker exec -i "$CONTAINER" psql -X -q -tA -v ON_ERROR_STOP=1 -U luxora_backup -d "$DB" -c "$1" ${2:+-c "$2"} 2>&1; }

echo "== role de backup (luxora_backup)"

# ------------------------------------------------------- existência e atributos
ATTRS="$(q_admin "select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconnlimit from pg_roles where rolname = 'luxora_backup'")"
if [ -z "$ATTRS" ]; then
  ko "a role luxora_backup existe (ausente: o 02-backup-role.sh não rodou ou não criou a role — POSTGRES_BACKUP_PASSWORD vazia/fraca?)"
  echo; echo "backup-role: $PASS verificações passaram, $FAIL falharam"; exit 1
fi
ok "a role luxora_backup existe"
equal "login habilitado; sem superusuário, createdb, createrole nem replicação; BYPASSRLS; limite de 3 conexões" \
  "t|f|f|f|f|t|3" "$ATTRS"

# ------------------------------------------------------------------ participações
equal "participa somente de pg_read_all_data" "pg_read_all_data" \
  "$(q_admin "select coalesce(string_agg(r.rolname, ',' order by r.rolname), '') from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member where u.rolname = 'luxora_backup'")"
equal "não é membro (nem por herança) de pg_write_all_data, pg_monitor, luxora_app nem do admin" "f|f|f|f" \
  "$(q_admin "select pg_has_role('luxora_backup', 'pg_write_all_data', 'MEMBER'), pg_has_role('luxora_backup', 'pg_monitor', 'MEMBER'), pg_has_role('luxora_backup', 'luxora_app', 'MEMBER'), pg_has_role('luxora_backup', 'postgres', 'MEMBER')")"

# ------------------------------------------------------------------ configurações
SETTINGS="$(q_admin "select coalesce(string_agg(s.setdatabase::text || ':' || c, ',' order by c), '') from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) c where r.rolname = 'luxora_backup'")"
equal "configuração da role: só default_transaction_read_only=on, global (nenhuma específica por banco)" \
  "0:default_transaction_read_only=on" "$SETTINGS"

# ------------------------------------------------- sessão real como luxora_backup
equal "a role conecta ao banco do ensaio (CONNECT) e a sessão é dela" "luxora_backup" "$(q_backup "select current_user")"
equal "a sessão da role abre com default_transaction_read_only=on (trava de acidente, não a fronteira)" "on" \
  "$(q_backup "show default_transaction_read_only")"

# ------------------------------------------------------------ banco e schemas
equal "banco: CONNECT permitido e CREATE negado" "t|f" \
  "$(q_admin "select has_database_privilege('luxora_backup', current_database(), 'CONNECT'), has_database_privilege('luxora_backup', current_database(), 'CREATE')")"
USER_SCHEMAS="select nspname from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema'"
equal "schemas do usuário: existe ao menos um" "t" "$(q_admin "select count(*) > 0 from ($USER_SCHEMAS) s")"
equal "schemas do usuário: nenhum sem USAGE" "0" \
  "$(q_admin "select count(*) from ($USER_SCHEMAS) s where not has_schema_privilege('luxora_backup', s.nspname, 'USAGE')")"
equal "schemas do usuário: nenhum com CREATE" "0" \
  "$(q_admin "select count(*) from ($USER_SCHEMAS) s where has_schema_privilege('luxora_backup', s.nspname, 'CREATE')")"

# ---------------------------------------------------- tabelas e sequências: leitura
REL="select c.oid, n.nspname, c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'"
equal "há tabelas no banco do ensaio" "t" "$(q_admin "select count(*) > 0 from ($REL and c.relkind in ('r','p')) t")"
equal "tabelas: nenhuma sem SELECT" "0" \
  "$(q_admin "select count(*) from ($REL and c.relkind in ('r','p')) t where not coalesce(case when t.relkind in ('r','p') then has_table_privilege('luxora_backup', t.oid, 'SELECT') end, true)")"
equal "sequências: nenhuma sem SELECT" "0" \
  "$(q_admin "select count(*) from ($REL and c.relkind = 'S') t where not coalesce(case when t.relkind = 'S' then has_sequence_privilege('luxora_backup', t.oid, 'SELECT') end, true)")"
equal "leitura real: a role lê as migrations aplicadas" "t" "$(q_backup "select count(*) > 0 from _prisma_migrations")"

# ------------------------------------------------------------------------ escrita
equal "tabelas: nenhuma com INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES ou TRIGGER" "0" \
  "$(q_admin "select count(*) from ($REL and c.relkind in ('r','p')) t where coalesce(case when t.relkind in ('r','p') then has_table_privilege('luxora_backup', t.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') end, false)")"
equal "sequências: nenhuma com USAGE ou UPDATE (nextval/setval)" "0" \
  "$(q_admin "select count(*) from ($REL and c.relkind = 'S') t where coalesce(case when t.relkind = 'S' then has_sequence_privilege('luxora_backup', t.oid, 'USAGE,UPDATE') end, false)")"
FIRST_TABLE="$(q_admin "select format('%I.%I', nspname, relname) from ($REL and c.relkind = 'r') t order by 1 limit 1")"
if [ -n "$FIRST_TABLE" ]; then
  # Mesmo com a trava de leitura desligada na sessão: sem privilégio, é recusado. Os dois comandos
  # não alterariam linha nenhuma nem se fossem aceitos.
  OUT="$(q_backup "set default_transaction_read_only = off" "insert into $FIRST_TABLE select * from $FIRST_TABLE limit 0" || true)"
  case "$OUT" in *"permission denied"*) ok "tentativa real de INSERT (com a trava desligada) é negada por falta de privilégio" ;;
    *) ko "tentativa real de INSERT (com a trava desligada) deveria ser negada por falta de privilégio (obtido: ${OUT:-<vazio>})" ;; esac
  OUT="$(q_backup "set default_transaction_read_only = off" "delete from $FIRST_TABLE where false" || true)"
  case "$OUT" in *"permission denied"*) ok "tentativa real de DELETE (com a trava desligada) é negada por falta de privilégio" ;;
    *) ko "tentativa real de DELETE (com a trava desligada) deveria ser negada por falta de privilégio (obtido: ${OUT:-<vazio>})" ;; esac
fi

# ------------------------------------------------------------------ objetos grandes
equal "o banco não tem objetos grandes (Large Objects)" "0" "$(q_admin "select count(*) from pg_largeobject_metadata")"
for who in luxora_backup luxora_app; do
  equal "$who não executa as funções que criam objetos grandes (lo_create, lo_creat, lo_from_bytea, lo_import)" "f|f|f|f|f" \
    "$(q_admin "select has_function_privilege('$who', 'pg_catalog.lo_create(oid)', 'EXECUTE'), has_function_privilege('$who', 'pg_catalog.lo_creat(integer)', 'EXECUTE'), has_function_privilege('$who', 'pg_catalog.lo_from_bytea(oid, bytea)', 'EXECUTE'), has_function_privilege('$who', 'pg_catalog.lo_import(text)', 'EXECUTE'), has_function_privilege('$who', 'pg_catalog.lo_import(text, oid)', 'EXECUTE')")"
done
equal "a leitura de objetos grandes (lo_get, que o pg_dump usa) não foi revogada" "t" \
  "$(q_admin "select has_function_privilege('luxora_backup', 'pg_catalog.lo_get(oid)', 'EXECUTE')")"

# -------------------------------------------------------------------------- RLS
FORCED="select c.oid, n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and c.relkind = 'r' and c.relforcerowsecurity"
equal "há tabelas com Row-Level Security forçada" "t" "$(q_admin "select count(*) > 0 from ($FORCED) f")"
# Soma das linhas de todas as tabelas com RLS forçada: o administrador (superusuário) vê tudo; a role
# só vê tudo se o BYPASSRLS estiver funcionando. Se o ensaio não tem linhas nelas, não há o que provar.
SUM="select coalesce(sum((xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', f.nspname, f.relname), false, true, '')))[1]::text::bigint), 0) from ($FORCED) f"
ROWS_ADMIN="$(q_admin "$SUM")"
if [ "${ROWS_ADMIN:-0}" -gt 0 ] 2>/dev/null; then
  equal "RLS forçada: a role lê o mesmo total de linhas que o administrador ($ROWS_ADMIN)" "$ROWS_ADMIN" "$(q_backup "$SUM")"
else
  SKIP=$((SKIP + 1)); echo "  pulou   leitura sob RLS forçada: as tabelas do ensaio estão vazias neste ponto (o atributo BYPASSRLS foi conferido acima)"
fi

echo
echo "backup-role: $PASS verificações passaram, $FAIL falharam, $SKIP puladas"
[ "$FAIL" -eq 0 ]
