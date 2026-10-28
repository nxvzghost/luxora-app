#!/usr/bin/env bash
# Luxora — ensaio do K11 com a versão anterior de verdade (ADR-0069, K11; decisões D1 a D8 de 23/10/2026).
#
#   infra/tests/k11-compat-rehearsal.sh --new <tag> --previous <tag>
#
# <previous> é a última versão anterior ao K11 (2b9147a: tem o K2-a e a K2-b,
# billing-eligibility-v1 e appointment-outcome-v1, e lê o autor do desfecho
# como obrigatório), construída do próprio commit, num clone limpo, com
# infra/scripts/build-images.sh; <new> é a versão com o K11. Sobe uma
# homologação DESCARTÁVEL, como o rehearsal.sh, e prova com a imagem antiga
# de verdade:
#   1. a anterior no ar marca e cancela consultas pelo painel (desfecho de pessoa);
#   2. o primeiro deploy com o K11 falha depois das migrations: o rollback
#      automático volta para a anterior, em modo degradado e registrado; as
#      migrations não reescrevem as tabelas nem mudam os desfechos e as
#      comunicações existentes (impressão digital e arquivos iguais); todo
#      desfecho existente fica com a autoria de pessoa; a anterior continua
#      cancelando e remarcando pelo painel, e o banco aceita o que ela grava;
#   3. deploy da nova; o pedido, a resposta e o desfecho da IA são gravados
#      com o papel da aplicação, como o K11 grava (o fluxo pelo WhatsApp, com
#      a IA, está provado na Suíte Crítica; aqui não há chamada à Anthropic),
#      e o banco recusa o desfecho da IA sem a confirmação; a nova lê e lista;
#   4. rollback para a anterior: recusado; com --allow-degraded e
#      justificativa, volta e fica registrado como degradado;
#   5. a anterior, contra o banco com desfecho da IA: o que ela não sabe ler
#      (o desfecho sem usuário) falha sem alterar nada; o resto funciona;
#   6. deploy da nova de novo, saindo do modo degradado;
#   7. desastre: o backup anterior ao K11 restaurado num banco vazio —
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
[ -n "$NEW" ] && [ -n "$PREVIOUS" ] || { echo "uso: k11-compat-rehearsal.sh --new <tag> --previous <tag>" >&2; exit 2; }

PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ok      $1"; }
ko() { FAIL=$((FAIL + 1)); echo "  FALHOU  $1"; }
equal() { if [ "$2" = "$3" ]; then ok "$1"; else ko "$1 (esperado: $2 · obtido: $3)"; fi; }
refused() { if [ "$2" != "201" ] && [ "$2" != "200" ]; then ok "$1 (HTTP $2)"; else ko "$1 (HTTP $2)"; fi; }
section() { echo; echo "== $1"; }

IMAGE="luxora-backend"
WORK="$(mktemp -d)"
ENV_FILE="$WORK/staging.env"
export LUXORA_PROJECT="luxora-k11compat-$$"
export LUXORA_STATE_DIR="$WORK/state"
export DEPLOY_ACTOR="ensaio-k11"
BACKEND_PORT="${REHEARSAL_BACKEND_PORT:-13300}"
API="http://127.0.0.1:$BACKEND_PORT"
DB="luxora_staging"
ALL_THREE="appointment-ai-confirmation-v1,appointment-outcome-v1,billing-eligibility-v1"

