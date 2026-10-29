#!/usr/bin/env bash
# Luxora — teste local de infra/scripts/external-backup.sh (A-12).
#
#   bash infra/tests/external-backup-test.sh
#
# Isolado: docker SIMULADO (um script no PATH que finge pg_dump e pg_restore --list),
# armazenamento S3 FALSO em 127.0.0.1 (infra/tests/support/mock-s3.js, precisa de
# node), dados e segredos fictícios, tudo num diretório temporário apagado ao final.
# Não usa banco, contêiner, rede externa nem credencial real. Roda no CI, no job
# deploy-rehearsal, antes do build das imagens.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../scripts/external-backup.sh"
MOCK="$HERE/support/mock-s3.js"

if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" >/dev/null 2>&1
fi
for tool in node gpg curl sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ferramenta ausente ($tool): teste não executado"; exit 2; }
done

WORK="$(mktemp -d)"; chmod 700 "$WORK"
ORIG="$(mktemp -d)"; chmod 700 "$ORIG"   # cópias do dump original, fora da área varrida
MOCK_PID=""
trap '[ -z "$MOCK_PID" ] || kill "$MOCK_PID" 2>/dev/null; rm -rf "$WORK" "$ORIG"' EXIT
mkdir -p "$WORK/store/objs" "$WORK/bin" "$WORK/env" "$WORK/keys" "$WORK/tmp"

# ---- armazenamento falso ------------------------------------------------------------
ACCESS="AKIAFICTICIO0000"; SECRET="segredo-ficticio-nao-real-0001"; REGION="sa-test-1"
node "$MOCK" "$WORK/store/objs" "$ACCESS" "$REGION" "$WORK/port" &
MOCK_PID=$!
for _ in $(seq 1 50); do [ -s "$WORK/port" ] && break; sleep 0.1; done
[ -s "$WORK/port" ] || { echo "o armazenamento falso não subiu"; exit 2; }
PORT="$(cat "$WORK/port")"

# ---- docker simulado ----------------------------------------------------------------
cat > "$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
[ -z "${DOCKER_CALLS:-}" ] || echo "$*" >> "$DOCKER_CALLS"
case "$*" in
  *pg_dump*)
    { printf 'PGDMP'; printf 'LUXORA-FAKE-DUMP-MARKER-%s' "$$"; head -c 150000 /dev/urandom; } | tee "${FAKE_DUMP_COPY:-/dev/null}"
    if [ "${FAKE_DUMP_FAIL:-0}" = "1" ]; then echo "pg_dump: erro simulado" >&2; exit 1; fi ;;
  *pg_restore*--list*)
    data="$(mktemp)"; cat > "$data"
    head -c 5 "$data" | grep -q '^PGDMP$'; rc=$?
    rm -f "$data"; exit "$rc" ;;
  *) echo "docker simulado: comando inesperado: $*" >&2; exit 99 ;;
esac
EOF
chmod +x "$WORK/bin/docker"

# ---- arquivos de ambiente e chave (fictícios) ---------------------------------------
KEYFILE="$WORK/keys/backup.key"; WRONGKEY="$WORK/keys/errada.key"
printf 'frase-ficticia-de-teste-com-mais-de-24-caracteres' > "$KEYFILE"; chmod 600 "$KEYFILE"
printf 'outra-frase-ficticia-tambem-com-mais-de-24-chars' > "$WRONGKEY"; chmod 600 "$WRONGKEY"
write_env() { # arquivo chave [linhas a omitir (regex)]
  grep -vE "${3:-^$}" > "$1" <<EOF
APP_ENV=staging
POSTGRES_DB=luxora_staging
BACKUP_S3_ENDPOINT=http://127.0.0.1:$PORT
BACKUP_S3_ALLOW_INSECURE_HTTP=1
BACKUP_S3_REGION=$REGION
BACKUP_S3_BUCKET=bucket-ficticio
BACKUP_S3_PREFIX=luxora-teste
BACKUP_S3_ACCESS_KEY_ID=$ACCESS
BACKUP_S3_SECRET_ACCESS_KEY=$SECRET
BACKUP_ENCRYPTION_PASSPHRASE_FILE=$2
EOF
}
ENVF="$WORK/env/staging.env"; write_env "$ENVF" "$KEYFILE"
STATE="$WORK/env/luxora-deploy-state"

