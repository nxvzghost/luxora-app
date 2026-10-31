#!/usr/bin/env bash
# Luxora — teste de infra/scripts/install-backup-scripts.sh (instalação dos scripts do backup em
# um diretório de root, fora do alcance do usuário deploy).
#
#   bash infra/tests/install-backup-scripts-test.sh
#
# Isolado: repositórios git e destinos temporários; nada é instalado em /opt, nenhum usuário é criado
# e nenhum serviço é tocado. Fora de root usa LUXORA_INSTALL_TEST=1 (o "dono confiável" passa a ser o
# usuário atual); como root também roda o caminho real (root:root) e, com o usuário nobody, mostra que
# quem não é root não consegue alterar o que foi instalado. Chamado por backup-schedule-test.sh (CI,
# job deploy-rehearsal); pode rodar sozinho.
#
# O que NÃO prova: o systemd do servidor executando as unidades a partir de /opt/luxora-backup.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL="$HERE/../scripts"
UNITS="$HERE/../systemd"
FILES="backup-job.sh external-backup.sh external-backup-health.sh lib.sh"

command -v git >/dev/null 2>&1 || { echo "git ausente: teste não executado"; exit 2; }
WORK="$(mktemp -d)"; chmod 755 "$WORK"
trap 'rm -rf "$WORK"' EXIT
PASSED=0; FAILED=0; SKIPPED=0
ok() { PASSED=$((PASSED + 1)); echo "  ok    $1"; }
ko() { FAILED=$((FAILED + 1)); echo "  FALHA $1"; sed 's/^/        | /' "$WORK/out.txt" 2>/dev/null | tail -n 5; }
skip() { SKIPPED=$((SKIPPED + 1)); echo "  pulou $1"; }

G() { git -c user.name=teste -c user.email=teste@example.invalid -c commit.gpgsign=false "$@"; }
mkrepo() { # nome -> cria o repositório de teste e imprime o caminho; o commit fica em $WORK/<nome>.sha
  local r="$WORK/$1"; rm -rf "$r"; mkdir -p "$r/infra/scripts"
  cp "$REAL/install-backup-scripts.sh" $(for f in $FILES; do printf '%s ' "$REAL/$f"; done) "$r/infra/scripts/"
  (cd "$r" && G init -q . && G add -A && G commit -q -m teste && G rev-parse HEAD > "$WORK/$1.sha")
  find "$r" -type d -exec chmod 755 {} +
  echo "$r"
}
inst() { # repo [args...] -> RC e $WORK/out.txt
  local r="$1"; shift
  LUXORA_INSTALL_TEST=1 bash "$r/infra/scripts/install-backup-scripts.sh" "$@" > "$WORK/out.txt" 2>&1; RC=$?
}
expect_rc() { if [ "$RC" -eq "$2" ]; then ok "$1 (saída $RC)"; else ko "$1 — esperado $2, obtido $RC"; fi; }
has() { if grep -qE -- "$2" "$WORK/out.txt"; then ok "$1"; else ko "$1 — não encontrei: $2"; fi; }

echo "== instalação a partir de um commit conferido"
R="$(mkrepo ok)"; SHA="$(cat "$WORK/ok.sha")"; D="$WORK/dest"; mkdir -p "$WORK"
inst "$R" --expect-commit "$SHA" --dest "$D"
expect_rc "instala" 0
[ "$(ls -A "$D/scripts" | sort | tr '\n' ' ')" = "MANIFEST.sha256 VERSION backup-job.sh external-backup-health.sh external-backup.sh lib.sh " ] \
  && ok "o conjunto instalado é exatamente: backup-job, external-backup, external-backup-health, lib, MANIFEST e VERSION" || ko "conteúdo: $(ls -A "$D/scripts" | tr '\n' ' ')"