compose() { docker compose -p "$LUXORA_PROJECT" --env-file "$ENV_FILE" -f "$TESTS_DIR/../staging/docker-compose.yml" "$@"; }
psql_on() { compose exec -T postgres psql -U postgres -d "$1" -v ON_ERROR_STOP=1 -tA -c "$2" 2>/dev/null; }
sql() { psql_on "$DB" "$1"; }
# Como a aplicação grava: papel luxora_app, RLS pela clínica, privilégios dela. Saída e erros em $WORK/app-sql.out.
as_app() { # sql (lido da entrada padrão)
  compose exec -T -e PGPASSWORD="$APP_PASSWORD" postgres psql -h 127.0.0.1 -U luxora_app -d "$DB" -v ON_ERROR_STOP=1 -tA > "$WORK/app-sql.out" 2>&1
}
version() { curl -s --max-time 5 "$API/api/v1/health" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }
last_history() { tail -n 1 "$LUXORA_STATE_DIR/history.jsonl" 2>/dev/null | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }
label() {
  local value
  value="$(docker image inspect -f '{{ index .Config.Labels "luxora.capabilities" }}' "$1" 2>/dev/null)"
  [ "$value" != "<no value>" ] || value=""
  echo "$value"
}
uuid() { cat /proc/sys/kernel/random/uuid; }

