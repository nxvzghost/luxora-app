#!/usr/bin/env bash
# Luxora — executor dos timers do backup externo (A-12).
# (Procedimento: docs/07-Infra/DEPLOY_RUNBOOK.md, "Agendamento e alertas do backup".)
#
#   backup-job.sh backup --env-file F    # backup diário: confere a configuração e roda o push
#   backup-job.sh health --env-file F    # verificação horária da idade do último backup
#
# Só chama os scripts irmãos que já existem (external-backup.sh e
# external-backup-health.sh) e decide o que fazer com o código de saída deles; não
# repete a lógica de nenhum dos dois. Não depende de fornecedor de alertas: a entrega
# fica por conta de um "notificador" opcional (ver abaixo).
#
# backup: um flock impede duas execuções ao mesmo tempo (também contra uma execução
#         manual); `external-backup.sh check` roda antes e, se a configuração estiver
#         incompleta, o push NÃO roda; depois `external-backup.sh push`.
# health: roda external-backup-health.sh e classifica o resultado. Um marcador
#         inválido é conferido uma segunda vez (o marcador é gravado sem troca atômica,
#         e uma leitura no meio da gravação o veria vazio).
#
# Códigos de saída, fora de 0-3 (usados por deploy.sh e external-backup.sh):
#   backup:  0 backup enviado | 20 configuração inválida (nada foi executado)
#            21 falha no backup (push) | 75 já havia uma execução em andamento (nada foi feito)
#   health:  0 saudável | 10 backup ausente | 11 backup atrasado | 13 configuração inválida
#            14 a própria verificação falhou ou não pôde concluir (inclui marcador inválido)
#   ambos:   64 uso incorreto
#
# Alertas. Cada mudança de estado vira um evento: backup_upload_failed, backup_missing,
# backup_overdue, config_invalid, check_failed e recovered (o problema acabou). O mesmo
# problema não é repetido antes de BACKUP_ALERT_REPEAT_HOURS (padrão 12), salvo se o
# aviso anterior não foi entregue: aí tenta de novo a cada execução.
#
# Notificador: BACKUP_ALERT_NOTIFIER no arquivo de ambiente = caminho ABSOLUTO de um
# executável. Ele é chamado direto, SEM shell e sem argumentos, com o evento em JSON
# no stdin (schema luxora.backup-alert/1) e um ambiente mínimo (env -i: não herda
# nenhuma variável do serviço), dentro de um tempo limite (BACKUP_ALERT_TIMEOUT_SECONDS,
# padrão 30). Só é aceito se for um arquivo comum, executável, sem escrita para grupo ou
# outros, de dono root ou do usuário atual, e em pasta com a mesma regra. Contrato: o
# notificador sai com 0 SOMENTE depois que o canal confirmou o recebimento; qualquer
# outro código, ou o estouro do tempo, é "não entregue". A saída dele é descartada, para
# que um token que ele imprima não chegue ao log. O evento nunca carrega segredos, nem a
# saída dos scripts chamados: só texto fixo, o código de saída e, no atraso, a linha
# "idade=… limite=… ultimo=…" do verificador.
#
# Sem notificador configurado, o log diz expressamente "ALERTA NÃO ENVIADO". Um alerta só
# aparece como ENTREGUE quando o notificador saiu com 0.

set -uo pipefail
umask 077

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SCRIPT="$SCRIPTS_DIR/external-backup.sh"
HEALTH_SCRIPT="$SCRIPTS_DIR/external-backup-health.sh"

EX_BACKUP_CONFIG=20; EX_BACKUP_FAILED=21; EX_LOCKED=75; EX_HEALTH_FAILED=14; EX_USAGE=64
REPEAT_DEFAULT=12; TIMEOUT_DEFAULT=30; RECHECK_DEFAULT=2

jlog() { printf 'backup-job: %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
clean() { printf '%s' "$1" | tr -c 'A-Za-z0-9 =:._,/+-' '?' | cut -c1-200; }
usage_die() { jlog "evento=uso-invalido motivo=$1 (uso: backup-job.sh backup|health --env-file <arquivo>)"; exit "$EX_USAGE"; }

COMMAND="${1:-}"
case "$COMMAND" in backup|health) shift ;; *) usage_die "comando desconhecido" ;; esac
ENV_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) [ $# -ge 2 ] || usage_die "--env-file sem valor"; ENV_FILE="$2"; shift 2 ;;
    *) usage_die "argumento desconhecido" ;;
  esac