[ ! -e "$D/scripts/restore-drill.sh" ] && ok "restore-drill.sh e o compose não entram (só o pull --drill manual os usa)" || ko "restore-drill.sh instalado"
ok_modes=1; for f in $FILES; do [ "$(stat -c %a "$D/scripts/$f")" = 755 ] || ok_modes=0; done
for f in MANIFEST.sha256 VERSION; do [ "$(stat -c %a "$D/scripts/$f")" = 644 ] || ok_modes=0; done
[ "$(stat -c %a "$D")" = 755 ] && [ "$(stat -c %a "$D/scripts")" = 755 ] && [ "$ok_modes" = 1 ] && ok "modos: pastas 755, scripts 755, MANIFEST e VERSION 644 (ninguém além do dono escreve)" || ko "modos"
[ -z "$(find "$D" -perm /022 ! -type l)" ] && ok "nenhum arquivo ou pasta gravável por grupo ou outros" || ko "gravável: $(find "$D" -perm /022 | head -n 3)"
grep -qx "commit=$SHA" "$D/scripts/VERSION" && ok "VERSION registra o commit instalado" || ko "VERSION: $(cat "$D/scripts/VERSION")"
for f in $FILES; do cmp -s "$R/infra/scripts/$f" "$D/scripts/$f" || { ko "cópia de $f diferente da origem"; break; }; done && ok "as quatro cópias são idênticas aos arquivos do commit"
(cd "$D/scripts" && sha256sum --check --quiet MANIFEST.sha256 >/dev/null 2>&1) && ok "MANIFEST.sha256 confere" || ko "MANIFEST.sha256"
[ -z "$(ls -A "$D" | grep -F '.stage')" ] && ok "nenhum diretório temporário sobrou" || ko "sobrou: $(ls -A "$D")"

echo "== as cópias funcionam sozinhas (dependências relativas entre os scripts)"
# Cada script que um deles chama ou inclui precisa estar no conjunto (restore-drill.sh só no pull --drill).
refs="$(cd "$D/scripts" && grep -ohE '\$SCRIPTS_DIR/[a-z-]+\.sh|\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)/[a-z-]+\.sh' $FILES | sed -E 's#.*/##' | sort -u | tr '\n' ' ')"
missing=""; for r in $refs; do case " $FILES restore-drill.sh " in *" $r "*) ;; *) missing="$missing $r" ;; esac; done
[ -z "$missing" ] && ok "referências entre scripts: $refs— todas no conjunto instalado, exceto restore-drill.sh (pull --drill)" || ko "referências fora do conjunto:$missing"
printf 'APP_ENV=staging\n' > "$WORK/min.env"; chmod 600 "$WORK/min.env"
env -i PATH="$PATH" HOME="$WORK" bash "$D/scripts/external-backup.sh" check --env-file "$WORK/min.env" > "$WORK/out.txt" 2>&1; RC=$?
expect_rc "external-backup.sh instalado carrega o lib.sh e para na configuração incompleta" 3
has "o motivo vem do script instalado" 'variáveis ausentes no arquivo de ambiente'
env -i PATH="$PATH" HOME="$WORK" LUXORA_STATE_DIR="$WORK/st" bash "$D/scripts/backup-job.sh" backup --env-file "$WORK/min.env" > "$WORK/out.txt" 2>&1; RC=$?
expect_rc "backup-job.sh instalado chama o external-backup.sh irmão (check recusa a configuração)" 20
has "o backup-job.sh viu o resultado do check" 'codigo-do-check=3'
env -i PATH="$PATH" HOME="$WORK" LUXORA_STATE_DIR="$WORK/st" bash "$D/scripts/backup-job.sh" health --env-file "$WORK/min.env" > "$WORK/out.txt" 2>&1; RC=$?
expect_rc "backup-job.sh health chama o external-backup-health.sh irmão (sem backup: ausente)" 10
has "o verificador instalado respondeu" 'estado=ausente'

echo "== as unidades chamam a cópia instalada"
for u in luxora-backup@.service luxora-backup-health@.service; do
  grep -qE '^ExecStart=/usr/bin/bash /opt/luxora-backup/scripts/backup-job\.sh (backup|health) --env-file /etc/luxora-backup/%i\.env$' "$UNITS/$u" \
    && ok "$u executa /opt/luxora-backup/scripts/backup-job.sh (não o checkout do deploy)" || ko "$u: ExecStart"
  grep -v '^[[:space:]]*#' "$UNITS/$u" | grep -vE '^(InaccessiblePaths|Documentation)=' | grep -q '/srv/' && ko "$u ainda executa algo em /srv" || ok "$u não executa nada de /srv"
  grep -qx 'InaccessiblePaths=/etc/luxora /srv/luxora-app' "$UNITS/$u" && ok "$u: o checkout do deploy (/srv/luxora-app) e o ambiente da aplicação ficam fora de alcance do serviço" || ko "$u: InaccessiblePaths"
