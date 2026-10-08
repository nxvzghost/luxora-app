#!/usr/bin/env bash
# Testes de ponta a ponta do painel — Tarefa 06 da auditoria (AD-012).
#
# Sobe uma pilha DESCARTÁVEL (Postgres e Redis próprios, dados em memória),
# aplica as migrations, constrói backend e painel e roda a suíte do
# Playwright, que inicia e encerra os dois processos. No fim — passe, falhe
# ou seja interrompido — a pilha é destruída: nenhum dado de teste sobra.
#
# Não usa o banco de desenvolvimento, não usa credencial real e não chama
# Meta, Anthropic nem Asaas. É o mesmo comando localmente e no CI:
#
#   bash infra/tests/e2e.sh                # suíte inteira
#   bash infra/tests/e2e.sh tests/sessao.spec.ts
#   E2E_SKIP_BUILD=1 bash infra/tests/e2e.sh   # reaproveita os builds já feitos
#
# Pré-requisitos: Docker, pnpm install e `pnpm --filter @luxora/e2e exec
# playwright install chromium` (no CI, com --with-deps).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/infra/e2e/docker-compose.yml")

export E2E_API_PORT="${E2E_API_PORT:-3200}"
export E2E_WEB_PORT="${E2E_WEB_PORT:-3201}"
export E2E_DATABASE_URL="postgresql://luxora_app:luxora_app_dev_pw@localhost:55432/luxora_e2e"
export E2E_ADMIN_DATABASE_URL="postgresql://postgres:postgres@localhost:55432/luxora_e2e"
export E2E_REDIS_URL="redis://localhost:56379"

step() { printf '\n== %s ==\n' "$1"; }

cleanup() {
  local status=$?
  step "Destruindo a pilha descartável"
  "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

for port in "$E2E_API_PORT" "$E2E_WEB_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "A porta $port já está em uso — encerre o que estiver nela ou defina E2E_API_PORT/E2E_WEB_PORT." >&2
    exit 1
  fi
done

step "Pilha descartável (Postgres e Redis)"
"${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --wait

cd "$ROOT"

step "Migrations no banco descartável"
pnpm --filter @luxora/backend prisma:generate >/dev/null
DATABASE_URL="$E2E_DATABASE_URL" pnpm --filter @luxora/backend prisma:migrate

if [ "${E2E_SKIP_BUILD:-}" != "1" ]; then
  step "Build do backend"
  pnpm --filter @luxora/backend build
  step "Build do painel (apontando para a API de teste)"
  NEXT_PUBLIC_API_URL="http://localhost:${E2E_API_PORT}/api/v1" pnpm --filter @luxora/frontend build
fi

step "Playwright"
cd "$ROOT/apps/e2e"
pnpm exec playwright test "$@"
