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
# Role luxora_backup (somente leitura): usada só pelo pg_dump do backup, no host, por 127.0.0.1.
# Senha própria; uma cópia vai para o arquivo de senhas do usuário de backup, nunca para a aplicação.
POSTGRES_BACKUP_PASSWORD=$(secret)
POSTGRES_BACKUP_PORT=15432

# Preencha com o endereço público do painel (origem aceita pelo CORS da API).
FRONTEND_URL=http://localhost:13001
BACKEND_PORT=13000
FRONTEND_PORT=13001

# --- proxy HTTPS (Caddy). Vazios = o proxy não sobe e a API e o painel ficam só no loopback.
# Nome de host, SEM https:// e SEM caminho. Os dois precisam ter DNS apontando para o servidor.
# PUBLIC_PANEL_HOST deve ser o mesmo host de FRONTEND_URL; o api_url do CD é https://<PUBLIC_API_HOST>/api/v1.
# Exemplos: api-staging.exemplo.com.br e painel-staging.exemplo.com.br
PUBLIC_API_HOST=
PUBLIC_PANEL_HOST=
# E-mail da conta do Let's Encrypt (avisos de expiracao de certificado). Obrigatorio para o proxy subir
# quando os dois enderecos acima estao preenchidos; sem ele o deploy avisa e nao inicia o proxy.
# Use um e-mail real do responsavel, preenchido so no arquivo de ambiente do servidor; nunca no repositorio.
ACME_EMAIL=

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

# --- backup externo cifrado (infra/scripts/external-backup.sh). Tudo vazio = desligado.
# Qualquer armazenamento compativel com S3 com enderecamento por caminho: <endpoint>/<bucket>/<chave>.
# Endpoint em https://. Credencial de envio: so escrita (e BACKUP_VERIFY_AFTER_UPLOAD=0) ou escrita + leitura.
BACKUP_S3_ENDPOINT=
BACKUP_S3_REGION=
BACKUP_S3_BUCKET=
BACKUP_S3_PREFIX=luxora
BACKUP_S3_ACCESS_KEY_ID=
BACKUP_S3_SECRET_ACCESS_KEY=
# Caminho de um arquivo (permissao 600, 24+ caracteres) com a chave de cifragem. NAO e a chave em si.
# Guarde uma copia dessa chave FORA do servidor: sem ela, os backups externos nao abrem.
BACKUP_ENCRYPTION_PASSPHRASE_FILE=
BACKUP_VERIFY_AFTER_UPLOAD=1
EOF
chmod 600 "$TARGET"
echo "arquivo gerado: $TARGET (permissão 600, $(grep -cE '^[A-Z_]+=' "$TARGET") variáveis). Nenhum valor foi exibido."
