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

V1="$BASE"; V2="$BASE-r2"; BAD="$BASE-quebrada"; NOCAP="$BASE-sem-capacidade"
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
  docker image rm -f "$IMAGE:$V2" "$IMAGE:$BAD" "$IMAGE:$NOCAP" "$IMAGE-migrate:$V2" "$IMAGE-migrate:$BAD" "$IMAGE-migrate:$NOCAP" >/dev/null 2>&1
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
# K2-a: uma versão que não declara a capacidade billing-eligibility-v1, no
# lugar de uma anterior ao K2-a (o ensaio com a versão antiga de verdade é o
# infra/tests/k2-compat-rehearsal.sh).
printf 'FROM %s\nENV APP_VERSION=%s\nLABEL luxora.capabilities=""\n' "$IMAGE:$V1" "$NOCAP" | docker build -q -t "$IMAGE:$NOCAP" - >/dev/null
docker tag "$IMAGE-migrate:$V1" "$IMAGE-migrate:$V2"
docker tag "$IMAGE-migrate:$V1" "$IMAGE-migrate:$BAD"
docker tag "$IMAGE-migrate:$V1" "$IMAGE-migrate:$NOCAP"

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
equal "um único pool: a aplicação abre uma conexão logo após o boot (eram 17, uma por PrismaClient)" "1" "$(psql_admin "select count(*) from pg_stat_activity where usename = 'luxora_app'")"

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

# ------------------------------------- K2-a: capacidades e retorno degradado
section "K2-a e K2-b: exigência de versão e retorno degradado"
K2A_CONSTRAINTS="'billing_eligibility_protocol_fkey','billing_legacy_or_protocol_check','billing_session_billing_patient_fkey','billing_session_session_patient_fkey','billing_session_legacy_or_patient_check'"
# A lista da K2-b é a mesma que os scripts conferem (lib.sh), no formato do SQL.
K2B_CONSTRAINTS="$(bash -c ". '$SCRIPTS/lib.sh' >/dev/null 2>&1; printf \"'%s',\" \$K2B_CONSTRAINTS")"; K2B_CONSTRAINTS="${K2B_CONSTRAINTS%,}"
equal "a imagem declara as capacidades billing-eligibility-v1 e appointment-outcome-v1" "billing-eligibility-v1,appointment-outcome-v1" "$(docker image inspect -f '{{ index .Config.Labels "luxora.capabilities" }}' "$IMAGE:$V1")"
equal "o banco exige as duas" "appointment-outcome-v1,billing-eligibility-v1" "$(psql_admin "select string_agg(capability, ',' order by capability) from deployment_requirement")"
equal "o ambiente registra a exigência ativa" "appointment-outcome-v1 billing-eligibility-v1" "$(cat "$LUXORA_STATE_DIR/requirement-active" 2>/dev/null)"
equal "as cinco restrições do K2-a existem e estão validadas" "5" "$(psql_admin "select count(*) from pg_constraint where conname in ($K2A_CONSTRAINTS) and convalidated")"
equal "as 23 restrições da K2-b existem e estão validadas" "23" "$(psql_admin "select count(*) from pg_constraint where conname in ($K2B_CONSTRAINTS) and convalidated")"
equal "a política de congelamento é RESTRICTIVE, de UPDATE, para a role de runtime" "f|w|luxora_app" \
  "$(psql_admin "select p.polpermissive, p.polcmd, r.rolname from pg_policy p join pg_roles r on r.oid = any(p.polroles) where p.polrelid = 'appointment'::regclass and p.polname = 'appointment_frozen_after_outcome'")"
equal "a role de runtime não grava legacy_billing nem legacy_link e não muda o protocolo" "f|f|f" \
  "$(psql_admin "select has_column_privilege('luxora_app', 'billing', 'legacy_billing', 'INSERT,UPDATE'), has_column_privilege('luxora_app', 'billing_session', 'legacy_link', 'INSERT,UPDATE'), has_column_privilege('luxora_app', 'billing', 'eligibility_protocol', 'UPDATE')")"
