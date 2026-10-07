#!/usr/bin/env bash
# Luxora — ensaio de deploy e rollback (Tarefa 04 da auditoria).
#
#   infra/tests/rehearsal.sh --backend-version <tag> [--frontend-version <tag>]
#
# Sobe uma homologação DESCARTÁVEL nesta máquina, com as imagens já
# construídas (luxora-backend:<tag>, luxora-backend-migrate:<tag> e,
# opcionalmente, luxora-frontend:<tag>), e exercita de verdade o que os
# scripts de infra/scripts prometem: deploy, rollback automático, rollback
# manual, readiness com dependência fora do ar, encerramento gracioso,
# restauração de backup e exportação de traces.
#
# Não usa credencial externa, não chama Meta/Anthropic/Asaas e não gera
# custo. Usa um projeto compose próprio (luxora-rehearsal-<pid>) com volumes
# próprios, apagados ao final — o Postgres/Redis de desenvolvimento
# (projeto "luxora") não é tocado.
#
# Roda igual no CI (.github/workflows/ci.yml, job deploy-rehearsal).

set -uo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$TESTS_DIR/../scripts"
BASE=""; FRONTEND=""
while [ $# -gt 0 ]; do
  case "$1" in
    --backend-version) BASE="$2"; shift 2 ;;
    --frontend-version) FRONTEND="$2"; shift 2 ;;
    *) echo "argumento desconhecido: $1" >&2; exit 2 ;;
  esac
done
[ -n "$BASE" ] || { echo "uso: rehearsal.sh --backend-version <tag> [--frontend-version <tag>]" >&2; exit 2; }

PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ok      $1"; }
ko() { FAIL=$((FAIL + 1)); echo "  FALHOU  $1"; }
check() { local description="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$description"; else ko "$description"; fi; }
equal() { if [ "$2" = "$3" ]; then ok "$1"; else ko "$1 (esperado: $2 · obtido: $3)"; fi; }
section() { echo; echo "== $1"; }

V1="$BASE"; V2="$BASE-r2"; BAD="$BASE-quebrada"
IMAGE="luxora-backend"
WORK="$(mktemp -d)"
ENV_FILE="$WORK/staging.env"
export LUXORA_PROJECT="luxora-rehearsal-$$"
export LUXORA_STATE_DIR="$WORK/state"
export DEPLOY_ACTOR="ensaio-automatico"
BACKEND_PORT="${REHEARSAL_BACKEND_PORT:-13000}"
FRONTEND_PORT="${REHEARSAL_FRONTEND_PORT:-13001}"
API="http://127.0.0.1:$BACKEND_PORT"

