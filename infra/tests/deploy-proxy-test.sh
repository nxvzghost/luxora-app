#!/usr/bin/env bash
# Luxora — teste do resultado do proxy HTTPS em infra/scripts/deploy.sh (A-12).
#
#   bash infra/tests/deploy-proxy-test.sh
#
# Roda o deploy.sh INTEIRO (o do repositório, sem cópia nem extração) contra um docker e
# um curl SIMULADOS, colocados na frente do PATH: nenhum contêiner é iniciado, nenhuma
# imagem é baixada, nenhuma conexão é aberta e nenhuma credencial é usada. Tudo (arquivos
# de ambiente, estado do deploy, histórico) fica num diretório temporário apagado ao final.
#
# Confere, para cada cenário, o código de saída, a linha final, os eventos em
# history.jsonl (o `success` da aplicação preservado, o evento `proxy` separado e no mesmo
# esquema) e as chamadas feitas ao docker simulado. Cobre também os códigos 1, 2 e 3 e o
# rollback automático, que acontecem antes do bloco do proxy.
#
# O que NÃO prova: o Caddy real, o Docker Compose real, o DNS, o certificado e o CD real.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$HERE/../scripts/deploy.sh"
[ -f "$DEPLOY" ] || { echo "deploy.sh não encontrado: $DEPLOY"; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

# ---- docker simulado ----------------------------------------------------------------
cat > "$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
args="$*"
first="${args%%$'\n'*}"
if [ "$1" = "image" ]; then   # image inspect [-f formato] referência
  echo "${first:0:160}" >> "$DOCKER_CALLS"
  case "$args" in *" -f "*) echo "" ;; esac
  exit 0
fi
[ "$1" = "compose" ] || { echo "docker simulado: comando inesperado: $first" >&2; exit 99; }
shift
while [ $# -gt 0 ]; do
  case "$1" in -p|--env-file|-f) shift 2 ;; *) break ;; esac
done
sub="$*"
first="${sub%%$'\n'*}"
echo "compose ${first:0:160}" >> "$DOCKER_CALLS"   # só o subcomando: sem os caminhos temporários
case "$sub" in
  "up -d --wait postgres redis") exit 0 ;;
  *"exec -T postgres pg_dump"*)
    [ "${FAKE_DUMP_EMPTY:-0}" = "1" ] || printf 'PGDMP-simulado'
    exit 0 ;;
  *"exec -T postgres pg_restore --list"*) cat > /dev/null; exit 0 ;;
  *"exec -T postgres psql"*)
    case "$sub" in *to_regclass*) echo f ;; *) echo ;; esac
    exit 0 ;;
  *"--profile tools run --rm migrate"*) exit 0 ;;
  *"up -d --no-deps backend"*) echo "${BACKEND_IMAGE##*:}" > "$FAKE_RUNNING"; exit 0 ;;
  *"stop backend"*) : > "$FAKE_RUNNING"; exit 0 ;;
  *"--profile frontend up -d --no-deps frontend"*) exit 0 ;;
  *"--profile proxy up -d --no-deps caddy"*)
    if [ "${FAKE_BREAK_HISTORY:-0}" = "1" ]; then rm -f "$FAKE_HISTORY"; mkdir "$FAKE_HISTORY"; fi
    exit "${FAKE_CADDY_UP_RC:-0}" ;;
  *"exec -T caddy caddy reload"*) exit "${FAKE_CADDY_RELOAD_RC:-0}" ;;
  *"ps -a"*|logs*) exit 0 ;;
  *) echo "docker simulado: comando inesperado: ${sub%%$'\n'*}" >&2; exit 99 ;;
esac
EOF

# ---- curl simulado: readiness, versão em execução e smoke ---------------------------
cat > "$WORK/bin/curl" <<'EOF'
#!/usr/bin/env bash
url="${*: -1}"
running="$(cat "$FAKE_RUNNING" 2>/dev/null || true)"
case "$*" in
  *"-w"*)
    case "$url" in
      */health/ready)
        if [ -n "$running" ] && [ "$running" != "${FAKE_BAD_VERSION:-}" ]; then printf 200; else printf 503; fi ;;
      */auth/login) printf 401 ;;
      *) printf 000 ;;
    esac ;;
  *) [ -z "$running" ] || printf '{"version":"%s"}' "$running" ;;