done
grep -qx 'DEFAULT_DEST=/opt/luxora-backup' "$REAL/install-backup-scripts.sh" && ok "o destino padrão do instalador é o das unidades (/opt/luxora-backup)" || ko "destino padrão"

echo "== verificação (--verify)"
inst "$R" --verify --dest "$D"; expect_rc "instalação íntegra" 0
has "informa o commit" "Commit instalado: $SHA"
inst "$R" --verify --dest "$D" --expect-commit "$(printf '%040d' 1)"; expect_rc "commit esperado diferente do instalado" 1
drift() { # descrição comando-que-estraga comando-que-conserta
  eval "$2"; inst "$R" --verify --dest "$D"
  if [ "$RC" -eq 1 ] && grep -q PROBLEMA "$WORK/out.txt"; then ok "detecta: $1"; else ko "não detectou: $1 (saída $RC)"; fi
  eval "$3"
}
drift "script alterado depois da instalação" "echo '# x' >> '$D/scripts/lib.sh'" "cp '$R/infra/scripts/lib.sh' '$D/scripts/lib.sh'"
drift "modo 775 em um script" "chmod 775 '$D/scripts/backup-job.sh'" "chmod 755 '$D/scripts/backup-job.sh'"
drift "pasta com escrita para outros" "chmod 777 '$D/scripts'" "chmod 755 '$D/scripts'"
drift "arquivo a mais na pasta" "touch '$D/scripts/extra.sh'" "rm -f '$D/scripts/extra.sh'"
drift "arquivo a menos na pasta" "mv '$D/scripts/lib.sh' '$WORK/lib.guardado'" "mv '$WORK/lib.guardado' '$D/scripts/lib.sh'"
drift "script trocado por link simbólico" "mv '$D/scripts/lib.sh' '$WORK/lib.guardado'; ln -s '$WORK/lib.guardado' '$D/scripts/lib.sh'" "rm '$D/scripts/lib.sh'; mv '$WORK/lib.guardado' '$D/scripts/lib.sh'"
drift "MANIFEST adulterado" "echo '0000  lib.sh' >> '$D/scripts/MANIFEST.sha256'" "(cd '$D/scripts' && sha256sum $FILES > MANIFEST.sha256)"
inst "$R" --verify --dest "$D"; expect_rc "íntegra de novo depois de desfazer tudo" 0
inst "$R" --verify --dest "$WORK/nao-existe"; expect_rc "destino inexistente" 1