NEW_BAD="$NEW-quebrada"
cleanup() {
  compose --profile observability --profile tools down -v --remove-orphans >/dev/null 2>&1
  docker image rm -f "$IMAGE:$NEW_BAD" "$IMAGE-migrate:$NEW_BAD" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

TOKEN=""
api() { # método caminho [json]
  local args=(-s -o "$WORK/resp.json" -w '%{http_code}' --max-time 20 -X "$1" -H 'Content-Type: application/json')
  [ -z "$TOKEN" ] || args+=(-H "Authorization: Bearer $TOKEN")
  [ -z "${3:-}" ] || args+=(-d "$3")
  curl "${args[@]}" "$API/api/v1$2" 2>/dev/null || true
}
field() {
  python3 -I -c '
import json, sys
value = json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."):
    value = value.get(key, "") if isinstance(value, dict) else ""
print("" if value is None else value)' "$WORK/resp.json" "$1" 2>/dev/null
}
# Estado de um pedido na lista de pendências da nova (vazio se não aparece).
request_status() {
  python3 -I -c '
import json, sys
data = json.load(open(sys.argv[1])).get("data", [])
print(",".join(item["status"] for item in data if item["appointment"]["id"] == sys.argv[2]))' "$WORK/resp.json" "$1" 2>/dev/null
}
ADMIN_EMAIL="admin-k11@ensaio.invalid"
ADMIN_PASSWORD="senha-do-ensaio-k11-2026"
login() {
  TOKEN=""
  [ "$(api POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")" = "200" ] && TOKEN="$(field accessToken)"
}

# Cada consulta num dia diferente, no futuro, às 12:00 UTC.
DAY=3; SLOT_AT=""
future_slot() { DAY=$((DAY + 1)); SLOT_AT="$(date -u -d "+$DAY days" +%Y-%m-%dT12:00:00.000Z)"; }
APPOINTMENT=""
book() { # paciente horário
  APPOINTMENT=""
  [ "$(api POST /appointments "{\"patientId\":\"$1\",\"therapistId\":\"$THERAPIST\",\"scheduledAt\":\"$2\",\"modality\":\"presencial\"}")" = "201" ] \
    || { echo "    | consulta recusada: $(cat "$WORK/resp.json")"; return 1; }
  APPOINTMENT="$(field id)"
}
day_of() { # horário → "from=...&to=..." do dia dele (cada consulta do ensaio tem o seu dia)
  local day="${1%%T*}"
  echo "from=${day}T00:00:00.000Z&to=$(date -u -d "$day +1 day" +%Y-%m-%dT00:00:00.000Z)"
}

# Desfechos e comunicações, pelas colunas que existiam antes do K11.
fingerprint() {
  sql "select count(*) || ':' || md5(coalesce(string_agg(x, '|' order by x), '')) from (
         select 'o:' || appointment_id || ':' || outcome || ':' || outcome_recorded_by_user_id || ':' || coalesce(closing_notice_id, '') as x from appointment_outcome
         union all select 'n:' || id || ':' || appointment_id || ':' || channel || ':' || intent || ':' || timing from appointment_notice) t"
}
filenodes() { sql "select pg_relation_filenode('appointment_outcome') || ',' || pg_relation_filenode('appointment_notice') || ',' || pg_relation_filenode('appointment') || ',' || pg_relation_filenode('conversation')"; }
invariants() { # o que nunca pode existir, venha de que versão vier
  equal "$1: nenhum desfecho da IA sem confirmação do mesmo pedido" "0" \
    "$(sql "select count(*) from appointment_outcome o where o.outcome_recorded_by_actor_type = 'ai_agent' and not exists (
              select 1 from appointment_notice c join appointment_notice r on r.id = c.confirms_notice_id
               where c.id = o.confirmation_notice_id and r.id = o.closing_notice_id and c.confirmation_answer = 'confirma'
                 and c.timing <> 'depois_do_inicio' and r.appointment_id = o.appointment_id and c.conversation_id = r.conversation_id)")"
  equal "$1: nenhum desfecho de pessoa sem o usuário" "0" "$(sql "select count(*) from appointment_outcome where outcome_recorded_by_actor_type = 'user' and outcome_recorded_by_user_id is null")"
  equal "$1: nenhum desfecho da IA que não seja cancelamento ou remarcação" "0" \
    "$(sql "select count(*) from appointment_outcome where outcome_recorded_by_actor_type = 'ai_agent' and outcome not in ('Cancelada', 'Remarcada')")"
  equal "$1: nenhuma consulta com desfecho fora do retrato" "0" \
    "$(sql "select count(*) from appointment_outcome o join appointment a on a.id = o.appointment_id where a.state <> o.state_at_outcome or a.scheduled_at <> o.scheduled_at_at_outcome or a.modality <> o.modality_at_outcome")"
}

# ---------------------------------------------------------------- preparação
section "preparação"
for image in "$IMAGE:$NEW" "$IMAGE-migrate:$NEW" "$IMAGE:$PREVIOUS" "$IMAGE-migrate:$PREVIOUS"; do
  docker image inspect "$image" >/dev/null 2>&1 || { echo "imagem ausente: $image — construa antes (ver o cabeçalho)"; exit 2; }
done
equal "a versão nova declara as três capacidades" "billing-eligibility-v1,appointment-outcome-v1,appointment-ai-confirmation-v1" "$(label "$IMAGE:$NEW")"
equal "a anterior declara só as duas do K2" "billing-eligibility-v1,appointment-outcome-v1" "$(label "$IMAGE:$PREVIOUS")"
printf 'FROM %s\nENV APP_VERSION=%s\nCMD ["node","-e","console.error(\\"versao quebrada de proposito\\");process.exit(1)"]\n' "$IMAGE:$NEW" "$NEW_BAD" \
  | docker build -q -t "$IMAGE:$NEW_BAD" - >/dev/null
docker tag "$IMAGE-migrate:$NEW" "$IMAGE-migrate:$NEW_BAD"
bash "$SCRIPTS/generate-env.sh" "$ENV_FILE" staging >/dev/null || { echo "não foi possível gerar o arquivo de ambiente"; exit 2; }
sed -i -e "s/^BACKEND_PORT=.*/BACKEND_PORT=$BACKEND_PORT/" -e "s/^FRONTEND_PORT=.*/FRONTEND_PORT=$((BACKEND_PORT + 1))/" "$ENV_FILE"
APP_PASSWORD="$(sed -n 's/^POSTGRES_APP_PASSWORD=//p' "$ENV_FILE")"

# ------------------------------------------ 1. a anterior no ar, antes do K11
section "1. versão anterior ($PREVIOUS) no ar, antes do K11"
bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$PREVIOUS" --notes "ensaio K11: versão anterior" > "$WORK/deploy-previous.log" 2>&1
equal "deploy da anterior (0)" "0|$PREVIOUS" "$?|$(version)"
equal "o banco exige as duas capacidades do K2" "appointment-outcome-v1,billing-eligibility-v1" "$(sql "select string_agg(capability, ',' order by capability) from deployment_requirement")"
PROVISION="$(compose exec -T backend node dist/cli/provisionar-clinica-piloto.js --nome "Clínica do ensaio K11" 2>&1)"
TENANT_ID="$(printf '%s\n' "$PROVISION" | sed -n 's/.*id da clínica: \([0-9a-f-]*\).*/\1/p')"
equal "clínica provisionada pela CLI da anterior" "1" "$(sql "select count(*) from tenant where id = '$TENANT_ID'")"
equal "administrador criado (bootstrap-admin)" "201" "$(api POST /users/bootstrap-admin "{\"tenantId\":\"$TENANT_ID\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")"
login
equal "login na anterior" "yes" "$([ -n "$TOKEN" ] && echo yes)"
api POST /therapists '{"name":"Terapeuta do ensaio K11"}' >/dev/null; THERAPIST="$(field id)"
WINDOWS="$(for d in 0 1 2 3 4 5 6; do printf '{"dayOfWeek":%s,"startTime":"00:00","endTime":"23:59","sessionDurationMinutes":60},' "$d"; done)"
equal "agenda do terapeuta" "200" "$(api PUT "/therapists/$THERAPIST/availability" "{\"windows\":[${WINDOWS%,}]}")"
api POST /patients '{"name":"Paciente Um do ensaio K11","phone":"11999990021"}' >/dev/null; P1="$(field id)"
api POST /patients '{"name":"Paciente Dois do ensaio K11","phone":"11999990022"}' >/dev/null; P2="$(field id)"

future_slot; book "$P1" "$SLOT_AT"; A_AI="$APPOINTMENT"; A_AI_AT="$SLOT_AT"   # será cancelada pela IA, com confirmação
future_slot; book "$P2" "$SLOT_AT"; A_WAIT="$APPOINTMENT"                     # terá um pedido aguardando
future_slot; book "$P1" "$SLOT_AT"; A_OLD="$APPOINTMENT"; A_OLD_AT="$SLOT_AT" # cancelada pelo painel, antes do K11
future_slot; book "$P2" "$SLOT_AT"; A_FREE="$APPOINTMENT"
equal "a anterior cancela pelo painel, com quem pediu" "201" "$(api POST "/appointments/$A_OLD/cancel" '{"requestedBy":"paciente"}')"
equal "desfecho Cancelada, de pessoa" "Cancelada|true" "$(sql "select outcome || '|' || (outcome_recorded_by_user_id is not null) from appointment_outcome where appointment_id = '$A_OLD'")"
FP_BEFORE="$(fingerprint)"
FN_BEFORE="$(filenodes)"

# ---------------- 2. primeiro deploy com o K11 falha depois das migrations
section "2. primeiro deploy com o K11 ($NEW_BAD) falha depois das migrations"
READY_TIMEOUT_SECONDS=90 bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$NEW_BAD" > "$WORK/deploy-new-bad.log" 2>&1
equal "rollback automático para a anterior (1)" "1" "$?"
PRE_K11_BACKUP="$(cat "$LUXORA_STATE_DIR/last-backup")"
equal "a anterior está de volta no ar" "$PREVIOUS" "$(version)"
equal "histórico: retorno automático em modo degradado, no deploy que introduz a exigência" "rolled-back|degraded" "$(last_history result)|$(last_history mode)"
equal "o banco exige as três capacidades (as migrations rodaram)" "$ALL_THREE" "$(sql "select string_agg(capability, ',' order by capability) from deployment_requirement")"
equal "o ambiente registra a exigência mesmo com o deploy falho" "${ALL_THREE//,/ }" "$(cat "$LUXORA_STATE_DIR/requirement-active" 2>/dev/null)"
equal "as migrations não mudaram desfechos e comunicações (impressão digital)" "$FP_BEFORE" "$(fingerprint)"
equal "ADD COLUMN com padrão constante não reescreveu as tabelas (arquivos iguais)" "$FN_BEFORE" "$(filenodes)"
equal "todo desfecho existente ficou com a autoria de pessoa" "0" "$(sql "select count(*) from appointment_outcome where outcome_recorded_by_actor_type <> 'user'")"
K11_LIST="$(bash -c ". '$SCRIPTS/lib.sh' >/dev/null 2>&1; printf \"'%s',\" \$K11_CONSTRAINTS")"
equal "as 7 restrições do K11 validadas sobre os dados existentes" "7" "$(sql "select count(*) from pg_constraint where conname in (${K11_LIST%,}) and convalidated")"
login
future_slot; book "$P1" "$SLOT_AT"; A_D="$APPOINTMENT"
equal "a anterior, de volta, ainda cancela pelo painel" "201" "$(api POST "/appointments/$A_D/cancel" '{"requestedBy":"clinica"}')"
equal "e o banco aceita o desfecho que ela grava (autoria de pessoa, pelo padrão da coluna)" "user|true" \
  "$(sql "select outcome_recorded_by_actor_type || '|' || (outcome_recorded_by_user_id is not null) from appointment_outcome where appointment_id = '$A_D'")"
