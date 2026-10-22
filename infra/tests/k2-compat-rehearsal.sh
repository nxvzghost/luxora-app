#!/usr/bin/env bash
# Luxora — ensaio do K2-a com a versão anterior de verdade (ADR-0069, seções 3.7 e 9.4).
#
#   infra/tests/k2-compat-rehearsal.sh --new <tag> --previous <tag>
#
# <previous> é a última versão anterior ao K2-a (fd0874f), construída do
# próprio commit, num clone limpo, com infra/scripts/build-images.sh; <new> é
# a versão com o K2-a. Sobe uma homologação DESCARTÁVEL, como o rehearsal.sh,
# e prova com a imagem antiga de verdade:
#   1. a anterior no ar grava cobrança e vínculo, que viram legados na migration;
#   2. o primeiro deploy com o K2-a falha depois das migrations: o rollback
#      automático volta para a anterior, em modo degradado e registrado;
#   3. deploy da nova: a nova grava o protocolo e quita uma legada;
#   4. rollback para a anterior: recusado; com --allow-degraded e justificativa,
#      volta e fica registrado como degradado;
#   5. a anterior, contra o banco migrado, não cria cobrança (nem com sessão de
#      outro paciente), não deixa cobrança órfã nem vínculo inválido, e ainda
#      quita uma cobrança existente, sem pagamento confirmado inconsistente;
#   6. deploy da nova de novo, saindo do modo degradado;
#   7. desastre: o backup anterior ao K2-a restaurado num banco vazio
#      (MIGRATION_RUNBOOK) — rollback recusado com a aplicação parada; o
#      deploy.sh reaplica as migrations e as proteções voltam.
#
# Não usa credencial externa, não chama Meta/Anthropic/Asaas e não gera custo.
# Não roda no CI: a imagem antiga tem de ser construída do commit anterior.

set -uo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$TESTS_DIR/../scripts"
NEW=""; PREVIOUS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --new) NEW="$2"; shift 2 ;;
    --previous) PREVIOUS="$2"; shift 2 ;;
    *) echo "argumento desconhecido: $1" >&2; exit 2 ;;
  esac
done
[ -n "$NEW" ] && [ -n "$PREVIOUS" ] || { echo "uso: k2-compat-rehearsal.sh --new <tag> --previous <tag>" >&2; exit 2; }

PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ok      $1"; }
ko() { FAIL=$((FAIL + 1)); echo "  FALHOU  $1"; }
equal() { if [ "$2" = "$3" ]; then ok "$1"; else ko "$1 (esperado: $2 · obtido: $3)"; fi; }
section() { echo; echo "== $1"; }

IMAGE="luxora-backend"
WORK="$(mktemp -d)"
ENV_FILE="$WORK/staging.env"
export LUXORA_PROJECT="luxora-k2compat-$$"
export LUXORA_STATE_DIR="$WORK/state"
export DEPLOY_ACTOR="ensaio-k2a"
BACKEND_PORT="${REHEARSAL_BACKEND_PORT:-13100}"
API="http://127.0.0.1:$BACKEND_PORT"
DB="luxora_staging"

compose() { docker compose -p "$LUXORA_PROJECT" --env-file "$ENV_FILE" -f "$TESTS_DIR/../staging/docker-compose.yml" "$@"; }
psql_on() { compose exec -T postgres psql -U postgres -d "$1" -v ON_ERROR_STOP=1 -tA -c "$2" 2>/dev/null; }
sql() { psql_on "$DB" "$1"; }
version() { curl -s --max-time 5 "$API/api/v1/health" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }
last_history() { tail -n 1 "$LUXORA_STATE_DIR/history.jsonl" 2>/dev/null | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }
label() {
  local value
  value="$(docker image inspect -f '{{ index .Config.Labels "luxora.capabilities" }}' "$1" 2>/dev/null)"
  [ "$value" != "<no value>" ] || value=""
  echo "$value"
}

