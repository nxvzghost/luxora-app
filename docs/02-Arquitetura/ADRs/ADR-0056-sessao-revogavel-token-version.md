# ADR-0056 — Sessão revogável por versão de token (`User.tokenVersion`)

**Status:** ADOTADO
**Origem:** Fase 2 da auditoria técnica de 04/10/2026 (Segurança e dependências), riscos R4 e R12.
**Data:** 5 de outubro de 2026

## Objetivo

Dar efeito real, no servidor, ao encerramento de uma sessão: um refresh token precisa poder ser invalidado, um usuário desativado não pode continuar renovando o acesso, e o logout não pode ser só o cliente esquecendo o token.

## Auditoria prévia (achados confirmados no código, não só no relatório)

Fluxo auditado de ponta a ponta — login → access token → refresh → logout → expiração → revogação → usuário inativo:

1. **`AuthService.refresh()` confiava só na assinatura.** O novo par de tokens era montado a partir do payload do token antigo (`sub`, `tenantId`, `role`), sem consultar o banco. Um usuário desativado continuava renovando o acesso, e o papel (`role`) ficava congelado no valor do primeiro login.
2. **A sessão era renovável para sempre.** Cada refresh emitia um refresh token novo de 7 dias; o prazo de 7 dias valia para um token, nunca para a sessão.
3. **`POST /auth/logout` não fazia nada** (corpo vazio, comentário "stateless neste MVP").
4. **`JwtAuthGuard` não verificava o campo `type`.** Qualquer JWT com assinatura válida autenticava a requisição — inclusive o refresh token de 7 dias, o que anulava a curta duração (15 minutos) do access token.

Os itens 2 e 4 não constavam do relatório da auditoria; apareceram na inspeção do código desta fase.

## Decisão

**Versão de sessão por usuário.** Nova coluna `user.token_version` (`INTEGER NOT NULL DEFAULT 0`, migration `20261005033326_add_user_token_version`). Todo refresh token carrega duas claims novas: `tv` (o `tokenVersion` do usuário na emissão) e `sst` (início da sessão, em segundos desde a época, preservado a cada renovação). O access token não muda e continua stateless.

**Refresh.** `AuthService.refresh()` verifica a assinatura e o tipo, relê o usuário no banco e só renova se o usuário existir, estiver ativo (`deletedAt` nulo) e `tokenVersion` do banco for igual a `tv`. O novo par sai com o papel atual do banco.

**Logout.** `POST /auth/logout` passa a receber `{ "refreshToken": "..." }` e incrementa `tokenVersion`, invalidando todos os refresh tokens emitidos antes. O incremento é condicional à versão do próprio token (`UPDATE ... WHERE id = ? AND token_version = ?`), então repetir a chamada — ou duas chamadas simultâneas — nunca incrementa duas vezes. Responde 204 também para token inválido, expirado ou já revogado: não há nada a revogar.

**Desativação.** `PrismaUserRepository.save()` incrementa `tokenVersion` ao gravar um usuário desativado. O refresh já recusa usuário desativado; o incremento impede que uma reativação posterior ressuscite sessões antigas.

**Só access token autentica.** `JwtAuthGuard` recusa qualquer token cujo `type` não seja `access`.

**Duração máxima da sessão.** `JWT_SESSION_MAX_AGE_DAYS` (padrão 30). Passado esse prazo desde o login, o refresh é recusado mesmo com o token ainda válido — é o "tempo máximo configurável" que `06-Autenticacao.md` já previa.

**Acesso ao banco sem bypass de RLS.** Refresh e logout rodam antes de existir `TenantContext`. Como o `tenantId` vem de um refresh token cuja assinatura já foi verificada — a mesma origem de confiança do `JwtAuthGuard` —, a consulta roda numa transação escopada a esse Tenant (`set_config('app.tenant_id', ...)` parametrizado, mesmo padrão de `PrismaUserRepository.withTenant()`). A RLS de `user` garante que o usuário pertence ao Tenant do token. `forAuthLookup()` não é usado: o Tenant é conhecido, então o bypass não é necessário.

## Alternativas consideradas