future_slot; book "$P2" "$SLOT_AT"; A_R="$APPOINTMENT"; future_slot
equal "a anterior ainda remarca pelo painel" "200" "$(api PATCH "/appointments/$A_R/reschedule" "{\"newScheduledAt\":\"$SLOT_AT\",\"requestedBy\":\"paciente\"}")"
equal "desfecho Remarcada, de pessoa" "Remarcada|user" "$(sql "select outcome || '|' || outcome_recorded_by_actor_type from appointment_outcome where appointment_id = '$A_R'")"
invariants "anterior em modo degradado"

# ------------------------------------------------ 3. deploy da versão nova
section "3. deploy da versão nova ($NEW) e um cancelamento confirmado pelo WhatsApp"
bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$NEW" --notes "ensaio K11: versão nova" > "$WORK/deploy-new.log" 2>&1
equal "deploy da nova (0)" "0|success|normal" "$?|$(last_history result)|$(last_history mode)"
equal "a nova está no ar" "$NEW" "$(version)"
CONV="$(uuid)"; CONV2="$(uuid)"; REQ="$(uuid)"; REP="$(uuid)"; REQ_WAIT="$(uuid)"
# O pedido (etapa 1) e, em outra mensagem, a confirmação com a execução (etapa 2) — como o K11 grava.
as_app <<SQL
begin;
select set_config('app.tenant_id', '$TENANT_ID', true);
insert into conversation (id, tenant_id, phone_number, patient_id) values ('$CONV', '$TENANT_ID', '5511999990021', '$P1'), ('$CONV2', '$TENANT_ID', '5511999990022', '$P2');
insert into appointment_notice (id, tenant_id, appointment_id, patient_id, channel, message_id, received_at, recorded_at, reference_time, reference_source,
  timing, minutes_from_start, intent, intent_source, requested_by, recorded_by_actor_type, review_status,
  conversation_id, awaits_confirmation, requested_action, asked_scheduled_at, asked_modality)
