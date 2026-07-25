# Comece Aqui — Luxora

Oi, Pedro. Isso aqui é o backend + frontend da Luxora, construído com Claude ao longo de vários módulos. Nunca rodou contra um ambiente real ainda — este documento é o ponto de partida pra colocar isso de pé.

## O que já está pronto

Módulos 1 a 17: fundação técnica, domínio, autenticação, multi-tenant, pacientes, clínica/terapeuta, agenda, API, financeiro, auditoria, WhatsApp, IA (agente que conversa e age), follow-up/inadimplência, automações (n8n), frontend (login, dashboard, agenda, checkout de assinatura), e assinatura da Luxora via Asaas.

## Ambiente oficial (se você está no Windows)

Todo o projeto — código, `node_modules`, Git, e todo comando abaixo (`pnpm`, `git`, `docker`, `prisma`, testes) — roda de dentro do **WSL2**, em filesystem `ext4` nativo (ex.: `/root/luxora-app` ou `~/luxora-app`), **não** em `C:\Users\...` acessado via `/mnt/c`. Abra o VS Code de dentro do WSL2 (`cd ~/luxora-app && code .`, modo Remote-WSL) — nunca apontando para `\\wsl.localhost\...`/`\\wsl$\...` de um VS Code do lado Windows. Motivo e evidências: [`docs/02-Arquitetura/ADRs/ADR-0048-repositorio-ext4-wsl2.md`](./docs/02-Arquitetura/ADRs/ADR-0048-repositorio-ext4-wsl2.md) (resumo: rodar em `/mnt/c` chegou a ser ~94x mais lento para carregar módulos Node do que em `ext4`).

## O que você precisa instalar primeiro

- Node.js (versão 20 ou mais recente) — instalado nativamente dentro do WSL2 (ex.: via NVM), não a versão do Windows
- pnpm (`corepack enable` ou `npm install -g pnpm`, também dentro do WSL2)
- PostgreSQL (via Docker Engine nativo no WSL2 é o mais simples — ver [`ADR-0047`](./docs/02-Arquitetura/ADRs/ADR-0047-docker-engine-nativo-wsl2.md), não Docker Desktop — ou já direto uma instância)
- Redis (mesma lógica — Docker no WSL2 ou instância)

## Passo a passo

Rode tudo a partir de uma shell WSL2, dentro do diretório onde o repositório vive em ext4:

```bash
# 1. instalar as dependências
pnpm install

# 2. copiar o modelo de variáveis de ambiente
cp .env.example .env

# 3. abrir o .env e preencher pelo menos:
#    DATABASE_URL, REDIS_URL, JWT_SECRET (qualquer string longa aleatória)
#    Para rodar sem integrações externas ainda, pode deixar
#    ASAAS_API_KEY, ANTHROPIC_API_KEY e afins vazios por enquanto —
#    só vai dar erro quando o fluxo específico que usa aquilo for chamado.

# 4. rodar a primeira migration (isso cria as tabelas no banco)
pnpm --filter @luxora/backend exec prisma migrate dev --name init

# 5. aplicar as políticas de segurança do banco (RLS) — passo manual,
#    rode o conteúdo deste arquivo direto no seu Postgres:
#    apps/backend/prisma/rls/enable-rls.sql
#    apps/backend/prisma/rls/unique-active-appointment.sql

# 6. popular com dados de teste
pnpm --filter @luxora/backend seed

# 7. rodar tudo
pnpm dev
```

Se tudo der certo, o backend sobe numa porta (provavelmente 3000) e o frontend em outra (provavelmente 3001 ou 3002 — o terminal mostra qual).

## Onde estão as credenciais reais

- **Asaas**: `ASAAS_API_KEY` — pega no painel da própria Asaas, conta da Luxora
- **WhatsApp**: não é mais global — cada clínica conecta o próprio número depois, dentro do sistema (endpoint `POST /whatsapp/connect`)
- **Anthropic** (motor do agente de IA): `ANTHROPIC_API_KEY` — console.anthropic.com

Detalhe completo de cada variável: `CONFIGURACAO_AMBIENTE.md` (raiz do repo).

## Se algo der erro

É esperado ter ajuste na primeira rodada real — nada disso foi testado contra banco/API de verdade até agora. Roda os testes automatizados primeiro pra isolar se é problema de ambiente ou de código:

```bash
pnpm --filter @luxora/backend test:unit
```

## Documentação completa

- `docs/` — toda a documentação técnica (arquitetura, domínio, API)
- Decisões de arquitetura relevantes vivem na pasta `LUXORA/03 - ENGINEERING/ADRs/` que o Frederico deve ter — vale a leitura antes de mexer em Financeiro, IA ou Assinatura, tem bastante contexto de por que as coisas foram feitas do jeito que foram.
