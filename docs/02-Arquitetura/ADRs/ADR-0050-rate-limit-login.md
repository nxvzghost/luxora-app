# ADR-0050 — Rate limiting em `POST /auth/login` via `@nestjs/throttler`

**Status:** ADOTADO
**Origem:** AD-006 (`docs/PLANO_DE_EXECUCAO.md`, Epic 3 — Segurança Fundamental), auditoria técnica aprovada em 25/07/2026, implementação aprovada na mesma data.
**Data:** 25 de julho de 2026

## Objetivo

`POST /auth/login` não tinha nenhuma proteção contra força bruta — nenhum limite de tentativas, em nenhuma janela de tempo, para nenhum cliente. Esta ADR fecha essa lacuna.

## Auditoria prévia (resumo)

Mapeamento completo do fluxo de autenticação, feito antes de qualquer código: `AuthController` tem os 3 únicos endpoints da API sem `JwtAuthGuard` (login/refresh/logout — são o próprio mecanismo de obter o token). `AuthService.login()` é auto-contido (só depende de `JwtService`/`PrismaService`), sem nenhum guard hoje. Achados relevantes:
- `@nestjs/throttler` não estava instalado; nenhum rate limit existia em nenhuma rota da API.
- `main.ts` nunca configurava `trust proxy` no Express — em produção, atrás do proxy do Railway, qualquer rate limit por IP veria sempre o IP do proxy, não do cliente real.
- A Suíte Crítica (18 arquivos) faz dezenas de logins reais contra `POST /auth/login`, do mesmo processo/IP — um throttle mal calibrado quebraria a suíte inteira, risco identificado e confirmado na prática durante a implementação (ver "Lições aprendidas").

## Decisão

**Escopo: só `POST /auth/login`, nunca global.** `ThrottlerModule` registrado em `AuthModule` (não em `AppModule`); `@UseGuards(ThrottlerGuard)` aplicado explicitamente só no handler `login()` de `AuthController` — `refresh`/`logout` ficam de fora desta AD (menos sensíveis a força bruta: `refresh` exige um refresh token já válido; `logout` não autentica nada).

**Chave de rastreamento: IP do cliente, comportamento padrão do `@nestjs/throttler` (`req.ip`) — decisão explícita, não uma chave composta IP+email.** Uma proposta inicial de chave composta (IP+email, para evitar que usuários atrás do mesmo NAT/proxy corporativo compartilhem o mesmo balde) foi avaliada e **rejeitada deliberadamente**: permitiria a um atacante distribuir tentativas sobre muitos emails diferentes a partir do mesmo IP sem esbarrar rapidamente no limite daquele endereço — o comportamento padrão por IP protege melhor contra esse cenário. Uma estratégia mais sofisticada (IP+identidade, reputação, store distribuído) fica registrada como possível evolução futura, não escopo desta AD.

**Configuração:** `ThrottlerModule.forRootAsync()` (não `forRoot()` — ver "Lições aprendidas" sobre por que isso importa), lendo `AUTH_THROTTLE_LIMIT` (padrão 5) e `AUTH_THROTTLE_TTL_MS` (padrão 60000) via `process.env`, mesmo padrão de `JWT_EXPIRES_IN`.

**`trust proxy`:** `app.getHttpAdapter().getInstance().set('trust proxy', 1)` em `main.ts` — confia apenas no primeiro hop à frente da aplicação (o proxy de borda do Railway), necessário para que `req.ip` reflita o cliente real em produção.

**Formato de erro:** `ThrottlerException` (sempre HTTP 429) mapeada em `LuxoraExceptionFilter` para o formato oficial da API — novo código `TOO_MANY_REQUESTS`, nova categoria `rate_limit` (adicionada ao union type `ErrorCategory`).

## Lições aprendidas (achado real durante a implementação, não hipotético)

