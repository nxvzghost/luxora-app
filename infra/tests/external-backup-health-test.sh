#!/usr/bin/env bash
# Luxora — teste de infra/scripts/external-backup-health.sh (A-12).
#
#   bash infra/tests/external-backup-health-test.sh
#
# Isolado: diretórios temporários, marcadores fictícios e "agora" fixo
# (BACKUP_HEALTH_NOW_EPOCH), então o resultado não depende do relógio da máquina.
# Não usa docker, banco, armazenamento, rede nem credencial. Roda no CI, no job
# deploy-rehearsal, antes do build das imagens.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../scripts/external-backup-health.sh"

WORK="$(mktemp -d)"; chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

NOW=1793000000            # instante fixo de referência
PASSED=0; FAILED=0; SKIPPED=0
ok() { PASSED=$((PASSED + 1)); echo "  ok    $1"; }
ko() { FAILED=$((FAILED + 1)); echo "  FALHA $1"; sed 's/^/        | /' "$WORK/out.txt" | tail -n 4; }
skip() { SKIPPED=$((SKIPPED + 1)); echo "  pulou $1"; }

# Chave de objeto com o horário de (NOW - segundos), no formato que o external-backup.sh grava.
key_at() { # segundos-atrás
  printf 'luxora-teste/staging/luxora_staging/%s-%s.dump.gpg' "$(date -u -d "@$((NOW - $1))" +%Y%m%dT%H%M%SZ)" "a1b2c3d4"
}
new_state() { # nome -> diretório de estado vazio
  local d="$WORK/$1"; rm -rf "$d"; mkdir -p "$d"; printf '%s' "$d"
}
HC() { BACKUP_HEALTH_NOW_EPOCH="$NOW" bash "$SCRIPT" "$@" >"$WORK/out.txt" 2>"$WORK/err.txt"; }
expect() { # descrição código-esperado trecho-esperado-na-saída
  local rc=$RC
  if [ "$rc" -ne "$2" ]; then ko "$1 — esperado $2, obtido $rc"; return; fi
  if [ -n "${3:-}" ] && ! grep -qF -- "$3" "$WORK/out.txt"; then ko "$1 — a saída não tem: $3"; return; fi
  ok "$1 (saída $rc)"
}
SEEN_CODES=""
run() { HC "$@"; RC=$?; SEEN_CODES="$SEEN_CODES $RC"; }

echo "== backup recente e limite"
S="$(new_state recente)"; printf '%s\n' "$(key_at 11520)" > "$S/last-external-backup"   # 3h12m
run --state-dir "$S"
expect "backup recente (3h12m, limite padrão 26h)" 0 "estado=saudavel"
grep -qF "idade=3h12m" "$WORK/out.txt" && ok "informa a idade" || ko "idade não informada"
grep -qF "limite=26h" "$WORK/out.txt" && ok "informa o limite padrão" || ko "limite não informado"

printf '%s\n' "$(key_at 93599)" > "$S/last-external-backup"   # 25h59m59s
run --state-dir "$S"
expect "um segundo antes do limite padrão (25h59m59s)" 0 "estado=saudavel"
printf '%s\n' "$(key_at 93600)" > "$S/last-external-backup"   # exatamente 26h
run --state-dir "$S"
expect "exatamente no limite padrão (26h00m00s) já é atraso" 11 "estado=atrasado"
printf '%s\n' "$(key_at 93601)" > "$S/last-external-backup"   # 1 segundo além
run --state-dir "$S"
expect "um segundo além do limite (26h00m01s)" 11 "estado=atrasado"

printf '%s\n' "$(key_at 108000)" > "$S/last-external-backup"   # 30h
run --state-dir "$S"
expect "backup atrasado (30h)" 11 "estado=atrasado"
grep -qF "idade=30h00m" "$WORK/out.txt" && ok "informa a idade do atrasado" || ko "idade do atrasado não informada"

