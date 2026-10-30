#!/usr/bin/env bash
# Luxora — teste do agendamento e dos alertas do backup externo (A-12):
# infra/scripts/backup-job.sh e as unidades de infra/systemd/.
#
#   bash infra/tests/backup-schedule-test.sh
#
# Isolado: external-backup.sh SIMULADO (um script que só registra a chamada e sai com o
# código pedido), notificadores falsos, dados e segredos fictícios, tudo num diretório
# temporário. Usa o external-backup-health.sh de verdade (ele só lê arquivos) e, em um
# caso, o external-backup.sh de verdade só até o `check`, que não usa rede, banco nem
# docker. Não instala nada, não fala com o systemd, nem com rede, armazenamento ou
# credencial reais. Não repete os testes do external-backup.sh nem do verificador. Roda
# no CI, no job deploy-rehearsal, antes do build das imagens.
#
# O que NÃO prova: que o systemd do servidor lê as unidades, dispara nos horários e
# recupera a execução perdida (Persistent=true); isso só se vê no servidor real.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL="$HERE/../scripts"
UNITS="$HERE/../systemd"

WORK="$(mktemp -d)"; chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
unset LUXORA_STATE_DIR BACKUP_MAX_AGE_HOURS BACKUP_HEALTH_NOW_EPOCH

PASSED=0; FAILED=0; SKIPPED=0
ok() { PASSED=$((PASSED + 1)); echo "  ok    $1"; }
ko() { FAILED=$((FAILED + 1)); echo "  FALHA $1"; sed 's/^/        | /' "$WORK/out.txt" 2>/dev/null | tail -n 6; }
skip() { SKIPPED=$((SKIPPED + 1)); echo "  pulou $1"; }

# ---- diretórios de scripts: o real (copiado) e um com o external-backup.sh simulado ----
SCR="$WORK/scripts"; mkdir -p "$SCR"
cp "$REAL/backup-job.sh" "$REAL/external-backup-health.sh" "$SCR/"
cat > "$SCR/external-backup.sh" <<'STUB'
#!/usr/bin/env bash
# Simulado: registra a chamada, espera se mandarem e sai com o código pedido.
echo "$*" >> "$STUB_CALLS"
CMD="$1"
ENVF=""; while [ $# -gt 0 ]; do [ "$1" = "--env-file" ] && ENVF="$2"; shift; done
case "$CMD" in
  check) exit "${STUB_CHECK_RC:-0}" ;;
  push)
    [ -n "${STUB_PUSH_STARTED:-}" ] && : > "$STUB_PUSH_STARTED"
    if [ -n "${STUB_PUSH_WAIT:-}" ]; then while [ ! -e "$STUB_PUSH_WAIT" ]; do sleep 0.1; done; fi
    rc="${STUB_PUSH_RC:-0}"
    if [ "$rc" -eq 0 ]; then
      d="$(dirname "$ENVF")/luxora-deploy-state"; mkdir -p "$d"
      printf 'luxora/staging/db/%s-a1b2c3d4.dump.gpg\n' "$(date -u +%Y%m%dT%H%M%SZ)" > "$d/last-external-backup"
    fi
    exit "$rc" ;;
esac
exit 99
STUB
REALDIR="$WORK/real"; mkdir -p "$REALDIR"; cp "$REAL/backup-job.sh" "$REAL/external-backup.sh" "$REAL/external-backup-health.sh" "$REAL/lib.sh" "$REALDIR/"
BROKEN="$WORK/broken"; mkdir -p "$BROKEN"; cp "$REAL/backup-job.sh" "$BROKEN/"   # sem o verificador nem o backup

