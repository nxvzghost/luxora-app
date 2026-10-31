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
      d="${LUXORA_STATE_DIR:-$(dirname "$ENVF")/luxora-deploy-state}"; mkdir -p "$d"
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
  chmod 600 "$ENVF"   # o backup-job.sh recusa arquivo de ambiente legível por outros
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
  grep -qx 'User=luxora-backup' "$f" && grep -qx 'Group=luxora-backup' "$f" && ! grep -qiE '^(User|Group)=(root|deploy|docker)' "$f" \
    && ok "$u roda como o usuário dedicado luxora-backup (grupo próprio), não root nem deploy" || ko "$u: usuário"
  ! grep -qiE '^(SupplementaryGroups|DynamicUser|PermissionsStartOnly|ExecStartPre|ExecStartPost|AmbientCapabilities)=' "$f" \
    && ok "$u não acrescenta grupos (docker, sudo) nem capacidades nem passos extras" || ko "$u: grupos, capacidades ou passos extras"
  # Só as linhas de configuração (os comentários explicam o isolamento e citam docker de propósito).
  grep -v '^[[:space:]]*#' "$f" > "$WORK/unit-linhas.txt"
  ! grep -qiE 'docker|sudo|/var/run' "$WORK/unit-linhas.txt" && ok "$u não depende do Docker (sem dependência, grupo, socket nem sudo)" || ko "$u menciona docker, sudo ou socket"
  ! grep -qiE '^(After|Requires|Wants|BindsTo|PartOf)=.*docker' "$f" && ok "$u não exige docker.service" || ko "$u exige docker.service"
  ! grep -qE '/etc/luxora/|EnvironmentFile' "$WORK/unit-linhas.txt" && ok "$u não lê o ambiente da aplicação (/etc/luxora) nem usa EnvironmentFile" || ko "$u lê /etc/luxora ou EnvironmentFile"
  grep -qx 'InaccessiblePaths=/etc/luxora' "$f" && ok "$u: o ambiente da aplicação (/etc/luxora) fica fora de alcance" || ko "$u: InaccessiblePaths"
  grep -qx 'NoNewPrivileges=yes' "$f" && ok "$u sem novos privilégios" || ko "$u: NoNewPrivileges"
  grep -qx 'UMask=0077' "$f" && ok "$u com umask 0077" || ko "$u: UMask"
  grep -qx 'Environment=LUXORA_STATE_DIR=%S/luxora-backup/%i' "$f" && [ "$(grep -c '^Environment=' "$f")" -eq 1 ] \
    && ok "$u: a única variável é o caminho do estado (LUXORA_STATE_DIR), nada de segredo" || ko "$u: Environment"
  grep -qx 'StateDirectory=luxora-backup/%i' "$f" && grep -qx 'StateDirectoryMode=0700' "$f" \
    && ok "$u: estado em /var/lib/luxora-backup/<ambiente>, criado pelo systemd com modo 0700" || ko "$u: StateDirectory"
  missing=""
  for d in PrivateTmp=yes PrivateDevices=yes ProtectSystem=strict ProtectHome=yes ProtectKernelTunables=yes ProtectKernelModules=yes ProtectControlGroups=yes RestrictSUIDSGID=yes LockPersonality=yes 'CapabilityBoundingSet=' 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6'; do
    grep -qxF "$d" "$f" || missing="$missing $d"
  done
  [ -z "$missing" ] && ok "$u: endurecimento (sistema de arquivos somente leitura exceto o estado, sem capacidades, famílias de rede restritas)" || ko "$u: faltam$missing"
  ! grep -qE '^\[Install\]' "$f" && ok "$u não se instala sozinha (só o timer)" || ko "$u tem [Install]"
done
grep -qE '^ExecStart=/usr/bin/bash /srv/luxora-app/infra/scripts/backup-job\.sh backup --env-file /etc/luxora-backup/%i\.env$' "$UNITS/luxora-backup@.service" \
  && ok "o backup chama backup-job.sh backup com o arquivo de ambiente /etc/luxora-backup/<ambiente>.env" || ko "ExecStart do backup"
