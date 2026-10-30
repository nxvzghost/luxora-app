#!/usr/bin/env bash
# Luxora — teste local de infra/scripts/external-backup.sh (A-12).
#
#   bash infra/tests/external-backup-test.sh
#
# Isolado: pg_dump e pg_restore SIMULADOS (os clientes PostgreSQL do host, que o push
# usa), docker SIMULADO (só o pull o usa, para o pg_restore --list e o restore-drill.sh),
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

export DOCKER_CALLS="$WORK/docker.calls" PG_CALLS="$WORK/pg.calls" PG_ENVLOG="$WORK/pg.envlog" PG_ENVDUMP="$WORK/pg.envdump"
reset_logs() { : > "$DOCKER_CALLS"; : > "$PG_CALLS"; : > "$PG_ENVLOG"; : > "$PG_ENVDUMP"; }
reset_logs

# ---- pg_dump e pg_restore simulados (clientes PostgreSQL do host) -----------------------
cat > "$WORK/bin/pg_dump" <<'EOF'
#!/usr/bin/env bash
# Finge o pg_dump: registra argumentos e ambiente, confere o arquivo de senhas como o libpq
# faria (uma linha host:porta:banco:usuário:) e escreve um "dump" no stdout.
if [ "${1:-}" = "--version" ]; then echo "pg_dump (PostgreSQL) 16.4"; exit 0; fi
echo "pg_dump $*" >> "$PG_CALLS"
{
  echo "PGPASSFILE=${PGPASSFILE:-unset}"
  echo "PGPASSWORD=${PGPASSWORD+set}"
  echo "PGSSLMODE=${PGSSLMODE:-unset}"
  echo "passfile_mode=$(stat -c %a "${PGPASSFILE:-/nao-existe}" 2>/dev/null || echo ausente)"
} >> "$PG_ENVLOG"
env >> "$PG_ENVDUMP"
host=""; port=""; user=""; db=""; nopass=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) host="$2"; shift 2 ;; --port) port="$2"; shift 2 ;; --username) user="$2"; shift 2 ;;
    --dbname) db="$2"; shift 2 ;; --no-password) nopass=1; shift ;; -Fc) shift ;;
    *) echo "pg_dump simulado: argumento inesperado: $1" >&2; exit 98 ;;
  esac
done
[ "$nopass" -eq 1 ] || { echo "pg_dump simulado: faltou --no-password" >&2; exit 97; }
grep -qF "$host:$port:$db:$user:" "${PGPASSFILE:-/nao-existe}" 2>/dev/null \
  || { echo "pg_dump: erro: falha na autenticação (sem senha no arquivo de senhas para $user@$host:$port/$db)" >&2; exit 2; }
{ printf 'PGDMP'; printf 'LUXORA-FAKE-DUMP-MARKER-%s' "$$"; head -c 150000 /dev/urandom; } | tee "${FAKE_DUMP_COPY:-/dev/null}"
if [ "${FAKE_DUMP_FAIL:-0}" = "1" ]; then echo "pg_dump: erro simulado" >&2; exit 1; fi
EOF
cat > "$WORK/bin/pg_restore" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then echo "pg_restore (PostgreSQL) 16.4"; exit 0; fi
echo "pg_restore $*" >> "$PG_CALLS"
[ "${1:-}" = "--list" ] || { echo "pg_restore simulado: só aceita --list" >&2; exit 98; }
data="$(mktemp)"; cat > "$data"
head -c 5 "$data" | grep -q '^PGDMP$'; rc=$?
rm -f "$data"; exit "$rc"
EOF

# ---- docker simulado: só o pull o usa (pg_restore --list no contêiner) -------------------
cat > "$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
[ -z "${DOCKER_CALLS:-}" ] || echo "$*" >> "$DOCKER_CALLS"
case "$*" in
  *pg_dump*) echo "docker simulado: o push não pode chamar pg_dump pelo Docker" >&2; exit 96 ;;
  *pg_restore*--list*)
    data="$(mktemp)"; cat > "$data"
    head -c 5 "$data" | grep -q '^PGDMP$'; rc=$?
    rm -f "$data"; exit "$rc" ;;
  *) echo "docker simulado: comando inesperado: $*" >&2; exit 99 ;;
