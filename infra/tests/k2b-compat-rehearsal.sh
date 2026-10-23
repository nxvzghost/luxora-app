#!/usr/bin/env bash
# Luxora — ensaio da K2-b com a versão anterior de verdade (ADR-0069, seções 2.4, 2.9, 3.7 e 9.4).
#
#   infra/tests/k2b-compat-rehearsal.sh --new <tag> --previous <tag>
#
# <previous> é a última versão anterior à K2-b (fb93885: tem o K2-a,
# billing-eligibility-v1, mas não conhece o desfecho da consulta), construída
# do próprio commit, num clone limpo, com infra/scripts/build-images.sh; <new>
# é a versão com a K2-b. Sobe uma homologação DESCARTÁVEL, como o
# rehearsal.sh, e prova com a imagem antiga de verdade:
#   1. a anterior no ar cria sessões pela confirmação e cobra uma delas
#      (vínculo com paciente, gravado depois do K2-a);
#   2. o primeiro deploy com a K2-b falha depois das migrations: o rollback
#      automático volta para a anterior, em modo degradado e registrado; as
#      migrations não reescrevem as tabelas nem mudam cobranças, vínculos e
#      pagamentos (impressão digital financeira e arquivos das tabelas
#      iguais); toda sessão existente fica não elegível, sem desfecho inventado;
#      a anterior não cobra mais nenhuma sessão sem desfecho, sem deixar
#      cobrança órfã, e ainda quita a cobrança existente;
#   3. deploy da nova: recusa a sessão legada, registra a realização
#      reaproveitando a sessão legada, falta, remarcação com histórico;
#   4. rollback para a anterior: recusado; com --allow-degraded e
#      justificativa, volta e fica registrado como degradado;
#   5. a anterior, contra o banco migrado, não altera consulta com desfecho
#      (confirmar, cancelar, remarcar no lugar), confirma a consulta sem
#      desfecho criando sessão não elegível, não a cobra, cobra só sessão
#      elegível e quita cobrança existente;
#   6. deploy da nova de novo, saindo do modo degradado;
#   7. desastre: o backup anterior à K2-b restaurado num banco vazio —
#      rollback recusado com a aplicação parada; o deploy.sh reaplica as
#      migrations e as proteções voltam.
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
[ -n "$NEW" ] && [ -n "$PREVIOUS" ] || { echo "uso: k2b-compat-rehearsal.sh --new <tag> --previous <tag>" >&2; exit 2; }

PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ok      $1"; }
ko() { FAIL=$((FAIL + 1)); echo "  FALHOU  $1"; }
equal() { if [ "$2" = "$3" ]; then ok "$1"; else ko "$1 (esperado: $2 · obtido: $3)"; fi; }
refused() { if [ "$2" != "201" ] && [ "$2" != "200" ]; then ok "$1 (HTTP $2)"; else ko "$1 (HTTP $2)"; fi; }
section() { echo; echo "== $1"; }

IMAGE="luxora-backend"
WORK="$(mktemp -d)"
ENV_FILE="$WORK/staging.env"
export LUXORA_PROJECT="luxora-k2bcompat-$$"
export LUXORA_STATE_DIR="$WORK/state"
export DEPLOY_ACTOR="ensaio-k2b"
BACKEND_PORT="${REHEARSAL_BACKEND_PORT:-13200}"
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
# Campo do corpo da última resposta; aceita caminho com ponto (session.id).
field() {
  python3 -I -c '
import json, sys
value = json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."):
    value = value.get(key, "") if isinstance(value, dict) else ""
print("" if value is None else value)' "$WORK/resp.json" "$1" 2>/dev/null
}
error_code() { field error.code; }

ADMIN_EMAIL="admin-k2b@ensaio.invalid"
ADMIN_PASSWORD="senha-do-ensaio-k2b-2026"
login() {
  TOKEN=""
  [ "$(api POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")" = "200" ] && TOKEN="$(field accessToken)"
}

# Horários: cada consulta num dia diferente, às 10:00 UTC (07:00 em São Paulo).
# O horário fica em SLOT_AT, fora de subshell, para o contador valer.
DAY=0; SLOT_AT=""
past_slot() { DAY=$((DAY + 1)); SLOT_AT="$(date -u -d "-$DAY days" +%Y-%m-%dT10:00:00.000Z)"; }
future_slot() { DAY=$((DAY + 1)); SLOT_AT="$(date -u -d "+$DAY days" +%Y-%m-%dT12:00:00.000Z)"; }