- **Tabela de sessões com rotação de refresh token e detecção de reuso.** É o desenho mais forte: logout por dispositivo e detecção automática de token roubado. Rejeitada nesta fase por custo e risco: estado por sessão, limpeza de linhas expiradas e, principalmente, a corrida entre abas — duas abas renovando ao mesmo tempo com o mesmo token seriam tratadas como reuso e derrubariam a sessão legítima, o que exige coordenação extra no frontend. Fica registrada como evolução, não como pendência desta ADR.
- **Lista de revogação em Redis.** Rejeitada: o Redis do projeto não tem persistência garantida, e perder o estado reabilitaria tokens já revogados (falha aberta). A coluna no Postgres é durável.
- **Conferir `tokenVersion` também no access token, a cada requisição.** Rejeitada: uma consulta ao banco por requisição autenticada. O access token curto já limita a janela.

## Limitações conhecidas

- Um access token já emitido continua válido até expirar (15 minutos por padrão) depois de logout ou desativação.
- O logout encerra todas as sessões do usuário, não só a do dispositivo. `06-Autenticacao.md` prevê "encerrar sessão atual" separado de "encerrar todas as sessões"; só o segundo está atendido.
- O refresh token não é de uso único. Um token roubado renova até que haja logout, desativação ou o fim da duração máxima da sessão; não há detecção automática de roubo.
- Refresh tokens emitidos antes desta ADR não têm `tv`/`sst` e deixam de renovar: o usuário faz login de novo uma vez.
- Não existe troca de senha no sistema. Quando existir, deve incrementar `tokenVersion` (`06-Autenticacao.md`: "revogação das sessões anteriores").
- `POST /auth/refresh` e `POST /auth/logout` continuam sem rate limit próprio (decisão da ADR-0050, não revista aqui).

## Evidências

**Arquivos alterados:**
- `apps/backend/prisma/schema.prisma` e migration `20261005033326_add_user_token_version` (SQL gerado por `prisma migrate diff`, aplicado com `prisma migrate deploy`).
- `apps/backend/src/api/auth/auth.service.ts` — `refresh()`, `logout()`, claims `tv`/`sst`, duração máxima.
- `apps/backend/src/api/auth/auth.controller.ts` — `logout` recebe o refresh token.
- `apps/backend/src/api/auth/jwt-auth.guard.ts` — só `type: 'access'`.
- `apps/backend/src/infrastructure/database/repositories/prisma-user.repository.ts` — incremento na desativação.
- `.env.example`, `CONFIGURACAO_AMBIENTE.md`, `docs/04-API/01-Contratos-REST.md`.

**Testes:**
- `apps/backend/test/critical/auth-session-revocation.test.ts` — 16 testes novos contra Postgres real: refresh de usuário ativo; refresh token recusado como Bearer; access token recusado no refresh; papel atualizado no refresh; logout revogando o token usado e os anteriores; idempotência e concorrência do logout; usuário desativado e depois reativado; token forjado apontando para outro Tenant; token no formato antigo; sessão acima da duração máxima.
- `apps/backend/test/unit/api/auth/auth.service.test.ts` (22 testes) e `jwt-auth.guard.test.ts` (5 testes, novo).

**Resultado das suítes:** unitária 77 arquivos, 692 testes; integração 9 testes; crítica 29 arquivos, 214 testes (1 skip pré-existente); 0 falhas. `nest build` e `eslint` limpos.

## Confirmações

- **Contrato alterado:** `POST /auth/logout` passa a exigir `refreshToken` no corpo (400 sem ele). Nenhum cliente chamava essa rota antes.
- **Multi-tenant preservado:** nenhuma policy nova, nenhum bypass novo; a coluna nova está sob a `tenant_isolation` já existente.
- **Validação de JWT não foi enfraquecida:** só ganhou verificações (tipo do token, claims de sessão, formato de `tenantId`/`sub`).

## Referências

- `docs/02-Arquitetura/06-Autenticacao.md` — seções "Sessão", "Expiração" e "Revogação de Sessões".
- `docs/02-Arquitetura/ADRs/ADR-0050-rate-limit-login.md` — escopo do rate limit de autenticação.
- `apps/backend/prisma/rls/enable-rls.sql` — policies de `user`.