equal "a role de runtime não escreve nas tabelas de protocolo e de exigência" "f|f|f" \
  "$(psql_admin "select has_table_privilege('luxora_app', 'billing_eligibility_protocol', 'INSERT,DELETE,TRUNCATE'), has_any_column_privilege('luxora_app', 'billing_eligibility_protocol', 'UPDATE'), has_table_privilege('luxora_app', 'deployment_requirement', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')")"
equal "a role de runtime não apaga desfecho, comunicação nem decisão, nem reescreve o retrato" "f|f|f|f" \
  "$(psql_admin "select has_table_privilege('luxora_app', 'appointment_outcome', 'DELETE,TRUNCATE'), has_table_privilege('luxora_app', 'appointment_notice', 'DELETE,TRUNCATE'), has_table_privilege('luxora_app', 'appointment_decision', 'DELETE,TRUNCATE'), has_column_privilege('luxora_app', 'appointment_outcome', 'state_at_outcome', 'UPDATE')")"

bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$NOCAP" > "$WORK/k2-deploy-nocap.log" 2>&1
equal "deploy.sh recusa a versão sem a capacidade antes de tocar em algo (3)" "3" "$?"
equal "a versão no ar continua a mesma" "$V1" "$(version)"
equal "histórico registra a recusa" "refused-capability" "$(last_history result)"
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" --to "$NOCAP" > "$WORK/k2-rollback-refused.log" 2>&1
equal "rollback.sh recusa voltar para a versão sem a capacidade (3)" "3" "$?"
equal "a versão no ar continua a mesma" "$V1" "$(version)"
equal "histórico registra a recusa do rollback" "rollback|refused-capability" "$(last_history action)|$(last_history result)"
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" --to "$NOCAP" --allow-degraded > "$WORK/k2-rollback-no-notes.log" 2>&1
equal "--allow-degraded sem justificativa também é recusado (3)" "3" "$?"
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" --to "$NOCAP" --allow-degraded --notes "ensaio: retorno degradado justificado" > "$WORK/k2-rollback-degraded.log" 2>&1
equal "com --allow-degraded e justificativa, o rollback volta (0)" "0" "$?"
equal "a versão sem a capacidade está no ar" "$NOCAP" "$(version)"
equal "histórico registra o retorno como degradado, com a justificativa" "degraded|ensaio: retorno degradado justificado" "$(last_history mode)|$(last_history notes)"

READY_TIMEOUT_SECONDS=90 bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$BAD" > "$WORK/k2-deploy-bad.log" 2>&1
equal "versão quebrada com a anterior sem a capacidade: rollback automático recusado (2)" "2" "$?"
equal "a aplicação fica parada (nenhuma versão responde)" "" "$(version)"
equal "histórico registra o rollback automático recusado" "rollback-refused" "$(last_history result)"
READY_TIMEOUT_SECONDS=90 bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$BAD" --allow-degraded --notes "ensaio: aceito voltar degradado" > "$WORK/k2-deploy-bad-allowed.log" 2>&1
equal "com --allow-degraded e justificativa, o rollback automático volta para a anterior (1)" "1" "$?"
equal "a anterior, sem a capacidade, está no ar" "$NOCAP" "$(version)"
equal "histórico registra o rollback automático como degradado" "rolled-back|degraded" "$(last_history result)|$(last_history mode)"
bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$V1" > "$WORK/k2-deploy-v1.log" 2>&1
equal "deploy da versão com a capacidade sai do modo degradado (0)" "0" "$?"
equal "a versão com a capacidade está no ar" "$V1" "$(version)"
equal "histórico registra modo normal" "success|normal" "$(last_history result)|$(last_history mode)"

section "K2-a: banco sem as proteções que exige → rollback e deploy recusados"
k2_rollback_refused() { # descrição
  bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" --to "$V2" > "$WORK/k2-tamper.log" 2>&1
  equal "$1: rollback.sh recusa (3)" "3" "$?"
  equal "$1: a versão no ar continua a mesma" "$V1" "$(version)"
  equal "$1: histórico registra a recusa" "refused-protections" "$(last_history result)"
}
psql_admin "alter table billing drop constraint billing_legacy_or_protocol_check" >/dev/null
k2_rollback_refused "restrição removida"
bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$V2" > "$WORK/k2-tamper-deploy.log" 2>&1
equal "restrição removida: deploy.sh recusa depois das migrations, sem trocar a aplicação (3)" "3|$V1|failed-protections" "$?|$(version)|$(last_history result)"
psql_admin "alter table billing add constraint billing_legacy_or_protocol_check check (legacy_billing or eligibility_protocol is not null)" >/dev/null
psql_admin "grant update (legacy_billing) on billing to luxora_app" >/dev/null
k2_rollback_refused "privilégio devolvido à aplicação"
psql_admin "revoke update (legacy_billing) on billing from luxora_app" >/dev/null
# K2-b — sem a política restritiva, o papel da aplicação voltaria a atualizar consulta com desfecho.
psql_admin "drop policy appointment_frozen_after_outcome on appointment" >/dev/null
k2_rollback_refused "política de congelamento removida"
psql_admin "create policy appointment_frozen_after_outcome on appointment as restrictive for update to luxora_app using (not exists (select 1 from appointment_outcome o where o.appointment_id = appointment.id))" >/dev/null
psql_admin "grant delete on appointment_outcome to luxora_app" >/dev/null
k2_rollback_refused "privilégio de apagar desfecho devolvido à aplicação"
psql_admin "revoke delete on appointment_outcome from luxora_app" >/dev/null
psql_admin "delete from deployment_requirement" >/dev/null
k2_rollback_refused "exigência sumida do banco (como num backup antigo restaurado sem migrations)"
psql_admin "insert into deployment_requirement (capability, set_by_migration) values ('billing-eligibility-v1', '20261022120000_k2a_billing_eligibility'), ('appointment-outcome-v1', '20261023130014_k2b_appointment_outcome')" >/dev/null
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" --to "$V2" > "$WORK/k2-rollback-v2.log" 2>&1
equal "proteções de volta: rollback para uma versão com a capacidade passa (0)" "0|$V2" "$?|$(version)"
bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$V1" > "$WORK/k2-deploy-v1-again.log" 2>&1
equal "e o deploy da versão em teste também (0)" "0|$V1" "$?|$(version)"

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

# Tarefa 07 da auditoria — a verificação do webhook da Meta manda o token de
# verificação na query string (o protocolo exige). A requisição é feita aqui,
# do jeito que a Meta a faz, contra a imagem de verdade: o token deste
# ambiente chega à aplicação e não pode chegar ao coletor. Nenhuma chamada à Meta.
VERIFY_TOKEN="$(sed -n 's/^WHATSAPP_WEBHOOK_VERIFY_TOKEN=//p' "$ENV_FILE")"
WRONG_TOKEN="token-errado-do-ensaio-7731"
CHALLENGE="desafio-do-ensaio-4412"
equal "a verificação do webhook aceita o token do ambiente e devolve o desafio" "$CHALLENGE" \
  "$(body "$API/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=$VERIFY_TOKEN&hub.challenge=$CHALLENGE")"
equal "a verificação do webhook recusa um token errado" "403" \
  "$(status "$API/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=$WRONG_TOKEN&hub.challenge=$CHALLENGE")"
check "a verificação virou um span com os nomes dos parâmetros e sem os valores" \
  wait_for webhook-span 30 collector_has 'url.query: Str(hub.mode=subscribe&hub.verify_token=REDACTED&hub.challenge=REDACTED)'
# Espera o span da segunda requisição (a recusada) também ter sido exportado.
wait_for webhook-403 30 collector_has 'http.response.status_code: Int(403)'
if [ -z "$VERIFY_TOKEN" ] || collector_has "$VERIFY_TOKEN" || collector_has "$WRONG_TOKEN" || collector_has "$CHALLENGE"; then
  ko "nem o token de verificação, nem o token errado, nem o desafio chegam ao coletor"
else
  ok "nem o token de verificação, nem o token errado, nem o desafio chegam ao coletor"
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
check "o banco restaurado tem a exigência e as proteções do K2-a e da K2-b" grep -q 'exigência=appointment-outcome-v1,billing-eligibility-v1 proteções=ok' "$WORK/restore.log"
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

  # Tarefa 07 da auditoria — a imagem distribui as fontes Fraunces e Inter; o
  # aviso de direitos autorais e o texto da licença (SIL OFL 1.1) têm de ir
  # junto: servidos pelo painel e guardados na imagem, um por família,
  # idênticos aos OFL.txt do repositório.
  FRONT="http://127.0.0.1:$FRONTEND_PORT"
  REPO_FONTS="$TESTS_DIR/../../apps/frontend/app/fonts"
  sha() { sha256sum | cut -d' ' -f1; }
  check "o índice das licenças das fontes é servido e identifica as duas famílias" sh -c \
    "curl -s --max-time 5 '$FRONT/licencas/fontes.txt' > '$WORK/fontes.txt' && grep -q '^Fraunces (títulos)' '$WORK/fontes.txt' && grep -q '^Inter (texto)' '$WORK/fontes.txt' && grep -q '/licencas/fraunces-OFL.txt' '$WORK/fontes.txt' && grep -q '/licencas/inter-OFL.txt' '$WORK/fontes.txt'"
  for family in fraunces inter; do
    REPO_SHA="$(sha < "$REPO_FONTS/$family/OFL.txt")"
    equal "licença da $family servida pelo painel é o OFL.txt do repositório" "$REPO_SHA" "$(body "$FRONT/licencas/$family-OFL.txt" | sha)"
    equal "licença da $family guardada na imagem é o OFL.txt do repositório" "$REPO_SHA" \
      "$(docker run --rm --entrypoint cat "luxora-frontend:$FRONTEND" "/app/licenses/fonts/$family/OFL.txt" 2>/dev/null | sha)"
  done
  FONT_PATH="$(body "$FRONT/login" | grep -o '/_next/static/media/[^"]*\.woff2' | head -n 1)"
  check "o arquivo de fonte servido aponta para a licença (cabeçalho Link)" sh -c \
    "test -n '$FONT_PATH' && curl -s -D - -o /dev/null --max-time 5 '$FRONT$FONT_PATH' | grep -qi '^link: </licencas/fontes.txt>; rel=\"license\"'"
fi

echo
echo "ensaio: $PASS verificações passaram, $FAIL falharam"
if [ "$FAIL" -ne 0 ]; then
  for file in deploy-1 deploy-bad deploy-2 rollback restore deploy-front; do
    [ -f "$WORK/$file.log" ] && { echo "--- $file.log"; tail -n 12 "$WORK/$file.log" | sed 's/^/    | /'; }
  done
  exit 1
fi
