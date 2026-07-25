# PD-003 — Acesso à API por Tenant (Business/Enterprise): Análise Arquitetural

## Origem

Pendência registrada em `plan-benefits.ts` desde a implementação de
Benefícios por Plano: `externalApiAccess: true` para Business/Enterprise
não tem nenhum gate real — não existe mecanismo de API key por Tenant no
sistema, só JWT de usuário logado e o `AutomationApiKeyGuard` global do
Módulo 14 (uma única chave, para o n8n, sem noção de Tenant).

## Método

Investiguei o código real antes de propor qualquer coisa — mesmo padrão do
PD-001/PD-005 (Multiunidade).

## O que já existe (e por que não serve de base direta)

- **`AutomationApiKeyGuard`** (`api/automations/automation-api-key.guard.ts`): 1 chave só, em `process.env.AUTOMATION_API_KEY`, comparação direta de string. Não tem conceito de Tenant — não dá pra saber, a partir dela, qual clínica está fazendo a chamada.
- **`JwtAuthGuard`**: hoje é, por design e por documentação (`docs/02-Arquitetura`), o **único** ponto de entrada de `tenantId` no sistema — o comentário no código é explícito: *"Único lugar do sistema onde tenantId é atribuído — nunca em outro ponto do código."* Qualquer novo guard de API key que também chame `tenantContext.set(...)` contradiz literalmente essa frase como está escrita hoje.
- **`AuthService.hashPassword()`**: usa bcrypt — correto para senha (baixa entropia, escolhida por humano, precisa de salt + custo computacional alto para resistir a dicionário). **Não é o padrão certo para API key** — API keys são segredos de alta entropia gerados aleatoriamente (não escolhidos por humano), então o problema de ataque de dicionário não existe; o padrão de mercado (Stripe, GitHub) é hash rápido e determinístico (SHA-256), que permite busca direta indexada no banco — bcrypt, com seu salt aleatório por hash, torna impossível localizar a linha certa sem escanear a tabela inteira.
- **`ActorType`** (schema Prisma): já existe `'user' | 'ai_agent' | 'system'` — o valor `system` já existe e nunca foi usado; é candidato natural para "esta escrita veio de uma integração externa autenticada por API key", sem precisar de migration para um 4º valor.
- **RLS já tem precedente de exceção documentada**: `auth_lookup_by_email` (Módulo 04) é uma segunda política, estreita e explícita, para um caso legítimo que a regra geral não cobria (login antes de saber o tenantId). O mesmo padrão de "exceção única, documentada, não uma porta aberta" se aplica aqui.

## Decisões de arquitetura necessárias (com recomendação)

### 1. Meio-termo do "único ponto de entrada de tenantId"

**Recomendo:** tratar `TenantApiKeyGuard` como uma segunda exceção
explícita e documentada, atualizando o comentário do `JwtAuthGuard` de
"único" para nomear os dois guards autorizados — nunca abrir a regra de
forma genérica. Mesmo espírito do `auth_lookup_by_email`.

### 2. Modelo de dados

Nova entidade `TenantApiKey`, 1:1 com `Tenant` (como `ClinicSettings`/`AiSettings`) — só 1 chave ativa por vez, gerar uma nova invalida a anterior automaticamente (upsert, não uma lista). Suficiente para o MVP; não modelar múltiplas chaves nomeadas/com escopo agora — ninguém pediu isso.

```
model TenantApiKey {
  id         String   @id @default(uuid())
  tenantId   String   @unique
  hashedKey  String   // SHA-256, não bcrypt — ver justificativa acima
  createdAt  DateTime @default(now())
  lastUsedAt DateTime?
}
```

RLS: mesma política padrão de tenant_id que todas as outras tabelas.

### 3. Geração e exibição

`POST /settings/api-key` (autenticado por JWT normal, ação de admin) —
gera um segredo aleatório (32 bytes, hex), calcula o SHA-256, salva o
hash, **retorna o segredo em texto puro uma única vez** na resposta —
nunca mais recuperável depois (mesmo padrão que GitHub Personal Access
Tokens). Bloqueado (`ConflictException`, mesmo padrão de `THERAPIST_LIMIT_REACHED`) se `PLAN_BENEFITS[plan].externalApiAccess === false` (Professional).

### 4. Verificação em cada requisição (`TenantApiKeyGuard`)

1. Lê header `X-API-Key`.
2. Calcula SHA-256, busca `TenantApiKey` por `hashedKey` (lookup direto, indexado).
3. Se não encontrar: 401.
4. **Confere o plano de novo, na hora** (mesmo padrão do `SubscriptionAccessGuard`, que também não confia em estado cacheado) — se o Tenant foi rebaixado para Professional depois de gerar a chave, a chave para de funcionar sem precisar de nenhuma revogação manual.
5. `tenantContext.set(tenantId, ???)` — não existe um `userId` real numa chamada de API key. Ver ponto em aberto abaixo.
6. Toda escrita feita nessa requisição é auditada com `actorType: 'system'`, `userId: null` — nunca atribuída a um humano.

## Decisões finais (2026-07-18) — implementado

- **Exceção ao "único ponto de entrada de tenantId":** aprovada, opção
  recomendada. `TenantApiKeyGuard` é hoje o segundo guard autorizado a
  chamar `tenantContext.set(...)` — documentado em `JwtAuthGuard`,
  `TenantContext` e `prisma/rls/enable-rls.sql`.
- **`userId` sentinel:** aprovada a opção (b) — `TenantContext.userId`
  agora é `string | null`. Varredura completa feita: havia exatamente 1
  uso real de `tenantContext.userId` em todo `src/` (dentro de
  `AuditService.recordAll()`), já ajustado para inferir `actorType:
  'system'` automaticamente quando `userId` é `null` — nenhum outro Use
  Case precisou mudar.

**Implementado:** `TenantApiKey` (schema + migration + RLS, reaproveitando
o mesmo bypass do login por email), `GerarApiKeyUseCase`
(`POST /subscription/api-key`, bloqueado para Professional), `TenantApiKeyGuard`
(SHA-256, reavalia o plano a cada uso). Testado contra Postgres real em
`test/critical/tenant-api-key.test.ts` (geração via HTTP real, isolamento
entre Tenants, não-vazamento do bypass de RLS entre transações, bloqueio
por rebaixamento de plano).

**Não implementado (fora do escopo desta rodada, deliberado):** nenhum
endpoint de negócio (agenda, pacientes, financeiro) usa
`TenantApiKeyGuard` ainda — só a infraestrutura de autenticação existe.
Decidir quais dados ficam expostos por API é uma decisão de superfície de
API separada, não decidida pela tabela de benefícios nem por esta análise.

## Impacto

- **Módulos afetados:** novo (Módulo 17 ou um novo "Módulo 18 — API Pública", a definir); `JwtAuthGuard`/`TenantContext` só na documentação do invariante, não na lógica.
- **Migração:** 1 tabela nova (`tenant_api_key`), com RLS padrão — aditiva.
- **Nenhuma mudança** em `AutomationApiKeyGuard` (Módulo 14) — mecanismo separado, propósito separado (n8n, não um Tenant específico).

## Recomendação geral

Arquitetura pequena e isolada (1 tabela, 1 guard, 1 endpoint de geração),
mas com duas decisões reais que não são só engenharia — o "único ponto de
entrada de tenantId" e o formato do `userId` sentinel. Peço as duas
decisões antes de implementar.