done
[ -n "$ENV_FILE" ] || usage_die "informe --env-file"

env_file_get() { # nome -> valor (mesma regra do env_get do lib.sh)
  local line value
  line="$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  value="${line#*=}"; value="${value%\"}"; value="${value#\"}"
  printf '%s' "$value"
}
int_setting() { # nome padrão mínimo máximo -> valor válido ou o padrão (com aviso)
  local v; v="$(env_file_get "$1")"
  [ -n "$v" ] || { printf '%s' "$2"; return; }
  if [[ "$v" =~ ^[1-9][0-9]{0,3}$ ]] && [ "$v" -ge "$3" ] && [ "$v" -le "$4" ]; then printf '%s' "$v"; return; fi
  jlog "aviso=$1 inválida, usando o padrão $2" >&2
  printf '%s' "$2"
}

fail_without_env() { # código
  jlog "evento=configuracao-invalida motivo=arquivo-de-ambiente-ilegivel codigo=$1"
  jlog "ALERTA NÃO ENVIADO: sem o arquivo de ambiente não há como saber o canal de notificação."
  exit "$1"
}

[ -f "$ENV_FILE" ] && [ -r "$ENV_FILE" ] || fail_without_env "$([ "$COMMAND" = backup ] && echo "$EX_BACKUP_CONFIG" || echo 13)"
ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"

APP_ENV_NAME="$(clean "$(env_file_get APP_ENV)")"; APP_ENV_NAME="${APP_ENV_NAME:-staging}"
NOTIFIER="$(env_file_get BACKUP_ALERT_NOTIFIER)"
REPEAT_HOURS="$(int_setting BACKUP_ALERT_REPEAT_HOURS "$REPEAT_DEFAULT" 1 720)"
NOTIFY_TIMEOUT="$(int_setting BACKUP_ALERT_TIMEOUT_SECONDS "$TIMEOUT_DEFAULT" 1 300)"
RECHECK_SECONDS="$(int_setting BACKUP_JOB_RECHECK_SECONDS "$RECHECK_DEFAULT" 1 60)"

STATE_DIR="${LUXORA_STATE_DIR:-$(dirname "$ENV_FILE")/luxora-deploy-state}"
JOB_DIR="$STATE_DIR/backup-job"
if ! { mkdir -p "$JOB_DIR" && chmod 700 "$STATE_DIR" "$JOB_DIR"; } 2>/dev/null; then
  jlog "evento=configuracao-invalida motivo=diretorio-de-estado-sem-escrita"
  jlog "ALERTA NÃO ENVIADO: sem o diretório de estado não há como registrar nem avisar com segurança."
  exit "$([ "$COMMAND" = backup ] && echo "$EX_BACKUP_CONFIG" || echo 13)"
fi

# ---- alertas -----------------------------------------------------------------------

message_for() {
  case "$1" in
    backup_upload_failed) echo "O backup externo falhou: nenhuma cópia nova foi enviada." ;;
    backup_missing)       echo "Nenhum backup externo bem-sucedido está registrado." ;;
    backup_overdue)       echo "O último backup externo bem-sucedido está atrasado (idade igual ou maior que o limite; padrão 26 horas)." ;;
    config_invalid)       echo "A configuração do backup externo está inválida ou incompleta." ;;
    check_failed)         echo "A verificação da idade do backup falhou ou não concluiu; o estado do backup é desconhecido." ;;
    recovered)            echo "O problema anterior com o backup externo foi resolvido." ;;
  esac
}
severity_for() { case "$1" in recovered) echo info ;; check_failed) echo warning ;; *) echo critical ;; esac; }