compose() { docker compose -p "$LUXORA_PROJECT" --env-file "$ENV_FILE" -f "$TESTS_DIR/../staging/docker-compose.yml" "$@"; }
psql_admin() { compose exec -T postgres psql -U postgres -d luxora_staging -tA -c "$1" 2>/dev/null; }
status() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@" 2>/dev/null || echo 000; }
body() { curl -s --max-time 5 "$@" 2>/dev/null; }
version() { body "$API/api/v1/health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }
last_history() { tail -n 1 "$LUXORA_STATE_DIR/history.jsonl" 2>/dev/null | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }
wait_for() { # descrição, segundos, comando...
  local deadline=$(( $(date +%s) + $2 )); shift 2
  while [ "$(date +%s)" -lt "$deadline" ]; do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

cleanup() {
  compose --profile frontend --profile observability --profile tools down -v --remove-orphans >/dev/null 2>&1
  docker image rm -f "$IMAGE:$V2" "$IMAGE:$BAD" "$IMAGE-migrate:$V2" "$IMAGE-migrate:$BAD" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------- preparação
section "preparação"
for image in "$IMAGE:$V1" "$IMAGE-migrate:$V1"; do
  docker image inspect "$image" >/dev/null 2>&1 || { echo "imagem ausente: $image — construa antes (ver DEPLOY_RUNBOOK)"; exit 2; }
done
BAKED="$(docker run --rm --entrypoint printenv "$IMAGE:$V1" APP_VERSION 2>/dev/null)"
equal "a tag da imagem é a versão gravada nela (APP_VERSION)" "$V1" "$BAKED"

bash "$SCRIPTS/generate-env.sh" "$ENV_FILE" staging >/dev/null || { echo "não foi possível gerar o arquivo de ambiente"; exit 2; }
sed -i -e "s/^BACKEND_PORT=.*/BACKEND_PORT=$BACKEND_PORT/" -e "s/^FRONTEND_PORT=.*/FRONTEND_PORT=$FRONTEND_PORT/" \
  -e "s#^FRONTEND_URL=.*#FRONTEND_URL=http://localhost:$FRONTEND_PORT#" \
  -e "s#^OTEL_EXPORTER_OTLP_ENDPOINT=.*#OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318#" "$ENV_FILE"
equal "arquivo de ambiente gerado com permissão 600" "600" "$(stat -c %a "$ENV_FILE")"
ADMIN_PASSWORD="$(sed -n 's/^POSTGRES_ADMIN_PASSWORD=//p' "$ENV_FILE")"

# Uma segunda versão boa e uma quebrada de propósito, derivadas da imagem em teste.
printf 'FROM %s\nENV APP_VERSION=%s\n' "$IMAGE:$V1" "$V2" | docker build -q -t "$IMAGE:$V2" - >/dev/null
printf 'FROM %s\nENV APP_VERSION=%s\nCMD ["node","-e","console.error(\\"versao quebrada de proposito\\");process.exit(1)"]\n' "$IMAGE:$V1" "$BAD" \
  | docker build -q -t "$IMAGE:$BAD" - >/dev/null
docker tag "$IMAGE-migrate:$V1" "$IMAGE-migrate:$V2"
docker tag "$IMAGE-migrate:$V1" "$IMAGE-migrate:$BAD"

# -------------------------------------------------------------------- imagem
section "imagem do backend"
in_image() { docker run --rm --entrypoint sh "$IMAGE:$V1" -c "$1"; }
equal "roda como usuário sem privilégio" "node" "$(docker image inspect -f '{{.Config.User}}' "$IMAGE:$V1")"
equal "nenhum arquivo .env dentro da imagem" "0" "$(in_image "find / -xdev -name '.env*' -not -path '*/node_modules/*' 2>/dev/null | wc -l")"
check "dependências de produção presentes (@nestjs/core, bullmq, @prisma/client)" in_image "test -e node_modules/@nestjs/core && test -e node_modules/bullmq && test -e node_modules/@prisma/client"
check "ferramentas de desenvolvimento ausentes (typescript, vitest, prisma CLI, eslint)" in_image "test ! -e node_modules/typescript && test ! -e node_modules/vitest && test ! -e node_modules/prisma && test ! -e node_modules/eslint"
check "código-fonte e testes ausentes (só dist)" in_image "test -f dist/main.js && test ! -e src && test ! -e test"
check "o client do Prisma foi gerado na árvore final" in_image "node -e \"const { PrismaClient } = require('@prisma/client'); new PrismaClient()\""

# ------------------------------------------------------------ primeiro deploy
section "primeiro deploy ($V1)"
bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$V1" --notes "ensaio: primeiro deploy" > "$WORK/deploy-1.log" 2>&1
equal "deploy.sh termina com sucesso" "0" "$?"
[ "$FAIL" -eq 0 ] || { sed 's/^/    | /' "$WORK/deploy-1.log" | tail -n 30; }
equal "readiness responde 200" "200" "$(status "$API/api/v1/health/ready")"
equal "a versão no ar é a implantada" "$V1" "$(version)"
equal "estado registra a versão atual" "$V1" "$(cat "$LUXORA_STATE_DIR/current-version" 2>/dev/null)"
equal "histórico registra o deploy com sucesso" "success" "$(last_history result)"
equal "histórico registra o responsável" "ensaio-automatico" "$(last_history actor)"
check "backup feito antes das migrations" test -s "$(cat "$LUXORA_STATE_DIR/last-backup" 2>/dev/null)"
check "migrations aplicadas pelo job de migração" test "$(psql_admin "select count(*) from _prisma_migrations where finished_at is not null")" -gt 0

section "banco: papéis e isolamento"
equal "a role de runtime não é superusuário nem ignora RLS" "f|f" "$(psql_admin "select rolsuper, rolbypassrls from pg_roles where rolname = 'luxora_app'")"
check "a aplicação está conectada com a role restrita" test "$(psql_admin "select count(*) from pg_stat_activity where usename = 'luxora_app'")" -gt 0
equal "nenhuma conexão da aplicação com o usuário admin" "0" "$(psql_admin "select count(*) from pg_stat_activity where usename = 'postgres' and application_name not in ('psql', '') and pid <> pg_backend_pid()")"
check "tabelas com Row-Level Security forçada depois das migrations" test "$(psql_admin "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity")" -gt 0
BACKEND_CONTAINER="$(compose ps -q backend)"
if docker inspect -f '{{json .Config.Env}}' "$BACKEND_CONTAINER" | grep -qF "$ADMIN_PASSWORD"; then
  ko "a senha de admin do banco não entra no container da aplicação"
else
  ok "a senha de admin do banco não entra no container da aplicação"
fi
echo "  info    conexões abertas pela aplicação logo após o boot: $(psql_admin "select count(*) from pg_stat_activity where usename = 'luxora_app'")"

section "borda HTTP em modo produção"
equal "smoke: login inexistente consulta o banco e devolve 401" "401" "$(status -X POST -H 'Content-Type: application/json' -d '{"email":"ensaio@luxora.invalid","password":"senha-inexistente-0000"}' "$API/api/v1/auth/login")"
equal "/metrics sem token é recusado" "401" "$(status "$API/metrics")"
equal "/metrics com o token responde" "200" "$(status -H "X-Metrics-Token: $(sed -n 's/^METRICS_ACCESS_TOKEN=//p' "$ENV_FILE")" "$API/metrics")"
equal "documentação interativa não existe em produção" "404" "$(status "$API/api/v1/docs")"
check "headers de segurança presentes" sh -c "curl -s -D - -o /dev/null --max-time 5 '$API/api/v1/health' | grep -qi '^x-content-type-options: nosniff'"
check "CORS aceita a origem do painel configurada" sh -c "curl -s -D - -o /dev/null --max-time 5 -X OPTIONS -H 'Origin: http://localhost:$FRONTEND_PORT' -H 'Access-Control-Request-Method: POST' '$API/api/v1/auth/login' | grep -qi '^access-control-allow-origin: http://localhost:$FRONTEND_PORT'"

section "logs estruturados"
LOG_STATS="$(compose logs --no-log-prefix --no-color backend 2>/dev/null | docker run --rm -i --entrypoint node "$IMAGE:$V1" -e '
let total = 0, bad = 0;
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  total++;
  try { const r = JSON.parse(line); if (!r.timestamp || !r.level || r.service !== "luxora-backend" || typeof r.message !== "string") throw new Error(); }
  catch { bad++; if (bad <= 3) console.error("    | fora do formato: " + line.slice(0, 180)); }
}).on("close", () => console.log(total + " " + bad));')"
check "a aplicação registrou linhas de log" test "${LOG_STATS%% *}" -gt 0
equal "todas as linhas de log são JSON com timestamp, level, service e message" "0" "${LOG_STATS##* }"
check "os logs carregam a versão e o ambiente" sh -c "docker compose -p '$LUXORA_PROJECT' --env-file '$ENV_FILE' -f '$TESTS_DIR/../staging/docker-compose.yml' logs --no-log-prefix --no-color backend | grep -q '\"version\":\"$V1\",\"environment\":\"staging\"'"

psql_admin "create table if not exists rehearsal_marker (id int primary key); insert into rehearsal_marker values (1) on conflict do nothing" >/dev/null
marker() { psql_admin "select count(*) from rehearsal_marker"; }

# ------------------------------------------------------- rollback automático
section "deploy de uma versão quebrada → rollback automático"
READY_TIMEOUT_SECONDS=90 bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$BAD" > "$WORK/deploy-bad.log" 2>&1
equal "deploy.sh acusa a falha com o código de 'anterior restaurada' (1)" "1" "$?"
equal "a versão anterior está de volta no ar" "$V1" "$(version)"
equal "e está pronta" "200" "$(status "$API/api/v1/health/ready")"
equal "o estado continua apontando para a versão boa" "$V1" "$(cat "$LUXORA_STATE_DIR/current-version")"
equal "histórico registra o rollback automático" "rolled-back" "$(last_history result)"
equal "os dados do banco continuam lá" "1" "$(marker)"

# ----------------------------------------------------------- rollback manual
section "deploy de uma versão nova ($V2) e rollback manual"
bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$V2" > "$WORK/deploy-2.log" 2>&1
equal "deploy da versão nova termina com sucesso" "0" "$?"
equal "a versão nova está no ar" "$V2" "$(version)"
equal "estado guarda a anterior para o rollback" "$V1" "$(cat "$LUXORA_STATE_DIR/previous-version" 2>/dev/null)"
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" --notes "ensaio: rollback manual" > "$WORK/rollback.log" 2>&1
equal "rollback.sh termina com sucesso" "0" "$?"
equal "a versão anterior está no ar" "$V1" "$(version)"
equal "e está pronta" "200" "$(status "$API/api/v1/health/ready")"
equal "histórico registra o rollback manual" "rollback" "$(last_history action)"
equal "os dados do banco continuam lá" "1" "$(marker)"

# ------------------------------------------------- readiness e dependências
section "readiness com dependência fora do ar"
ready_is() { [ "$(status "$API/api/v1/health/ready")" = "$1" ]; }
compose stop redis >/dev/null 2>&1
check "Redis parado → readiness 503" wait_for redis-down 20 ready_is 503
check "a resposta aponta o Redis" sh -c "curl -s --max-time 5 '$API/api/v1/health/ready' | grep -q '\"redis\":\"down\"'"
equal "liveness continua 200 (o container não deve ser reiniciado)" "200" "$(status "$API/api/v1/health")"
compose start redis >/dev/null 2>&1
check "Redis de volta → readiness 200 sem reiniciar a aplicação" wait_for redis-up 40 ready_is 200
compose stop postgres >/dev/null 2>&1
check "Postgres parado → readiness 503" wait_for pg-down 20 ready_is 503
check "a resposta aponta o banco" sh -c "curl -s --max-time 5 '$API/api/v1/health/ready' | grep -q '\"database\":\"down\"'"
compose start postgres >/dev/null 2>&1
check "Postgres de volta → readiness 200 sem reiniciar a aplicação" wait_for pg-up 60 ready_is 200
equal "o container da aplicação nunca foi reiniciado nesse intervalo" "0" "$(docker inspect -f '{{.RestartCount}}' "$(compose ps -q backend)")"

# ------------------------------------------------------------ traces (OTLP)
section "traces exportados por OTLP para o coletor"
status -X POST -H 'Content-Type: application/json' -d '{"email":"trace@luxora.invalid","password":"senha-inexistente-0000"}' "$API/api/v1/auth/login" >/dev/null
# O log vai primeiro para um arquivo: com `pipefail`, um `grep -q` que acha o
# texto cedo fecha o pipe e faz o `compose logs` (e a verificação) falhar.
collector_has() {
  compose logs --no-color otel-collector > "$WORK/collector.log" 2>/dev/null
  grep -qF -- "$1" "$WORK/collector.log"
}
check "o coletor recebeu spans do serviço luxora-backend" wait_for spans 30 collector_has 'service.name: Str(luxora-backend)'
check "os spans carregam a versão" collector_has "service.version: Str($V1)"
check "os spans carregam o ambiente" collector_has 'deployment.environment.name: Str(staging)'
check "a requisição de login virou um span" collector_has 'Name           : POST /api/v1/auth/login'
# O deploy consulta /health e /health/ready dezenas de vezes: se as sondas
# gerassem trace, estariam aqui.
if collector_has '/api/v1/health'; then
  ko "as sondas de saúde não geram trace"
else
  ok "as sondas de saúde não geram trace"
fi

# ----------------------------------------------------- encerramento gracioso
section "encerramento gracioso"
BACKEND_CONTAINER="$(compose ps -q backend)"
STOP_START="$(date +%s)"
compose stop backend >/dev/null 2>&1
STOP_SECONDS=$(( $(date +%s) - STOP_START ))
EXIT_CODE="$(docker inspect -f '{{.State.ExitCode}}' "$BACKEND_CONTAINER")"
if [ "$EXIT_CODE" != "137" ]; then ok "o processo terminou sozinho com o SIGTERM (código $EXIT_CODE, sem SIGKILL)"; else ko "o processo precisou de SIGKILL (137)"; fi
check "terminou bem antes do prazo de 90 s (${STOP_SECONDS} s)" test "$STOP_SECONDS" -lt 30
docker start "$BACKEND_CONTAINER" >/dev/null 2>&1
check "volta a ficar pronta depois de religada" wait_for restart 60 ready_is 200

# ------------------------------------------------------ restauração de backup
section "ensaio de restauração do backup"
bash "$SCRIPTS/restore-drill.sh" --env-file "$ENV_FILE" > "$WORK/restore.log" 2>&1
equal "restore-drill.sh termina com sucesso" "0" "$?"
[ "$(last_history result)" = "success" ] || sed 's/^/    | /' "$WORK/restore.log" | tail -n 15
equal "histórico registra o ensaio de restauração" "restore-drill" "$(last_history action)"
equal "o banco descartável foi apagado" "0" "$(psql_admin "select count(*) from pg_database where datname = 'luxora_restore_drill'")"
equal "o banco em uso não foi tocado" "1" "$(marker)"

# -------------------------------------------------------------------- painel
if [ -n "$FRONTEND" ]; then
  section "painel ($FRONTEND)"
  equal "roda como usuário sem privilégio" "node" "$(docker image inspect -f '{{.Config.User}}' "luxora-frontend:$FRONTEND" 2>/dev/null)"
  bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$V1" --frontend-version "$FRONTEND" > "$WORK/deploy-front.log" 2>&1
  equal "deploy com o painel termina com sucesso" "0" "$?"
  front_is_up() { [ "$(status "http://127.0.0.1:$FRONTEND_PORT/login")" = "200" ]; }
  check "a tela de login responde 200" wait_for front 60 front_is_up
  check "a página servida é a do painel" sh -c "curl -s --max-time 5 'http://127.0.0.1:$FRONTEND_PORT/login' | grep -qi 'luxora'"
fi

echo
echo "ensaio: $PASS verificações passaram, $FAIL falharam"
if [ "$FAIL" -ne 0 ]; then
  for file in deploy-1 deploy-bad deploy-2 rollback restore deploy-front; do
    [ -f "$WORK/$file.log" ] && { echo "--- $file.log"; tail -n 12 "$WORK/$file.log" | sed 's/^/    | /'; }
  done
  exit 1
fi