select n.id, a.tenant_id, a.id, a.patient_id, 'whatsapp', 'wamid.ensaio-k11-' || n.id, n.at, n.at, n.at, 'recebimento_webhook',
  'sem_limite_configurado', ceil(extract(epoch from (a.scheduled_at - n.at)) / 60), 'pedido_cancelamento', 'ia', 'paciente', 'ai_agent', 'sem_revisao_necessaria',
  n.conversation, true, 'cancelar', a.scheduled_at, a.modality
from (values ('$REQ', '$A_AI', '$CONV', (now() at time zone 'utc') - interval '10 minutes'),
             ('$REQ_WAIT', '$A_WAIT', '$CONV2', (now() at time zone 'utc') - interval '9 minutes')) as n(id, appointment, conversation, at)
join appointment a on a.id = n.appointment;
commit;
begin;
select set_config('app.tenant_id', '$TENANT_ID', true);
insert into appointment_notice (id, tenant_id, appointment_id, patient_id, channel, message_id, received_at, recorded_at, reference_time, reference_source,
  timing, minutes_from_start, intent, intent_source, requested_by, recorded_by_actor_type, review_status,
  conversation_id, awaits_confirmation, confirms_notice_id, confirmation_answer)
select '$REP', a.tenant_id, a.id, a.patient_id, 'whatsapp', 'wamid.ensaio-k11-sim', n.at, n.at, n.at, 'recebimento_webhook',
  'sem_limite_configurado', ceil(extract(epoch from (a.scheduled_at - n.at)) / 60), 'pedido_cancelamento', 'ia', 'paciente', 'ai_agent', 'sem_revisao_necessaria',
  '$CONV', false, '$REQ', 'confirma'
