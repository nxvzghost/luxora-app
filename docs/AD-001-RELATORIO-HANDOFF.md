# Relatório Final de Handoff — AD-001 (Gestão de Usuários)

**Epic:** 5 — Gestão de Usuários (Onboarding)
**Status:** Implementação tecnicamente validada. **Nenhum commit foi realizado** — aguardando aprovação (governança explícita desta AD).
**Data:** 28 de julho de 2026

---

## 1. Resumo técnico da implementação

A API ganha CRUD completo de `User` (criar, listar, atualizar, desativar, reativar) e, principalmente, um caminho de **bootstrap do primeiro administrador** de um Tenant recém-criado — até esta AD, não existia nenhum caminho de aplicação (Controller, Use Case ou rota) para criar o primeiro usuário de uma clínica nova; `prisma/seed.ts` era o único meio.

**Decisão arquitetural aprovada na descoberta — Opção A (endpoint público condicional):** `POST /users/bootstrap-admin` não usa `JwtAuthGuard` — por definição não pode, pois nenhum usuário existe ainda para emitir o JWT. A segurança do endpoint não vem de autenticação, vem de uma garantia de negócio ("Tenant com exatamente 0 usuários") aplicada **atomicamente dentro do repositório**, nunca por uma checagem solta em Controller ou Use Case: `PrismaUserRepository.provisionFirstAdmin()` abre uma transação, executa `SELECT id FROM tenant WHERE id = $1 FOR UPDATE` (lock de linha sobre o Tenant), conta os usuários existentes, e só então insere — validado sob concorrência real (2 chamadas simultâneas para o mesmo Tenant produzem exatamente `[201, 409]`, nunca 2 admins).

`AssignableUserRole = 'admin' | 'therapist'` exclui `super_admin` em 3 camadas independentes (tipo TypeScript do DTO, `@IsIn()` do `class-validator`, invariante da entidade `User`) — nenhuma rota desta AD jamais aceita `super_admin`.

**3 achados reais, descobertos e corrigidos durante a implementação (nenhum hipotético, nenhum estava previsto na fase de descoberta):**

1. **`AuditService` é incompatível com o fluxo de bootstrap.** `PrismaAuditLogRepository.record()` chama `PrismaService.forTenant()` incondicionalmente, que lê `TenantContext.tenantId` — mas `TenantContext` nunca é inicializado neste fluxo (só `JwtAuthGuard`/`TenantApiKeyGuard` podem chamar `.set()`, e nenhum dos dois roda em `bootstrap-admin`). O erro foi capturado diretamente em execução de teste (`TenantContext acessado antes de ser inicializado`). Corrigido movendo a gravação do evento de auditoria para **dentro da própria transação** de `provisionFirstAdmin()` — `tx.auditLog.create()` sobre `user.pullDomainEvents()`, com `actorType: 'system'` explícito — em vez de `AuditService`, só para este único caminho. Documentado no próprio código como exceção arquitetural deliberada e estreita.
2. **Regressão real e confirmada no rate limit de `POST /auth/login` (AD-006).** A primeira versão registrava um `ThrottlerModule.forRootAsync()` independente em `UsersModule` (rate limit próprio do `bootstrap-admin`), além do já existente em `AuthModule`. Isso quebrou a suíte crítica de AD-006 (`expected 200 to be 429`). Causa raiz, confirmada lendo o código-fonte do pacote instalado (`@nestjs/throttler@6.5.0`, não a documentação): a classe `ThrottlerModule` já é decorada com `@Global()` **internamente pelo próprio pacote** — não existe (nem nunca existiu) uma opção `isGlobal` em `ThrottlerAsyncOptions` (confirmado em `throttler-module-options.interface.d.ts`); declará-la nem compila (`TS2353`, pego pelo `nest build` desta própria validação). Cada `forRootAsync()` já nasce global; dois registros geram dois providers concorrentes para o mesmo token `THROTTLER_OPTIONS`, e um sobrescreve o outro — por isso o limite de `/auth/login` parava de ser aplicado. Corrigido consolidando em **um único** `ThrottlerModule.forRootAsync()`, em `AuthModule`, com os dois throttlers nomeados (`auth-login`, `users-bootstrap-admin`) no mesmo array; cada rota seleciona explicitamente o seu via `@Throttle()`/`@SkipThrottle()`.
3. **Gap de fixture de teste, não de código de produção.** O teste crítico do caminho de sucesso do bootstrap usava um Tenant dedicado sem assinatura ativa; o token emitido no bootstrap, usado em seguida para `GET /users` (rota protegida por `SubscriptionAccessGuard`), corretamente retornava `403` — comportamento certo da aplicação, fixture incompleta. Corrigido adicionando `{ withActiveSubscription: true }` à fixture desse teste específico.

