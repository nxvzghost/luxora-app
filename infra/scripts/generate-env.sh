#!/usr/bin/env bash
# Luxora — gera o arquivo de ambiente de um ambiente novo, com segredos aleatórios.
# (Tarefa 04 da auditoria. Modelo das variáveis: infra/staging/.env.staging.example.)
#
#   infra/scripts/generate-env.sh /caminho/fora/do/repositório/staging.env [staging|production]
#
# Gera só o que é segredo interno (senhas do banco, JWT, cifra, tokens). Os
# endereços e as chaves de integração (Anthropic, Asaas) ficam para você
# preencher. Nenhum valor é impresso. O arquivo sai com permissão 600 e
# NUNCA deve entrar no Git: o script recusa um caminho rastreável pelo repositório.

set -euo pipefail

TARGET="${1:-}"; APP_ENV="${2:-staging}"
[ -n "$TARGET" ] || { echo "uso: generate-env.sh <arquivo> [staging|production]" >&2; exit 1; }
[ ! -e "$TARGET" ] || { echo "ERRO: $TARGET já existe — não sobrescrevo um arquivo de segredos" >&2; exit 1; }
command -v openssl >/dev/null || { echo "ERRO: openssl não encontrado" >&2; exit 1; }

DIR="$(cd "$(dirname "$TARGET")" && pwd)"
if git -C "$DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 && ! git -C "$DIR" check-ignore -q "$DIR/$(basename "$TARGET")"; then
  echo "ERRO: $TARGET fica dentro de um repositório Git e não está ignorado — escolha um caminho fora dele" >&2
  exit 1
fi

# Hexadecimal: seguro dentro de uma URL de conexão, sem precisar de escape.
secret() { openssl rand -hex "${1:-24}"; }

umask 077
cat > "$TARGET" <<EOF
# Luxora — ambiente "$APP_ENV". Gerado em $(date -u +%Y-%m-%dT%H:%M:%SZ) por infra/scripts/generate-env.sh.
# CONTÉM SEGREDOS. Não versionar, não colar em chat, não copiar para log.
APP_ENV=$APP_ENV

POSTGRES_DB=luxora_$APP_ENV
POSTGRES_ADMIN_PASSWORD=$(secret)
POSTGRES_APP_PASSWORD=$(secret)

# Preencha com o endereço público do painel (origem aceita pelo CORS da API).
FRONTEND_URL=http://localhost:13001
BACKEND_PORT=13000
FRONTEND_PORT=13001

JWT_SECRET=$(secret 32)
WHATSAPP_TOKEN_ENCRYPTION_KEY=$(secret 32)
WHATSAPP_APP_SECRET=$(secret)
WHATSAPP_WEBHOOK_VERIFY_TOKEN=$(secret)
ASAAS_WEBHOOK_TOKEN=$(secret)
AUTOMATION_API_KEY=$(secret)
METRICS_ACCESS_TOKEN=$(secret)

# Integrações externas: vazias = desligadas. Preencha só com chaves de teste/sandbox.
ANTHROPIC_API_KEY=
ASAAS_API_KEY=
ASAAS_ENV=sandbox
ASAAS_BASE_URL=https://api-sandbox.asaas.com/v3

OTEL_EXPORTER_OTLP_ENDPOINT=
LOG_LEVEL=log
EOF
chmod 600 "$TARGET"
echo "arquivo gerado: $TARGET (permissão 600, $(grep -cE '^[A-Z_]+=' "$TARGET") variáveis). Nenhum valor foi exibido."
