#!/usr/bin/env bash
# Luxora — verificador da idade do último backup externo bem-sucedido (A-12).
# (Procedimento: docs/07-Infra/DEPLOY_RUNBOOK.md, "Backup externo cifrado".)
#
#   external-backup-health.sh --env-file F      # estado ao lado do arquivo de ambiente
#   external-backup-health.sh --state-dir D     # ou o diretório de estado direto
#
# Só lê. Não acessa a rede, o banco nem o armazenamento, não grava nada, não cria
# diretório e NÃO ENVIA ALERTA: quem chama (um agendador, um monitor) decide o que
# fazer com o resultado. Não depende de provedor de monitoramento.
#
# Fonte da idade: o arquivo `last-external-backup` do estado, que o external-backup.sh
# só grava DEPOIS de um envio bem-sucedido e cujo conteúdo é a chave do objeto,
# terminada em <AAAAMMDD>T<HHMMSS>Z-<8 hex>.dump.gpg. A data (UTC) é a do início do
# envio, gerada pelo próprio script; por isso a idade vem do NOME, nunca da data de
# modificação do arquivo (que muda com cópia, restauração do estado ou touch). O
# history.jsonl não é lido. Na saída aparece só o horário do backup, nunca a chave.
#
# Limite: BACKUP_MAX_AGE_HOURS (ambiente do processo, ou arquivo de ambiente quando
# --env-file é usado), inteiro de 1 a 8760; padrão 26. Vazio vale como ausente.
# Saudável: idade estritamente menor que o limite (exatamente no limite já é atraso).
#
# Saída: uma linha em stdout, "external-backup-health: estado=<estado> ...".
# Códigos de saída (propositalmente fora de 0-3, usados por deploy.sh e
# external-backup.sh):
#   0   saudavel
#   10  ausente            (nenhum backup bem-sucedido registrado)
#   11  atrasado           (o último tem idade igual ou maior que o limite)
#   12  marcador-invalido  (marcador ilegível, malformado ou com data impossível)
#   13  configuracao-invalida (argumentos, limite ou variáveis de teste inválidos)
#
# BACKUP_HEALTH_NOW_EPOCH fixa "agora" (segundos desde 1970) e existe só para os testes.

set -uo pipefail

MAX_AGE_DEFAULT=26
FUTURE_TOLERANCE_SECONDS=300   # relógios com pequena diferença não derrubam a verificação

report() { # estado código detalhe
  printf 'external-backup-health: estado=%s%s\n' "$1" "${3:+ $3}"
  exit "$2"
}

ENV_FILE=""; STATE_DIR_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) [ $# -ge 2 ] || report configuracao-invalida 13 "motivo=--env-file sem valor"; ENV_FILE="$2"; shift 2 ;;
    --state-dir) [ $# -ge 2 ] || report configuracao-invalida 13 "motivo=--state-dir sem valor"; STATE_DIR_ARG="$2"; shift 2 ;;
    *) report configuracao-invalida 13 "motivo=argumento desconhecido (uso: --env-file <arquivo> | --state-dir <diretório>)" ;;
  esac
done
if [ -n "$ENV_FILE" ] && [ -n "$STATE_DIR_ARG" ]; then
  report configuracao-invalida 13 "motivo=use --env-file ou --state-dir, não os dois"
fi
if [ -z "$ENV_FILE" ] && [ -z "$STATE_DIR_ARG" ]; then
  report configuracao-invalida 13 "motivo=informe --env-file ou --state-dir"
fi