esac
EOF
chmod +x "$WORK/bin/docker" "$WORK/bin/pg_dump" "$WORK/bin/pg_restore"

# ---- arquivos de ambiente e chave (fictícios) ---------------------------------------
KEYFILE="$WORK/keys/backup.key"; WRONGKEY="$WORK/keys/errada.key"
printf 'frase-ficticia-de-teste-com-mais-de-24-caracteres' > "$KEYFILE"; chmod 600 "$KEYFILE"
printf 'outra-frase-ficticia-tambem-com-mais-de-24-chars' > "$WRONGKEY"; chmod 600 "$WRONGKEY"
# Arquivo de senhas do PostgreSQL (formato pgpass), com a senha fictícia do papel de backup.
PGSECRET="senha-pg-ficticia-nao-vazar-0001"; PGPASS="$WORK/keys/pgpass"
printf '127.0.0.1:15432:luxora_staging:luxora_backup:%s\n' "$PGSECRET" > "$PGPASS"; chmod 600 "$PGPASS"
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
BACKUP_PG_HOST=127.0.0.1
BACKUP_PG_PORT=15432
BACKUP_PG_USER=luxora_backup
BACKUP_PG_PASSFILE=$PGPASS
EOF
}
ENVF="$WORK/env/staging.env"; write_env "$ENVF" "$KEYFILE"
STATE="$WORK/env/luxora-deploy-state"

EB() { PATH="$WORK/bin:$PATH" TMPDIR="$WORK/tmp" bash "$SCRIPT" "$@" >"$WORK/out.txt" 2>&1; }

# PATHs restritos: só as ferramentas de que o script precisa, mais os simulados pedidos.
# Assim "sem Docker" e "sem pg_dump" são verdade de fato, não só uma promessa.
BASE_TOOLS="bash env cat curl gpg gpgconf sha256sum mktemp stat od tr cut head tail wc date grep sed awk id mkdir chmod rm find shred dirname basename tee sort sleep cp mv ls uname hostname readlink xargs dd"
tools_dir() { # nome simulados...
  local d="$WORK/path-$1" t p; shift; mkdir -p "$d"
  for t in $BASE_TOOLS; do p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$d/$t"; done
  for t in "$@"; do ln -sf "$WORK/bin/$t" "$d/$t"; done
  printf '%s' "$d"
}
NODOCKER="$(tools_dir semdocker pg_dump pg_restore)"
NOPGDUMP="$(tools_dir sempgdump pg_restore docker)"
NOPGRESTORE="$(tools_dir sempgrestore pg_dump docker)"
EBP() { local p="$1"; shift; PATH="$p" TMPDIR="$WORK/tmp" bash "$SCRIPT" "$@" >"$WORK/out.txt" 2>&1; }

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
  if grep -qF -e "$SECRET" -e "$PGSECRET" "$WORK/out.txt"; then ko "$1: a saída contém um segredo"; else ok "$1: a saída não contém os segredos (armazenamento e PostgreSQL)"; fi
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

echo "== check: conexão do host com o PostgreSQL, sem Docker"
if PATH="$NODOCKER" bash -c 'command -v docker' >/dev/null 2>&1; then ko "o PATH de teste sem Docker ainda tem docker"; else ok "o PATH de teste não tem docker (e tem pg_dump: $(PATH="$NODOCKER" bash -c 'command -v pg_dump' >/dev/null 2>&1 && echo sim || echo não))"; fi
EBP "$NODOCKER" check --env-file "$ENVF"; rc=$?
expect_rc "check sem Docker no PATH" 0 $rc
expect_out "check informa a origem do dump" "origem do dump: luxora_backup@127.0.0.1:15432/luxora_staging (sslmode=prefer)"
expect_out "check informa o cliente" "pg_dump (PostgreSQL) 16.4"
no_secret_in_out "check sem Docker"
[ ! -s "$PG_CALLS" ] && ok "check só pergunta a versão do cliente: não rodou dump nem restore" || ko "check chamou o pg_dump ou o pg_restore"