echo "== a origem e o commit precisam ser confiáveis"
inst "$R"; expect_rc "sem --expect-commit" 64
inst "$R" --expect-commit "${SHA:0:12}" --dest "$WORK/d1"; expect_rc "hash abreviado" 64
inst "$R" --expect-commit "$(printf '%040d' 1)" --dest "$WORK/d1"; expect_rc "commit diferente do HEAD" 1
has "diz que o HEAD não é o informado" 'não é o commit informado'
[ ! -e "$WORK/d1" ] && ok "nada foi criado quando o commit não confere" || ko "criou destino"
R2="$(mkrepo sujo)"; SHA2="$(cat "$WORK/sujo.sha")"; echo '# alterado depois do commit' >> "$R2/infra/scripts/lib.sh"
inst "$R2" --expect-commit "$SHA2" --dest "$WORK/d2"; expect_rc "script alterado no checkout depois do commit" 1
has "recusa e diz qual arquivo" 'lib.sh difere do commit'
[ ! -e "$WORK/d2" ] && ok "nada foi criado" || ko "criou destino"
R3="$(mkrepo grupo)"; SHA3="$(cat "$WORK/grupo.sha")"; chmod 775 "$R3/infra/scripts"
inst "$R3" --expect-commit "$SHA3" --dest "$WORK/d3"; expect_rc "pasta de scripts com escrita para o grupo" 1
has "diz que a origem não é confiável" 'origem não confiável'
chmod 755 "$R3/infra/scripts"; chmod 664 "$R3/infra/scripts/lib.sh"
inst "$R3" --expect-commit "$SHA3" --dest "$WORK/d3"; expect_rc "arquivo com escrita para o grupo" 1
chmod 644 "$R3/infra/scripts/lib.sh"; chmod 775 "$R3"
inst "$R3" --expect-commit "$SHA3" --dest "$WORK/d3"; expect_rc "raiz do repositório com escrita para o grupo" 1
chmod 755 "$R3"; chmod 775 "$R3/.git"
inst "$R3" --expect-commit "$SHA3" --dest "$WORK/d3"; expect_rc ".git com escrita para o grupo" 1
chmod 755 "$R3/.git"
mv "$R3/infra/scripts/lib.sh" "$WORK/lib.real"; ln -s "$WORK/lib.real" "$R3/infra/scripts/lib.sh"
inst "$R3" --expect-commit "$SHA3" --dest "$WORK/d3"; expect_rc "script da origem trocado por link simbólico" 1
rm "$R3/infra/scripts/lib.sh"; mv "$WORK/lib.real" "$R3/infra/scripts/lib.sh"
mkdir -p "$WORK/alvo"; ln -s "$WORK/alvo" "$WORK/d4"
inst "$R3" --expect-commit "$SHA3" --dest "$WORK/d4"; expect_rc "destino que é link simbólico" 1
[ -z "$(ls -A "$WORK/alvo")" ] && ok "nada foi gravado no alvo do link simbólico" || ko "gravou no alvo do link: $(ls -A "$WORK/alvo")"
inst "$R3" --expect-commit "$SHA3" --dest "relativo/dest"; expect_rc "destino relativo" 1
inst "$R3" --expect-commit "$SHA3" --dest "/tmp/../etc/x"; expect_rc "destino com .." 1
chmod 775 "$WORK"; inst "$R3" --expect-commit "$SHA3" --dest "$WORK/d5"; expect_rc "pasta pai do destino com escrita para o grupo" 1; chmod 755 "$WORK"
if [ "$(id -u)" -ne 0 ]; then
  bash "$R3/infra/scripts/install-backup-scripts.sh" --expect-commit "$SHA3" --dest "$WORK/d6" > "$WORK/out.txt" 2>&1; RC=$?
  expect_rc "sem root e sem o modo de teste: recusa" 77
  has "pede root" 'precisa rodar como root'
else skip "recusa sem root (este teste está rodando como root)"; fi

echo "== reinstalação troca a versão e guarda a anterior"
echo '# versão 2' >> "$R/infra/scripts/lib.sh"; (cd "$R" && G commit -q -am v2 && G rev-parse HEAD > "$WORK/ok2.sha"); SHA_B="$(cat "$WORK/ok2.sha")"
inst "$R" --expect-commit "$SHA_B" --dest "$D"; expect_rc "reinstala o novo commit" 0
grep -qx "commit=$SHA_B" "$D/scripts/VERSION" && grep -qx "commit=$SHA" "$D/scripts.prev/VERSION" && ok "scripts/ é o commit novo; scripts.prev/ é o anterior" || ko "versões"
grep -q '# versão 2' "$D/scripts/lib.sh" && ! grep -q '# versão 2' "$D/scripts.prev/lib.sh" && ok "o conteúdo trocou de fato" || ko "conteúdo"
inst "$R" --verify --dest "$D"; expect_rc "a nova instalação passa na conferência" 0
echo '# versão 3' >> "$R/infra/scripts/lib.sh"; (cd "$R" && G commit -q -am v3 && G rev-parse HEAD > "$WORK/ok3.sha"); SHA_C="$(cat "$WORK/ok3.sha")"
inst "$R" --expect-commit "$SHA_C" --dest "$D"; expect_rc "terceira instalação" 0
grep -qx "commit=$SHA_B" "$D/scripts.prev/VERSION" && ok "só a anterior é guardada (a primeira foi descartada)" || ko "scripts.prev"