from appointment a, (select (now() at time zone 'utc') - interval '5 minutes' as at) n where a.id = '$A_AI';
update appointment set state = 'Cancelada', updated_at = now() where id = '$A_AI';
insert into appointment_outcome (appointment_id, tenant_id, outcome, outcome_recorded_at, outcome_recorded_by_user_id, outcome_recorded_by_actor_type,
  state_at_outcome, scheduled_at_at_outcome, modality_at_outcome, closing_notice_id, closing_notice_timing,
  closing_requested_action, confirmation_notice_id, confirmation_answer, confirmation_notice_timing)
select a.id, a.tenant_id, 'Cancelada', now(), null, 'ai_agent', 'Cancelada', a.scheduled_at, a.modality, '$REQ', 'sem_limite_configurado',
  'cancelar', '$REP', 'confirma', 'sem_limite_configurado'
from appointment a where a.id = '$A_AI';
commit;
SQL
APP_WRITE=$?
equal "o papel da aplicação grava o pedido, a resposta e o desfecho da IA (0)" "0" "$APP_WRITE"
[ "$APP_WRITE" -eq 0 ] || sed 's/^/    | /' "$WORK/app-sql.out" | tail -n 5
equal "desfecho da IA: sem usuário, ligado ao pedido e à confirmação" "ai_agent||$REQ|$REP" \
  "$(sql "select outcome_recorded_by_actor_type || '|' || coalesce(outcome_recorded_by_user_id, '') || '|' || closing_notice_id || '|' || confirmation_notice_id from appointment_outcome where appointment_id = '$A_AI'")"
as_app <<SQL
begin;
select set_config('app.tenant_id', '$TENANT_ID', true);
update appointment set state = 'Cancelada', updated_at = now() where id = '$A_FREE';
insert into appointment_outcome (appointment_id, tenant_id, outcome, outcome_recorded_at, outcome_recorded_by_user_id, outcome_recorded_by_actor_type,
  state_at_outcome, scheduled_at_at_outcome, modality_at_outcome, closing_notice_id, closing_notice_timing, closing_requested_action)
select a.id, a.tenant_id, 'Cancelada', now(), null, 'ai_agent', 'Cancelada', a.scheduled_at, a.modality, '$REQ_WAIT', 'sem_limite_configurado', 'cancelar'
from appointment a where a.id = '$A_FREE';
commit;
SQL
if grep -q 'appointment_outcome_actor_check' "$WORK/app-sql.out"; then ok "o banco recusa o desfecho da IA sem a confirmação (appointment_outcome_actor_check)"; else ko "o banco recusa o desfecho da IA sem a confirmação: $(tail -n 2 "$WORK/app-sql.out")"; fi
equal "e nada foi gravado na consulta" "Reservada|0" "$(sql "select state from appointment where id = '$A_FREE'")|$(sql "select count(*) from appointment_outcome where appointment_id = '$A_FREE'")"
login
equal "a nova lê o desfecho da IA: cancelar de novo não muda nada e devolve a autoria" "200|ai_agent" \
  "$(api POST "/appointments/$A_AI/cancel" '{"requestedBy":"clinica"}')|$(field outcome.recordedBy)"
equal "a lista de pendências mostra o executado e o que aguarda" "200|confirmado|aguardando" \
  "$(api GET /appointments/whatsapp-requests)|$(request_status "$A_AI")|$(request_status "$A_WAIT")"
refused "a nova não altera a consulta cancelada pela IA" "$(api POST "/appointments/$A_AI/confirm")"
invariants "versão nova"