for v in BACKUP_PG_HOST BACKUP_PG_PORT BACKUP_PG_USER BACKUP_PG_PASSFILE; do
  write_env "$WORK/env/sem-$v.env" "$KEYFILE" "^$v="
  EBP "$NODOCKER" check --env-file "$WORK/env/sem-$v.env"; rc=$?
  expect_rc "check sem $v" 3 $rc
  expect_out "check nomeia $v" "$v"
done
bad_pg() { # descrição variável valor
  sed "s|^$2=.*|$2=$3|" "$ENVF" > "$WORK/env/ruim.env"
  EBP "$NODOCKER" check --env-file "$WORK/env/ruim.env"; rc=$?
  expect_rc "check com $1" 3 $rc
}
bad_pg "host começando com hífen" BACKUP_PG_HOST "-oHost"
bad_pg "host com espaço" BACKUP_PG_HOST "host com espaco"
bad_pg "host com ponto e vírgula" BACKUP_PG_HOST "a;b"
bad_pg "porta zero" BACKUP_PG_PORT "0"
bad_pg "porta acima de 65535" BACKUP_PG_PORT "70000"
bad_pg "porta não numérica" BACKUP_PG_PORT "abc"
bad_pg "usuário começando com hífen" BACKUP_PG_USER "-x"
bad_pg "usuário com espaço" BACKUP_PG_USER "usuario com espaco"
bad_pg "banco que seria uma string de conexão" POSTGRES_DB "luxora=1 host=outro"
bad_pg "banco com hífen no início" POSTGRES_DB "-luxora"
cp "$ENVF" "$WORK/env/ssl-ruim.env"; echo "BACKUP_PG_SSLMODE=invalido" >> "$WORK/env/ssl-ruim.env"
EBP "$NODOCKER" check --env-file "$WORK/env/ssl-ruim.env"; rc=$?
expect_rc "check com BACKUP_PG_SSLMODE inválido" 3 $rc
for mode in disable allow prefer require verify-ca verify-full; do
  cp "$ENVF" "$WORK/env/ssl-ok.env"; echo "BACKUP_PG_SSLMODE=$mode" >> "$WORK/env/ssl-ok.env"
  EBP "$NODOCKER" check --env-file "$WORK/env/ssl-ok.env"; rc=$?
  [ "$rc" -eq 0 ] && ok "check aceita BACKUP_PG_SSLMODE=$mode" || ko "check recusou BACKUP_PG_SSLMODE=$mode"
done

env_with_passfile() { sed "s|^BACKUP_PG_PASSFILE=.*|BACKUP_PG_PASSFILE=$1|" "$ENVF" > "$WORK/env/passfile.env"; }
for m in 644 640 660 604 700 777; do
  chmod "$m" "$PGPASS"; EBP "$NODOCKER" check --env-file "$ENVF"; rc=$?
  expect_rc "check com o arquivo de senhas em $m" 3 $rc
  expect_out "check explica a permissão $m" "permissão $m"
