# Sprint 0 — Entregável 3: Arquitetura Física do Repositório

## Decisão: Monorepo

**Recomendação:** monorepo único, não repositórios separados por Backend/Frontend/Infra.

**Justificativa:** equipe pequena (Frederico + Pedro no início), Backend e Frontend evoluem juntos no MVP, e um monorepo permite que o Motor Operacional e os contratos de API sejam a fonte única de verdade compartilhada entre times — sem risco de divergência de versão entre repositórios. Reavaliar separação apenas se a equipe crescer significativamente (gatilho: mais de ~8 engenheiros ou necessidade real de deploy independente com cadência muito diferente).

---

## Estrutura de diretórios

```
luxora/
├── apps/
│   ├── backend/                    # NestJS — API, Motor Operacional, Serviços de Domínio
│   │   ├── src/
│   │   │   ├── domain/              # Camada pura — entidades, value objects, state machines (M2)
│   │   │   │   ├── patient/
│   │   │   │   ├── session/
│   │   │   │   ├── billing/
│   │   │   │   └── ...
│   │   │   ├── operational-engine/  # Motor Operacional (M4) — núcleo, nunca renomeado
│   │   │   ├── domain-services/     # Os 6 Serviços de Domínio consolidados (ver Entregável 2)
│   │   │   │   ├── patient-ops/
│   │   │   │   ├── financial/
│   │   │   │   ├── communication/
│   │   │   │   ├── engagement/
│   │   │   │   ├── platform/
│   │   │   │   └── ai/
│   │   │   ├── use-cases/           # Casos de Uso (AgendarConsulta, GerarCobranca etc.)
│   │   │   ├── infrastructure/      # Prisma, Redis, BullMQ, S3, provedores externos
│   │   │   │   ├── database/
│   │   │   │   ├── cache/
│   │   │   │   ├── queue/
│   │   │   │   └── ai-provider/     # Implementação de IAIProvider (Claude Haiku 4.5)
│   │   │   ├── api/                 # Controllers, DTOs, guards (camada REST)
│   │   │   │   ├── auth/
│   │   │   │   ├── patients/
│   │   │   │   ├── appointments/
│   │   │   │   ├── billing/
│   │   │   │   └── reports/
│   │   │   ├── shared/              # TenantContext, decorators, pipes comuns
│   │   │   └── main.ts
│   │   ├── test/
│   │   │   ├── unit/                 # Espelha src/domain (M2 — 100% cobertura)
│   │   │   ├── integration/          # Espelha src/api
│   │   │   └── critical/             # Os 16 Testes Críticos (09-Testes/01) — nunca misturados com os demais
│   │   └── prisma/
│   │       ├── schema.prisma
│   │       └── migrations/
│   │
│   └── frontend/                    # Next.js — Dashboard, Agenda, Financeiro
│       ├── app/                     # App Router
│       │   ├── (auth)/
│       │   ├── dashboard/
│       │   ├── agenda/
│       │   ├── financeiro/
│       │   └── configuracoes/
│       ├── components/
│       │   └── ui/                  # Shadcn/UI
│       ├── lib/
│       │   ├── api-client/          # Cliente gerado a partir do OpenAPI do Backend
│       │   └── stores/              # Zustand
│       └── test/
│
├── packages/                        # Código compartilhado entre apps
│   ├── shared-types/                 # Tipos TypeScript compartilhados (DTOs, enums do Domain)
│   └── config/                       # ESLint, TSConfig, Prettier compartilhados
│
├── infra/
│   ├── docker/
│   │   ├── Dockerfile.backend
│   │   └── Dockerfile.frontend
│   ├── railway/                      # Configuração de deploy (railway.json/toml)
│   └── scripts/
│       ├── seed-dev.ts               # Seeds de desenvolvimento (múltiplos Tenants — 09-Testes/00)
│       └── migrate.sh
│
├── docs/                             # Espelho da documentação já produzida (fonte: este processo)
│   ├── 00-PRD/
│   ├── 01-Domain/
│   ├── 02-Arquitetura/
│   ├── 03-Database/
│   ├── 04-API/
│   ├── 05-IA/
│   ├── 06-UX/
│   ├── 07-Infra/
│   └── 09-Testes/
│
├── .github/
│   └── workflows/
│       ├── ci.yml                    # Lint + testes em todo PR
│       └── deploy.yml                # Deploy automático em merge para main (Staging) / tag (Prod)
│
├── .env.example
├── package.json                      # Workspace root (pnpm/turborepo)
├── turbo.json
└── README.md                         # Ponto de entrada — aponta para docs/
```

---

## Convenções de organização

- **`domain/` nunca importa de `infrastructure/` ou `api/`** — a dependência é sempre de fora para dentro (Clean Architecture, Princípio 14). Enforçado por regra de lint (`eslint-plugin-boundaries` ou equivalente), não apenas por disciplina.
- **Todo Serviço de Domínio mora em `domain-services/`, nunca dentro de `api/`** — reforça que a API é apenas a porta de entrada, nunca o lugar de regra de negócio (Princípio 04).
- **`test/critical/` é isolado** dos demais testes — roda como gate obrigatório de merge, separado da suíte geral, para que os 16 Testes Críticos nunca sejam acidentalmente pulados ou ignorados em um CI mais permissivo.
- **`docs/` é sincronizado, não duplicado** — qualquer atualização de arquitetura durante a implementação atualiza primeiro `docs/`, depois o código. Documentação code-adjacent, não separada em outro repositório.

## O que fica fora do monorepo

- Documentação institucional do CEO (`CEO/`) — permanece em local separado (ex: Google Drive, Notion), não pertence ao repositório de engenharia.
- `20 - Anotações do CEO` — já recomendado para arquivamento fora do escopo técnico na Auditoria Final (Entregável 1).
