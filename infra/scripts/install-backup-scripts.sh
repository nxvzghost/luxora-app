#!/usr/bin/env bash
# Luxora — instala os scripts do backup num diretório de root, fora do alcance do usuário deploy.
#
#   sudo bash infra/scripts/install-backup-scripts.sh --expect-commit <sha de 40 caracteres> [--dest /opt/luxora-backup]
#   sudo bash infra/scripts/install-backup-scripts.sh --verify [--dest /opt/luxora-backup] [--expect-commit <sha>]
#
# Por quê. O luxora-backup@.service roda como o usuário luxora-backup, que lê o banco inteiro (BYPASSRLS)
# e as credenciais do armazenamento. Se os scripts que ele executa estivessem no checkout do deploy
# (/srv/luxora-app), quem controla o deploy controlaria também o código que roda como luxora-backup.
# As unidades chamam /opt/luxora-backup/scripts/backup-job.sh: uma cópia de root:root, sem escrita
# para ninguém mais. Alterar só as permissões do checkout não resolve: o deploy.sh/CD refazem o checkout
# a cada versão, e o dono do repositório pode trocar o que está lá a qualquer momento.
#
# O que instala (e só isto): backup-job.sh, external-backup.sh, external-backup-health.sh e lib.sh, que
# se encontram pelo próprio diretório (SCRIPTS_DIR/dirname). restore-drill.sh e o compose NÃO entram:
# só o `pull --drill`, manual e fora do timer, os usa. Mais MANIFEST.sha256 (sha256 de cada arquivo) e
# VERSION (commit, data, arquivos).
#
# Confiança na origem. O instalador roda como root e copia o que está no repositório; por isso recusa
# uma origem que alguém além de root possa ter alterado: o repositório, infra/, infra/scripts/, .git,
# os quatro arquivos e este instalador precisam ser de root e sem escrita para grupo ou outros; o HEAD
# precisa ser exatamente o commit informado (--expect-commit, 40 caracteres, conferido por você contra
# o GitHub e o CI verde) e cada arquivo precisa ser idêntico ao do commit. Caminho esperado: um clone
# feito POR ROOT (por exemplo em /root/luxora-install), nunca o checkout do deploy.
#
# Troca. Monta tudo num diretório temporário dentro do destino, confere e só então troca scripts/ por
# renomeação; a versão anterior fica em scripts.prev/ (uma só) para voltar atrás. Recusa instalar com um
# serviço luxora-backup* ativo (a troca no meio de uma execução misturaria versões).
#
# --verify não precisa de git: confere o que está instalado (donos, modos, arquivos a mais ou a menos,
# links simbólicos e o sha256 contra o MANIFEST.sha256) e sai com 1 se algo estiver fora do previsto.
#
# Teste: LUXORA_INSTALL_TEST=1 deixa rodar sem root (o "dono confiável" passa a ser o usuário atual e
# nada é chown-ado). É só para infra/tests/install-backup-scripts-test.sh; nunca use no servidor.

set -euo pipefail

FILES="backup-job.sh external-backup.sh external-backup-health.sh lib.sh"
EXTRA_FILES="MANIFEST.sha256 VERSION"
DEFAULT_DEST=/opt/luxora-backup

die() { echo "ERRO: $*" >&2; exit "${2:-1}"; }
note() { echo "[install-backup-scripts] $*"; }

MODE=install; DEST="$DEFAULT_DEST"; EXPECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dest) [ $# -ge 2 ] || die "--dest sem valor" 64; DEST="$2"; shift 2 ;;
    --expect-commit) [ $# -ge 2 ] || die "--expect-commit sem valor" 64; EXPECT="$2"; shift 2 ;;
    --verify) MODE=verify; shift ;;
    *) die "argumento desconhecido: $1 (ver o cabeçalho do script)" 64 ;;
  esac
done

TEST_MODE="${LUXORA_INSTALL_TEST:-0}"
if [ "$TEST_MODE" = 1 ]; then
  TRUSTED_UID="$(id -u)"; TRUSTED_GID=""; OWN=""
else
  [ "$(id -u)" -eq 0 ] || die "precisa rodar como root (sudo): o destino é de root:root" 77
  TRUSTED_UID=0; TRUSTED_GID=0; OWN="-o root -g root"
fi