APPOINTMENT=""
book() { # paciente horário
  APPOINTMENT=""
  [ "$(api POST /appointments "{\"patientId\":\"$1\",\"therapistId\":\"$THERAPIST\",\"scheduledAt\":\"$2\",\"modality\":\"presencial\"}")" = "201" ] \
    || { echo "    | consulta recusada: $(cat "$WORK/resp.json")"; return 1; }
  APPOINTMENT="$(field id)"
}
session_of() { sql "select id from session where appointment_id = '$1'"; }

DUE_DATE="$(date -u -d '+30 days' +%Y-%m-%d)"
create_billing() { # paciente sessão...
  local patient="$1" ids
  shift
  ids="$(printf '"%s",' "$@")"
  api POST /billings "{\"patientId\":\"$patient\",\"amount\":400,\"dueDate\":\"$DUE_DATE\",\"sessionIds\":[${ids%,}]}"
}
pay() { IDEMPOTENCY="ensaio-k2b-$1" api POST /payments "{\"billingId\":\"$1\",\"amount\":400}"; }

billings() { sql "select count(*) from billing"; }
links() { sql "select count(*) from billing_session"; }
# Cobranças, vínculos e pagamentos, pelas colunas originais (ADR-0069, seção 6.6).
fingerprint() {
  sql "select count(*) || ':' || md5(coalesce(string_agg(x, '|' order by x), '')) from (
         select 'b:' || id || ':' || status || ':' || amount || ':' || due_date as x from billing
         union all select 'l:' || id || ':' || billing_id || ':' || session_id from billing_session
         union all select 'p:' || id || ':' || billing_id || ':' || status || ':' || amount from payment) t"
}
filenodes() { sql "select pg_relation_filenode('session') || ',' || pg_relation_filenode('billing_session') || ',' || pg_relation_filenode('billing') || ',' || pg_relation_filenode('appointment')"; }
invariants() { # o que nunca pode existir, venha de que versão vier
  equal "$1: nenhuma cobrança nova sem vínculo" "0" "$(sql "select count(*) from billing b where not b.legacy_billing and not exists (select 1 from billing_session s where s.billing_id = b.id)")"
  equal "$1: nenhum vínculo novo com sessão não elegível" "0" \
    "$(sql "select count(*) from billing_session bs join session s on s.id = bs.session_id where not bs.legacy_eligibility_link and s.billing_eligibility <> 'elegivel'")"
  equal "$1: nenhum vínculo entre cobrança e sessão de pacientes diferentes" "0" \
    "$(sql "select count(*) from billing_session s join billing b on b.id = s.billing_id join session se on se.id = s.session_id where b.patient_id <> se.patient_id or b.tenant_id <> se.tenant_id")"
  equal "$1: nenhuma sessão elegível sem kind ou anulada" "0" "$(sql "select count(*) from session where billing_eligibility = 'elegivel' and (kind is null or voided_at is not null)")"
  equal "$1: nenhuma consulta com desfecho fora do retrato" "0" \
    "$(sql "select count(*) from appointment_outcome o join appointment a on a.id = o.appointment_id where a.state <> o.state_at_outcome or a.scheduled_at <> o.scheduled_at_at_outcome or a.modality <> o.modality_at_outcome")"
  equal "$1: nenhum pagamento confirmado com a cobrança em aberto" "0" \
    "$(sql "select count(*) from payment p join billing b on b.id = p.billing_id where p.status = 'confirmado' and b.status <> 'quitada'")"
}

# ---------------------------------------------------------------- preparação
section "preparação"
for image in "$IMAGE:$NEW" "$IMAGE-migrate:$NEW" "$IMAGE:$PREVIOUS" "$IMAGE-migrate:$PREVIOUS"; do
  docker image inspect "$image" >/dev/null 2>&1 || { echo "imagem ausente: $image — construa antes (ver o cabeçalho)"; exit 2; }
done
equal "a versão nova declara as duas capacidades" "billing-eligibility-v1,appointment-outcome-v1" "$(label "$IMAGE:$NEW")"
equal "a anterior declara só billing-eligibility-v1" "billing-eligibility-v1" "$(label "$IMAGE:$PREVIOUS")"
printf 'FROM %s\nENV APP_VERSION=%s\nCMD ["node","-e","console.error(\\"versao quebrada de proposito\\");process.exit(1)"]\n' "$IMAGE:$NEW" "$NEW_BAD" \
  | docker build -q -t "$IMAGE:$NEW_BAD" - >/dev/null