# Só aceita um executável que ninguém além de root ou do usuário atual consiga trocar.
notifier_problem() { # caminho -> imprime o motivo e sai com 1 se não servir
  local p="$1" real dir me; me="$(id -u)"
  [[ "$p" =~ ^/[A-Za-z0-9._/+-]+$ ]] && [[ "$p" != *..* ]] || { echo "caminho-nao-absoluto-ou-com-caracteres-invalidos"; return 1; }
  real="$(readlink -f -- "$p" 2>/dev/null)" || { echo "caminho-inexistente"; return 1; }
  [ -f "$real" ] && [ -x "$real" ] || { echo "nao-e-um-executavel-comum"; return 1; }
  dir="$(dirname "$real")"
  local what
  for what in "$real" "$dir"; do
    local owner mode
    owner="$(stat -c %u "$what")"; mode="$(stat -c %a "$what")"
    { [ "$owner" = 0 ] || [ "$owner" = "$me" ]; } || { echo "dono-inesperado"; return 1; }
    [ $(( 8#$mode & 8#022 )) -eq 0 ] || { echo "gravavel-por-grupo-ou-outros"; return 1; }
  done
  return 0
}

DELIVERY=""; REASON=""
deliver() { # tipo origem código detalhe -> define DELIVERY (entregue|nao-enviado|nao-entregue) e REASON
  local kind="$1" origin="$2" code="$3" detail="$4" sev msg json payload rc=0
  sev="$(severity_for "$kind")"; msg="$(message_for "$kind")"
  json="$(printf '{"schema":"luxora.backup-alert/1","kind":"%s","severity":"%s","origin":"%s","environment":"%s","host":"%s","occurred_at":"%s","exit_code":%s,"message":"%s","detail":"%s"}' \
    "$kind" "$sev" "$origin" "$APP_ENV_NAME" "$(clean "$(hostname 2>/dev/null || echo desconhecido)")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code" "$msg" "$(clean "$detail")")"

  if [ -z "$NOTIFIER" ]; then
    DELIVERY=nao-enviado; REASON=sem-canal-configurado
  elif REASON="$(notifier_problem "$NOTIFIER")"; [ -n "$REASON" ]; then
    DELIVERY=nao-entregue; REASON="notificador-invalido:$REASON"
  else
    payload="$(mktemp "$JOB_DIR/evento.XXXXXX")"; printf '%s\n' "$json" > "$payload"
    timeout --kill-after=5 "$NOTIFY_TIMEOUT" env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 \
      LUXORA_ALERT_KIND="$kind" LUXORA_ALERT_SEVERITY="$sev" LUXORA_ALERT_ORIGIN="$origin" LUXORA_ALERT_ENVIRONMENT="$APP_ENV_NAME" \
      "$NOTIFIER" < "$payload" >/dev/null 2>&1 9>&- || rc=$?
    rm -f "$payload"
    case "$rc" in
      0) DELIVERY=entregue; REASON="confirmado-pelo-notificador" ;;
      124|137) DELIVERY=nao-entregue; REASON="tempo-esgotado" ;;
      *) DELIVERY=nao-entregue; REASON="notificador-saiu-com-$rc" ;;
    esac
  fi

  case "$DELIVERY" in
    entregue)    jlog "evento=alerta tipo=$kind origem=$origin alerta=ENTREGUE motivo=$REASON" ;;
    nao-enviado) jlog "evento=alerta tipo=$kind origem=$origin alerta=NAO-ENVIADO motivo=$REASON"
                 jlog "ALERTA NÃO ENVIADO: nenhum canal de notificação configurado (BACKUP_ALERT_NOTIFIER vazio). Ninguém foi avisado deste evento: $kind." ;;
    *)           jlog "evento=alerta tipo=$kind origem=$origin alerta=NAO-ENTREGUE motivo=$REASON"
                 jlog "ALERTA NÃO ENTREGUE: o evento $kind NÃO chegou a ninguém ($REASON)." ;;
  esac
  printf '{"timestamp":"%s","kind":"%s","origin":"%s","severity":"%s","exit_code":%s,"delivery":"%s","reason":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$kind" "$origin" "$sev" "$code" \
    "$(case "$DELIVERY" in entregue) echo delivered ;; nao-enviado) echo not-sent ;; *) echo not-delivered ;; esac)" \
    "$REASON" >> "$STATE_DIR/alerts.jsonl"
}

# Estado por família (backup, health): status atual, desde quando e se o último aviso foi entregue.
PREV_STATUS=ok; PREV_SINCE=0; PREV_LAST=0; PREV_DELIVERED=1
read_state() {
  PREV_STATUS=ok; PREV_SINCE=0; PREV_LAST=0; PREV_DELIVERED=1
  local f="$JOB_DIR/$1.state" line
  [ -f "$f" ] || return 0
  line="$(head -n 1 "$f")"
  if [[ "$line" =~ ^status=([a-z_]+)\ since=([0-9]+)\ last_alert=([0-9]+)\ delivered=([01])$ ]]; then
    PREV_STATUS="${BASH_REMATCH[1]}"; PREV_SINCE="${BASH_REMATCH[2]}"; PREV_LAST="${BASH_REMATCH[3]}"; PREV_DELIVERED="${BASH_REMATCH[4]}"
  fi
}
write_state() { # família status desde último-aviso entregue
  printf 'status=%s since=%s last_alert=%s delivered=%s\n' "$2" "$3" "$4" "$5" > "$JOB_DIR/$1.state.tmp" \
    && mv "$JOB_DIR/$1.state.tmp" "$JOB_DIR/$1.state"
}