esac
exit 0
EOF
chmod +x "$WORK/bin/docker" "$WORK/bin/curl"

PASSED=0; FAILED=0
ok() { PASSED=$((PASSED + 1)); echo "  ok    $1"; }
ko() { FAILED=$((FAILED + 1)); echo "  FALHA $1"; sed 's/^/        | /' "$D/out" | tail -n 6; }

HOSTS=$'PUBLIC_API_HOST=api.teste.invalid\nPUBLIC_PANEL_HOST=painel.teste.invalid'
OKMAIL="ACME_EMAIL=ops@teste.invalid"

# cenario NOME "linhas do ambiente" [versão anterior]. O que o docker/curl simulado deve fazer
# vem do vetor FAKE (VAR=valor). READY_TIMEOUT: prazo do readiness; 10 s não gasta tempo quando a
# versão fica pronta de imediato, e 3 s só nos cenários em que ela nunca fica (cerca de 4 s de espera cada). Com 1 s o laço do
# readiness pode nem rodar (o relógio vira o segundo antes da primeira volta) e derrubaria o rollback.
scenario() {
  local name="$1" envlines="$2" previous="${3:-}"
  D="$WORK/$name"; mkdir -p "$D/luxora-deploy-state"
  printf 'APP_ENV=staging\nPOSTGRES_DB=luxora_staging\n%s\n' "$envlines" > "$D/staging.env"
  [ -z "$previous" ] || printf '%s\n' "$previous" > "$D/luxora-deploy-state/current-version"
  : > "$D/calls"; printf '%s' "$previous" > "$D/running"
  HIST="$D/luxora-deploy-state/history.jsonl"
  env DOCKER_CALLS="$D/calls" FAKE_RUNNING="$D/running" FAKE_HISTORY="$HIST" \
      PATH="$WORK/bin:$PATH" READY_TIMEOUT_SECONDS="${READY_TIMEOUT:-10}" \
      ${FAKE[@]+"${FAKE[@]}"} \
      bash "$DEPLOY" --env-file "$D/staging.env" --version v-novo --frontend-version v-novo > "$D/out" 2>&1
  RC=$?
  FINAL="$(tail -n 1 "$D/out")"
  echo; echo "### $name"
}
FAKE=()

expect_rc() { if [ "$RC" -eq "$1" ]; then ok "código de saída $RC"; else ko "código de saída: esperado $1, obtido $RC"; fi; }
final_has() { if printf '%s' "$FINAL" | grep -qF -- "$1"; then ok "linha final contém: $1"; else ko "linha final sem: $1 — era: $FINAL"; fi; }
final_lacks() { if printf '%s' "$FINAL" | grep -qF -- "$1"; then ko "linha final não deveria conter: $1 — era: $FINAL"; else ok "linha final não contém: $1"; fi; }
out_has() { if grep -qF -- "$1" "$D/out"; then ok "saída contém: $1"; else ko "saída sem: $1"; fi; }
calls_count() { grep -cF -- "$1" "$D/calls" || true; }
expect_calls() { # descrição trecho esperado
  local n; n="$(calls_count "$2")"
  if [ "$n" -eq "$3" ]; then ok "$1 ($n chamada(s))"; else ko "$1: esperado $3, obtido $n"; fi
}
success_events() { grep -c '"action":"deploy".*"result":"success"' "$HIST" 2>/dev/null || true; }
proxy_events() { grep -c '"action":"proxy"' "$HIST" 2>/dev/null || true; }
proxy_result() { sed -n 's/.*"action":"proxy".*"result":"\([^"]*\)".*/\1/p' "$HIST" 2>/dev/null | tail -n 1; }
keys_of() { grep -o '"[a-z]*":' | tr -d '\n'; }
expect_success_kept() {
  if [ "$(success_events)" -eq 1 ]; then ok "evento success da aplicação preservado (1)"; else ko "eventos success: $(success_events)"; fi
}
expect_proxy_event() { # resultado esperado
  if [ "$(proxy_events)" -eq 1 ] && [ "$(proxy_result)" = "$1" ]; then ok "evento proxy separado: result=$1"; else ko "evento proxy: $(proxy_events) evento(s), result=$(proxy_result), esperado $1"; fi
  local s p
  s="$(grep '"action":"deploy".*"result":"success"' "$HIST" | head -n 1 | keys_of)"
  p="$(grep '"action":"proxy"' "$HIST" | head -n 1 | keys_of)"
  if [ -n "$p" ] && [ "$s" = "$p" ]; then ok "evento proxy no mesmo esquema do success"; else ko "esquema do evento proxy difere do success"; fi
  local ls lp
  ls="$(grep -n '"action":"deploy".*"result":"success"' "$HIST" | head -n 1 | cut -d: -f1)"
  lp="$(grep -n '"action":"proxy"' "$HIST" | head -n 1 | cut -d: -f1)"
  if [ -n "$ls" ] && [ -n "$lp" ] && [ "$ls" -lt "$lp" ]; then ok "o evento proxy vem depois do success"; else ko "ordem dos eventos"; fi
}
expect_no_proxy_event() { if [ "$(proxy_events)" -eq 0 ]; then ok "nenhum evento proxy no histórico"; else ko "evento proxy inesperado"; fi; }