# ---- notificador falso: grava o evento e o ambiente, imprime um "token" e sai como pedido ----
NDIR="$WORK/notifiers"; mkdir -p "$NDIR/received"; chmod 700 "$NDIR"
cat > "$NDIR/notify.sh" <<'NOTIFY'
#!/usr/bin/env bash
D="$(dirname "$0")"
n=$(( $(ls "$D/received" | grep -c '\.json$') + 1 ))
cat > "$D/received/$n.json"
env > "$D/received/$n.env"
echo "TOKEN-FICTICIO-DO-CANAL-123"; echo "TOKEN-FICTICIO-DO-CANAL-123" >&2
[ -f "$D/sleep" ] && exec sleep 30
exit "$(cat "$D/rc" 2>/dev/null || echo 0)"
NOTIFY
chmod 755 "$NDIR/notify.sh"
NOTIFIER_LINE="BACKUP_ALERT_NOTIFIER=$NDIR/notify.sh"

ENVD="$WORK/env"; ENVF="$ENVD/staging.env"; STATE="$ENVD/luxora-deploy-state"
CALLS="$WORK/calls.txt"; export STUB_CALLS="$CALLS"

fresh() { # [linhas extras para o arquivo de ambiente]
  rm -rf "$ENVD"; mkdir -p "$ENVD"
  { echo 'APP_ENV=staging'; echo 'BACKUP_S3_SECRET_ACCESS_KEY=SEGREDO-FICTICIO-NAO-VAZAR'; printf '%s\n' "$@"; } > "$ENVF"
  rm -f "$CALLS" "$WORK"/flag-* "$NDIR/rc" "$NDIR/sleep"; rm -rf "$NDIR/received"; mkdir -p "$NDIR/received"
  unset STUB_CHECK_RC STUB_PUSH_RC STUB_PUSH_STARTED STUB_PUSH_WAIT
}
jobin() { local dir="$1"; shift; bash "$dir/backup-job.sh" "$@" >"$WORK/out.txt" 2>&1; RC=$?; }
job() { jobin "$SCR" "$@" --env-file "$ENVF"; }
expect_rc() { if [ "$RC" -eq "$2" ]; then ok "$1 (saída $RC)"; else ko "$1 — esperado $2, obtido $RC"; fi; }
has() { if grep -qE -- "$2" "${3:-$WORK/out.txt}"; then ok "$1"; else ko "$1 — não encontrei: $2"; fi; }
lacks() { if grep -qE -- "$2" "${3:-$WORK/out.txt}"; then ko "$1 — apareceu: $2"; else ok "$1"; fi; }
nrecv() { ls "$NDIR/received" 2>/dev/null | grep -c '\.json$'; }
ncalls() { local n=""; [ -f "$CALLS" ] && n="$(grep -c "^$1 " "$CALLS")"; echo "${n:-0}"; }
set_marker() { # segundos-atrás
  mkdir -p "$STATE"
  printf 'luxora/staging/db/%s-a1b2c3d4.dump.gpg\n' "$(date -u -d "@$(( $(date -u +%s) - $1 ))" +%Y%m%dT%H%M%SZ)" > "$STATE/last-external-backup"
}
age_alert() { sed -i -E "s/last_alert=[0-9]+/last_alert=$(( $(date -u +%s) - $1 ))/" "$STATE/backup-job/$2.state"; }

# =====================================================================================
echo "== unidades do systemd (arquivos, sem instalar)"
for u in luxora-backup@.service luxora-backup@.timer luxora-backup-health@.service luxora-backup-health@.timer; do
  [ -f "$UNITS/$u" ] && ok "existe $u" || ko "falta $u"
done
for u in luxora-backup@.service luxora-backup-health@.service; do
  f="$UNITS/$u"
  grep -qx 'Type=oneshot' "$f" && ok "$u é oneshot" || ko "$u não é oneshot"
  grep -qx 'User=deploy' "$f" && ! grep -qiE '^User=root' "$f" && ok "$u roda como usuário sem privilégios (deploy), não root" || ko "$u: usuário"
  grep -qx 'NoNewPrivileges=yes' "$f" && ok "$u sem novos privilégios" || ko "$u: NoNewPrivileges"
  grep -qx 'UMask=0077' "$f" && ok "$u com umask 0077" || ko "$u: UMask"
  ! grep -qE '^\[Install\]' "$f" && ok "$u não se instala sozinha (só o timer)" || ko "$u tem [Install]"