done
chmod 400 "$PGPASS"; EBP "$NODOCKER" check --env-file "$ENVF"; rc=$?
expect_rc "check com o arquivo de senhas em 400 (mais restritivo que 600)" 0 $rc
chmod 600 "$PGPASS"; EBP "$NODOCKER" check --env-file "$ENVF"; rc=$?
expect_rc "check com o arquivo de senhas em 600" 0 $rc
ln -sf "$PGPASS" "$WORK/keys/pgpass-link"; env_with_passfile "$WORK/keys/pgpass-link"
EBP "$NODOCKER" check --env-file "$WORK/env/passfile.env"; rc=$?
expect_rc "check com o arquivo de senhas sendo link simbólico" 3 $rc
expect_out "check diz que link simbólico não é aceito" "não pode ser um link simbólico"
env_with_passfile "$WORK/keys/nao-existe"; EBP "$NODOCKER" check --env-file "$WORK/env/passfile.env"; rc=$?
expect_rc "check com o arquivo de senhas inexistente" 3 $rc
: > "$WORK/keys/pgpass-vazio"; chmod 600 "$WORK/keys/pgpass-vazio"; env_with_passfile "$WORK/keys/pgpass-vazio"
EBP "$NODOCKER" check --env-file "$WORK/env/passfile.env"; rc=$?
expect_rc "check com o arquivo de senhas vazio" 3 $rc
mkdir -p "$WORK/keys/pgpass-dir"; env_with_passfile "$WORK/keys/pgpass-dir"
EBP "$NODOCKER" check --env-file "$WORK/env/passfile.env"; rc=$?
expect_rc "check com o arquivo de senhas sendo um diretório" 3 $rc
if [ "$(id -u)" -eq 0 ]; then
  cp "$PGPASS" "$WORK/keys/pgpass-alheio"; chown 12345 "$WORK/keys/pgpass-alheio"; chmod 600 "$WORK/keys/pgpass-alheio"; env_with_passfile "$WORK/keys/pgpass-alheio"
  EBP "$NODOCKER" check --env-file "$WORK/env/passfile.env"; rc=$?
  expect_rc "check com o arquivo de senhas de outro dono" 3 $rc
  expect_out "check explica o dono" "não pertence ao usuário que executa"
else
  echo "  pulou arquivo de senhas de outro dono (só dá para preparar como root)"
fi

EBP "$NOPGDUMP" check --env-file "$ENVF"; rc=$?
expect_rc "check sem pg_dump no PATH" 3 $rc
expect_out "check nomeia o pg_dump" "ferramenta ausente no host: pg_dump"
EBP "$NOPGRESTORE" check --env-file "$ENVF"; rc=$?
expect_rc "check sem pg_restore no PATH" 3 $rc
expect_out "check nomeia o pg_restore" "ferramenta ausente no host: pg_restore"

echo "== push"
reset_logs
PGHOST=outro.exemplo PGUSER=postgres PGPASSWORD="senha-do-ambiente-nao-deve-valer" FAKE_DUMP_COPY="$ORIG/dump1" EBP "$NODOCKER" push --env-file "$ENVF"; rc=$?
expect_rc "push completo, sem Docker no PATH" 0 $rc
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
[ "$(sed -n 1p "$PG_CALLS")" = "pg_dump --host 127.0.0.1 --port 15432 --username luxora_backup --dbname luxora_staging --no-password -Fc" ] \
  && ok "pg_dump com os argumentos de conexão corretos (e --no-password)" || ko "argumentos do pg_dump: $(sed -n 1p "$PG_CALLS")"
[ "$(sed -n 2p "$PG_CALLS")" = "pg_restore --list" ] && [ "$(wc -l < "$PG_CALLS" | tr -d ' ')" = "2" ] \
  && ok "depois do dump, pg_restore --list do host, e mais nenhuma chamada" || ko "chamadas: $(tr '\n' '|' < "$PG_CALLS")"
[ ! -s "$DOCKER_CALLS" ] && ok "o Docker não foi chamado pelo push" || ko "o push chamou o Docker: $(head -n 2 "$DOCKER_CALLS")"
grep -qx "PGPASSFILE=$PGPASS" "$PG_ENVLOG" && ok "a senha chegou ao pg_dump só pelo PGPASSFILE configurado" || ko "PGPASSFILE inesperado: $(grep PGPASSFILE "$PG_ENVLOG")"
grep -qx "PGPASSWORD=" "$PG_ENVLOG" && ok "PGPASSWORD herdado do ambiente foi descartado" || ko "PGPASSWORD chegou ao pg_dump"
grep -qx "passfile_mode=600" "$PG_ENVLOG" && ok "o pg_dump viu o arquivo de senhas com permissão 600" || ko "permissão do arquivo de senhas: $(grep passfile_mode "$PG_ENVLOG")"
grep -qx "PGSSLMODE=prefer" "$PG_ENVLOG" && ok "sslmode padrão (prefer)" || ko "sslmode: $(grep PGSSLMODE "$PG_ENVLOG")"
if grep -qE '^(PGHOST|PGUSER|PGPASSWORD|PGDATABASE|PGPORT|PGSERVICE)=' "$PG_ENVDUMP"; then ko "variáveis PG* herdadas chegaram ao pg_dump"; else ok "PGHOST, PGUSER e PGPASSWORD herdados do processo não chegaram ao pg_dump"; fi
leak=""
for f in "$WORK/out.txt" "$PG_CALLS" "$PG_ENVLOG" "$PG_ENVDUMP" "$STATE/history.jsonl" "$STATE/last-external-backup" "$OBJ"; do
  grep -qaF -e "$PGSECRET" -e "senha-do-ambiente-nao-deve-valer" "$f" && leak="$leak $f"