**`ThrottlerModule.forRoot({...})` avalia o objeto de configuração no momento em que o módulo é *carregado*** — a metadata do decorator `@Module()` é montada quando a cadeia de `import` estática resolve o arquivo, o que acontece **antes** de qualquer `beforeAll` de teste rodar. Um teste que tenta sobrescrever `process.env.AUTH_THROTTLE_LIMIT` antes de `bootstrapTestApp()` **não tem efeito nenhum** com `forRoot()` — o valor já foi capturado antes. Descoberto na prática (não hipótese): a primeira versão do teste crítico de throttle sempre via o limite de `global-setup.ts` (10000), nunca o limite pequeno que o próprio teste tentava configurar. Corrigido trocando para `ThrottlerModule.forRootAsync({ useFactory: () => ({...}) })` — a função `useFactory` só é invocada quando o Nest de fato instancia o módulo (`compile()`), momento em que o `beforeAll` do teste já rodou.

## Estratégia para a Suíte Crítica

`test/critical/support/global-setup.ts` eleva `AUTH_THROTTLE_LIMIT`/`AUTH_THROTTLE_TTL_MS` para valores permissivos (10000 tentativas / 1s), herdados por todos os workers da Suíte Crítica — mesmo mecanismo já usado para `DATABASE_URL`/`connection_limit`. Sem isso, os ~18 arquivos que fazem login real via `loginAs()`/`createDedicatedUserAndLogin()` esgotariam o limite quase imediatamente. `apps/backend/.env`/`.env` reais (usados por `pnpm dev`/`test:unit`/`test:integration`) nunca são tocados por este override — só `process.env` do processo do Vitest, escopado a `test/critical`.

Um arquivo que precise testar o comportamento real do throttle (`auth-login-throttle.test.ts`, novo nesta AD) sobrescreve as duas variáveis no próprio `beforeAll`, **antes** de chamar `bootstrapTestApp()`, e restaura os valores originais no `afterAll` — padrão possível justamente por causa da correção `forRootAsync()` acima.

## Evidências quantitativas

**Arquivos alterados:**
- `apps/backend/package.json`/`pnpm-lock.yaml` — nova dependência `@nestjs/throttler@6.5.0`.
- `apps/backend/src/api/auth/auth.module.ts` — `ThrottlerModule.forRootAsync()`.
- `apps/backend/src/api/auth/auth.controller.ts` — `@UseGuards(ThrottlerGuard)` só em `login()`.
- `apps/backend/src/main.ts` — `trust proxy`.
- `apps/backend/src/shared/luxora-exception.filter.ts` — categoria `rate_limit` + código `TOO_MANY_REQUESTS`.
- `apps/backend/test/critical/support/global-setup.ts` — override para a Suíte Crítica.
- `.env.example`, `CONFIGURACAO_AMBIENTE.md`, `.env`, `apps/backend/.env` — novas variáveis.

**Arquivos novos:**
- `apps/backend/test/critical/auth-login-throttle.test.ts` (3 testes, Postgres real: dentro do limite → 401 real; N+1 → 429 no formato oficial; após o TTL → 200 real).
- 1 teste unitário novo em `luxora-exception.filter.test.ts` (mapeamento de `ThrottlerException`).

**Resultado da suíte unitária completa:** 52 arquivos, 430 testes, 0 falhas.

**Resultado da suíte crítica completa** (`/root/luxora-app`, 2 execuções consecutivas): ambas 19/20 arquivos, 138/139 testes, 0 falhas (1 skip documentado, não relacionado).

**Build:** `nest build` limpo, exit 0. **Lint:** 2 erros pré-existentes (mesmos já identificados na AD-005, não relacionados a esta mudança).

## Confirmações

- **Nenhuma regra de negócio foi alterada** — `AuthService.login()` continua idêntico; o guard roda antes do handler, sem tocar a lógica de autenticação em si.
- **Nenhum endpoint público mudou de contrato** — `POST /auth/login` mantém a mesma assinatura de request/response; só passa a poder responder 429 sob volume excessivo.
- **Nenhuma migration de banco foi necessária.**

## Referências

- `docs/PLANO_DE_EXECUCAO.md` — AD-006, Epic 3.
- `docs/02-Arquitetura/12-Seguranca.md` — seção "Proteção contra Ataques".
- `CONFIGURACAO_AMBIENTE.md` — `AUTH_THROTTLE_LIMIT`/`AUTH_THROTTLE_TTL_MS`.