# Mesma regra do env_get do lib.sh: KEY=valor, com ou sem aspas, a última linha vale.
env_file_get() {
  local line value
  line="$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  value="${line#*=}"; value="${value%\"}"; value="${value#\"}"
  printf '%s' "$value"
}

STATE_DIR=""
if [ -n "$ENV_FILE" ]; then
  [ -f "$ENV_FILE" ] && [ -r "$ENV_FILE" ] || report configuracao-invalida 13 "motivo=arquivo de ambiente não encontrado ou ilegível"
  STATE_DIR="${LUXORA_STATE_DIR:-$(cd "$(dirname "$ENV_FILE")" && pwd)/luxora-deploy-state}"
else
  STATE_DIR="$STATE_DIR_ARG"
  [ -d "$STATE_DIR" ] || report configuracao-invalida 13 "motivo=diretório de estado não encontrado"
fi

MAX_AGE="${BACKUP_MAX_AGE_HOURS:-}"
if [ -z "$MAX_AGE" ] && [ -n "$ENV_FILE" ]; then MAX_AGE="$(env_file_get BACKUP_MAX_AGE_HOURS)"; fi
MAX_AGE="${MAX_AGE:-$MAX_AGE_DEFAULT}"
if ! [[ "$MAX_AGE" =~ ^[1-9][0-9]{0,3}$ ]] || [ "$MAX_AGE" -gt 8760 ]; then
  report configuracao-invalida 13 "motivo=BACKUP_MAX_AGE_HOURS precisa ser um inteiro de 1 a 8760"
fi

NOW="${BACKUP_HEALTH_NOW_EPOCH:-}"
if [ -n "$NOW" ]; then
  [[ "$NOW" =~ ^[0-9]{1,12}$ ]] || report configuracao-invalida 13 "motivo=BACKUP_HEALTH_NOW_EPOCH inválida"
else
  NOW="$(date -u +%s)"
fi

MARKER="$STATE_DIR/last-external-backup"
if [ ! -e "$MARKER" ] && [ ! -L "$MARKER" ]; then
  report ausente 10 "limite=${MAX_AGE}h motivo=nenhum backup externo bem-sucedido registrado"
fi
if [ ! -f "$MARKER" ] || [ ! -r "$MARKER" ]; then
  report marcador-invalido 12 "limite=${MAX_AGE}h motivo=marcador ilegível ou não é um arquivo comum"
fi

size="$(wc -c < "$MARKER" 2>/dev/null | tr -d ' ')"
{ [ -n "$size" ] && [ "$size" -ge 1 ] && [ "$size" -le 1024 ]; } \
  || report marcador-invalido 12 "limite=${MAX_AGE}h motivo=marcador vazio ou grande demais"
lines="$(grep -c '' "$MARKER" 2>/dev/null || echo 0)"
[ "$lines" -eq 1 ] || report marcador-invalido 12 "limite=${MAX_AGE}h motivo=marcador com mais de uma linha"
KEY="$(head -n 1 "$MARKER" | tr -d '\r')"

# Mesma regra de chave que o external-backup.sh aceita para objetos.
if ! { [[ "$KEY" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] && [[ "$KEY" != *..* ]]; }; then
  report marcador-invalido 12 "limite=${MAX_AGE}h motivo=conteúdo não é uma chave de objeto válida"
fi
NAME="${KEY##*/}"
if ! [[ "$NAME" =~ ^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z-[0-9a-f]{8}\.dump\.gpg$ ]]; then
  report marcador-invalido 12 "limite=${MAX_AGE}h motivo=nome sem o horário do backup no formato esperado"
fi
STAMP="${NAME%%-*}"
ISO="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}T${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}Z"
BACKUP_EPOCH="$(date -u -d "${ISO%Z} UTC" +%s 2>/dev/null)" || BACKUP_EPOCH=""
# Ida e volta: rejeita datas que o date "conserta" (30 de fevereiro, hora 25...).
if [ -z "$BACKUP_EPOCH" ] || [ "$(date -u -d "@$BACKUP_EPOCH" +%Y%m%dT%H%M%SZ 2>/dev/null)" != "$STAMP" ]; then
  report marcador-invalido 12 "limite=${MAX_AGE}h motivo=data do backup impossível"
fi

AGE=$(( NOW - BACKUP_EPOCH ))
if [ "$AGE" -lt 0 ]; then
  if [ "$AGE" -lt $(( -FUTURE_TOLERANCE_SECONDS )) ]; then
    report marcador-invalido 12 "limite=${MAX_AGE}h ultimo=$ISO motivo=horário do backup no futuro (relógio ou marcador errado)"
  fi
  AGE=0
fi
AGE_TEXT="$(( AGE / 3600 ))h$(printf '%02d' $(( AGE % 3600 / 60 )))m"
DETAIL="idade=$AGE_TEXT limite=${MAX_AGE}h ultimo=$ISO"
if [ "$AGE" -lt $(( MAX_AGE * 3600 )) ]; then
  report saudavel 0 "$DETAIL"
fi
report atrasado 11 "$DETAIL"