done
[ -z "$leak" ] && ok "a senha do PostgreSQL não aparece em argv, ambiente, saída, histórico, estado nem no objeto enviado" || ko "senha do PostgreSQL encontrada em:$leak"
SHA1="$(sed -n 's/.*sha256=\([0-9a-f]*\).*/\1/p' "$STATE/history.jsonl" | tail -n 1)"

EBP "$NODOCKER" push --env-file "$WORK/env/staging.env" ; true  # segunda execução: nomes diferentes
[ "$(count_objects)" = "2" ] && [ "$(objects | xargs -n1 basename | sort -u | wc -l | tr -d ' ')" = "2" ] && ok "segunda execução gera outro nome" || ko "nomes repetidos ou objeto faltando"

echo "== push com falhas"
before="$(count_objects)"
FAKE_DUMP_FAIL=1 EBP "$NODOCKER" push --env-file "$ENVF"; rc=$?
expect_rc "push com pg_dump falhando" 3 $rc
expect_out "erro explícito do dump" "o dump ou a cifragem falhou"
[ "$(count_objects)" = "$before" ] && ok "nada foi enviado" || ko "objeto enviado apesar da falha"
expect_clean "push com dump falho"

touch "$WORK/store/fail-put"
EBP "$NODOCKER" push --env-file "$ENVF"; rc=$?
expect_rc "push com o armazenamento recusando (500)" 3 $rc
expect_out "erro explícito do envio" "o envio falhou (HTTP 500)"
[ "$(count_objects)" = "$before" ] && ok "nenhum objeto novo" || ko "objeto criado apesar da recusa"
expect_clean "push com envio recusado"
rm -f "$WORK/store/fail-put"

write_env "$WORK/env/sem-chave.env" "$WORK/keys/nao-existe.key"
reset_logs
EBP "$NODOCKER" push --env-file "$WORK/env/sem-chave.env"; rc=$?
expect_rc "push sem o arquivo da chave" 3 $rc
[ ! -s "$PG_CALLS" ] && ok "o dump nem começou" || ko "o dump rodou sem chave"

printf '127.0.0.1:9999:luxora_staging:luxora_backup:%s\n' "$PGSECRET" > "$WORK/keys/pgpass-errado"; chmod 600 "$WORK/keys/pgpass-errado"
sed "s|^BACKUP_PG_PASSFILE=.*|BACKUP_PG_PASSFILE=$WORK/keys/pgpass-errado|" "$ENVF" > "$WORK/env/pgpass-errado.env"
reset_logs; before="$(count_objects)"
EBP "$NODOCKER" push --env-file "$WORK/env/pgpass-errado.env"; rc=$?
expect_rc "push com a autenticação do PostgreSQL recusada (senha de outra porta)" 3 $rc
expect_out "erro explícito do dump" "o dump ou a cifragem falhou"
expect_out "a causa vem do pg_dump" "falha na autenticação"
no_secret_in_out "push com autenticação recusada"
[ "$(count_objects)" = "$before" ] && ok "nada foi enviado" || ko "objeto enviado apesar da falha de autenticação"
grep -q '"result":"failed-dump"' "$STATE/history.jsonl" && ok "histórico registra failed-dump" || ko "histórico sem failed-dump"
expect_clean "push com autenticação recusada"