echo "== arquivo de senhas do backup (install-backup-pgpass.sh)"
PGP="$REAL/install-backup-pgpass.sh"
APPENV="$WORK/app.env"; PWD_T="abcdef0123456789abcdef0123456789abcdef0123456789"
printf 'APP_ENV=staging\nPOSTGRES_DB=luxora_staging\nPOSTGRES_ADMIN_PASSWORD=admin-ficticio-0000000000\nPOSTGRES_BACKUP_PASSWORD=%s\nPOSTGRES_BACKUP_PORT=15432\n' "$PWD_T" > "$APPENV"; chmod 600 "$APPENV"
mkdir -p "$WORK/etc-bk"; chmod 750 "$WORK/etc-bk"; PGF="$WORK/etc-bk/backup.pgpass"
pgp() { LUXORA_INSTALL_TEST=1 bash "$PGP" "$@" > "$WORK/out.txt" 2>&1; RC=$?; }
pgp --app-env "$APPENV" --dest "$PGF"; expect_rc "cria o arquivo de senhas" 0
[ "$(cat "$PGF")" = "127.0.0.1:15432:luxora_staging:luxora_backup:$PWD_T" ] && ok "uma linha no formato do libpq: host:porta:banco:usuário:senha, para a role luxora_backup em 127.0.0.1" || ko "conteúdo do pgpass"
[ "$(stat -c %a "$PGF")" = 400 ] && [ "$(stat -c %u "$PGF")" = "$(id -u)" ] && ok "modo 0400 e dono = quem executa o backup (o que o external-backup.sh exige)" || ko "modo/dono do pgpass"
! grep -q "$PWD_T" "$WORK/out.txt" && ok "a senha não aparece na saída" || ko "senha na saída"
[ -z "$(ls -A "$WORK/etc-bk" | grep -F '.pgpass.')" ] && ok "nenhum arquivo temporário sobrou" || ko "sobrou temporário"
pgp --app-env "$APPENV" --dest "$PGF"; expect_rc "não sobrescreve sem --force" 1
printf 'APP_ENV=staging\nPOSTGRES_DB=outro_banco\nPOSTGRES_BACKUP_PASSWORD=%s\nPOSTGRES_BACKUP_PORT=15440\n' "${PWD_T}zz" > "$APPENV"
pgp --app-env "$APPENV" --dest "$PGF" --force; expect_rc "troca com --force" 0
[ "$(cat "$PGF")" = "127.0.0.1:15440:outro_banco:luxora_backup:${PWD_T}zz" ] && ok "a nova senha, porta e banco substituíram os antigos" || ko "troca"
bad_pgp() { # descrição conteúdo-do-env
  printf '%s\n' "$2" > "$APPENV"; rm -f "$WORK/etc-bk/novo.pgpass"; pgp --app-env "$APPENV" --dest "$WORK/etc-bk/novo.pgpass"
  if [ "$RC" -eq 1 ] && [ ! -e "$WORK/etc-bk/novo.pgpass" ]; then ok "recusa: $1"; else ko "não recusou: $1 (saída $RC)"; fi
}
bad_pgp "senha ausente" "POSTGRES_DB=luxora_staging"
bad_pgp "valor de modelo" "POSTGRES_BACKUP_PASSWORD=troque-este-valor"
bad_pgp "senha curta" "POSTGRES_BACKUP_PASSWORD=curta123"
bad_pgp "senha com dois-pontos (quebraria o pgpass)" "POSTGRES_BACKUP_PASSWORD=abcdef0123456789:abcdef0123456789"
bad_pgp "porta inválida" "POSTGRES_BACKUP_PASSWORD=$PWD_T
POSTGRES_BACKUP_PORT=99999"
bad_pgp "banco inválido" "POSTGRES_BACKUP_PASSWORD=$PWD_T
POSTGRES_DB=banco;drop"
pgp --app-env "$WORK/nao-existe.env" --dest "$WORK/etc-bk/n.pgpass"; expect_rc "arquivo de ambiente inexistente" 1
ln -s "$WORK/alvo" "$WORK/etc-bk/link.pgpass"; pgp --app-env "$APPENV" --dest "$WORK/etc-bk/link.pgpass" --force; expect_rc "destino que é link simbólico" 1
pgp --app-env "$APPENV" --dest "$WORK/pasta-inexistente/x.pgpass"; expect_rc "pasta de destino inexistente" 1
if [ "$(id -u)" -ne 0 ]; then
  bash "$PGP" --app-env "$APPENV" --dest "$WORK/etc-bk/n2.pgpass" > "$WORK/out.txt" 2>&1; RC=$?
  expect_rc "sem root e sem o modo de teste: recusa" 77
else skip "recusa sem root (rodando como root)"; fi