## 2. Arquivos criados

- `apps/backend/src/domain/user/user.entity.ts`
- `apps/backend/src/domain-services/platform/user.repository.ts`
- `apps/backend/src/infrastructure/database/repositories/prisma-user.repository.ts`
- `apps/backend/src/use-cases/user/gerenciar-usuarios.use-case.ts` (6 Use Cases: `ProvisionarPrimeiroAdminUseCase`, `CriarUsuarioUseCase`, `ListarUsuariosUseCase`, `AtualizarUsuarioUseCase`, `DesativarUsuarioUseCase`, `ReativarUsuarioUseCase`)
- `apps/backend/src/api/users/dto/user.dto.ts`
- `apps/backend/src/api/users/users.controller.ts`
- `apps/backend/src/api/users/users.module.ts`
- `apps/backend/test/unit/domain/user/user.entity.test.ts` (11 testes)
- `apps/backend/test/unit/use-cases/user/gerenciar-usuarios.use-case.test.ts` (14 testes)
- `apps/backend/test/critical/users-bootstrap-admin.test.ts` (5 testes, incluindo concorrência real)
- `apps/backend/test/critical/users-crud.test.ts` (5 testes)
- `docs/AD-001-RELATORIO-HANDOFF.md` (este documento)

## 3. Arquivos modificados

- `apps/backend/src/api/auth/auth.service.ts` — `issueTokens()` tornado público (era `private`) para reúso por `ProvisionarPrimeiroAdminUseCase`; nenhuma mudança de comportamento.
- `apps/backend/src/api/auth/auth.module.ts` — achado #2: consolidação do `ThrottlerModule.forRootAsync()` em um único registro, dois throttlers nomeados.
- `apps/backend/src/api/auth/auth.controller.ts` — `@SkipThrottle({ 'users-bootstrap-admin': true })` em `login()`.
- `apps/backend/src/app.module.ts` — `UsersModule` importado.
- `.env`, `.env.example`, `apps/backend/.env` — `USERS_BOOTSTRAP_THROTTLE_LIMIT`/`USERS_BOOTSTRAP_THROTTLE_TTL_MS`.
- `apps/backend/test/critical/support/global-setup.ts` — eleva o limite do novo throttler só para a Suíte Crítica (mesmo padrão já usado para `AUTH_THROTTLE_*`).
- `docs/02-Arquitetura/16-Politica-RBAC.md` — 4 rotas novas em `@Roles('admin')`, 1 rota nova aberta a qualquer autenticado, 1 rota nova fora do escopo RBAC (`bootstrap-admin`); totais recalculados (33 rotas com `@Roles()`, 12 abertas, 45 autenticadas via `JwtAuthGuard`).
- `docs/04-API/01-Contratos-REST.md` — nova seção `Usuários (/api/v1/users)`.
- `CHANGELOG.md`, `docs/PLANO_DE_EXECUCAO.md` — fechamento formal (Epic 5 concluído integralmente).

## 4. Resultado das validações