chmod 644 "$PGPASS"; reset_logs
EBP "$NODOCKER" push --env-file "$ENVF"; rc=$?
expect_rc "push com o arquivo de senhas legível por outros (644)" 3 $rc
[ ! -s "$PG_CALLS" ] && ok "o pg_dump nem foi chamado" || ko "o pg_dump rodou com o arquivo de senhas exposto"
chmod 600 "$PGPASS"

cp "$ENVF" "$WORK/env/ssl-require.env"; echo "BACKUP_PG_SSLMODE=require" >> "$WORK/env/ssl-require.env"
reset_logs
EBP "$NODOCKER" push --env-file "$WORK/env/ssl-require.env"; rc=$?
expect_rc "push com BACKUP_PG_SSLMODE=require" 0 $rc
grep -qx "PGSSLMODE=require" "$PG_ENVLOG" && ok "o sslmode configurado chegou ao pg_dump" || ko "sslmode: $(grep PGSSLMODE "$PG_ENVLOG")"

echo "== pull continua exigindo Docker e não usa a conexão do host"
EBP "$NODOCKER" pull --env-file "$ENVF" --object "$KEY" --output "$WORK/sem-docker.dump"; rc=$?
expect_rc "pull sem Docker no PATH" 3 $rc
expect_out "pull exige o docker" "ferramenta ausente no host: docker"
[ ! -e "$WORK/sem-docker.dump" ] && ok "nada foi entregue" || ko "arquivo entregue sem Docker"
write_env "$WORK/env/sem-pg.env" "$KEYFILE" '^BACKUP_PG_'
reset_logs
EB pull --env-file "$WORK/env/sem-pg.env" --object "$KEY" --output "$WORK/sem-pg.dump"; rc=$?
expect_rc "pull sem nenhuma variável BACKUP_PG_*" 0 $rc
cmp -s "$WORK/sem-pg.dump" "$ORIG/dump1" && ok "o dump recuperado é idêntico ao original" || ko "o dump recuperado difere"
grep -q 'pg_restore --list' "$DOCKER_CALLS" && ok "a conferência do pull continua dentro do contêiner (docker)" || ko "o pull não usou o docker"
[ ! -s "$PG_CALLS" ] && ok "o pull não chamou o pg_dump nem o pg_restore do host" || ko "o pull chamou os clientes do host"

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

if grep -rlaF --exclude-dir=bin "LUXORA-FAKE-DUMP-MARKER" "$WORK" 2>/dev/null | grep -v '/restaurado.dump$' | grep -v '/com-sha.dump$' | grep -v '/sem-pg.dump$' | grep -q .; then
  ko "dump em claro sobrou fora dos arquivos entregues de propósito"
else
  ok "nenhum dump em claro sobrou, exceto os arquivos entregues de propósito"
fi

echo "== o código: push e check sem Docker, pull com Docker"
body() { awk -v f="$1" '$0 ~ "^"f"\\(\\)" {on=1} on {print} on && /^}/ {exit}' "$SCRIPT"; }
if body cmd_push | grep -qE 'docker|compose'; then ko "cmd_push menciona docker ou compose"; else ok "cmd_push não menciona docker nem compose"; fi
if body cmd_check | grep -qE 'docker|compose'; then ko "cmd_check menciona docker ou compose"; else ok "cmd_check não menciona docker nem compose"; fi
if body cmd_pull | grep -q 'compose'; then ok "cmd_pull continua usando o contêiner (compose)"; else ko "cmd_pull não usa mais o compose"; fi
[ -n "$(body cmd_push)" ] && [ -n "$(body cmd_pull)" ] || ko "não consegui extrair as funções do script"
if grep -nE 'PGPASSWORD=|--password|-W ' "$SCRIPT" | grep -v '^[0-9]*:#' | grep -q .; then ko "o script monta senha em variável ou argumento"; else ok "o script não monta senha em variável de ambiente nem em argumento"; fi

echo
echo "Resultado: $PASSED verificações ok, $FAILED falhas"
[ "$FAILED" -eq 0 ]