EB() { PATH="$WORK/bin:$PATH" TMPDIR="$WORK/tmp" bash "$SCRIPT" "$@" >"$WORK/out.txt" 2>&1; }

PASSED=0; FAILED=0
ok() { PASSED=$((PASSED + 1)); echo "  ok    $1"; }
ko() { FAILED=$((FAILED + 1)); echo "  FALHA $1"; sed 's/^/        | /' "$WORK/out.txt" | tail -n 6; }
expect_rc() { # descrição esperado obtido
  if [ "$3" -eq "$2" ]; then ok "$1 (saída $3)"; else ko "$1 — esperado $2, obtido $3"; fi
}
expect_out() { # descrição trecho
  if grep -qF -- "$2" "$WORK/out.txt"; then ok "$1"; else ko "$1 — a saída não tem: $2"; fi
}
expect_clean() { # nada sobrou nos diretórios temporários
  local left; left="$(find "$STATE/tmp" "$WORK/tmp" -mindepth 1 2>/dev/null | head -n 3)"
  if [ -z "$left" ]; then ok "$1: nenhum arquivo temporário sobrou"; else ko "$1: sobrou: $left"; fi
}
objects() { find "$WORK/store/objs" -type f | sort; }
count_objects() { objects | wc -l | tr -d ' '; }
no_secret_in_out() {
  if grep -qF -e "$SECRET" "$WORK/out.txt"; then ko "$1: a saída contém o segredo"; else ok "$1: a saída não contém o segredo"; fi
}

echo "== check"
EB check --env-file "$ENVF"; rc=$?
expect_rc "check com configuração completa" 0 $rc
expect_out "check informa a conferência" "configuração do backup externo conferida"
no_secret_in_out "check"

write_env "$WORK/env/sem-bucket.env" "$KEYFILE" '^BACKUP_S3_BUCKET='
EB check --env-file "$WORK/env/sem-bucket.env"; rc=$?
expect_rc "check sem BACKUP_S3_BUCKET" 3 $rc
expect_out "check nomeia a variável ausente" "BACKUP_S3_BUCKET"

chmod 644 "$KEYFILE"
EB check --env-file "$ENVF"; rc=$?
expect_rc "check com a chave legível por outros (644)" 3 $rc
expect_out "check explica a permissão" "permissão 644"
chmod 600 "$KEYFILE"

write_env "$WORK/env/http.env" "$KEYFILE" '^BACKUP_S3_ALLOW_INSECURE_HTTP='
EB check --env-file "$WORK/env/http.env"; rc=$?
expect_rc "check recusa http:// sem a permissão de teste" 3 $rc

echo "== push"
FAKE_DUMP_COPY="$ORIG/dump1" DOCKER_CALLS="$WORK/docker.calls" EB push --env-file "$ENVF"; rc=$?
expect_rc "push completo" 0 $rc
[ "$(count_objects)" = "1" ] && ok "um objeto no armazenamento" || ko "esperado 1 objeto, há $(count_objects)"
OBJ="$(objects | head -n 1)"; KEY="${OBJ#"$WORK/store/objs/bucket-ficticio/"}"
[[ "$KEY" =~ ^luxora-teste/staging/luxora_staging/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\.dump\.gpg$ ]] && ok "nome único com prefixo/ambiente/banco: $KEY" || ko "nome inesperado: $KEY"
if grep -qaF "PGDMP" "$OBJ" || grep -qaF "LUXORA-FAKE-DUMP-MARKER" "$OBJ"; then ko "o objeto enviado contém o dump em claro"; else ok "o objeto enviado está cifrado (sem o dump em claro)"; fi
[ "$(wc -c < "$OBJ")" -gt 150000 ] && ok "tamanho do objeto compatível com o dump" || ko "objeto pequeno demais"
grep -q '"action":"external-backup".*"result":"success"' "$STATE/history.jsonl" && ok "histórico registra o sucesso" || ko "histórico sem o sucesso"
[ "$(cat "$STATE/last-external-backup")" = "$KEY" ] && ok "estado last-external-backup gravado" || ko "estado last-external-backup ausente"
if grep -qF 'auth=INVALIDA' "$WORK/store/requests.log"; then ko "houve requisição sem assinatura SigV4 válida no formato"; else ok "todas as requisições levaram Authorization AWS4-HMAC-SHA256"; fi
grep -E 'PUT|HEAD' "$WORK/store/requests.log" | grep -q 'signed=.*x-amz-content-sha256' && ok "o hash do conteúdo entra nos cabeçalhos assinados" || ko "x-amz-content-sha256 não está nos cabeçalhos assinados"
no_secret_in_out "push"
expect_clean "push"
if grep -rlaF --exclude-dir=bin "LUXORA-FAKE-DUMP-MARKER" "$WORK" >/dev/null 2>&1; then ko "o dump em claro apareceu no disco: $(grep -rlaF --exclude-dir=bin 'LUXORA-FAKE-DUMP-MARKER' "$WORK" | head -n 3)"; else ok "o dump em claro não foi gravado em nenhum lugar da área de teste"; fi
SHA1="$(sed -n 's/.*sha256=\([0-9a-f]*\).*/\1/p' "$STATE/history.jsonl" | tail -n 1)"