# =========================== 1. hosts não preenchidos ================================
scenario hosts-vazios $'PUBLIC_API_HOST=\nPUBLIC_PANEL_HOST=\n'"$OKMAIL" ""
expect_rc 0
final_has "6/6 deploy concluído: v-novo"
final_has "proxy HTTPS não configurado"
final_has "aplicação acessível só pelo loopback do host"
final_lacks "PARCIALMENTE"
expect_calls "Caddy não ativado" "profile proxy" 0
expect_success_kept; expect_no_proxy_event

scenario so-um-host $'PUBLIC_API_HOST=api.teste.invalid\nPUBLIC_PANEL_HOST=\n'"$OKMAIL" ""
expect_rc 0
final_has "proxy HTTPS não configurado"
final_lacks "PARCIALMENTE"
expect_calls "Caddy não ativado" "profile proxy" 0
expect_no_proxy_event

# =========================== 2. ACME_EMAIL ausente ou inválido =======================
for caso in "vazio|ACME_EMAIL=" "ausente|" "invalido|ACME_EMAIL=nao-e-um-email" "com-espaco|ACME_EMAIL=a b@teste.invalid"; do
  scenario "email-${caso%%|*}" "$HOSTS"$'\n'"${caso#*|}" ""
  expect_rc 0
  out_has "AVISO: ACME_EMAIL ausente ou inválido"
  final_has "6/6 deploy concluído PARCIALMENTE: v-novo"
  final_has "proxy HTTPS NÃO iniciado nesta tentativa (ACME_EMAIL ausente ou inválido)"
  final_has "HTTPS não validado"
  expect_calls "Caddy não iniciado" "profile proxy" 0
  expect_calls "Caddy não recarregado" "caddy reload" 0
  expect_success_kept; expect_proxy_event not-started
done

# =========================== 3. o Caddy não sobe =====================================
FAKE=(FAKE_CADDY_UP_RC=1)
scenario caddy-nao-sobe "$HOSTS"$'\n'"$OKMAIL" ""
FAKE=()
expect_rc 0
out_has "AVISO: o Caddy não subiu nesta tentativa"
final_has "6/6 deploy concluído PARCIALMENTE: v-novo"
final_has "o Caddy não subiu"
final_has "o estado de um proxy anterior, se existir, não foi confirmado"
final_lacks "indisponível"
expect_calls "tentativa de subir o Caddy" "profile proxy up -d --no-deps caddy" 1
expect_calls "sem reload depois da falha" "caddy reload" 0
expect_success_kept; expect_proxy_event start-failed

# =========================== 4. o reload falha =======================================
FAKE=(FAKE_CADDY_RELOAD_RC=1)
scenario reload-falha "$HOSTS"$'\n'"$OKMAIL" ""
FAKE=()
expect_rc 0
out_has "AVISO: o Caddy não recarregou a configuração"
final_has "6/6 deploy concluído PARCIALMENTE: v-novo"
final_has "a configuração NÃO foi recarregada (pode continuar com a anterior)"
final_lacks "configuração recarregada"
expect_calls "Caddy iniciado" "profile proxy up -d --no-deps caddy" 1
expect_calls "reload tentado" "caddy reload" 1
expect_success_kept; expect_proxy_event reload-failed