done
grep -qE '^ExecStart=/usr/bin/bash /srv/luxora-app/infra/scripts/backup-job\.sh backup --env-file /etc/luxora/%i\.env$' "$UNITS/luxora-backup@.service" \
  && ok "o backup chama backup-job.sh backup com o arquivo de ambiente /etc/luxora/<ambiente>.env" || ko "ExecStart do backup"
grep -qE '^ExecStart=/usr/bin/bash /srv/luxora-app/infra/scripts/backup-job\.sh health --env-file /etc/luxora/%i\.env$' "$UNITS/luxora-backup-health@.service" \
  && ok "a verificação chama backup-job.sh health com o arquivo de ambiente /etc/luxora/<ambiente>.env" || ko "ExecStart da verificação"
for t in luxora-backup@.timer luxora-backup-health@.timer; do
  grep -qx 'Persistent=true' "$UNITS/$t" && ok "$t recupera execução perdida (Persistent=true)" || ko "$t sem Persistent=true"
  grep -qx 'WantedBy=timers.target' "$UNITS/$t" && ok "$t se instala em timers.target" || ko "$t: [Install]"
done
grep -qx 'OnCalendar=\*-\*-\* 03:30:00 UTC' "$UNITS/luxora-backup@.timer" && ok "backup: uma vez por dia, 03:30 UTC" || ko "OnCalendar do backup"
grep -qx 'OnCalendar=\*-\*-\* \*:15:00 UTC' "$UNITS/luxora-backup-health@.timer" && ok "verificação: a cada hora, minuto 15 UTC" || ko "OnCalendar da verificação"
if grep -qiE 'SECRET|PASSPHRASE|TOKEN|PASSWORD|Environment=' "$UNITS"/*; then ko "as unidades não podem carregar segredos nem variáveis"; else ok "as unidades não carregam segredos nem variáveis (tudo vem do arquivo de ambiente)"; fi
if command -v systemd-analyze >/dev/null 2>&1; then
  out="$(systemd-analyze calendar --iterations=3 '*-*-* *:15:00 UTC' 2>&1)"; echo "$out" > "$WORK/out.txt"
  [ "$(printf '%s\n' "$out" | grep -c 'Next elapse\|Iteration #')" -ge 3 ] && ok "systemd-analyze aceita a expressão horária e calcula 3 próximas execuções" || ko "systemd-analyze (horária)"
  out="$(systemd-analyze calendar '*-*-* 03:30:00 UTC' 2>&1)"; echo "$out" > "$WORK/out.txt"
  printf '%s' "$out" | grep -q '03:30:00' && ok "systemd-analyze aceita a expressão diária (03:30:00)" || ko "systemd-analyze (diária)"
else skip "systemd-analyze ausente: expressões OnCalendar não conferidas"; fi

# =====================================================================================
echo "== uso incorreto"
fresh; jobin "$SCR"; expect_rc "sem argumentos" 64
jobin "$SCR" outro --env-file "$ENVF"; expect_rc "comando desconhecido" 64
jobin "$SCR" backup; expect_rc "sem --env-file" 64
jobin "$SCR" backup --env-file; expect_rc "--env-file sem valor" 64

echo "== backup diário: sucesso"
fresh "$NOTIFIER_LINE"; job backup
expect_rc "backup bem-sucedido" 0
has "o resultado fica no log" 'evento=fim job=backup resultado=sucesso codigo-do-push=0 codigo-de-saida=0'
[ "$(sed -n 1p "$CALLS")" = "check --env-file $ENVF" ] && [ "$(sed -n 2p "$CALLS")" = "push --env-file $ENVF" ] && [ "$(wc -l < "$CALLS")" -eq 2 ] \
  && ok "chama external-backup.sh check e depois push, com o arquivo de ambiente, e mais nada" || ko "chamadas: $(tr '\n' '|' < "$CALLS")"
[ ! -e "$STATE/alerts.jsonl" ] && [ "$(nrecv)" -eq 0 ] && ok "sucesso sem problema anterior não gera alerta" || ko "gerou alerta no sucesso"
[ "$(stat -c %a "$STATE/backup-job")" = 700 ] && ok "o estado do job fica em pasta 700" || ko "permissão do estado do job"

echo "== backup diário: configuração incompleta (stub) e arquivo de ambiente ausente"
fresh "$NOTIFIER_LINE"; STUB_CHECK_RC=3 job backup
expect_rc "check falhou, backup não executado" 20
[ "$(ncalls push)" -eq 0 ] && [ "$(ncalls check)" -eq 1 ] && ok "o push NÃO foi chamado" || ko "push chamado com configuração inválida"
has "log diz que o backup não foi executado" 'evento=configuracao-invalida job=backup codigo-do-check=3 \(o backup NAO foi executado\)'
has "alerta config_invalid entregue" '"kind":"config_invalid"' "$NDIR/received/1.json"
fresh; rm -f "$ENVF"; job backup
expect_rc "arquivo de ambiente ausente" 20
has "diz que o alerta não foi enviado" 'ALERTA NÃO ENVIADO'

echo "== backup diário: external-backup.sh real com configuração incompleta (sem docker nem rede)"
fresh "$NOTIFIER_LINE"; jobin "$REALDIR" backup --env-file "$ENVF"
expect_rc "o check real recusa a configuração (BACKUP_S3_* ausentes)" 20
has "o motivo vem do script real" 'variáveis ausentes no arquivo de ambiente'
[ ! -d "$STATE/tmp" ] && ok "nenhum diretório de trabalho do push foi criado" || ko "o push chegou a rodar"
lacks "a saída não vaza o segredo do arquivo de ambiente" 'SEGREDO-FICTICIO'

echo "== backup diário: falha no envio"
fresh "$NOTIFIER_LINE"; STUB_PUSH_RC=3 job backup
expect_rc "push falhou" 21
has "log com os códigos" 'evento=fim job=backup resultado=falha codigo-do-push=3 codigo-de-saida=21'
J="$NDIR/received/1.json"
[ "$(nrecv)" -eq 1 ] && ok "um alerta foi entregue ao notificador" || ko "alertas recebidos: $(nrecv)"
has "evento backup_upload_failed, severidade critical" '"kind":"backup_upload_failed","severity":"critical","origin":"backup","environment":"staging"' "$J"
has "schema e código de saída no evento" '"schema":"luxora.backup-alert/1".*"exit_code":3' "$J"

echo "== alertas: sem canal, entrega simulada e falha na entrega"
fresh; STUB_PUSH_RC=3 job backup
expect_rc "falha sem notificador" 21
has "declara que o alerta NÃO foi enviado" 'alerta=NAO-ENVIADO motivo=sem-canal-configurado'
has "mensagem explícita" 'ALERTA NÃO ENVIADO: nenhum canal de notificação configurado'
lacks "nunca registra como entregue" 'alerta=ENTREGUE'
has "alerts.jsonl registra not-sent" '"delivery":"not-sent","reason":"sem-canal-configurado"' "$STATE/alerts.jsonl"
STUB_PUSH_RC=3 job backup
[ "$(grep -c 'alerta=NAO-ENVIADO' "$WORK/out.txt")" -eq 1 ] && ok "sem canal, tenta de novo a cada execução (não fica 'avisado')" || ko "suprimiu sem entrega"

fresh "$NOTIFIER_LINE"; STUB_PUSH_RC=3 job backup
has "entrega confirmada pelo notificador (saída 0)" 'alerta=ENTREGUE motivo=confirmado-pelo-notificador'
has "alerts.jsonl registra delivered" '"delivery":"delivered"' "$STATE/alerts.jsonl"
has "o notificador recebeu LUXORA_ALERT_KIND" '^LUXORA_ALERT_KIND=backup_upload_failed$' "$NDIR/received/1.env"
lacks "o ambiente do notificador não tem o segredo do serviço" 'SEGREDO-FICTICIO|BACKUP_S3|BACKUP_ALERT' "$NDIR/received/1.env"
[ "$(wc -l < "$NDIR/received/1.env")" -le 10 ] && ok "o ambiente do notificador é mínimo ($(wc -l < "$NDIR/received/1.env") variáveis)" || ko "ambiente do notificador grande"
if grep -rqE 'SEGREDO-FICTICIO|TOKEN-FICTICIO' "$WORK/out.txt" "$STATE/alerts.jsonl" "$NDIR/received/1.json"; then ko "segredo ou token no log, em alerts.jsonl ou no evento"; else ok "nem o segredo do ambiente nem o token impresso pelo notificador chegam ao log ou ao evento"; fi

fresh "$NOTIFIER_LINE"; echo 1 > "$NDIR/rc"; STUB_PUSH_RC=3 job backup
expect_rc "notificador falha" 21
has "declara NÃO ENTREGUE" 'alerta=NAO-ENTREGUE motivo=notificador-saiu-com-1'
has "mensagem explícita" 'ALERTA NÃO ENTREGUE: o evento backup_upload_failed NÃO chegou a ninguém'
lacks "não registra como entregue" 'alerta=ENTREGUE'
STUB_PUSH_RC=3 job backup
[ "$(nrecv)" -eq 2 ] && ok "aviso não entregue é tentado de novo na execução seguinte" || ko "tentativas: $(nrecv)"
rm -f "$NDIR/rc"; STUB_PUSH_RC=3 job backup
has "entregue na terceira tentativa" 'alerta=ENTREGUE'
STUB_PUSH_RC=3 job backup
has "depois de entregue, o mesmo problema é suprimido" 'evento=alerta-suprimido tipo=backup_upload_failed'
[ "$(nrecv)" -eq 3 ] && ok "nenhuma entrega nova enquanto suprimido" || ko "entregas: $(nrecv)"

fresh "$NOTIFIER_LINE" "BACKUP_ALERT_TIMEOUT_SECONDS=1"; : > "$NDIR/sleep"; STUB_PUSH_RC=3 job backup
has "notificador que trava vira NÃO ENTREGUE por tempo esgotado" 'alerta=NAO-ENTREGUE motivo=tempo-esgotado'
rm -f "$NDIR/sleep"

echo "== alertas: o notificador é um executável direto, nunca um comando de shell"
bad_notifier() { # descrição valor
  fresh "BACKUP_ALERT_NOTIFIER=$2"; STUB_PUSH_RC=3 job backup
  if grep -q 'alerta=NAO-ENTREGUE motivo=notificador-invalido' "$WORK/out.txt" && ! grep -q 'alerta=ENTREGUE' "$WORK/out.txt"; then ok "$1 é recusado"; else ko "$1 não foi recusado"; fi
}
bad_notifier "comando com ponto e vírgula" "/bin/true; touch $WORK/PWNED"
bad_notifier "substituição de comando" "\$(touch $WORK/PWNED)"
bad_notifier "caminho relativo" "notify.sh"
bad_notifier "caminho inexistente" "$NDIR/nao-existe.sh"
[ ! -e "$WORK/PWNED" ] && ok "nenhum comando embutido no valor foi executado" || ko "comando embutido executado"
cp "$NDIR/notify.sh" "$NDIR/sem-exec.sh"; chmod 644 "$NDIR/sem-exec.sh"; bad_notifier "arquivo sem permissão de execução" "$NDIR/sem-exec.sh"
cp "$NDIR/notify.sh" "$NDIR/grupo.sh"; chmod 775 "$NDIR/grupo.sh"; bad_notifier "executável gravável por grupo" "$NDIR/grupo.sh"
mkdir -p "$WORK/aberta"; cp "$NDIR/notify.sh" "$WORK/aberta/notify.sh"; chmod 755 "$WORK/aberta/notify.sh"; chmod 777 "$WORK/aberta"; bad_notifier "executável em pasta gravável por todos" "$WORK/aberta/notify.sh"
if [ "$(id -u)" -eq 0 ]; then
  mkdir -p "$WORK/alheio"; cp "$NDIR/notify.sh" "$WORK/alheio/notify.sh"; chown 12345 "$WORK/alheio/notify.sh"; chmod 755 "$WORK/alheio/notify.sh"
  bad_notifier "executável de outro dono (nem root nem o usuário do serviço)" "$WORK/alheio/notify.sh"
else skip "dono alheio (só dá para preparar como root)"; fi

echo "== alertas: repetição, recuperação"
fresh "$NOTIFIER_LINE"; STUB_PUSH_RC=3 job backup; STUB_PUSH_RC=3 job backup
has "mesmo problema dentro do intervalo: suprimido" 'evento=alerta-suprimido tipo=backup_upload_failed origem=backup motivo=ja-avisado-ha-menos-de-12h'
[ "$(nrecv)" -eq 1 ] && ok "um único aviso para o mesmo problema" || ko "avisos: $(nrecv)"
age_alert 46800 backup; STUB_PUSH_RC=3 job backup
[ "$(nrecv)" -eq 2 ] && ok "passado o intervalo (12h), avisa de novo" || ko "avisos depois do intervalo: $(nrecv)"
STUB_CHECK_RC=3 job backup
[ "$(nrecv)" -eq 3 ] && has "problema diferente avisa na hora" '"kind":"config_invalid"' "$NDIR/received/3.json" || ko "avisos com problema diferente: $(nrecv)"
job backup
expect_rc "backup volta a funcionar" 0
[ "$(nrecv)" -eq 4 ] && has "aviso de recuperação" '"kind":"recovered","severity":"info","origin":"backup"' "$NDIR/received/4.json" || ko "recuperação: $(nrecv) avisos"
job backup
[ "$(nrecv)" -eq 4 ] && ok "novo sucesso não repete a recuperação" || ko "recuperação repetida"
fresh "BACKUP_ALERT_REPEAT_HOURS=abc" "$NOTIFIER_LINE"; STUB_PUSH_RC=3 job backup
has "intervalo inválido usa o padrão e avisa" 'aviso=BACKUP_ALERT_REPEAT_HOURS inválida, usando o padrão 12'

echo "== execuções simultâneas"
fresh "$NOTIFIER_LINE"
STUB_PUSH_STARTED="$WORK/flag-started" STUB_PUSH_WAIT="$WORK/flag-release" bash "$SCR/backup-job.sh" backup --env-file "$ENVF" >"$WORK/out-a.txt" 2>&1 &
PID_A=$!
for _ in $(seq 1 100); do [ -e "$WORK/flag-started" ] && break; sleep 0.1; done
[ -e "$WORK/flag-started" ] && ok "a primeira execução está no meio do push" || ko "a primeira execução não chegou ao push"
job backup
expect_rc "segunda execução enquanto a primeira roda" 75
has "diz que nada foi feito" 'evento=ja-em-execucao codigo=75'
[ "$(ncalls push)" -eq 1 ] && ok "o push rodou uma única vez" || ko "pushes: $(ncalls push)"
[ ! -e "$STATE/alerts.jsonl" ] && ok "pular por trava não é falha nem gera alerta" || ko "alerta por trava"
: > "$WORK/flag-release"; wait "$PID_A"; RC_A=$?
[ "$RC_A" -eq 0 ] && ok "a primeira execução termina bem (saída 0)" || ko "primeira execução saiu com $RC_A"
rm -f "$WORK/flag-started"; job backup
expect_rc "trava liberada: nova execução roda" 0

echo "== verificação horária"
fresh "$NOTIFIER_LINE"; set_marker 11520; job health
expect_rc "backup recente" 0
has "o verificador de verdade foi chamado" 'codigo-do-verificador=0 saida=external-backup-health: estado=saudavel'
[ "$(nrecv)" -eq 0 ] && ok "saudável sem problema anterior não gera alerta" || ko "alerta indevido"
fresh "$NOTIFIER_LINE"; job health
expect_rc "backup ausente" 10
has "evento backup_missing" '"kind":"backup_missing","severity":"critical","origin":"health"' "$NDIR/received/1.json"
fresh "$NOTIFIER_LINE"; set_marker 108000; job health
expect_rc "backup atrasado (30h)" 11
has "evento backup_overdue com a idade" '"kind":"backup_overdue".*"detail":"external-backup-health: estado=atrasado idade=30h' "$NDIR/received/1.json"
lacks "o evento não traz a chave do objeto" 'a1b2c3d4|luxora/staging' "$NDIR/received/1.json"
fresh "$NOTIFIER_LINE" "BACKUP_MAX_AGE_HOURS=abc"; set_marker 100; job health
expect_rc "limite de idade inválido" 13
has "evento config_invalid" '"kind":"config_invalid".*"origin":"health"' "$NDIR/received/1.json"
fresh "$NOTIFIER_LINE" "BACKUP_JOB_RECHECK_SECONDS=1"; mkdir -p "$STATE"; echo "isto não é uma chave" > "$STATE/last-external-backup"; job health
expect_rc "marcador inválido: a verificação não consegue concluir" 14
has "evento check_failed (severidade warning)" '"kind":"check_failed","severity":"warning"' "$NDIR/received/1.json"
fresh "$NOTIFIER_LINE" "BACKUP_JOB_RECHECK_SECONDS=1"; mkdir -p "$STATE"; : > "$STATE/last-external-backup"
( sleep 0.4; printf 'luxora/staging/db/%s-a1b2c3d4.dump.gpg\n' "$(date -u +%Y%m%dT%H%M%SZ)" > "$STATE/last-external-backup" ) &
job health; wait
expect_rc "marcador visto no meio da gravação é conferido de novo" 0
fresh "$NOTIFIER_LINE"; set_marker 100; jobin "$BROKEN" health --env-file "$ENVF"
expect_rc "o próprio verificador falha (script ausente)" 14
has "evento check_failed" '"kind":"check_failed"' "$NDIR/received/1.json"
fresh; set_marker 108000; job health
has "sem canal, a verificação também declara que não enviou" 'ALERTA NÃO ENVIADO'

echo "== execução perdida e recuperação"
fresh "$NOTIFIER_LINE"; set_marker 108000; job health
expect_rc "o backup do dia não rodou (servidor desligado): a verificação acusa o atraso" 11
STUB_PUSH_RC=0 job backup
expect_rc "o systemd recupera a execução perdida (aqui: o backup roda)" 0
job health
expect_rc "a verificação seguinte vê o backup novo" 0
[ "$(nrecv)" -eq 2 ] && ok "dois avisos: o atraso e a recuperação (o backup que voltou não gera aviso próprio)" || ko "avisos: $(nrecv)"
has "recuperação da verificação" '"kind":"recovered".*"origin":"health"' "$NDIR/received/2.json"
has "a recuperação diz o que foi resolvido" 'antes=backup_overdue' "$NDIR/received/2.json"

echo
echo "Resultado: $PASSED verificações ok, $FAILED falhas, $SKIPPED puladas"
[ "$FAILED" -eq 0 ]