: > "$WORK/docker.calls"
EB push --env-file "$WORK/env/staging.env" ; true  # segunda execução: nomes diferentes
[ "$(count_objects)" = "2" ] && [ "$(objects | xargs -n1 basename | sort -u | wc -l | tr -d ' ')" = "2" ] && ok "segunda execução gera outro nome" || ko "nomes repetidos ou objeto faltando"

echo "== push com falhas"
before="$(count_objects)"
FAKE_DUMP_FAIL=1 EB push --env-file "$ENVF"; rc=$?
expect_rc "push com pg_dump falhando" 3 $rc
expect_out "erro explícito do dump" "o dump ou a cifragem falhou"
[ "$(count_objects)" = "$before" ] && ok "nada foi enviado" || ko "objeto enviado apesar da falha"
expect_clean "push com dump falho"

touch "$WORK/store/fail-put"
EB push --env-file "$ENVF"; rc=$?
expect_rc "push com o armazenamento recusando (500)" 3 $rc
expect_out "erro explícito do envio" "o envio falhou (HTTP 500)"
[ "$(count_objects)" = "$before" ] && ok "nenhum objeto novo" || ko "objeto criado apesar da recusa"
expect_clean "push com envio recusado"
rm -f "$WORK/store/fail-put"

write_env "$WORK/env/sem-chave.env" "$WORK/keys/nao-existe.key"
: > "$WORK/docker.calls"
DOCKER_CALLS="$WORK/docker.calls" EB push --env-file "$WORK/env/sem-chave.env"; rc=$?
expect_rc "push sem o arquivo da chave" 3 $rc
[ ! -s "$WORK/docker.calls" ] && ok "o dump nem começou" || ko "o dump rodou sem chave"

echo "== pull --output"
EB pull --env-file "$ENVF" --object "$KEY" --output "$WORK/restaurado.dump"; rc=$?
expect_rc "pull para arquivo" 0 $rc
cmp -s "$WORK/restaurado.dump" "$ORIG/dump1" && ok "o dump recuperado é idêntico ao original" || ko "o dump recuperado difere do original"
[ "$(stat -c %a "$WORK/restaurado.dump")" = "600" ] && ok "arquivo entregue com permissão 600" || ko "permissão inesperada"
expect_clean "pull"
EB pull --env-file "$ENVF" --object "$KEY" --output "$WORK/restaurado.dump"; rc=$?
expect_rc "pull não sobrescreve arquivo existente" 3 $rc

EB pull --env-file "$ENVF" --object "$KEY" --sha256 "$SHA1" --output "$WORK/com-sha.dump"; rc=$?
expect_rc "pull com o sha256 correto" 0 $rc
EB pull --env-file "$ENVF" --object "$KEY" --sha256 "0000000000000000000000000000000000000000000000000000000000000000" --output "$WORK/sha-errado.dump"; rc=$?
expect_rc "pull com o sha256 errado" 3 $rc
[ ! -e "$WORK/sha-errado.dump" ] && ok "nenhum arquivo entregue" || ko "arquivo entregue com sha256 errado"