# Dono confiável e ninguém mais com escrita (grupo ou outros).
trusted() { # caminho
  local owner group mode
  owner="$(stat -c %u "$1")"; group="$(stat -c %g "$1")"; mode="$(stat -c %a "$1")"
  [ "$owner" = "$TRUSTED_UID" ] || return 1
  [ -z "$TRUSTED_GID" ] || [ "$group" = "$TRUSTED_GID" ] || return 1
  [ $(( 8#$mode & 8#022 )) -eq 0 ]
}
describe() { echo "$(stat -c '%U:%G %a' "$1")"; }

[[ "$DEST" =~ ^/[A-Za-z0-9._/-]+$ ]] && [[ "$DEST" != *..* ]] || die "--dest precisa ser um caminho absoluto simples (letras, números, ponto, hífen, sublinhado e barras)"
[ "$DEST" != "/" ] || die "--dest não pode ser /"

# ---- --verify ---------------------------------------------------------------------------------
verify_installed() { # destino -> imprime cada problema; devolve 1 se houver
  local d="$1/scripts" problems=0 f expected actual mode
  p() { echo "  PROBLEMA: $*"; problems=$((problems + 1)); }
  if [ ! -d "$1" ] || [ -L "$1" ]; then p "$1 não existe ou é um link simbólico"; return 1; fi
  trusted "$1" || p "$1 não é de root:root sem escrita para grupo/outros ($(describe "$1"))"
  if [ ! -d "$d" ] || [ -L "$d" ]; then p "$d não existe ou é um link simbólico"; return 1; fi
  trusted "$d" || p "$d não é de root:root sem escrita para grupo/outros ($(describe "$d"))"
  expected="$(printf '%s\n' $FILES $EXTRA_FILES | sort | tr '\n' ' ')"
  actual="$(ls -A "$d" | sort | tr '\n' ' ')"
  [ "$expected" = "$actual" ] || p "conteúdo de $d diferente do previsto (previsto: $expected· encontrado: $actual)"
  for f in $FILES $EXTRA_FILES; do
    [ -e "$d/$f" ] || continue
    if [ -L "$d/$f" ] || [ ! -f "$d/$f" ]; then p "$d/$f não é um arquivo comum (link simbólico?)"; continue; fi
    trusted "$d/$f" || p "$d/$f não é de root:root sem escrita para grupo/outros ($(describe "$d/$f"))"
    mode="$(stat -c %a "$d/$f")"
    case "$f" in MANIFEST.sha256|VERSION) [ "$mode" = 644 ] || p "$d/$f com modo $mode (previsto 644)" ;;
                 *) [ "$mode" = 755 ] || p "$d/$f com modo $mode (previsto 755)" ;; esac
  done
  if [ -f "$d/MANIFEST.sha256" ]; then
    (cd "$d" && sha256sum --check --quiet MANIFEST.sha256 >/dev/null 2>&1) || p "o sha256 de algum arquivo difere do MANIFEST.sha256 (arquivo alterado depois da instalação?)"
    [ "$(wc -l < "$d/MANIFEST.sha256")" -eq "$(echo $FILES | wc -w)" ] || p "MANIFEST.sha256 não lista exatamente os arquivos previstos"
  fi
  [ "$problems" -eq 0 ]
}

if [ "$MODE" = verify ]; then
  note "conferindo $DEST/scripts"
  if verify_installed "$DEST"; then
    version="$(sed -n 's/^commit=//p' "$DEST/scripts/VERSION" 2>/dev/null | head -n 1)"
    if [ -n "$EXPECT" ] && [ "$EXPECT" != "$version" ]; then die "o commit instalado ($version) não é o esperado ($EXPECT)"; fi
    note "OK: arquivos, donos, modos e sha256 conferem. Commit instalado: ${version:-desconhecido}"
    exit 0
  fi
  die "a instalação em $DEST/scripts está fora do previsto — reinstale a partir de um clone de root"
fi

# ---- instalar ---------------------------------------------------------------------------------
[[ "$EXPECT" =~ ^[0-9a-f]{40}$ ]] || die "informe --expect-commit com o hash COMPLETO (40 caracteres hexadecimais) do commit que você conferiu no GitHub/CI" 64
command -v git >/dev/null 2>&1 || die "git não encontrado"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd "$SRC/../.." && pwd -P)"
[ -d "$REPO/.git" ] || die "$REPO não é a raiz de um clone git (sem .git)"