docker tag "$IMAGE-migrate:$NEW" "$IMAGE-migrate:$NEW_BAD"
bash "$SCRIPTS/generate-env.sh" "$ENV_FILE" staging >/dev/null || { echo "não foi possível gerar o arquivo de ambiente"; exit 2; }
sed -i -e "s/^BACKEND_PORT=.*/BACKEND_PORT=$BACKEND_PORT/" -e "s/^FRONTEND_PORT=.*/FRONTEND_PORT=$((BACKEND_PORT + 1))/" "$ENV_FILE"

# ---------------------------------------- 1. a anterior no ar, antes da K2-b
section "1. versão anterior ($PREVIOUS) no ar, antes da K2-b"
bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$PREVIOUS" --notes "ensaio K2-b: versão anterior" > "$WORK/deploy-previous.log" 2>&1
equal "deploy da anterior (0)" "0|$PREVIOUS" "$?|$(version)"
equal "o banco exige só billing-eligibility-v1" "billing-eligibility-v1" "$(sql "select string_agg(capability, ',' order by capability) from deployment_requirement")"

PROVISION="$(compose exec -T backend node dist/cli/provisionar-clinica-piloto.js --nome "Clínica do ensaio K2-b" 2>&1)"
TENANT_ID="$(printf '%s\n' "$PROVISION" | sed -n 's/.*id da clínica: \([0-9a-f-]*\).*/\1/p')"
equal "clínica provisionada pela CLI da anterior" "1" "$(sql "select count(*) from tenant where id = '$TENANT_ID'")"
equal "administrador criado (bootstrap-admin)" "201" "$(api POST /users/bootstrap-admin "{\"tenantId\":\"$TENANT_ID\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")"
login
equal "login na anterior" "yes" "$([ -n "$TOKEN" ] && echo yes)"
api POST /therapists '{"name":"Terapeuta do ensaio K2-b"}' >/dev/null; THERAPIST="$(field id)"
WINDOWS="$(for d in 0 1 2 3 4 5 6; do printf '{"dayOfWeek":%s,"startTime":"00:00","endTime":"23:59","sessionDurationMinutes":60},' "$d"; done)"
equal "agenda do terapeuta" "200" "$(api PUT "/therapists/$THERAPIST/availability" "{\"windows\":[${WINDOWS%,}]}")"
api POST /patients '{"name":"Paciente Um do ensaio K2-b","phone":"11999990011"}' >/dev/null; P1="$(field id)"
api POST /patients '{"name":"Paciente Dois do ensaio K2-b","phone":"11999990012"}' >/dev/null; P2="$(field id)"

past_slot; book "$P1" "$SLOT_AT"; A_L1="$APPOINTMENT"
equal "a anterior confirma (consulta que já passou)" "201" "$(api POST "/appointments/$A_L1/confirm")"
S_L1="$(session_of "$A_L1")"
equal "e a confirmação cria a sessão, a faturar (o defeito que a K2-b corrige)" "Realizada" "$(sql "select state from session where id = '$S_L1'")"
past_slot; book "$P1" "$SLOT_AT"; A_L2="$APPOINTMENT"
api POST "/appointments/$A_L2/confirm" >/dev/null; S_L2="$(session_of "$A_L2")"
equal "a anterior cobra a sessão (vínculo com paciente, depois do K2-a)" "201" "$(create_billing "$P1" "$S_L2")"
B_PREV="$(field id)"
future_slot; book "$P1" "$SLOT_AT"; A_F="$APPOINTMENT"
future_slot; book "$P2" "$SLOT_AT"; A_F2="$APPOINTMENT"
FP_BEFORE="$(fingerprint)"
FN_BEFORE="$(filenodes)"