NEW_BAD="$NEW-quebrada"
cleanup() {
  compose --profile observability --profile tools down -v --remove-orphans >/dev/null 2>&1
  docker image rm -f "$IMAGE:$NEW_BAD" "$IMAGE-migrate:$NEW_BAD" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

# Chamadas à API, como o painel faz. Código HTTP na saída; corpo em $WORK/resp.json.
TOKEN=""
api() { # método caminho [json]
  local args=(-s -o "$WORK/resp.json" -w '%{http_code}' --max-time 20 -X "$1" -H 'Content-Type: application/json')
  [ -z "$TOKEN" ] || args+=(-H "Authorization: Bearer $TOKEN")
  [ -z "${IDEMPOTENCY:-}" ] || args+=(-H "Idempotency-Key: $IDEMPOTENCY")
  [ -z "${3:-}" ] || args+=(-d "$3")
  curl "${args[@]}" "$API/api/v1$2" 2>/dev/null || true
}
field() { python3 -c 'import json, sys; v = json.load(open(sys.argv[1])); print(v.get(sys.argv[2], "") if isinstance(v, dict) else "")' "$WORK/resp.json" "$1" 2>/dev/null; }
error_code() { python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("error", {}).get("code", ""))' "$WORK/resp.json" 2>/dev/null; }

ADMIN_EMAIL="admin-k2a@ensaio.invalid"
ADMIN_PASSWORD="senha-do-ensaio-k2a-2026"
login() {
  TOKEN=""
  [ "$(api POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")" = "200" ] && TOKEN="$(field accessToken)"
}

# Uma sessão a faturar, em SESSION: consulta marcada e confirmada pela API da
# versão no ar, cada uma num horário. (Fora de subshell, para o contador valer.)
SLOT=0; SESSION=""
realized_session() { # paciente
  local when appointment
  SLOT=$((SLOT + 1)); SESSION=""
  when="$(date -u -d '+5 days' +%Y-%m-%d)T$(printf '%02d' $((11 + SLOT))):00:00.000Z"
  [ "$(api POST /appointments "{\"patientId\":\"$1\",\"therapistId\":\"$THERAPIST\",\"scheduledAt\":\"$when\",\"modality\":\"presencial\"}")" = "201" ] \
    || { echo "    | consulta recusada: $(cat "$WORK/resp.json")"; return 1; }
  appointment="$(field id)"
  [ "$(api POST "/appointments/$appointment/confirm")" = "201" ] || { echo "    | confirmação recusada: $(cat "$WORK/resp.json")"; return 1; }
  SESSION="$(sql "select id from session where appointment_id = '$appointment'")"
}

DUE_DATE="$(date -u -d '+30 days' +%Y-%m-%d)"
create_billing() { # paciente sessão...
  local patient="$1" ids
  shift
  ids="$(printf '"%s",' "$@")"
  api POST /billings "{\"patientId\":\"$patient\",\"amount\":400,\"dueDate\":\"$DUE_DATE\",\"sessionIds\":[${ids%,}]}"
}
pay() { IDEMPOTENCY="ensaio-k2a-$1" api POST /payments "{\"billingId\":\"$1\",\"amount\":400}"; }

billings() { sql "select count(*) from billing"; }
links() { sql "select count(*) from billing_session"; }
invariants() { # o que nunca pode existir, venha de que versão vier
  equal "$1: nenhuma cobrança nova sem vínculo" "0" "$(sql "select count(*) from billing b where not b.legacy_billing and not exists (select 1 from billing_session s where s.billing_id = b.id)")"
  equal "$1: nenhum vínculo novo sem paciente" "0" "$(sql "select count(*) from billing_session where not legacy_link and patient_id is null")"
  equal "$1: nenhum vínculo entre cobrança e sessão de pacientes diferentes" "0" \
    "$(sql "select count(*) from billing_session s join billing b on b.id = s.billing_id join session se on se.id = s.session_id where b.patient_id <> se.patient_id or b.tenant_id <> se.tenant_id")"
  equal "$1: nenhum pagamento confirmado com a cobrança em aberto" "0" \
    "$(sql "select count(*) from payment p join billing b on b.id = p.billing_id where p.status = 'confirmado' and b.status <> 'quitada'")"
}

# ---------------------------------------------------------------- preparação
section "preparação"
for image in "$IMAGE:$NEW" "$IMAGE-migrate:$NEW" "$IMAGE:$PREVIOUS" "$IMAGE-migrate:$PREVIOUS"; do
  docker image inspect "$image" >/dev/null 2>&1 || { echo "imagem ausente: $image — construa antes (ver o cabeçalho)"; exit 2; }
done
equal "a versão nova declara a capacidade billing-eligibility-v1" "billing-eligibility-v1" "$(label "$IMAGE:$NEW")"
equal "a anterior não declara capacidade nenhuma" "" "$(label "$IMAGE:$PREVIOUS")"
# A versão nova com as migrations de verdade e uma aplicação que não fica pronta.
printf 'FROM %s\nENV APP_VERSION=%s\nCMD ["node","-e","console.error(\\"versao quebrada de proposito\\");process.exit(1)"]\n' "$IMAGE:$NEW" "$NEW_BAD" \
  | docker build -q -t "$IMAGE:$NEW_BAD" - >/dev/null
docker tag "$IMAGE-migrate:$NEW" "$IMAGE-migrate:$NEW_BAD"
bash "$SCRIPTS/generate-env.sh" "$ENV_FILE" staging >/dev/null || { echo "não foi possível gerar o arquivo de ambiente"; exit 2; }
sed -i -e "s/^BACKEND_PORT=.*/BACKEND_PORT=$BACKEND_PORT/" -e "s/^FRONTEND_PORT=.*/FRONTEND_PORT=$((BACKEND_PORT + 1))/" "$ENV_FILE"

# ---------------------------------------- 1. a anterior no ar, antes do K2-a
section "1. versão anterior ($PREVIOUS) no ar, antes do K2-a"
bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$PREVIOUS" --notes "ensaio K2-a: versão anterior" > "$WORK/deploy-previous.log" 2>&1
equal "deploy da anterior num banco sem exigência (0)" "0" "$?"
equal "a anterior está no ar" "$PREVIOUS" "$(version)"
equal "o banco ainda não exige nada" "" "$(sql "select to_regclass('public.deployment_requirement')")"

PROVISION="$(compose exec -T backend node dist/cli/provisionar-clinica-piloto.js --nome "Clínica do ensaio K2-a" 2>&1)"
TENANT_ID="$(printf '%s\n' "$PROVISION" | sed -n 's/.*id da clínica: \([0-9a-f-]*\).*/\1/p')"
equal "clínica provisionada pela CLI da anterior" "1" "$(sql "select count(*) from tenant where id = '$TENANT_ID'")"
equal "administrador criado (bootstrap-admin)" "201" "$(api POST /users/bootstrap-admin "{\"tenantId\":\"$TENANT_ID\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")"
login
equal "login na anterior" "yes" "$([ -n "$TOKEN" ] && echo yes)"
api POST /therapists '{"name":"Terapeuta do ensaio"}' >/dev/null; THERAPIST="$(field id)"
WINDOWS="$(for d in 0 1 2 3 4 5 6; do printf '{"dayOfWeek":%s,"startTime":"00:00","endTime":"23:59","sessionDurationMinutes":60},' "$d"; done)"
equal "agenda do terapeuta" "200" "$(api PUT "/therapists/$THERAPIST/availability" "{\"windows\":[${WINDOWS%,}]}")"
api POST /patients '{"name":"Paciente Um do ensaio","phone":"11999990001"}' >/dev/null; P1="$(field id)"
api POST /patients '{"name":"Paciente Dois do ensaio","phone":"11999990002"}' >/dev/null; P2="$(field id)"

realized_session "$P1"; S1="$SESSION"
equal "a anterior cria a cobrança (antes do K2-a)" "201" "$(create_billing "$P1" "$S1")"
B1="$(field id)"
equal "e o vínculo dela" "1" "$(sql "select count(*) from billing_session where billing_id = '$B1'")"

# ------------- 2. primeiro deploy com o K2-a falha depois das migrations
section "2. primeiro deploy com o K2-a ($NEW_BAD) falha depois das migrations"
READY_TIMEOUT_SECONDS=90 bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$NEW_BAD" > "$WORK/deploy-new-bad.log" 2>&1
equal "rollback automático para a anterior (1)" "1" "$?"
PRE_K2_BACKUP="$(cat "$LUXORA_STATE_DIR/last-backup")"
equal "a anterior está de volta no ar" "$PREVIOUS" "$(version)"
equal "histórico: retorno automático em modo degradado, no deploy que introduz a exigência" "rolled-back|degraded" "$(last_history result)|$(last_history mode)"
equal "o banco já exige billing-eligibility-v1 (as migrations rodaram)" "billing-eligibility-v1" "$(sql "select string_agg(capability, ',') from deployment_requirement")"
equal "o ambiente registra a exigência mesmo com o deploy falho" "billing-eligibility-v1" "$(cat "$LUXORA_STATE_DIR/requirement-active" 2>/dev/null)"
equal "a cobrança anterior virou legada, sem protocolo" "t|" "$(sql "select legacy_billing, coalesce(eligibility_protocol, '') from billing where id = '$B1'")"
equal "o vínculo anterior virou legado, sem paciente" "t|" "$(sql "select legacy_link, coalesce(patient_id, '') from billing_session where billing_id = '$B1'")"
login
realized_session "$P1"; S_DEGRADED="$SESSION"
BEFORE="$(billings)|$(links)"
CODE="$(create_billing "$P1" "$S_DEGRADED")"
if [ "$CODE" != "201" ]; then ok "a anterior, de volta, não cria cobrança (HTTP $CODE)"; else ko "a anterior, de volta, não cria cobrança (HTTP 201)"; fi
equal "nenhuma cobrança e nenhum vínculo gravados" "$BEFORE" "$(billings)|$(links)"

# ------------------------------------------------ 3. deploy da versão nova
section "3. deploy da versão nova ($NEW)"
bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$NEW" --notes "ensaio K2-a: versão nova" > "$WORK/deploy-new.log" 2>&1
equal "deploy da nova (0)" "0|success|normal" "$?|$(last_history result)|$(last_history mode)"
equal "a nova está no ar" "$NEW" "$(version)"
login
equal "a nova fatura a sessão que a anterior não conseguiu" "201" "$(create_billing "$P1" "$S_DEGRADED")"
realized_session "$P1"; S2="$SESSION"
equal "a nova cria a cobrança" "201" "$(create_billing "$P1" "$S2")"
B2="$(field id)"
equal "com o protocolo, e o vínculo com o paciente" "billing-eligibility-v1|f|$P1|f" \
  "$(sql "select b.eligibility_protocol, b.legacy_billing, s.patient_id, s.legacy_link from billing b join billing_session s on s.billing_id = b.id where b.id = '$B2'")"
realized_session "$P2"; S_OTHER="$SESSION"
equal "a nova recusa sessão de outro paciente" "409|SESSION_OF_ANOTHER_PATIENT" "$(create_billing "$P1" "$S_OTHER")|$(error_code)"
equal "a nova quita a cobrança legada" "201" "$(pay "$B1")"
equal "cobrança legada quitada, pagamento confirmado" "quitada|confirmado" "$(sql "select b.status, p.status from billing b join payment p on p.billing_id = b.id where b.id = '$B1'")"
invariants "versão nova"

# ------------------------------------------------ 4. rollback para a anterior
section "4. rollback para a anterior ($PREVIOUS) contra o banco migrado"
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" > "$WORK/rollback-refused.log" 2>&1
equal "rollback recusado: a anterior não tem a capacidade (3)" "3|refused-capability" "$?|$(last_history result)"
equal "a nova continua no ar" "$NEW" "$(version)"
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" --allow-degraded > "$WORK/rollback-no-notes.log" 2>&1
equal "--allow-degraded sem justificativa: recusado (3)" "3" "$?"
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" --allow-degraded --notes "ensaio K2-a: retorno degradado para a anterior" > "$WORK/rollback-degraded.log" 2>&1
equal "com --allow-degraded e justificativa, volta (0)" "0" "$?"
equal "a anterior está no ar" "$PREVIOUS" "$(version)"
equal "histórico: rollback degradado com a justificativa" "rollback|success|degraded|ensaio K2-a: retorno degradado para a anterior" \
  "$(last_history action)|$(last_history result)|$(last_history mode)|$(last_history notes)"

# ------------------------- 5. a anterior, em modo degradado, no banco migrado
section "5. a anterior ($PREVIOUS) no banco migrado"
login
realized_session "$P1"; S3="$SESSION"
equal "a anterior ainda marca e confirma consultas (sessão a faturar)" "Realizada" "$(sql "select state from session where id = '$S3'")"
BEFORE="$(billings)|$(links)"
CODE="$(create_billing "$P1" "$S3")"
if [ "$CODE" != "201" ]; then ok "a anterior não cria cobrança (HTTP $CODE)"; else ko "a anterior não cria cobrança (HTTP 201)"; fi
equal "nenhuma cobrança e nenhum vínculo gravados" "$BEFORE" "$(billings)|$(links)"
equal "a sessão continua a faturar" "Realizada" "$(sql "select state from session where id = '$S3'")"
CODE="$(create_billing "$P1" "$S_OTHER")"
if [ "$CODE" != "201" ]; then ok "a anterior não cria cobrança com sessão de outro paciente (HTTP $CODE)"; else ko "a anterior não cria cobrança com sessão de outro paciente (HTTP 201)"; fi
equal "nenhuma cobrança e nenhum vínculo gravados" "$BEFORE" "$(billings)|$(links)"
compose logs --no-color backend > "$WORK/previous-backend.log" 2>&1
echo "  info    recusas da chave do protocolo no log da anterior: $(grep -c 'billing_eligibility_protocol_fkey' "$WORK/previous-backend.log")"
equal "a anterior quita uma cobrança criada pela nova" "201" "$(pay "$B2")"
equal "cobrança quitada, com o protocolo intacto, pagamento confirmado" "quitada|billing-eligibility-v1|confirmado" \
  "$(sql "select b.status, b.eligibility_protocol, p.status from billing b join payment p on p.billing_id = b.id where b.id = '$B2'")"
equal "a sessão da cobrança quitada foi recebida" "Recebida" "$(sql "select state from session where id = '$S2'")"
invariants "versão anterior"

# ------------------------------------------------------ 6. a nova de novo
section "6. deploy da nova ($NEW) de novo"
bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$NEW" --notes "ensaio K2-a: saída do modo degradado" > "$WORK/deploy-new-again.log" 2>&1
equal "deploy da nova (0)" "0|success|normal" "$?|$(last_history result)|$(last_history mode)"
equal "a nova está no ar" "$NEW" "$(version)"
login
equal "a sessão que a anterior não conseguiu faturar é faturada pela nova" "201" "$(create_billing "$P1" "$S3")"
invariants "de volta à nova"

# ------------------------------------- 7. desastre: backup anterior ao K2-a
section "7. backup anterior ao K2-a restaurado num banco vazio"
bash "$SCRIPTS/restore-drill.sh" --env-file "$ENV_FILE" --backup "$PRE_K2_BACKUP" > "$WORK/restore-drill.log" 2>&1
equal "o ensaio de restauração do backup anterior passa (0)" "0" "$?"
if grep -q 'backup-anterior-à-exigência:billing-eligibility-v1' "$WORK/restore-drill.log"; then ok "e avisa que o backup é anterior à exigência"; else ko "e avisa que o backup é anterior à exigência"; fi
compose stop backend >/dev/null 2>&1
psql_on postgres "drop database $DB with (force)" >/dev/null
psql_on postgres "create database $DB" >/dev/null
compose exec -T postgres pg_restore -U postgres -d "$DB" --exit-on-error < "$PRE_K2_BACKUP"
equal "backup restaurado num banco vazio, com a aplicação parada" "0|" "$?|$(version)"
equal "o banco restaurado não tem a exigência" "" "$(sql "select to_regclass('public.deployment_requirement')")"
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" --to "$PREVIOUS" --allow-degraded --notes "ensaio K2-a: tentativa depois da restauração" > "$WORK/rollback-after-restore.log" 2>&1
equal "rollback para a anterior recusado: o banco perdeu a exigência (3)" "3|refused-protections" "$?|$(last_history result)"
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" --to "$NEW" > "$WORK/rollback-new-after-restore.log" 2>&1
equal "religar a nova sem migrations também é recusado (3)" "3|refused-protections" "$?|$(last_history result)"
equal "a aplicação continua parada" "" "$(version)"
bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$NEW" --notes "ensaio K2-a: depois da restauração" > "$WORK/deploy-after-restore.log" 2>&1
equal "deploy.sh reaplica as migrations e sobe a nova (0)" "0|$NEW" "$?|$(version)"
equal "o banco exige billing-eligibility-v1 de novo" "billing-eligibility-v1" "$(sql "select string_agg(capability, ',') from deployment_requirement")"
equal "as cinco restrições do K2-a validadas" "5" "$(sql "select count(*) from pg_constraint where conname in ('billing_eligibility_protocol_fkey', 'billing_legacy_or_protocol_check', 'billing_session_billing_patient_fkey', 'billing_session_session_patient_fkey', 'billing_session_legacy_or_patient_check') and convalidated")"
equal "a cobrança do backup é legada de novo" "t|" "$(sql "select legacy_billing, coalesce(eligibility_protocol, '') from billing where id = '$B1'")"
equal "o que foi gravado depois do backup se perdeu (esperado numa restauração)" "0" "$(sql "select count(*) from billing where id = '$B2'")"
login
realized_session "$P1"; S4="$SESSION"
equal "a nova cria cobrança no banco restaurado" "201" "$(create_billing "$P1" "$S4")"
invariants "depois da restauração"

echo
echo "ensaio K2-a: $PASS verificações passaram, $FAIL falharam"
if [ "$FAIL" -ne 0 ]; then
  for file in deploy-previous deploy-new rollback-degraded deploy-new-again restore-drill deploy-after-restore; do
    [ -f "$WORK/$file.log" ] && { echo "--- $file.log"; tail -n 12 "$WORK/$file.log" | sed 's/^/    | /'; }
  done
  exit 1
fi