# Primeiro a confiança no que será lido (antes de deixar o git ou qualquer outro programa tocar nisso).
for p in "$REPO" "$REPO/infra" "$SRC" "$REPO/.git" "$SRC/$(basename "${BASH_SOURCE[0]}")"; do
  [ ! -L "$p" ] || die "origem não confiável: $p é um link simbólico"
  trusted "$p" || die "origem não confiável: $p precisa ser de root:root e sem escrita para grupo/outros (está $(describe "$p")). Clone o repositório como root, fora do checkout do deploy (ver docs/07-Infra/BACKUP_ISOLADO.md)."
done
for f in $FILES; do
  [ -f "$SRC/$f" ] && [ ! -L "$SRC/$f" ] || die "arquivo ausente ou link simbólico na origem: $SRC/$f"
  trusted "$SRC/$f" || die "origem não confiável: $SRC/$f precisa ser de root:root e sem escrita para grupo/outros (está $(describe "$SRC/$f"))"
done

[ "$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null)" = "$REPO" ] || die "$REPO não é a raiz de um repositório git"
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
[ "$HEAD_SHA" = "$EXPECT" ] || die "o HEAD do repositório ($HEAD_SHA) não é o commit informado ($EXPECT)"
for f in $FILES; do
  git -C "$REPO" ls-files --error-unmatch "infra/scripts/$f" >/dev/null 2>&1 || die "$f não é um arquivo versionado no commit"
  [ "$(git -C "$REPO" hash-object "$SRC/$f")" = "$(git -C "$REPO" rev-parse "HEAD:infra/scripts/$f")" ] \
    || die "$f difere do commit $EXPECT (alterado depois do checkout?) — refaça o clone como root"
done

if [ "$TEST_MODE" != 1 ] && command -v systemctl >/dev/null 2>&1; then
  running="$(systemctl list-units --state=active,activating --no-legend --plain 'luxora-backup@*.service' 'luxora-backup-health@*.service' 2>/dev/null || true)"
  [ -z "$running" ] || die "há serviço do backup em execução; espere terminar (ou rode fora de 03:30 UTC e do minuto 15 de cada hora): $running"
fi

[ ! -L "$DEST" ] || die "$DEST é um link simbólico"
PARENT="$(dirname "$DEST")"
[ -d "$PARENT" ] && trusted "$PARENT" || die "a pasta pai $PARENT não existe ou não é de root sem escrita para grupo/outros"
# shellcheck disable=SC2086  # $OWN é "-o root -g root" ou vazio
install -d -m 0755 $OWN "$DEST"
trusted "$DEST" || die "$DEST não é de root:root sem escrita para grupo/outros ($(describe "$DEST"))"

STAGE="$(mktemp -d "$DEST/.stage.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT
chmod 0755 "$STAGE"
# shellcheck disable=SC2086
install -d -m 0755 $OWN "$STAGE/scripts"
for f in $FILES; do
  # shellcheck disable=SC2086
  install -m 0755 $OWN "$SRC/$f" "$STAGE/scripts/$f"
done
(cd "$STAGE/scripts" && sha256sum $FILES > MANIFEST.sha256)
{
  echo "commit=$HEAD_SHA"
  echo "installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "files=$FILES"
} > "$STAGE/scripts/VERSION"
chmod 0644 "$STAGE/scripts/MANIFEST.sha256" "$STAGE/scripts/VERSION"
if [ -z "$OWN" ]; then :; else chown root:root "$STAGE/scripts/MANIFEST.sha256" "$STAGE/scripts/VERSION"; fi

for f in $FILES; do cmp -s "$SRC/$f" "$STAGE/scripts/$f" || die "a cópia de $f não é idêntica à origem"; done
(cd "$STAGE/scripts" && sha256sum --check --quiet MANIFEST.sha256 >/dev/null) || die "o MANIFEST.sha256 não confere com a cópia"

rm -rf "$DEST/scripts.prev"
if [ -d "$DEST/scripts" ]; then mv -T "$DEST/scripts" "$DEST/scripts.prev"; fi
mv -T "$STAGE/scripts" "$DEST/scripts"
rmdir "$STAGE"; trap - EXIT

verify_installed "$DEST" || die "a instalação recém-feita não passou na conferência — não use"
note "instalado em $DEST/scripts (commit $HEAD_SHA); versão anterior, se havia, em $DEST/scripts.prev"
note "as unidades do systemd chamam $DEST/scripts/backup-job.sh; confira de novo a qualquer momento com --verify"