# ------------------------------------------------ 4. rollback para a anterior
section "4. rollback para a anterior ($PREVIOUS) contra o banco com desfecho da IA"
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" > "$WORK/rollback-refused.log" 2>&1
equal "rollback recusado: a anterior não tem appointment-ai-confirmation-v1 (3)" "3|refused-capability" "$?|$(last_history result)"
equal "a nova continua no ar" "$NEW" "$(version)"
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" --allow-degraded > "$WORK/rollback-no-notes.log" 2>&1
equal "--allow-degraded sem justificativa: recusado (3)" "3" "$?"
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" --allow-degraded --notes "ensaio K11: retorno degradado para a anterior" > "$WORK/rollback-degraded.log" 2>&1
equal "com --allow-degraded e justificativa, volta (0)" "0|$PREVIOUS" "$?|$(version)"
equal "histórico: rollback degradado com a justificativa" "rollback|success|degraded|ensaio K11: retorno degradado para a anterior" \
  "$(last_history action)|$(last_history result)|$(last_history mode)|$(last_history notes)"

# ----------------- 5. a anterior, em modo degradado, no banco com o K11
section "5. a anterior ($PREVIOUS) no banco com desfecho da IA"
login
OUTCOMES_BEFORE="$(sql "select count(*) || ':' || md5(string_agg(appointment_id || outcome || outcome_recorded_by_actor_type, '|' order by appointment_id)) from appointment_outcome")"
equal "a anterior lista o dia do cancelamento da IA (nenhuma versão lista consulta cancelada na agenda)" "200" "$(api GET "/appointments?$(day_of "$A_AI_AT")")"
CODE="$(api POST "/appointments/$A_AI/cancel" '{"requestedBy":"clinica"}')"
refused "a anterior não cancela de novo a consulta cancelada pela IA" "$CODE"
echo "  info    resposta da anterior: HTTP $CODE $(head -c 200 "$WORK/resp.json")"
CODE="$(api POST "/appointments/$A_AI/confirm")"
refused "nem a confirma" "$CODE"
echo "  info    resposta da anterior: HTTP $CODE $(head -c 200 "$WORK/resp.json")"
compose logs --no-color backend > "$WORK/previous-backend.log" 2>&1
echo "  info    erro de leitura do desfecho sem usuário no log da anterior: $(grep -iE 'outcomeRecordedByUserId|P2032|non-nullable|Inconsistent column' "$WORK/previous-backend.log" | head -n 1 | cut -c1-220)"
equal "o desfecho da IA não mudou, e nenhum outro foi criado" "$OUTCOMES_BEFORE" "$(sql "select count(*) || ':' || md5(string_agg(appointment_id || outcome || outcome_recorded_by_actor_type, '|' order by appointment_id)) from appointment_outcome")"
equal "a anterior lista um dia sem desfecho da IA" "200" "$(api GET "/appointments?$(day_of "$A_OLD_AT")")"
equal "a anterior cancela pelo painel a consulta que tinha um pedido pelo WhatsApp aguardando" "201" "$(api POST "/appointments/$A_WAIT/cancel" '{"requestedBy":"paciente"}')"
equal "desfecho de pessoa; o pedido continua como estava (só acréscimo)" "user|true|1" \
  "$(sql "select outcome_recorded_by_actor_type || '|' || (outcome_recorded_by_user_id is not null) from appointment_outcome where appointment_id = '$A_WAIT'")|$(sql "select count(*) from appointment_notice where id = '$REQ_WAIT' and awaits_confirmation")"
echo "  info    em modo degradado a anterior volta a cancelar e remarcar pelo WhatsApp numa etapa só (comportamento dela); o ensaio não chama a IA"
invariants "anterior depois da nova"

# ------------------------------------------------------ 6. a nova de novo
section "6. deploy da nova ($NEW) de novo"
bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$NEW" --notes "ensaio K11: saída do modo degradado" > "$WORK/deploy-new-again.log" 2>&1
equal "deploy da nova (0)" "0|success|normal|$NEW" "$?|$(last_history result)|$(last_history mode)|$(version)"
login
equal "a nova lê de novo o desfecho da IA" "200|ai_agent" "$(api POST "/appointments/$A_AI/cancel" '{"requestedBy":"clinica"}')|$(field outcome.recordedBy)"
equal "o pedido que a anterior encerrou pelo painel sai das pendências" "200|" "$(api GET /appointments/whatsapp-requests)|$(request_status "$A_WAIT")"
invariants "de volta à nova"