# ------------- 2. primeiro deploy com a K2-b falha depois das migrations
section "2. primeiro deploy com a K2-b ($NEW_BAD) falha depois das migrations"
READY_TIMEOUT_SECONDS=90 bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$NEW_BAD" > "$WORK/deploy-new-bad.log" 2>&1
equal "rollback automático para a anterior (1)" "1" "$?"
PRE_K2B_BACKUP="$(cat "$LUXORA_STATE_DIR/last-backup")"
equal "a anterior está de volta no ar" "$PREVIOUS" "$(version)"
equal "histórico: retorno automático em modo degradado, no deploy que introduz a exigência" "rolled-back|degraded" "$(last_history result)|$(last_history mode)"
equal "o banco exige as duas capacidades (as migrations rodaram)" "appointment-outcome-v1,billing-eligibility-v1" "$(sql "select string_agg(capability, ',' order by capability) from deployment_requirement")"
equal "o ambiente registra a exigência mesmo com o deploy falho" "appointment-outcome-v1 billing-eligibility-v1" "$(cat "$LUXORA_STATE_DIR/requirement-active" 2>/dev/null)"
equal "as migrations não mudaram cobranças, vínculos e pagamentos (impressão digital)" "$FP_BEFORE" "$(fingerprint)"
equal "ADD COLUMN com padrão constante não reescreveu as tabelas (arquivos iguais)" "$FN_BEFORE" "$(filenodes)"
equal "toda sessão existente ficou não elegível e sem kind (nenhum desfecho inventado)" "0" "$(sql "select count(*) from session where billing_eligibility <> 'nao_elegivel' or kind is not null")"
equal "nenhum desfecho criado pela migration" "0" "$(sql "select count(*) from appointment_outcome")"
equal "o vínculo gravado depois do K2-a ficou anterior à K2-b, sem elegibilidade exigida" "t||f" \
  "$(sql "select legacy_eligibility_link, coalesce(required_eligibility::text, ''), legacy_link from billing_session where billing_id = '$B_PREV'")"
login
past_slot; book "$P1" "$SLOT_AT"; A_D="$APPOINTMENT"
equal "a anterior, de volta, ainda confirma" "201" "$(api POST "/appointments/$A_D/confirm")"
S_D="$(session_of "$A_D")"
equal "a sessão que ela cria nasce não elegível" "nao_elegivel" "$(sql "select billing_eligibility from session where id = '$S_D'")"
BEFORE="$(billings)|$(links)"
refused "a anterior não cobra a sessão que acabou de criar" "$(create_billing "$P1" "$S_D")"
refused "nem a sessão legada de antes da K2-b" "$(create_billing "$P1" "$S_L1")"
equal "nenhuma cobrança e nenhum vínculo gravados" "$BEFORE" "$(billings)|$(links)"
equal "a anterior quita a cobrança existente" "201" "$(pay "$B_PREV")"
equal "cobrança quitada, pagamento confirmado" "quitada|confirmado" "$(sql "select b.status, p.status from billing b join payment p on p.billing_id = b.id where b.id = '$B_PREV'")"
invariants "anterior em modo degradado"

# ------------------------------------------------ 3. deploy da versão nova
section "3. deploy da versão nova ($NEW)"
bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$NEW" --notes "ensaio K2-b: versão nova" > "$WORK/deploy-new.log" 2>&1
equal "deploy da nova (0)" "0|success|normal" "$?|$(last_history result)|$(last_history mode)"
equal "a nova está no ar" "$NEW" "$(version)"
login
equal "a nova recusa cobrar a sessão legada" "409|SESSION_NOT_BILLABLE" "$(create_billing "$P1" "$S_L1")|$(error_code)"
equal "a nova registra a realização da consulta legada" "201" "$(api POST "/appointments/$A_L1/attended")"
equal "e reaproveita a sessão legada como o item atendimento" "$S_L1|atendimento|elegivel" "$(field session.id)|$(sql "select kind || '|' || billing_eligibility from session where id = '$S_L1'")"
equal "a nova cobra a sessão realizada" "201" "$(create_billing "$P1" "$S_L1")"
B_N1="$(field id)"
past_slot; book "$P1" "$SLOT_AT"; A_NS="$APPOINTMENT"
equal "a nova registra a falta" "201" "$(api POST "/appointments/$A_NS/no-show")"
NS_BEFORE="$(sql "select state || '|' || scheduled_at from appointment where id = '$A_NS'")"
past_slot; book "$P1" "$SLOT_AT"; A_AT="$APPOINTMENT"
api POST "/appointments/$A_AT/attended" >/dev/null; S_AT="$(field session.id)"
equal "a nova cria o item atendimento elegível (ainda não cobrado)" "elegivel|Realizada" "$(sql "select billing_eligibility || '|' || state from session where id = '$S_AT'")"
future_slot; NEW_TIME="$SLOT_AT"
equal "a nova remarca: ocorrência nova ligada" "200" "$(api PATCH "/appointments/$A_F/reschedule" "{\"newScheduledAt\":\"$NEW_TIME\",\"requestedBy\":\"paciente\"}")"
A_F_NEW="$(field current.id)"
equal "a anterior fica Cancelada, com o horário original e o desfecho Remarcada" "Cancelada|Remarcada|paciente" \
  "$(sql "select a.state || '|' || o.outcome || '|' || n.requested_by from appointment a join appointment_outcome o on o.appointment_id = a.id join appointment_notice n on n.id = o.closing_notice_id where a.id = '$A_F'")"
