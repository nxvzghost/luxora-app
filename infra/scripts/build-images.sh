#!/usr/bin/env bash
# Luxora — constrói as imagens de uma versão (backend, job de migrations e painel).
# (Tarefa 04 da auditoria. Ver docs/07-Infra/DEPLOY_RUNBOOK.md.)
#
#   infra/scripts/build-images.sh --version <tag> [--api-url <URL pública da API>] [--skip-frontend] [--no-cache]
#
# A tag É a versão: fica gravada na imagem (APP_VERSION) e é o que o deploy
# confere em GET /health depois da troca. Use o commit curto:
#   infra/scripts/build-images.sh --version "$(git rev-parse --short HEAD)" --api-url https://api.exemplo.com.br/api/v1
#
# O contexto é a raiz do repositório, filtrado pelo .dockerignore (nenhum
# .env, node_modules ou dist local entra). Para um build a partir só do que
# está versionado, rode num clone limpo — é o que o CI faz.
#
# --api-url é embutida no JavaScript do painel: uma imagem do painel por
# ambiente. Sem ela, o painel não é construído.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_IMAGE_REPO="${BACKEND_IMAGE_REPO:-luxora-backend}"
BACKEND_MIGRATE_IMAGE_REPO="${BACKEND_MIGRATE_IMAGE_REPO:-${BACKEND_IMAGE_REPO}-migrate}"
FRONTEND_IMAGE_REPO="${FRONTEND_IMAGE_REPO:-luxora-frontend}"

VERSION=""; API_URL=""; SKIP_FRONTEND=0; NO_CACHE=()
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --api-url) API_URL="$2"; shift 2 ;;
    --skip-frontend) SKIP_FRONTEND=1; shift ;;
    --no-cache) NO_CACHE=(--no-cache); shift ;;
    *) echo "argumento desconhecido: $1" >&2; exit 1 ;;
  esac
done
[ -n "$VERSION" ] || { echo "informe a versão com --version <tag>" >&2; exit 1; }
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cd "$ROOT"

echo "== backend $VERSION"
docker build ${NO_CACHE[@]+"${NO_CACHE[@]}"} -f infra/docker/Dockerfile.backend \
  --build-arg APP_VERSION="$VERSION" --build-arg BUILD_DATE="$BUILD_DATE" \
  -t "$BACKEND_IMAGE_REPO:$VERSION" .

echo "== job de migrations $VERSION"
docker build -f infra/docker/Dockerfile.backend --target migrate -t "$BACKEND_MIGRATE_IMAGE_REPO:$VERSION" .

if [ "$SKIP_FRONTEND" -eq 0 ] && [ -n "$API_URL" ]; then
  echo "== painel $VERSION (API: $API_URL)"
  docker build ${NO_CACHE[@]+"${NO_CACHE[@]}"} -f infra/docker/Dockerfile.frontend \
    --build-arg NEXT_PUBLIC_API_URL="$API_URL" \
    --build-arg APP_VERSION="$VERSION" --build-arg BUILD_DATE="$BUILD_DATE" \
    -t "$FRONTEND_IMAGE_REPO:$VERSION" .
else
  echo "== painel não construído (sem --api-url, ou --skip-frontend)"
fi

echo "== imagens da versão $VERSION"
docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}' | grep -E ":$VERSION " || true