echo "== o modelo do arquivo de ambiente do backup (.env.backup.example) e o pgpass funcionam com o external-backup.sh instalado"
TPL="$HERE/../staging/.env.backup.example"
if command -v gpg >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
  BIN="$WORK/pgbin"; mkdir -p "$BIN"; printf '#!/usr/bin/env bash\n[ "${1:-}" = "--version" ] && echo "pg_dump (PostgreSQL) 16.4"\nexit 0\n' > "$BIN/pg_dump"; cp "$BIN/pg_dump" "$BIN/pg_restore"; chmod 755 "$BIN"/*
  printf 'APP_ENV=staging\nPOSTGRES_DB=luxora_staging\nPOSTGRES_BACKUP_PASSWORD=%s\nPOSTGRES_BACKUP_PORT=15432\n' "$PWD_T" > "$APPENV"; chmod 600 "$APPENV"
  rm -f "$PGF"; pgp --app-env "$APPENV" --dest "$PGF"
  head -c 48 /dev/urandom | base64 > "$WORK/etc-bk/backup-passphrase"; chmod 400 "$WORK/etc-bk/backup-passphrase"
  cp "$TPL" "$WORK/bk.env"; chmod 640 "$WORK/bk.env"; mkdir -p "$WORK/st-tpl"
  LUXORA_STATE_DIR="$WORK/st-tpl" PATH="$BIN:$PATH" bash "$D/scripts/backup-job.sh" backup --env-file "$WORK/bk.env" > "$WORK/out.txt" 2>&1; RC=$?
  expect_rc "o modelo sem edição NÃO funciona (valores de modelo recusados)" 20
  has "diz que ainda há valores de modelo" 'valores de modelo'
  ! grep -qE '^(POSTGRES_ADMIN_PASSWORD|POSTGRES_APP_PASSWORD|POSTGRES_BACKUP_PASSWORD|JWT_SECRET|ANTHROPIC_API_KEY|ASAAS_API_KEY|METRICS_ACCESS_TOKEN)=' "$TPL" \
    && ok "o modelo não tem nenhum segredo da aplicação" || ko "o modelo tem segredo da aplicação"
  sed -i -e 's#^BACKUP_S3_ENDPOINT=.*#BACKUP_S3_ENDPOINT=https://exemplo.invalid#' -e 's#^BACKUP_S3_REGION=.*#BACKUP_S3_REGION=auto#' \
    -e 's#^BACKUP_S3_BUCKET=.*#BACKUP_S3_BUCKET=bucket-ficticio#' -e 's#^BACKUP_S3_ACCESS_KEY_ID=.*#BACKUP_S3_ACCESS_KEY_ID=AKIAFICTICIO0000#' \
    -e 's#^BACKUP_S3_SECRET_ACCESS_KEY=.*#BACKUP_S3_SECRET_ACCESS_KEY=segredo-ficticio-s3#' \
    -e "s#^BACKUP_PG_PASSFILE=.*#BACKUP_PG_PASSFILE=$PGF#" -e "s#^BACKUP_ENCRYPTION_PASSPHRASE_FILE=.*#BACKUP_ENCRYPTION_PASSPHRASE_FILE=$WORK/etc-bk/backup-passphrase#" "$WORK/bk.env"
  PATH="$BIN:$PATH" LUXORA_STATE_DIR="$WORK/st-tpl" bash "$D/scripts/external-backup.sh" check --env-file "$WORK/bk.env" > "$WORK/out.txt" 2>&1; RC=$?
  expect_rc "modelo preenchido + pgpass gerado pelo script: external-backup.sh check passa" 0
  has "origem do dump conforme o modelo" 'origem do dump: luxora_backup@127.0.0.1:15432/luxora_staging'
  LUXORA_STATE_DIR="$WORK/st-tpl" PATH="$BIN:$PATH" bash "$D/scripts/backup-job.sh" health --env-file "$WORK/bk.env" > "$WORK/out.txt" 2>&1; RC=$?
  expect_rc "backup-job.sh aceita o modelo preenchido como arquivo de ambiente (sem backup ainda: ausente)" 10
else skip "gpg ou curl ausente: modelo do ambiente do backup não exercitado"; fi

echo "== como root de verdade: dono root:root e quem não é root não consegue alterar (só como root, com o usuário nobody)"
if [ "$(id -u)" -eq 0 ] && id nobody >/dev/null 2>&1 && command -v setpriv >/dev/null 2>&1; then
  NG="$(id -g nobody)"; RR="$(mkrepo raiz)"; SHAR="$(cat "$WORK/raiz.sha")"; chown -R root:root "$RR"; DR="$WORK/destroot"
  bash "$RR/infra/scripts/install-backup-scripts.sh" --expect-commit "$SHAR" --dest "$DR" > "$WORK/out.txt" 2>&1; RC=$?
  expect_rc "instalação real (sem LUXORA_INSTALL_TEST)" 0
  [ -z "$(find "$DR" ! -user root -o ! -group root)" ] && ok "tudo em $DR é root:root" || ko "dono: $(find "$DR" ! -user root -o ! -group root | head -n 3)"
  as_nobody() { setpriv --reuid=nobody --regid="$NG" --clear-groups "$@"; }
  chmod 755 "$WORK"
  as_nobody sh -c "echo '# x' >> '$DR/scripts/backup-job.sh'" >/dev/null 2>&1 && ko "nobody alterou um script instalado" || ok "um usuário comum (como o deploy) não consegue alterar um script instalado"
  as_nobody sh -c "rm -f '$DR/scripts/lib.sh'" >/dev/null 2>&1; [ -f "$DR/scripts/lib.sh" ] && ok "nem apagar um script" || ko "nobody apagou um script"
  as_nobody sh -c "touch '$DR/scripts/novo.sh'" >/dev/null 2>&1 && ko "nobody criou arquivo na pasta" || ok "nem criar arquivo na pasta de scripts"
  as_nobody sh -c "mv '$DR/scripts' '$DR/scripts.x'" >/dev/null 2>&1 && ko "nobody renomeou a pasta" || ok "nem trocar a pasta de scripts por outra"
  printf 'APP_ENV=staging\n' > "$WORK/min-nobody.env"; chmod 644 "$WORK/min-nobody.env"
  mkdir -p "$WORK/estado-nobody"; chown nobody:"$NG" "$WORK/estado-nobody"; chmod 700 "$WORK/estado-nobody"
  as_nobody env LUXORA_STATE_DIR="$WORK/estado-nobody" bash "$DR/scripts/external-backup.sh" check --env-file "$WORK/min-nobody.env" > "$WORK/out.txt" 2>&1; RC=$?
  expect_rc "mas consegue executar (leitura e execução bastam para o serviço)" 3
  has "executou o script instalado" 'variáveis ausentes no arquivo de ambiente'
  inst_nobody() { as_nobody env LUXORA_INSTALL_TEST= bash "$RR/infra/scripts/install-backup-scripts.sh" --expect-commit "$SHAR" --dest "$WORK/destnobody" > "$WORK/out.txt" 2>&1; RC=$?; }
  inst_nobody; expect_rc "o instalador recusa quem não é root" 77
  bash "$RR/infra/scripts/install-backup-scripts.sh" --verify --dest "$DR" > "$WORK/out.txt" 2>&1; RC=$?; expect_rc "conferência real (--verify)" 0
  chown nobody:"$NG" "$DR/scripts/lib.sh"; bash "$RR/infra/scripts/install-backup-scripts.sh" --verify --dest "$DR" > "$WORK/out.txt" 2>&1; RC=$?
  expect_rc "--verify detecta um script que passou a ser de outro dono" 1
  chown root:root "$DR/scripts/lib.sh"
  mkdir -p "$WORK/deploycheck"; cp -r "$RR" "$WORK/deploycheck/repo"; chown -R nobody:"$NG" "$WORK/deploycheck/repo"
  bash "$WORK/deploycheck/repo/infra/scripts/install-backup-scripts.sh" --expect-commit "$SHAR" --dest "$WORK/destdeploy" > "$WORK/out.txt" 2>&1; RC=$?
  expect_rc "origem que é do deploy (checkout de outro usuário) é recusada, mesmo rodando como root" 1
  has "diz que a origem não é confiável" 'origem não confiável'
  [ ! -e "$WORK/destdeploy" ] && ok "nada foi instalado a partir do checkout do deploy" || ko "instalou a partir do checkout do deploy"
else skip "caminho real (root:root, nobody): precisa de root, do usuário nobody e do setpriv"; fi

echo
echo "install-backup-scripts: $PASSED verificações ok, $FAILED falhas, $SKIPPED puladas"
[ "$FAILED" -eq 0 ]