equal "a nova aponta para a anterior" "$A_F" "$(sql "select rescheduled_from_id from appointment where id = '$A_F_NEW'")"
invariants "versão nova"

# ------------------------------------------------ 4. rollback para a anterior
section "4. rollback para a anterior ($PREVIOUS) contra o banco migrado"
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" > "$WORK/rollback-refused.log" 2>&1
equal "rollback recusado: a anterior não tem appointment-outcome-v1 (3)" "3|refused-capability" "$?|$(last_history result)"
equal "a nova continua no ar" "$NEW" "$(version)"
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" --allow-degraded > "$WORK/rollback-no-notes.log" 2>&1
equal "--allow-degraded sem justificativa: recusado (3)" "3" "$?"
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" --allow-degraded --notes "ensaio K2-b: retorno degradado para a anterior" > "$WORK/rollback-degraded.log" 2>&1
equal "com --allow-degraded e justificativa, volta (0)" "0|$PREVIOUS" "$?|$(version)"
equal "histórico: rollback degradado com a justificativa" "rollback|success|degraded|ensaio K2-b: retorno degradado para a anterior" \
  "$(last_history action)|$(last_history result)|$(last_history mode)|$(last_history notes)"

# ------------------------- 5. a anterior, em modo degradado, no banco migrado
section "5. a anterior ($PREVIOUS) no banco migrado, depois de a nova atender"
login
refused "a anterior não confirma a consulta com desfecho (falta)" "$(api POST "/appointments/$A_NS/confirm")"
refused "nem a cancela" "$(api POST "/appointments/$A_NS/cancel")"
future_slot
refused "nem a remarca no lugar" "$(api PATCH "/appointments/$A_NS/reschedule" "{\"newScheduledAt\":\"$SLOT_AT\"}")"
equal "a consulta com desfecho não mudou e não ganhou sessão" "$NS_BEFORE|0" "$(sql "select state || '|' || scheduled_at from appointment where id = '$A_NS'")|$(sql "select count(*) from session where appointment_id = '$A_NS'")"
compose logs --no-color backend > "$WORK/previous-backend.log" 2>&1
echo "  info    recusas do congelamento no log da anterior: $(grep -c 'appointment_frozen_after_outcome' "$WORK/previous-backend.log")"
equal "a anterior confirma consulta sem desfecho (compatível)" "201" "$(api POST "/appointments/$A_F2/confirm")"
S_F2="$(session_of "$A_F2")"
equal "e a sessão criada nasce não elegível" "nao_elegivel" "$(sql "select billing_eligibility from session where id = '$S_F2'")"
BEFORE="$(billings)|$(links)"
refused "a anterior não cobra essa sessão" "$(create_billing "$P2" "$S_F2")"
equal "nenhuma cobrança e nenhum vínculo gravados" "$BEFORE" "$(billings)|$(links)"
equal "a anterior só cobra sessão elegível (o item atendimento criado pela nova)" "201" "$(create_billing "$P1" "$S_AT")"
equal "o vínculo novo exige a elegibilidade" "elegivel|f" "$(sql "select required_eligibility, legacy_eligibility_link from billing_session where session_id = '$S_AT'")"
equal "a anterior quita uma cobrança criada pela nova" "201" "$(pay "$B_N1")"
equal "cobrança quitada, sessão recebida" "quitada|Recebida" "$(sql "select b.status || '|' || s.state from billing b join billing_session bs on bs.billing_id = b.id join session s on s.id = bs.session_id where b.id = '$B_N1'")"
invariants "anterior depois da nova"