| Verificação | Resultado |
|---|---|
| Migration | Nenhuma criada (condição explícita da aprovação) — confirmado: última migration em `prisma/migrations` continua `20260725235742_add_availability_calendar_exceptions`, da AD-008 |
| `schema.prisma` | Inalterado — `User` 100% reaproveitado |
| `nest build` | Exit 0, limpo (pegou o erro real do achado #2 — `isGlobal` não existe — antes da suíte de testes rodar) |
| `eslint` | Exit 0, sem erros |
| Suíte unitária completa | 56 arquivos, **466/466 testes, 0 falhas** |
| Suíte crítica completa (Postgres/Redis reais, `/root/luxora-app`) | 24 arquivos (23 passaram, 1 skip documentado pré-existente e não relacionado), **162/163 testes, 0 falhas** — inclui `auth-login-throttle.test.ts` (AD-006) passando, confirmando a regressão do achado #2 corrigida sem reintrodução |

## 5. Confirmações explícitas (condições da aprovação)

- **RBAC íntegro**: as 29 rotas pré-existentes com `@Roles()` permanecem sem alteração de comportamento; as 4 novas (`POST`/`PATCH`/`deactivate`/`reactivate` de `/users`) seguem o mesmo padrão `admin`-only já estabelecido pela AD-003.
- **`bootstrap-admin` permanece protegido pela regra "Tenant com 0 usuários"** — testado sob concorrência real (2 chamadas simultâneas → exatamente `[201, 409]`, contagem final de usuários = 1) e sob reexecução sequencial (segunda tentativa sempre `409`, nunca cria um segundo admin).
- **`super_admin` permanece impossível de criar ou atribuir via API** — testado explicitamente (`role: 'super_admin'` no corpo de `POST /users` → `400`, nunca chega a tocar o banco).
- **Auditoria funcionando conforme o padrão aprovado** — `actorType: 'system'` para o evento de bootstrap (gravado dentro da transação do repositório, achado #1); as demais 5 rotas usam `AuditService.recordAll()` normalmente, sem mudança em relação ao padrão já usado por `Therapist`/`Patient`.
- **Nenhuma migration de banco foi criada.**
- **Fluxo de autenticação existente intocado** — `AuthService.login()`/`refresh()` sem nenhuma alteração de comportamento; `issueTokens()` só teve sua visibilidade alterada de `private` para pública.

## 6. Riscos remanescentes

- **`ThrottlerAsyncOptions` não aceita `isGlobal`** (achado #2) é uma característica desta versão específica (`@nestjs/throttler@6.5.0`) — se o pacote for atualizado no futuro e essa API mudar, revisar `auth.module.ts` antes de assumir que a consolidação em registro único continua sendo a forma correta de coexistir dois throttlers nomeados.
- **A exceção arquitetural do achado #1** (auditoria gravada pelo repositório, não pelo `AuditService`, só para `provisionFirstAdmin()`) é um padrão único no código-base — se uma futura AD precisar de outro fluxo público pré-autenticação com necessidade de auditoria, replicar essa mesma exceção em vez de tentar reusar `AuditService` diretamente (ele sempre vai falhar sem `TenantContext` inicializado).
- **Nenhum GET dedicado para detalhe de um único usuário** (`GET /users/:id`) — só listagem (`GET /users`) foi implementada, consistente com o escopo aprovado na descoberta; considerar se um cliente futuro precisar buscar um usuário específico sem carregar a lista inteira.

## 7. ADR / registro correspondente

**Nenhum ADR novo foi criado.** A decisão arquitetural desta AD (Opção A — endpoint público condicional para bootstrap) foi aprovada explicitamente nesta conversa, com justificativa e alternativas registradas na fase de descoberta e resumidas na seção 1 deste relatório e no CHANGELOG — segue o mesmo critério já aplicado às ADs 004/008 (decisão registrada em CHANGELOG/PLANO_DE_EXECUCAO quando não introduz uma decisão arquitetural de escopo mais amplo que o próprio item de backlog).

## 8. Estado do repositório

Nenhuma ação de `git add`, `git commit` ou `git push` foi realizada. Todos os arquivos criados/modificados listados nas seções 2 e 3 estão no working tree, sincronizados e verificados byte-a-byte (`diff`) entre a cópia de referência (`C:\Users\pichau\Desktop\luxora-app\luxora-app`) e o repositório canônico de execução (`/root/luxora-app`, WSL2/ext4).

Aguardando sua aprovação para o commit desta AD.