handle_result() { # família status(ok|tipo) código detalhe
  local family="$1" status="$2" code="$3" detail="$4" now send=0 since delivered=0
  now="$(date -u +%s)"; read_state "$family"
  if [ "$status" = ok ]; then
    if [ "$PREV_STATUS" != ok ]; then
      deliver recovered "$family" "$code" "antes=$PREV_STATUS desde=$(date -u -d "@$PREV_SINCE" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"
    fi
    write_state "$family" ok "$now" 0 1
    return 0
  fi
  [ "$PREV_STATUS" != "$status" ] && send=1
  [ "$PREV_DELIVERED" != 1 ] && send=1
  [ $(( now - PREV_LAST )) -ge $(( REPEAT_HOURS * 3600 )) ] && send=1
  since="$now"; [ "$PREV_STATUS" = "$status" ] && since="$PREV_SINCE"
  if [ "$send" -eq 1 ]; then
    deliver "$status" "$family" "$code" "$detail"
    [ "$DELIVERY" = entregue ] && delivered=1
    write_state "$family" "$status" "$since" "$now" "$delivered"
  else
    jlog "evento=alerta-suprimido tipo=$status origem=$family motivo=ja-avisado-ha-menos-de-${REPEAT_HOURS}h"
  fi
}

# ---- backup ------------------------------------------------------------------------

run_backup() {
  local rc=0
  exec 9> "$STATE_DIR/backup-job.lock"
  if ! flock -n 9; then
    jlog "evento=ja-em-execucao codigo=$EX_LOCKED motivo=outra-execucao-do-backup-em-andamento (nada foi feito)"
    exit "$EX_LOCKED"
  fi
  jlog "evento=inicio job=backup ambiente=$APP_ENV_NAME"

  bash "$BACKUP_SCRIPT" check --env-file "$ENV_FILE" || rc=$?
  if [ "$rc" -ne 0 ]; then
    jlog "evento=configuracao-invalida job=backup codigo-do-check=$rc (o backup NAO foi executado)"
    handle_result backup config_invalid "$rc" "check saiu com $rc"
    exit "$EX_BACKUP_CONFIG"
  fi

  rc=0
  bash "$BACKUP_SCRIPT" push --env-file "$ENV_FILE" || rc=$?
  if [ "$rc" -ne 0 ]; then
    jlog "evento=fim job=backup resultado=falha codigo-do-push=$rc codigo-de-saida=$EX_BACKUP_FAILED"
    handle_result backup backup_upload_failed "$rc" "push saiu com $rc"
    exit "$EX_BACKUP_FAILED"
  fi
  jlog "evento=fim job=backup resultado=sucesso codigo-do-push=0 codigo-de-saida=0"
  handle_result backup ok 0 ""
  exit 0
}

# ---- verificação da idade ----------------------------------------------------------

run_health() {
  local out rc=0
  jlog "evento=inicio job=health ambiente=$APP_ENV_NAME"
  out="$(bash "$HEALTH_SCRIPT" --env-file "$ENV_FILE" 2>&1)" || rc=$?
  if [ "$rc" -eq 12 ]; then
    sleep "$RECHECK_SECONDS"; rc=0
    out="$(bash "$HEALTH_SCRIPT" --env-file "$ENV_FILE" 2>&1)" || rc=$?
  fi
  jlog "evento=verificacao codigo-do-verificador=$rc saida=$(clean "$out")"

  case "$rc" in
    0)  handle_result health ok 0 ""; exit 0 ;;
    10) handle_result health backup_missing 10 "$out"; exit 10 ;;
    11) handle_result health backup_overdue 11 "$out"; exit 11 ;;
    13) handle_result health config_invalid 13 "$out"; exit 13 ;;
    *)  handle_result health check_failed "$rc" "verificador saiu com $rc"; exit "$EX_HEALTH_FAILED" ;;
  esac
}

"run_$COMMAND"