# ------------------------------------------------------ 6. a nova de novo
section "6. deploy da nova ($NEW) de novo"
bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$NEW" --notes "ensaio K2-b: saída do modo degradado" > "$WORK/deploy-new-again.log" 2>&1
equal "deploy da nova (0)" "0|success|normal|$NEW" "$?|$(last_history result)|$(last_history mode)|$(version)"
login
equal "a nova não registra realização antes do início" "409|APPOINTMENT_NOT_STARTED" "$(api POST "/appointments/$A_F2/attended")|$(error_code)"
equal "a nova cancela a consulta que a anterior confirmou, com quem pediu" "201" "$(api POST "/appointments/$A_F2/cancel" '{"requestedBy":"clinica"}')"
equal "a sessão que a anterior criou continua não elegível" "nao_elegivel" "$(sql "select billing_eligibility from session where id = '$S_F2'")"
invariants "de volta à nova"

# ------------------------------------- 7. desastre: backup anterior à K2-b
section "7. backup anterior à K2-b restaurado num banco vazio"
bash "$SCRIPTS/restore-drill.sh" --env-file "$ENV_FILE" --backup "$PRE_K2B_BACKUP" > "$WORK/restore-drill.log" 2>&1
equal "o ensaio de restauração do backup anterior passa (0)" "0" "$?"
if grep -q 'backup-anterior-à-exigência:appointment-outcome-v1' "$WORK/restore-drill.log"; then ok "e avisa que o backup é anterior à exigência"; else ko "e avisa que o backup é anterior à exigência"; fi
compose stop backend >/dev/null 2>&1
psql_on postgres "drop database $DB with (force)" >/dev/null
psql_on postgres "create database $DB" >/dev/null
compose exec -T postgres pg_restore -U postgres -d "$DB" --exit-on-error < "$PRE_K2B_BACKUP"
equal "backup restaurado num banco vazio, com a aplicação parada" "0|" "$?|$(version)"
equal "o banco restaurado só exige billing-eligibility-v1" "billing-eligibility-v1" "$(sql "select string_agg(capability, ',' order by capability) from deployment_requirement")"
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" --to "$PREVIOUS" --allow-degraded --notes "ensaio K2-b: tentativa depois da restauração" > "$WORK/rollback-after-restore.log" 2>&1
equal "rollback para a anterior recusado: o banco perdeu a exigência (3)" "3|refused-protections" "$?|$(last_history result)"
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" --to "$NEW" > "$WORK/rollback-new-after-restore.log" 2>&1
equal "religar a nova sem migrations também é recusado (3)" "3|refused-protections" "$?|$(last_history result)"
equal "a aplicação continua parada" "" "$(version)"
bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$NEW" --notes "ensaio K2-b: depois da restauração" > "$WORK/deploy-after-restore.log" 2>&1
equal "deploy.sh reaplica as migrations e sobe a nova (0)" "0|$NEW" "$?|$(version)"
equal "o banco exige as duas capacidades de novo" "appointment-outcome-v1,billing-eligibility-v1" "$(sql "select string_agg(capability, ',' order by capability) from deployment_requirement")"
K2B_LIST="$(bash -c ". '$SCRIPTS/lib.sh' >/dev/null 2>&1; printf \"'%s',\" \$K2B_CONSTRAINTS")"
equal "as 23 restrições da K2-b validadas" "23" "$(sql "select count(*) from pg_constraint where conname in (${K2B_LIST%,}) and convalidated")"
equal "a política de congelamento de volta" "1" "$(sql "select count(*) from pg_policy where polname = 'appointment_frozen_after_outcome' and not polpermissive")"
equal "as sessões do backup são não elegíveis de novo" "0" "$(sql "select count(*) from session where billing_eligibility <> 'nao_elegivel'")"
equal "o que foi gravado depois do backup se perdeu (esperado numa restauração)" "0" "$(sql "select count(*) from appointment_outcome")"
login
past_slot; book "$P1" "$SLOT_AT"; A_R="$APPOINTMENT"
api POST "/appointments/$A_R/attended" >/dev/null; S_R="$(field session.id)"
equal "a nova registra a realização e cobra no banco restaurado" "201" "$(create_billing "$P1" "$S_R")"
invariants "depois da restauração"

echo
echo "ensaio K2-b: $PASS verificações passaram, $FAIL falharam"
if [ "$FAIL" -ne 0 ]; then
  for file in deploy-previous deploy-new-bad deploy-new rollback-degraded deploy-new-again restore-drill deploy-after-restore; do
    [ -f "$WORK/$file.log" ] && { echo "--- $file.log"; tail -n 12 "$WORK/$file.log" | sed 's/^/    | /'; }
  done
  exit 1
fi