echo "== pull com objeto adulterado, chave errada e nomes inválidos"
TAMPER_KEY="luxora-teste/staging/luxora_staging/adulterado.dump.gpg"
cp "$OBJ" "$WORK/store/objs/bucket-ficticio/$TAMPER_KEY"
b="$(dd if="$OBJ" bs=1 skip=5000 count=1 2>/dev/null | od -An -tu1 | tr -d ' ')"
new=$(( (b + 1) % 256 ))
printf "\\$(printf '%03o' "$new")" | dd of="$WORK/store/objs/bucket-ficticio/$TAMPER_KEY" bs=1 seek=5000 conv=notrunc 2>/dev/null
EB pull --env-file "$ENVF" --object "$TAMPER_KEY" --output "$WORK/adulterado.dump"; rc=$?
expect_rc "pull de objeto adulterado" 3 $rc
expect_out "erro explícito da decifragem" "a decifragem falhou"
[ ! -e "$WORK/adulterado.dump" ] && ok "nenhum arquivo entregue" || ko "arquivo entregue de objeto adulterado"
expect_clean "pull adulterado"

write_env "$WORK/env/chave-errada.env" "$WRONGKEY"
EB pull --env-file "$WORK/env/chave-errada.env" --object "$KEY" --output "$WORK/errada.dump"; rc=$?
expect_rc "pull com a chave errada" 3 $rc
[ ! -e "$WORK/errada.dump" ] && ok "nenhum arquivo entregue" || ko "arquivo entregue com chave errada"

EB pull --env-file "$ENVF" --object "../fora" --output "$WORK/x.dump"; rc=$?
expect_rc "pull com nome de objeto inválido (..)" 3 $rc
EB pull --env-file "$ENVF" --object "$KEY" --output "$WORK/y.dump" --drill; rc=$?
expect_rc "pull com --output e --drill juntos" 3 $rc
EB pull --env-file "$ENVF" --object "luxora-teste/staging/luxora_staging/nao-existe.dump.gpg" --output "$WORK/z.dump"; rc=$?
expect_rc "pull de objeto inexistente" 3 $rc
expect_out "erro explícito do download" "o download falhou (HTTP 404)"

echo "== pull --drill (restore-drill.sh simulado)"
cat > "$WORK/drill-stub.sh" <<'EOF'
#!/usr/bin/env bash
# Finge o restore-drill.sh: registra o que recebeu e o estado do arquivo em claro.
backup=""
while [ $# -gt 0 ]; do case "$1" in --backup) backup="$2"; shift 2 ;; *) shift ;; esac; done
{
  echo "backup=$backup"
  echo "existe=$([ -s "$backup" ] && echo sim || echo nao)"
  echo "modo=$(stat -c %a "$backup")"
  echo "sha256=$(sha256sum "$backup" | cut -d' ' -f1)"
} > "$DRILL_LOG"
exit "${DRILL_RC:-0}"
EOF
DRILL_LOG="$WORK/drill.log" LUXORA_RESTORE_DRILL_SCRIPT="$WORK/drill-stub.sh" EB pull --env-file "$ENVF" --object "$KEY" --drill; rc=$?
expect_rc "pull --drill" 0 $rc
ORIG_SHA="$(sha256sum "$ORIG/dump1" | cut -d' ' -f1)"
grep -q "^existe=sim$" "$WORK/drill.log" && grep -q "^modo=600$" "$WORK/drill.log" && grep -q "^sha256=$ORIG_SHA$" "$WORK/drill.log" \
  && ok "o ensaio recebeu o dump idêntico ao original, com permissão 600" || ko "o ensaio recebeu algo diferente: $(tr '\n' ' ' < "$WORK/drill.log")"
DRILLED="$(sed -n 's/^backup=//p' "$WORK/drill.log")"
[ ! -e "$DRILLED" ] && ok "o arquivo em claro foi apagado depois do ensaio" || ko "o arquivo em claro sobrou: $DRILLED"
expect_clean "pull --drill"

DRILL_RC=2 DRILL_LOG="$WORK/drill.log" LUXORA_RESTORE_DRILL_SCRIPT="$WORK/drill-stub.sh" EB pull --env-file "$ENVF" --object "$KEY" --drill; rc=$?
expect_rc "pull --drill propaga a falha do ensaio" 2 $rc
expect_clean "pull --drill com ensaio reprovado"

if grep -rlaF --exclude-dir=bin "LUXORA-FAKE-DUMP-MARKER" "$WORK" 2>/dev/null | grep -v '/restaurado.dump$' | grep -v '/com-sha.dump$' | grep -q .; then
  ko "dump em claro sobrou fora dos arquivos entregues de propósito"
else
  ok "nenhum dump em claro sobrou, exceto os arquivos entregues de propósito"
fi

echo
echo "Resultado: $PASSED verificações ok, $FAILED falhas"
[ "$FAILED" -eq 0 ]