# =========================== 5. Caddy iniciado e recarregado =========================
scenario caddy-ok "$HOSTS"$'\n'"$OKMAIL" ""
expect_rc 0
final_has "6/6 deploy concluído: v-novo"
final_has "proxy Caddy iniciado e configuração recarregada"
final_has "certificado e acesso por HTTPS não são verificados por este script"
final_lacks "PARCIALMENTE"
final_lacks "HTTPS validado"
expect_calls "Caddy iniciado" "profile proxy up -d --no-deps caddy" 1
expect_calls "reload feito" "caddy reload" 1
expect_calls "só o caddy foi tocado pelo bloco do proxy" "up -d --no-deps backend" 1
expect_success_kept; expect_proxy_event reloaded

# =========================== 6. o evento do proxy não pode ser gravado ===============
FAKE=(FAKE_BREAK_HISTORY=1 FAKE_CADDY_RELOAD_RC=1)
scenario historico-falha-parcial "$HOSTS"$'\n'"$OKMAIL" ""
FAKE=()
expect_rc 0
out_has "AVISO: não foi possível gravar o evento do proxy no history.jsonl"
final_has "6/6 deploy concluído PARCIALMENTE"
final_has "o evento do proxy NÃO foi gravado no history.jsonl"

FAKE=(FAKE_BREAK_HISTORY=1)
scenario historico-falha-ok "$HOSTS"$'\n'"$OKMAIL" ""
FAKE=()
expect_rc 0
final_has "proxy Caddy iniciado e configuração recarregada"
final_has "o evento do proxy NÃO foi gravado no history.jsonl"

# =========================== 7. códigos 1, 2 e 3 e rollback preservados ==============
# Falham antes do bloco do proxy: o proxy não pode ser tocado, mesmo com tudo configurado.
FAKE=(FAKE_DUMP_EMPTY=1)
scenario codigo-3-backup "$HOSTS"$'\n'"$OKMAIL" "v-antiga"
FAKE=()
expect_rc 3
out_has "backup falhou — nada foi alterado"
expect_calls "a aplicação não foi trocada" "up -d --no-deps backend" 0
expect_calls "o proxy não foi tocado" "profile proxy" 0
if grep -qF '"result":"failed-backup"' "$HIST"; then ok "histórico: failed-backup"; else ko "histórico sem failed-backup"; fi
expect_no_proxy_event

FAKE=(FAKE_BAD_VERSION=v-novo)
READY_TIMEOUT=3 scenario codigo-2-primeiro-deploy "$HOSTS"$'\n'"$OKMAIL" ""
FAKE=()
expect_rc 2
out_has "não há versão anterior para restaurar (primeiro deploy) — aplicação parada"
expect_calls "aplicação parada" "stop backend" 1
expect_calls "o proxy não foi tocado" "profile proxy" 0
if grep -qF '"result":"failed-no-previous"' "$HIST"; then ok "histórico: failed-no-previous"; else ko "histórico sem failed-no-previous"; fi
expect_no_proxy_event

FAKE=(FAKE_BAD_VERSION=v-novo)
READY_TIMEOUT=3 scenario codigo-1-rollback "$HOSTS"$'\n'"$OKMAIL" "v-antiga"
FAKE=()
expect_rc 1
out_has "ROLLBACK AUTOMÁTICO para v-antiga"
out_has "a versão v-antiga foi restaurada e está pronta"
if [ "$(cat "$D/running")" = "v-antiga" ]; then ok "a versão anterior ficou no ar"; else ko "versão no ar: $(cat "$D/running")"; fi
expect_calls "o proxy não foi tocado" "profile proxy" 0
if grep -qF '"result":"rolled-back"' "$HIST"; then ok "histórico: rolled-back"; else ko "histórico sem rolled-back"; fi
if [ "$(success_events)" -eq 0 ]; then ok "nenhum success registrado"; else ko "success indevido"; fi
expect_no_proxy_event

echo
echo "Resultado: $PASSED verificações ok, $FAILED falhas"
[ "$FAILED" -eq 0 ]