# ------------------------------------- 7. desastre: backup anterior ao K11
section "7. backup anterior ao K11 restaurado num banco vazio"
bash "$SCRIPTS/restore-drill.sh" --env-file "$ENV_FILE" --backup "$PRE_K11_BACKUP" > "$WORK/restore-drill.log" 2>&1
equal "o ensaio de restauração do backup anterior passa (0)" "0" "$?"
if grep -q 'backup-anterior-à-exigência:appointment-ai-confirmation-v1' "$WORK/restore-drill.log"; then ok "e avisa que o backup é anterior à exigência do K11"; else ko "e avisa que o backup é anterior à exigência do K11"; fi
compose stop backend >/dev/null 2>&1
psql_on postgres "drop database $DB with (force)" >/dev/null
psql_on postgres "create database $DB" >/dev/null
compose exec -T postgres pg_restore -U postgres -d "$DB" --exit-on-error < "$PRE_K11_BACKUP"
equal "backup restaurado num banco vazio, com a aplicação parada" "0|" "$?|$(version)"
equal "o banco restaurado só exige as duas do K2" "appointment-outcome-v1,billing-eligibility-v1" "$(sql "select string_agg(capability, ',' order by capability) from deployment_requirement")"
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" --to "$PREVIOUS" --allow-degraded --notes "ensaio K11: tentativa depois da restauração" > "$WORK/rollback-after-restore.log" 2>&1
equal "rollback para a anterior recusado: o banco perdeu a exigência (3)" "3|refused-protections" "$?|$(last_history result)"
bash "$SCRIPTS/rollback.sh" --env-file "$ENV_FILE" --to "$NEW" > "$WORK/rollback-new-after-restore.log" 2>&1
equal "religar a nova sem migrations também é recusado (3)" "3|refused-protections" "$?|$(last_history result)"
equal "a aplicação continua parada" "" "$(version)"
bash "$SCRIPTS/deploy.sh" --env-file "$ENV_FILE" --version "$NEW" --notes "ensaio K11: depois da restauração" > "$WORK/deploy-after-restore.log" 2>&1
equal "deploy.sh reaplica as migrations e sobe a nova (0)" "0|$NEW" "$?|$(version)"
equal "o banco exige as três capacidades de novo" "$ALL_THREE" "$(sql "select string_agg(capability, ',' order by capability) from deployment_requirement")"
equal "as 7 restrições do K11 validadas" "7" "$(sql "select count(*) from pg_constraint where conname in (${K11_LIST%,}) and convalidated")"
equal "o desfecho de antes do K11 voltou, com a autoria de pessoa" "Cancelada|user|true" \
  "$(sql "select outcome || '|' || outcome_recorded_by_actor_type || '|' || (outcome_recorded_by_user_id is not null) from appointment_outcome where appointment_id = '$A_OLD'")"
equal "o que foi gravado depois do backup se perdeu (esperado numa restauração)" "0" "$(sql "select count(*) from appointment_outcome where outcome_recorded_by_actor_type = 'ai_agent'")"
invariants "depois da restauração"

echo
echo "ensaio K11: $PASS verificações passaram, $FAIL falharam"
if [ "$FAIL" -ne 0 ]; then
  for file in deploy-previous deploy-new-bad deploy-new rollback-degraded deploy-new-again restore-drill deploy-after-restore; do
    [ -f "$WORK/$file.log" ] && { echo "--- $file.log"; tail -n 12 "$WORK/$file.log" | sed 's/^/    | /'; }
  done
  [ -f "$WORK/app-sql.out" ] && { echo "--- app-sql.out"; tail -n 8 "$WORK/app-sql.out" | sed 's/^/    | /'; }
  exit 1
fi