grep -qE '^ExecStart=/usr/bin/bash /srv/luxora-app/infra/scripts/backup-job\.sh health --env-file /etc/luxora-backup/%i\.env$' "$UNITS/luxora-backup-health@.service" \
  && ok "a verificação chama backup-job.sh health com o arquivo de ambiente /etc/luxora-backup/<ambiente>.env" || ko "ExecStart da verificação"
[ "$(grep -h '^StateDirectory=' "$UNITS/luxora-backup@.service" "$UNITS/luxora-backup-health@.service" | sort -u | wc -l)" -eq 1 ] \
  && ok "o backup e a verificação usam o MESMO diretório de estado (a verificação lê o marcador que o backup grava)" || ko "diretórios de estado diferentes"
for t in luxora-backup@.timer luxora-backup-health@.timer; do
  grep -qx 'Persistent=true' "$UNITS/$t" && ok "$t recupera execução perdida (Persistent=true)" || ko "$t sem Persistent=true"
  grep -qx 'WantedBy=timers.target' "$UNITS/$t" && ok "$t se instala em timers.target" || ko "$t: [Install]"
done
grep -qx 'OnCalendar=\*-\*-\* 03:30:00 UTC' "$UNITS/luxora-backup@.timer" && ok "backup: uma vez por dia, 03:30 UTC" || ko "OnCalendar do backup"
grep -qx 'OnCalendar=\*-\*-\* \*:15:00 UTC' "$UNITS/luxora-backup-health@.timer" && ok "verificação: a cada hora, minuto 15 UTC" || ko "OnCalendar da verificação"
if grep -vh '^[[:space:]]*#' "$UNITS"/*.service "$UNITS"/*.timer | grep -qiE 'SECRET|PASSPHRASE|TOKEN|PASSWORD|API_KEY|PGPASS'; then ko "as unidades não podem carregar segredos"; else ok "as unidades não carregam segredos (tudo vem do arquivo de ambiente do backup e dos arquivos de senha)"; fi
! grep -q '^Environment=' "$UNITS"/*.timer && ok "os timers não definem variáveis" || ko "timer com Environment="
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
# =====================================================================================
# Identidade dedicada (luxora-backup): configuração separada, estado próprio, sem Docker.
# =====================================================================================
echo "== arquivo de ambiente do backup: permissões e separação dos segredos da aplicação"
refused() { # descrição código-esperado trecho-do-motivo
  if [ "$RC" -eq "$2" ] && grep -q -- "$3" "$WORK/out.txt" && grep -q 'ALERTA NÃO ENVIADO' "$WORK/out.txt" \
     && [ ! -s "$CALLS" 2>/dev/null ] && [ "$(nrecv)" -eq 0 ]; then ok "$1 (saída $RC; nada executado; notificador do arquivo não usado)"; else ko "$1 — rc=$RC, esperado $2 / $3"; fi
}
for m in 600 640 400; do
  fresh "$NOTIFIER_LINE"; chmod "$m" "$ENVF"; job backup
  expect_rc "backup com arquivo de ambiente $m é aceito" 0
done
fresh "$NOTIFIER_LINE"; chmod 640 "$ENVF"; set_marker 100; job health
expect_rc "verificação com arquivo de ambiente 640 é aceita" 0
for m in 644 664 660 604 620 777; do
  fresh "$NOTIFIER_LINE"; chmod "$m" "$ENVF"; job backup; refused "backup recusa arquivo de ambiente $m" 20 "arquivo-de-ambiente-com-permissao-$m"
done
fresh "$NOTIFIER_LINE"; chmod 644 "$ENVF"; set_marker 100; job health; refused "verificação recusa arquivo de ambiente 644" 13 "arquivo-de-ambiente-com-permissao-644"
if [ "$(id -u)" -eq 0 ]; then
  fresh "$NOTIFIER_LINE"; chown 12345 "$ENVF"; job backup; refused "backup recusa arquivo de ambiente de outro dono (nem root nem o usuário do serviço)" 20 "dono-inesperado"
else skip "arquivo de ambiente de outro dono (só dá para preparar como root)"; fi
for key in POSTGRES_ADMIN_PASSWORD POSTGRES_APP_PASSWORD POSTGRES_BACKUP_PASSWORD JWT_SECRET WHATSAPP_APP_SECRET ANTHROPIC_API_KEY ASAAS_API_KEY METRICS_ACCESS_TOKEN; do
  fresh "$NOTIFIER_LINE" "$key=valor-ficticio-da-aplicacao-ABC123"; job backup
  refused "backup recusa arquivo de ambiente com $key (segredo da aplicação)" 20 "segredo-da-aplicacao:$key"
  lacks "o valor de $key não aparece na saída" 'valor-ficticio-da-aplicacao-ABC123'
done
fresh "$NOTIFIER_LINE" "ANTHROPIC_API_KEY=" "JWT_SECRET="; job backup
expect_rc "chaves da aplicação presentes mas vazias não bloqueiam" 0
if command -v openssl >/dev/null 2>&1; then
  rm -f "$WORK/app.env"; bash "$REAL/generate-env.sh" "$WORK/app.env" staging >/dev/null 2>&1
  jobin "$SCR" backup --env-file "$WORK/app.env"
  if [ "$RC" -eq 20 ] && grep -q 'segredo-da-aplicacao' "$WORK/out.txt"; then ok "o arquivo de ambiente COMPLETO da aplicação (generate-env.sh) é recusado pelo executor do backup"; else ko "arquivo da aplicação aceito (rc=$RC)"; fi
else skip "openssl ausente: generate-env.sh não executado"; fi

echo "== estado do backup fora da pasta de configuração (LUXORA_STATE_DIR)"
fresh "$NOTIFIER_LINE"; STATE2="$WORK/estado-dedicado"; chmod 500 "$ENVD"
LUXORA_STATE_DIR="$STATE2" job backup
chmod 700 "$ENVD"
expect_rc "backup com estado em diretório próprio" 0
[ "$(stat -c %a "$STATE2")" = 700 ] && [ "$(stat -c %a "$STATE2/backup-job")" = 700 ] && ok "estado e estado do job com modo 700" || ko "modo do estado"
[ -s "$STATE2/last-external-backup" ] && ok "o marcador do último backup foi gravado no estado dedicado" || ko "marcador fora do estado dedicado"
[ "$(ls -A "$ENVD" | tr '\n' ' ')" = "staging.env " ] && ok "a pasta do arquivo de ambiente continua só com o arquivo (nada foi gravado nela)" || ko "gravou na pasta de configuração: $(ls -A "$ENVD" | tr '\n' ' ')"
LUXORA_STATE_DIR="$STATE2" job health
expect_rc "a verificação, com o mesmo estado, enxerga o backup recém-gravado" 0
has "idade lida do marcador do estado dedicado" 'estado=saudavel'
if [ "$(id -u)" -ne 0 ]; then
  fresh "$NOTIFIER_LINE"; chmod 500 "$ENVD"; job backup; chmod 700 "$ENVD"
  expect_rc "sem LUXORA_STATE_DIR e com a pasta de configuração somente leitura: recusa com clareza" 20
  has "diz que o estado não tem escrita" 'motivo=diretorio-de-estado-sem-escrita'
else skip "pasta de configuração somente leitura (root escreve em qualquer lugar)"; fi

echo "== cadeia real do push sem Docker, com arquivo de senhas e chave de cifragem (pg_dump e armazenamento simulados)"
if command -v gpg >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
  FB="$WORK/fakebin"; mkdir -p "$FB"
  cat > "$FB/docker" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$DOCKER_CALLS"; echo "docker simulado: o backup automático não pode usar o Docker" >&2; exit 97
EOF
  cat > "$FB/pg_dump" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = "--version" ] && { echo "pg_dump (PostgreSQL) 16.4"; exit 0; }
echo "$*" >> "$PG_CALLS"; echo "PGPASSFILE=${PGPASSFILE:-}" >> "$PG_CALLS"
echo "PGPASSWORD=${PGPASSWORD+set}" >> "$PG_CALLS"
head -c 200000 /dev/urandom
EOF
  cat > "$FB/pg_restore" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null; exit 0
EOF
  chmod 755 "$FB/docker" "$FB/pg_dump" "$FB/pg_restore"
  export DOCKER_CALLS="$WORK/docker.calls" PG_CALLS="$WORK/pg.calls"
  PGPASS="$WORK/real.pgpass"; PASSFILE="$WORK/real.key"
  full_env() { # [linhas extras]
    fresh "$NOTIFIER_LINE" \
      "POSTGRES_DB=luxora_staging" "BACKUP_S3_ENDPOINT=http://127.0.0.1:9" "BACKUP_S3_ALLOW_INSECURE_HTTP=1" "BACKUP_S3_REGION=sa-test-1" \
      "BACKUP_S3_BUCKET=bucket-ficticio" "BACKUP_S3_ACCESS_KEY_ID=AKIAFICTICIO0000" "BACKUP_ENCRYPTION_PASSPHRASE_FILE=$PASSFILE" \
      "BACKUP_PG_HOST=127.0.0.1" "BACKUP_PG_PORT=15432" "BACKUP_PG_USER=luxora_backup" "BACKUP_PG_PASSFILE=$PGPASS" "$@"
    : > "$DOCKER_CALLS"; : > "$PG_CALLS"
    printf '127.0.0.1:15432:luxora_staging:luxora_backup:senha-ficticia-do-pgpass\n' > "$PGPASS"; chmod 600 "$PGPASS"
    head -c 48 /dev/urandom | base64 > "$PASSFILE"; chmod 600 "$PASSFILE"
  }
  full_env "BACKUP_S3_SECRET_ACCESS_KEY=segredo-ficticio-s3"
  PATH="$FB:$PATH" STUB_X=1 jobin "$REALDIR" backup --env-file "$ENVF"
  expect_rc "check e push reais chegam ao envio e falham aí (armazenamento inexistente): backup_upload_failed" 21
  has "o dump e a cifragem rodaram no host" '1/4 dump \(pg_dump no host, luxora_backup@127.0.0.1:15432\)'
  has "o envio foi tentado e falhou" 'o envio falhou'
  [ ! -s "$DOCKER_CALLS" ] && ok "o Docker não foi chamado nenhuma vez (check, dump, cifragem e envio)" || ko "docker chamado: $(cat "$DOCKER_CALLS")"
  grep -q -- "--username luxora_backup --dbname luxora_staging --no-password -Fc" "$PG_CALLS" && ok "pg_dump com o papel de backup, o banco do ambiente e sem pedir senha" || ko "argumentos do pg_dump: $(head -n1 "$PG_CALLS")"
  grep -q "^PGPASSFILE=$PGPASS$" "$PG_CALLS" && ok "a senha vem só do arquivo de senhas indicado (PGPASSFILE)" || ko "PGPASSFILE"
  ! grep -q '^PGPASSWORD=set' "$PG_CALLS" && ! grep -q 'senha-ficticia-do-pgpass' "$PG_CALLS" "$WORK/out.txt" && ok "nenhuma senha em variável PGPASSWORD, argumento ou saída" || ko "senha exposta"
  tail -n 1 "$STATE/history.jsonl" | grep -q '"result":"failed-upload"' && ok "histórico registra failed-upload" || ko "histórico: $(tail -n 1 "$STATE/history.jsonl")"
  [ ! -e "$STATE/last-external-backup" ] && [ -z "$(ls -A "$STATE/tmp" 2>/dev/null)" ] && ok "sem marcador de sucesso e sem sobras no diretório temporário" || ko "marcador ou sobras"
  has "o alerta de falha foi entregue pelo notificador" '"kind":"backup_upload_failed"' "$NDIR/received/1.json"
  lacks "nada da senha nem dos segredos no evento" 'senha-ficticia|segredo-ficticio' "$NDIR/received/1.json"
  full_env; chmod 644 "$PGPASS"; PATH="$FB:$PATH" jobin "$REALDIR" backup --env-file "$ENVF"
  expect_rc "arquivo de senhas com permissão 644 impede o backup (check)" 20
  has "diz o motivo" 'permissão 644'
  full_env; PATH="$FB:$PATH" jobin "$REALDIR" backup --env-file "$ENVF" >/dev/null 2>&1; rm -f "$PGPASS"
  PATH="$FB:$PATH" jobin "$REALDIR" backup --env-file "$ENVF"
  expect_rc "arquivo de senhas ausente impede o backup (check)" 20
else skip "gpg ou curl ausente: cadeia real do push não executada"; fi

echo "== execução como usuário sem privilégios, sem grupo docker (só como root, com o usuário nobody; nada é criado)"
if [ "$(id -u)" -eq 0 ] && id nobody >/dev/null 2>&1 && command -v setpriv >/dev/null 2>&1 && [ -d "$WORK/fakebin" ]; then
  NG="$(id -g nobody)"; IDT="$WORK/ident"; rm -rf "$IDT"; mkdir -p "$IDT/etc" "$IDT/scripts" "$IDT/estado" "$IDT/app"
  chmod 711 "$WORK"; cp "$REAL"/*.sh "$IDT/scripts/"; chmod -R a+rX "$IDT/scripts"; chmod 755 "$IDT" "$IDT/scripts"
  chown root:"$NG" "$IDT/etc"; chmod 750 "$IDT/etc"; chown nobody:"$NG" "$IDT/estado"; chmod 700 "$IDT/estado"
  chmod 755 "$FB" "$FB"/*
  { echo 'APP_ENV=staging'; echo 'POSTGRES_DB=luxora_staging'; echo 'BACKUP_S3_ENDPOINT=http://127.0.0.1:9'; echo 'BACKUP_S3_ALLOW_INSECURE_HTTP=1'
    echo 'BACKUP_S3_REGION=sa-test-1'; echo 'BACKUP_S3_BUCKET=bucket-ficticio'; echo 'BACKUP_S3_ACCESS_KEY_ID=AKIAFICTICIO0000'; echo 'BACKUP_S3_SECRET_ACCESS_KEY=segredo-ficticio-s3'
    echo "BACKUP_ENCRYPTION_PASSPHRASE_FILE=$IDT/etc/backup.key"; echo 'BACKUP_PG_HOST=127.0.0.1'; echo 'BACKUP_PG_PORT=15432'; echo 'BACKUP_PG_USER=luxora_backup'
    echo "BACKUP_PG_PASSFILE=$IDT/etc/backup.pgpass"; } > "$IDT/etc/staging.env"
  chown root:"$NG" "$IDT/etc/staging.env"; chmod 640 "$IDT/etc/staging.env"
  head -c 48 /dev/urandom | base64 > "$IDT/etc/backup.key"; printf '127.0.0.1:15432:luxora_staging:luxora_backup:senha-ficticia-do-pgpass\n' > "$IDT/etc/backup.pgpass"
  chown nobody:"$NG" "$IDT/etc/backup.key" "$IDT/etc/backup.pgpass"; chmod 400 "$IDT/etc/backup.key" "$IDT/etc/backup.pgpass"
  echo 'POSTGRES_ADMIN_PASSWORD=segredo-ficticio-da-aplicacao' > "$IDT/app/staging.env"; chmod 600 "$IDT/app/staging.env"
  asnobody() { setpriv --reuid=nobody --regid="$NG" --clear-groups env -i PATH="$FB:/usr/bin:/bin" HOME=/nonexistent TMPDIR="$IDT/tmp" "$@"; }
  mkdir -p "$IDT/tmp"; chown nobody:"$NG" "$IDT/tmp"; chmod 700 "$IDT/tmp"; : > "$DOCKER_CALLS"; : > "$PG_CALLS"; chmod 666 "$DOCKER_CALLS" "$PG_CALLS"
  asnobody sh -c 'id -nG' > "$WORK/out.txt" 2>&1
  ! grep -qwE 'docker|sudo|root|adm' "$WORK/out.txt" && ok "o usuário do teste não está nos grupos docker, sudo, root nem adm ($(tr -d '\n' < "$WORK/out.txt"))" || ko "grupos privilegiados: $(cat "$WORK/out.txt")"
  asnobody cat "$IDT/app/staging.env" >"$WORK/out.txt" 2>&1 && ko "o usuário sem privilégios leu o ambiente da aplicação" || ok "o ambiente da aplicação (modo 600 de outro dono) não é legível pelo usuário do backup"
  asnobody touch "$IDT/etc/novo" >"$WORK/out.txt" 2>&1 && { ko "o usuário gravou na pasta de configuração"; rm -f "$IDT/etc/novo"; } || ok "a pasta de configuração é somente leitura para o usuário do backup"
  asnobody sh -c "echo x >> '$IDT/etc/staging.env'" >"$WORK/out.txt" 2>&1 && ko "o usuário alterou o arquivo de ambiente" || ok "o arquivo de ambiente (root:grupo 640) não pode ser alterado pelo usuário do backup"
  asnobody env LUXORA_STATE_DIR="$IDT/estado" DOCKER_CALLS="$DOCKER_CALLS" PG_CALLS="$PG_CALLS" bash "$IDT/scripts/backup-job.sh" backup --env-file "$IDT/etc/staging.env" >"$WORK/out.txt" 2>&1; RC=$?
  expect_rc "backup como usuário sem privilégios: chega ao envio e falha aí (armazenamento inexistente)" 21
  has "o dump e a cifragem rodaram" '1/4 dump'
  [ ! -s "$DOCKER_CALLS" ] && ok "o Docker não foi chamado" || ko "docker chamado"
  [ "$(stat -c %U:%a "$IDT/estado")" = "nobody:700" ] && [ -s "$IDT/estado/history.jsonl" ] && [ "$(stat -c %U "$IDT/estado/history.jsonl")" = nobody ] && ok "estado e histórico são do usuário do backup (700)" || ko "dono do estado"
  [ "$(stat -c %U:%G:%a "$IDT/etc/staging.env")" = "root:$(getent group "$NG" | cut -d: -f1):640" ] && [ "$(ls -A "$IDT/etc" | tr '\n' ' ')" = "backup.key backup.pgpass staging.env " ] && ok "a pasta de configuração ficou intacta (mesmos arquivos, mesmos donos e modos)" || ko "pasta de configuração alterada"
  grep -q -- 'senha-ficticia\|segredo-ficticio' "$WORK/out.txt" && ko "segredo na saída" || ok "nenhum segredo na saída do serviço"
  chown root:"$NG" "$IDT/etc/backup.pgpass"
  asnobody env LUXORA_STATE_DIR="$IDT/estado" bash "$IDT/scripts/backup-job.sh" backup --env-file "$IDT/etc/staging.env" >"$WORK/out.txt" 2>&1; RC=$?
  expect_rc "arquivo de senhas que não é do usuário do backup (root, 400) é recusado" 20
  has "o usuário do backup não consegue usá-lo" 'BACKUP_PG_PASSFILE\) não encontrado ou ilegível'
  chown nobody:"$NG" "$IDT/etc/backup.pgpass"; echo 'POSTGRES_APP_PASSWORD=segredo-ficticio-da-aplicacao' >> "$IDT/etc/staging.env"
  asnobody env LUXORA_STATE_DIR="$IDT/estado" bash "$IDT/scripts/backup-job.sh" backup --env-file "$IDT/etc/staging.env" >"$WORK/out.txt" 2>&1; RC=$?
  expect_rc "arquivo de ambiente do backup com segredo da aplicação é recusado" 20
  has "diz qual chave" 'segredo-da-aplicacao:POSTGRES_APP_PASSWORD'
else skip "execução como nobody: precisa de root, do usuário nobody, do setpriv e da seção anterior"; fi

echo "Resultado: $PASSED verificações ok, $FAILED falhas, $SKIPPED puladas"
[ "$FAILED" -eq 0 ]