echo "== limite configurável"
printf '%s\n' "$(key_at 10800)" > "$S/last-external-backup"   # 3h
BACKUP_MAX_AGE_HOURS=2 run --state-dir "$S"
expect "limite de 2h com backup de 3h" 11 "limite=2h"
BACKUP_MAX_AGE_HOURS=3 run --state-dir "$S"
expect "limite de 3h com backup de exatamente 3h já é atraso" 11 "estado=atrasado"
printf '%s\n' "$(key_at 10799)" > "$S/last-external-backup"   # 2h59m59s
BACKUP_MAX_AGE_HOURS=3 run --state-dir "$S"
expect "limite de 3h com backup de 2h59m59s" 0 "estado=saudavel"
printf '%s\n' "$(key_at 10800)" > "$S/last-external-backup"   # volta para 3h
BACKUP_MAX_AGE_HOURS=8760 run --state-dir "$S"
expect "limite máximo aceito (8760)" 0
E="$WORK/staging.env"; printf 'APP_ENV=staging\nBACKUP_MAX_AGE_HOURS="2"\n' > "$E"
mkdir -p "$WORK/luxora-deploy-state"; printf '%s\n' "$(key_at 10800)" > "$WORK/luxora-deploy-state/last-external-backup"
run --env-file "$E"
expect "limite lido do arquivo de ambiente (2h) com --env-file" 11 "limite=2h"
BACKUP_MAX_AGE_HOURS=4 run --env-file "$E"
expect "o ambiente do processo vence o arquivo (4h)" 0 "limite=4h"

echo "== marcador ausente"
S="$(new_state vazio)"
run --state-dir "$S"
expect "diretório de estado sem marcador" 10 "estado=ausente"
E2="$WORK/sem-estado/staging.env"; mkdir -p "$WORK/sem-estado"; printf 'APP_ENV=staging\n' > "$E2"
run --env-file "$E2"
expect "--env-file sem diretório de estado" 10 "estado=ausente"
[ ! -e "$WORK/sem-estado/luxora-deploy-state" ] && ok "o verificador não criou o diretório de estado" || ko "o verificador criou o diretório de estado"

echo "== marcador inválido ou ilegível"
bad() { # descrição conteúdo-literal
  S="$(new_state invalido)"; printf '%b' "$2" > "$S/last-external-backup"
  run --state-dir "$S"; expect "$1" 12 "estado=marcador-invalido"
}
bad "marcador vazio" ""
bad "marcador com lixo" "isto não é uma chave\n"
bad "marcador sem horário no nome" "luxora-teste/staging/luxora_staging/backup.dump.gpg\n"
bad "marcador com mais de uma linha" "$(key_at 100)\n$(key_at 200)\n"
bad "marcador com .." "luxora-teste/../staging/$(date -u -d "@$((NOW - 100))" +%Y%m%dT%H%M%SZ)-a1b2c3d4.dump.gpg\n"
bad "marcador com 30 de fevereiro" "luxora-teste/x/20260230T120000Z-a1b2c3d4.dump.gpg\n"
bad "marcador com mês 13" "luxora-teste/x/20261301T120000Z-a1b2c3d4.dump.gpg\n"
bad "marcador com hora 25" "luxora-teste/x/20261029T250000Z-a1b2c3d4.dump.gpg\n"
bad "marcador com sufixo estranho" "luxora-teste/x/$(date -u -d "@$((NOW - 100))" +%Y%m%dT%H%M%SZ)-a1b2c3d4.dump.gpg.bak\n"
bad "marcador muito grande" "$(head -c 3000 /dev/zero | tr '\0' 'a')\n"
S="$(new_state futuro-longe)"; printf '%s\n' "$(key_at -7200)" > "$S/last-external-backup"   # 2h no futuro
run --state-dir "$S"; expect "horário 2h no futuro (relógio ou marcador errado)" 12 "estado=marcador-invalido"
S="$(new_state futuro-perto)"; printf '%s\n' "$(key_at -60)" > "$S/last-external-backup"       # 1 min no futuro
run --state-dir "$S"; expect "horário 1 min no futuro é tolerado" 0 "idade=0h00m"
S="$(new_state diretorio)"; mkdir "$S/last-external-backup"
run --state-dir "$S"; expect "marcador que é um diretório" 12 "estado=marcador-invalido"
S="$(new_state ilegivel)"; printf '%s\n' "$(key_at 100)" > "$S/last-external-backup"; chmod 000 "$S/last-external-backup"
if [ "$(id -u)" -eq 0 ]; then
  skip "marcador sem permissão de leitura (root lê qualquer arquivo; roda como usuário comum no CI)"
else
  run --state-dir "$S"; expect "marcador sem permissão de leitura" 12 "estado=marcador-invalido"
fi
chmod 600 "$S/last-external-backup" 2>/dev/null

echo "== a idade não vem da data de modificação do arquivo"
S="$(new_state mtime)"; printf '%s\n' "$(key_at 3600)" > "$S/last-external-backup"
touch -d '2020-01-01 00:00:00' "$S/last-external-backup"
run --state-dir "$S"; expect "arquivo antigo, backup recente no nome" 0 "estado=saudavel"
printf '%s\n' "$(key_at 200000)" > "$S/last-external-backup"; touch "$S/last-external-backup"
run --state-dir "$S"; expect "arquivo novo, backup antigo no nome" 11 "estado=atrasado"

echo "== configuração inválida"
S="$(new_state config)"; printf '%s\n' "$(key_at 100)" > "$S/last-external-backup"
for v in abc 0 -5 26.5 99999 8761 " 26" "26h" "0x1A"; do
  BACKUP_MAX_AGE_HOURS="$v" run --state-dir "$S"; expect "BACKUP_MAX_AGE_HOURS='$v'" 13 "estado=configuracao-invalida"
done
BACKUP_MAX_AGE_HOURS="" run --state-dir "$S"; expect "BACKUP_MAX_AGE_HOURS vazio vale como ausente (padrão)" 0 "limite=26h"
run; expect "sem argumentos" 13 "estado=configuracao-invalida"
run --state-dir; expect "--state-dir sem valor" 13 "estado=configuracao-invalida"
run --state-dir "$S" --env-file "$E"; expect "--state-dir e --env-file juntos" 13 "estado=configuracao-invalida"
run --state-dir "$S" --qualquer; expect "argumento desconhecido" 13 "estado=configuracao-invalida"
run --state-dir "$WORK/nao-existe"; expect "--state-dir inexistente (erro de digitação, não 'ausente')" 13 "estado=configuracao-invalida"
run --env-file "$WORK/nao-existe.env"; expect "--env-file inexistente" 13 "estado=configuracao-invalida"
BACKUP_HEALTH_NOW_EPOCH="abc" bash "$SCRIPT" --state-dir "$S" >"$WORK/out.txt" 2>&1; RC=$?
expect "BACKUP_HEALTH_NOW_EPOCH inválida" 13 "estado=configuracao-invalida"

echo "== códigos distintos e nada sensível na saída"
seen="$(printf '%s\n' $SEEN_CODES | sort -n | uniq | tr '\n' ' ')"
[ "$seen" = "0 10 11 12 13 " ] && ok "os testes observaram exatamente os códigos 0, 10, 11, 12 e 13 (nenhum é 1, 2 ou 3, usados por deploy.sh e external-backup.sh)" || { echo "  FALHA códigos observados: $seen"; FAILED=$((FAILED + 1)); }
S="$(new_state sigilo)"; printf '%s\n' "luxora-prefixo-secreto/staging/banco_secreto/$(date -u -d "@$((NOW - 100))" +%Y%m%dT%H%M%SZ)-a1b2c3d4.dump.gpg" > "$S/last-external-backup"
printf '{"timestamp":"x","notes":"SEGREDO-FICTICIO-NO-HISTORICO sha256=deadbeef"}\n' > "$S/history.jsonl"
E3="$WORK/sigilo.env"; printf 'APP_ENV=staging\nBACKUP_S3_SECRET_ACCESS_KEY=SEGREDO-FICTICIO-NO-ENV\n' > "$E3"
run --state-dir "$S"
expect "estado com histórico e marcador sensíveis" 0 "estado=saudavel"
if grep -qE 'SEGREDO|secreto|deadbeef|luxora-prefixo|banco_' "$WORK/out.txt" "$WORK/err.txt"; then ko "a saída vazou chave, histórico ou segredo"; else ok "a saída não mostra a chave do objeto nem o histórico"; fi
mkdir -p "$WORK/luxora-deploy-state"; cp "$S/last-external-backup" "$WORK/luxora-deploy-state/"
run --env-file "$E3"
if grep -qE 'SEGREDO' "$WORK/out.txt" "$WORK/err.txt"; then ko "a saída vazou o conteúdo do arquivo de ambiente"; else ok "a saída não mostra o conteúdo do arquivo de ambiente"; fi

echo "== só leitura"
S="$(new_state somente-leitura)"; printf '%s\n' "$(key_at 100)" > "$S/last-external-backup"
before="$(cd "$S" && find . -printf '%p %s %T@\n' | sort | sha256sum)"
run --state-dir "$S"; run --state-dir "$S"
after="$(cd "$S" && find . -printf '%p %s %T@\n' | sort | sha256sum)"
[ "$before" = "$after" ] && ok "o diretório de estado não foi alterado" || ko "o verificador alterou o estado"

echo
echo "Resultado: $PASSED verificações ok, $FAILED falhas, $SKIPPED puladas"
[ "$FAILED" -eq 0 ]
