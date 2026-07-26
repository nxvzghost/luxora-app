# Changelog — Vertex/Luxora

Registro das mudanças reais aplicadas ao código, na ordem em que foram executadas a partir do [Plano de Execução](./docs/PLANO_DE_EXECUCAO.md). Cada entrada cita o item de backlog correspondente (`AD-XXX`).

## [Não lançado]

### Encerramento — AD-008 (Persistência de AvailabilityException) (2026-07-25)

**AD-008 formalmente encerrada — bloqueios pontuais de disponibilidade do terapeuta (`AvailabilityException`) deixam de ser descartados a cada nova leitura do `AvailabilityCalendar`.**

**Achado real na fase de descoberta (auditoria prévia à implementação):** o gap era maior do que "não sobrevive a um restart" — não existia nenhum caminho de aplicação (use case, DTO ou rota) para sequer *definir* uma exceção; `setExceptions()` só era exercitado por teste de unidade da entidade, isoladamente. `VerificarDisponibilidadeUseCase`/`ConsultarDisponibilidadeUseCase` já consultavam `calendar.exceptions` corretamente — a lacuna era 100% de infraestrutura/aplicação, nunca de regra de negócio.

**Arquitetura adotada:**
- Coluna `exceptions Json @default("[]")` em `AvailabilityCalendar` — mesmo tratamento de `windows`, no mesmo Aggregate, nunca uma tabela dedicada (decisão explícita: `AvailabilityException` não tem existência independente do calendário que a possui, diferente de `ClinicHoliday`/`RecurringBlock`, que são Aggregate Roots próprios).
- `DefinirExcecoesDisponibilidadeUseCase` (novo), mesmo shape de `DefinirDisponibilidadeUseCase` — substitui a lista inteira, nunca faz merge parcial, mesma semântica já validada em `setExceptions()`.
- `PUT /therapists/:id/availability/exceptions`, `@Roles('admin')` — mesma política de RBAC da rota irmã de janelas, sem abrir nova decisão de política.
- **Achado corrigido durante a implementação, não hipotético:** `PrismaAvailabilityRepository.toDomain()` fazia apenas um cast de tipo (`as unknown as AvailabilityException[]`) sem converter `from`/`to` de string ISO (formato de retorno de uma coluna JSON) para `Date` — `isExcepted()` compara com `<`/`>`, que entre um `Date` e uma `string` não numérica sempre resulta em `false` (a string vira `NaN` na coerção). Sem a conversão explícita, a exceção seria persistida e lida do banco, mas nunca teria efeito real na decisão do Motor — bug pego pelo próprio teste crítico desta AD (a asserção de "horário bloqueado" só passou depois da correção).

**Evidência quantitativa:**
- 1 migration nova (`20260725235742_add_availability_calendar_exceptions`), validada (`prisma migrate status`: schema em dia, sem drift).
- 4 arquivos modificados de produção (`schema.prisma`, `prisma-availability.repository.ts`, `gerenciar-disponibilidade.use-case.ts`, `therapist.dto.ts`, `therapists.controller.ts`, `therapists.module.ts`) + 1 arquivo crítico novo (`availability-calendar-persistence.test.ts`, 6 testes) + 1 arquivo unitário estendido (`gerenciar-disponibilidade.use-case.test.ts`, +4 testes).
- Suíte unitária completa: 54 arquivos, 441 testes, 0 falhas (era 54/437 antes desta AD).
- Suíte crítica completa (`/root/luxora-app`, Postgres real): 21/22 arquivos (1 skip documentado, não relacionado), 152/153 testes, 0 falhas (era 20/21 arquivos, 146/147 antes desta AD).
- `nest build` limpo (exit 0). `eslint src/**/*.ts --fix` limpo (exit 0).

**Confirmações:** nenhuma regra de negócio alterada (`isAvailable()`/`isExcepted()`/`generateCandidateSlots()` intocados, exceto para consumir a persistência corretamente); nenhum endpoint existente mudou de contrato (rota nova, `windows`/janelas inalteradas); nenhuma tabela nova criada; sem impacto em RLS (policy já cobre a linha inteira por `tenant_id`, independente de coluna). Nenhum ADR novo foi criado — esta AD implementa uma decisão arquitetural já registrada em `ADR-0040`/PD-001, não introduz uma nova, mesmo critério já aplicado à AD-004.

### Encerramento — AD-016 (Observabilidade de Base — Correlation ID, OpenTelemetry, Prometheus) (2026-07-25)

**AD-016 formalmente encerrada — a plataforma passa a ter Correlation ID ponta a ponta, instrumentação OpenTelemetry explícita e métricas Prometheus reais.** Decisão completa em [`ADR-0051`](./docs/02-Arquitetura/ADRs/ADR-0051-observabilidade-correlation-id-otel-prometheus.md).

**Arquitetura adotada:**
- Correlation ID: middleware Express dedicado (`correlationIdMiddleware`), registrado antes de qualquer Guard; `CorrelationContext` próprio (`Scope.REQUEST`), deliberadamente **não** uma extensão de `TenantContext` — ciclos de vida e propósitos diferentes (decisão explícita do usuário, revertendo a proposta inicial da auditoria). Propagado explicitamente no payload de job do BullMQ (`MessageJobData.correlationId`) — nunca via contexto ambiente/DI, que não sobrevive à fronteira da fila (mesma limitação estrutural já existente para `TenantContext`, confirmada por auditoria).
- OpenTelemetry (`apps/backend/src/tracing.ts`): instrumentações registradas explicitamente (HTTP, Express, ioredis) — **nunca** `@opentelemetry/auto-instrumentations-node` (decisão explícita do usuário). Traces exportados via console (nenhum backend de tracing provisionado ainda).
- Prometheus: `GET /metrics`, fora do prefixo `api/v1`, protegido por `MetricsAccessGuard` (token estático, mesmo padrão de `AutomationApiKeyGuard`).
- Instrumentação de queries do Prisma **deliberadamente adiada** — exigiria `previewFeatures = ["tracing"]` (Prisma 5.22.0, confirmado lendo o runtime do client instalado), um recurso experimental. Reavaliação fica para quando a funcionalidade for GA.

**Evidência quantitativa:**
- 11 dependências novas (`@opentelemetry/*`).
- 6 arquivos novos de produção (`correlation-context.ts`, `correlation-context.module.ts`, `correlation-id.middleware.ts`, `tracing.ts`, `api/metrics/metrics-access.guard.ts`, `metrics.controller.ts`) + 12 arquivos alterados.
- 3 arquivos de teste novos (13 testes: 3 unitários de middleware + 2 unitários de contexto + 8 críticos contra Postgres/Redis reais, incluindo o smoke de 3 fluxos — auth/appointment/billing — exigido pelo critério de conclusão do Epic 4) + 2 arquivos de teste ajustados (`luxora-exception.filter.test.ts` +2 testes, `whatsapp-token-encryption.test.ts` +1 asserção).
- Suíte unitária completa: 54 arquivos, 437 testes, 0 falhas (era 52/432 antes desta AD).
- Suíte crítica completa (`/root/luxora-app`, Postgres/Redis reais): 20/21 arquivos (1 skip documentado, não relacionado), 146/147 testes, 0 falhas (era 19/20 arquivos, 138/139 testes antes desta AD).
- `nest build` limpo (exit 0). `eslint src/**/*.ts --fix` limpo (exit 0).
- Verificação manual ponta a ponta (app real, Postgres/Redis reais): `X-Correlation-Id` gerado/ecoado corretamente; `GET /metrics` rejeita sem token e com token errado (401), aceita com o token correto e devolve texto real no formato de exposição do Prometheus.

**Limitações conhecidas, documentadas na ADR:** instrumentação de spans do Prisma adiada; `fetch()` global (usado por `WhatsAppMessageProvider`/`AnthropicAIProvider`/gateway de pagamento) não é coberto por `HttpInstrumentation` (Node usa `undici`, não o módulo `http` clássico) — exigiria `@opentelemetry/instrumentation-undici`, não instalado; Correlation ID nas chamadas externas implementado só para o caminho do WhatsApp (o único que atravessa a fila); exportação de traces via console não é adequada para produção.

**Confirmações:** nenhuma regra de negócio alterada; nenhum endpoint público mudou de contrato (campos novos em DTOs são opcionais; `GET /metrics` é rota nova); nenhuma migration de banco necessária; nenhuma alteração em `schema.prisma`; nenhum `previewFeatures` habilitado.

### Encerramento — AD-006 (Rate limit em POST /auth/login) (2026-07-25)

**AD-006 formalmente encerrada — `POST /auth/login` protegido contra força bruta.** Decisão completa em [`ADR-0050`](./docs/02-Arquitetura/ADRs/ADR-0050-rate-limit-login.md).

**Arquitetura adotada:**
- `@nestjs/throttler@6.5.0`, escopado só a `POST /auth/login` (`@UseGuards(ThrottlerGuard)` no handler) — nunca aplicado globalmente à API.
- Chave de rastreamento: IP do cliente (`req.ip`, comportamento padrão da biblioteca) — decisão deliberada, não uma chave composta IP+email (avaliada e rejeitada: permitiria a um atacante distribuir tentativas sobre muitos emails a partir do mesmo IP).
- `AUTH_THROTTLE_LIMIT` (padrão 5) / `AUTH_THROTTLE_TTL_MS` (padrão 60000), via `process.env`, mesmo padrão de `JWT_EXPIRES_IN`.
- `app.set('trust proxy', 1)` em `main.ts` — necessário para `req.ip` refletir o cliente real atrás do proxy do Railway em produção.
- `ThrottlerException` mapeada em `LuxoraExceptionFilter` para o formato oficial da API (`TOO_MANY_REQUESTS`, categoria nova `rate_limit`).

**Achado real durante a implementação:** `ThrottlerModule.forRoot({...})` avalia `process.env` no momento em que o módulo é *carregado* (cadeia de `import` estática), não quando o app é de fato bootstrapado — um teste que sobrescreve o limite antes de `bootstrapTestApp()` não tinha nenhum efeito com `forRoot()`. Corrigido trocando para `forRootAsync({ useFactory: ... })`, que lê `process.env` só quando o Nest instancia o módulo. `test/critical/support/global-setup.ts` eleva o limite para toda a Suíte Crítica (mesmo mecanismo já usado para `DATABASE_URL`) — sem isso, os ~18 arquivos que fazem login real quebrariam a suíte inteira.

**Evidência quantitativa:**
- 7 arquivos alterados (`auth.module.ts`, `auth.controller.ts`, `main.ts`, `luxora-exception.filter.ts`, `global-setup.ts`, `.env`/`.env.example`, `CONFIGURACAO_AMBIENTE.md`) + `package.json`/`pnpm-lock.yaml` (nova dependência).
- 1 arquivo de teste novo (`auth-login-throttle.test.ts`, 3 testes, Postgres real) + 1 teste unitário novo em `luxora-exception.filter.test.ts`.
- Suíte unitária completa: 52 arquivos, 430 testes, 0 falhas.
- Suíte crítica completa (`/root/luxora-app`, 2 execuções consecutivas): ambas 19/20 arquivos, 138/139 testes, 0 falhas.
- `nest build` limpo (exit 0). 2 erros de ESLint pré-existentes (mesmos da AD-005), não relacionados, não bloqueantes.

**Confirmações:** nenhuma regra de negócio alterada (`AuthService.login()` intocado); nenhum endpoint público mudou de contrato; nenhuma migration de banco necessária.

### Encerramento — AD-005 (Criptografia em repouso do token de WhatsApp) (2026-07-25)

**AD-005 formalmente encerrada — `WhatsAppIntegration.accessToken` deixa de ser gravado em texto plano.** Dívida de segurança registrada desde o Módulo 11 (*"Precisa de endurecimento antes de produção real com clientes pagantes"*), fechada nesta AD. Decisão completa em [`ADR-0049`](./docs/02-Arquitetura/ADRs/ADR-0049-criptografia-token-whatsapp.md).

**Arquitetura adotada:**
- AES-256-GCM via `node:crypto` nativo — zero dependência de pacote nova.
- `TokenCipherService` (`apps/backend/src/shared/token-cipher.service.ts`) — único ponto do sistema que conhece o formato de cifragem; `ConectarWhatsAppUseCase`/`WhatsAppMessageProvider` só chamam `encrypt()`/`decrypt()`, sem saber versão nem formato.
- Formato armazenado (mesma coluna, sem migration): `v1:<iv>:<authTag>:<ciphertext>` (todos base64) — o prefixo de versão existe para permitir rotação de chave futura (`v2` conviveria com `v1` até re-gravação) sem exigir migração de schema.
- Chave via `WHATSAPP_TOKEN_ENCRYPTION_KEY` (mesma UX de `JWT_SECRET` — qualquer string longa, derivação via `scryptSync`), não KMS/Vault (projeto ainda no Railway, Fases 1–2, sem infraestrutura própria de nuvem).
- Compatibilidade retroativa: valores sem o prefixo `v1:` (texto puro, pré-AD-005) são devolvidos como estão por `decrypt()` — nenhum backfill obrigatório para o sistema continuar funcional; um valor `v1:` que falha ao decifrar (chave errada ou dado adulterado) lança erro, nunca mascara silenciosamente.

**Evidência quantitativa:**
- 6 arquivos alterados + 3 novos de produção/infra (`token-cipher.service.ts`, `.env`/`.env.example`) + 3 de teste (1 ajustado, 2 novos).
- 8 testes novos (6 unitários de `TokenCipherService` + 2 críticos de round-trip contra Postgres real) + 1 arquivo de teste existente ajustado.
- Suíte unitária completa: 52 arquivos, 429 testes, 0 falhas.
- Suíte crítica completa (`/root/luxora-app`, 2 execuções consecutivas): ambas 18/19 arquivos, 135/136 testes, 0 falhas.
- `nest build` limpo (exit 0). 2 erros de ESLint pré-existentes, confirmados via `git diff` como não introduzidos por esta AD, não bloqueantes.

**Confirmações:** nenhuma regra de negócio alterada; nenhum endpoint público mudou (`POST /whatsapp/connect` mantém a mesma assinatura); nenhuma migration de banco foi necessária (coluna `access_token` continua `String`, só o conteúdo gravado mudou).

**Achado correlato, registrado mas fora do escopo desta AD:** `whatsapp_integration` não está entre as 15 tabelas cobertas por Row-Level Security (`migration 20260723190000_enable_rls`) — candidato a item de backlog próprio, não corrigido aqui.

### Encerramento — AD-003 (Matriz de RBAC) (2026-07-25)

**AD-003 formalmente encerrada — 21/21 rotas mutantes da API protegidas por `RolesGuard`/`@Roles(...)`, política centralizada em [`docs/02-Arquitetura/16-Politica-RBAC.md`](./docs/02-Arquitetura/16-Politica-RBAC.md) (fonte única de verdade, referenciada — nunca duplicada — por `06-Autenticacao.md` e `04-API/01-Contratos-REST.md`).**

**Escopo concluído, em 5 etapas incrementais, cada uma validada contra a suíte crítica completa antes da próxima:**

| Etapa | Controller(s) | Rotas | Papel(is) |
|---|---|---|---|
| 1 | `ClinicController` | 3 | `admin` |
| 2 | `TherapistsController` | 3 | `admin` |
| 3 | `BillingController` + `PaymentController` | 4 | `admin` |
| 4 | `PatientsController` | 5 | `admin`, `therapist` |
| 5 | `AppointmentsController` + `RecurringBlocksController` | 6 | `admin`, `therapist` |
| **Total** | **7 Controllers** | **21/21** | — |

Somadas às 8 rotas já protegidas antes da AD-003 (`AuditLogController`, `WhatsAppController`, `SubscriptionController`), a API tem hoje **29 rotas com `@Roles()` explícito** sobre 40 rotas autenticadas — as 11 restantes são leitura (`GET`), intencionalmente abertas a qualquer usuário autenticado do próprio Tenant (decisão documentada, não uma lacuna).

**Evidência quantitativa consolidada:**
- **Testes de RBAC adicionados:** 63 (`apps/backend/test/critical/rbac-mutating-routes.test.ts`, novo) — 9 (Etapa 1) + 9 (Etapa 2) + 12 (Etapa 3) + 15 (Etapa 4) + 18 (Etapa 5).
- **Suíte RBAC isolada:** 63/63 aprovados.
- **Suíte crítica completa** (`test/critical`, 18 arquivos): 2 execuções consecutivas finais, ambas **17/18 arquivos, 133/134 testes, 0 falhas** (1 skip documentado, não relacionado à AD-003).
- **Ambiente oficial de execução:** `/root/luxora-app` (ext4 nativo do WSL2) — ver ADR-0048, adotada durante a investigação de um bloqueio de timeout de hook encontrado na Etapa 1 (não relacionado ao RBAC em si).

**Arquitetura:**
- Decisão e matriz completa: **AD-003**, `docs/PLANO_DE_EXECUCAO.md`; política técnica: `docs/02-Arquitetura/16-Politica-RBAC.md`.
- Ambiente de execução oficial: **[`ADR-0048`](./docs/02-Arquitetura/ADRs/ADR-0048-repositorio-ext4-wsl2.md)** — migração do repositório de trabalho para ext4/WSL2, motivada por uma penalidade de ~94x medida entre `/mnt/c` (DrvFs) e ext4/tmpfs, descoberta ao investigar o timeout intermitente da Suíte Crítica durante a Etapa 1 desta mesma AD.

**Lições aprendidas:**
- Toda correção feita durante a implementação foi **exclusivamente de infraestrutura de teste** (`apps/backend/test/critical/support/dedicated-fixture.ts`: novas coleções `userIds`, `patientIds`, campo `clinicSettingsId`, parâmetro `role` em `createDedicatedUserAndLogin()`) — **nenhum caso de uso, serviço de domínio, entidade ou máquina de estados foi alterado** em nenhuma das 5 etapas.
- Três achados de estado compartilhado entre testes foram identificados e corrigidos, todos isolando fixtures em vez de alterar comportamento: (1) teto de plano (`maxTherapists`) da fixture padrão colidindo com testes de criação de terapeuta (Etapa 2); (2) `AvailabilityCalendar` de um terapeuta compartilhado sendo estreitada por um teste de outra etapa (Etapa 3, resolvido com terapeuta dedicado `billingTherapistId`); (3) `Session` órfã criada como efeito colateral de `confirm` não rastreada para limpeza (Etapa 5).
- Nenhuma rota recebeu papel sem estar na matriz central; nenhuma lógica de RBAC foi encontrada espalhada em condicionais fora de `RolesGuard`/`roles.decorator.ts`/`jwt-auth.guard.ts` (verificado na etapa de auditoria inicial da AD-003).

### Encerramento — Ciclo de Estabilização da Infraestrutura (2026-07-23)

Ciclo iniciado pelo incidente AD-026 (Docker Desktop), passando por AD-002, AD-033 e AD-034, **formalmente encerrado**. Documento de fechamento completo: [`docs/CICLO_ESTABILIZACAO_INFRAESTRUTURA.md`](./docs/CICLO_ESTABILIZACAO_INFRAESTRUTURA.md) — contém a auditoria completa dos 17 arquivos de `test/critical` (12 Conforme, 1 Melhorável, 4 Divergente), a baseline oficial de infraestrutura (17 arquivos de teste, 11 Dedicated Fixtures, 27 instâncias de `PrismaClient`/`PrismaClientProvider`, suíte com média de 16,1s e 5/5 execuções idênticas) e a arquitetura oficial documentada em [`docs/09-Testes/02-Dedicated-Fixtures.md`](./docs/09-Testes/02-Dedicated-Fixtures.md). A auditoria encontrou 4 arquivos divergentes da arquitetura oficial (não corrigidos, fora do escopo aprovado da AD-034) — registrados como **AD-035**, novo item de backlog, não bloqueante.

### Concluído

- **AD-034 — Fragilidade de limpeza da suíte crítica eliminada (3 causas raízes independentes)** (2026-07-23)
  Decomposição confirmada por evidência de código, não hipótese única:
  1. **`subscription-upgrade-downgrade.test.ts` — determinístico, não relacionado a paralelismo.** O 4º teste criava um segundo `therapist` nunca rastreado; `cleanupDedicatedFixture()` só apagava o terapeuta original, deixando a FK `therapist_tenant_id_fkey` bloquear `tenant.delete()` sempre que o teste rodava até o fim.
  2. **`tenant-api-key.test.ts` — genuinamente sensível a concorrência.** 4 testes abriam, cada um, seu próprio `new PrismaClientProvider()` (= um `PrismaClient` novo, um pool novo) — com `maxWorkers=6` e outros arquivos abrindo pools próprios em paralelo, a pressão agregada de conexões já havia causado `Hook timed out in 10000ms`.
  3. **`recurring-blocks-api.test.ts` — mascaramento de erro, sintoma da causa 2.** Cleanup manual acessava `fixturePrisma` sem checar se `beforeAll` havia de fato terminado — uma falha real e anterior no `beforeAll` (sob a mesma pressão de conexão) produzia um `TypeError` secundário no `afterAll` que escondia a causa real.

  **Correções aplicadas — `test/critical/support/dedicated-fixture.ts`:**
  - `DedicatedFixture.therapistIds: string[]` — coleção (não um campo ad hoc por teste), inicializada com `[therapistId]` por `createDedicatedFixture()`. Qualquer teste que precise de terapeutas extras dá `push()` nela; `cleanupDedicatedFixture()` agora apaga via `deleteMany({ where: { id: { in: therapistIds } } })`, cobrindo qualquer quantidade.
  - `cleanupDedicatedFixture()` agora aceita `fixture: DedicatedFixture | undefined` e retorna cedo, silenciosamente, quando `fixture` não foi inicializada — resiliente a `beforeAll` parcial, sem mascarar a falha real com um erro secundário.

  **`subscription-upgrade-downgrade.test.ts`:** o segundo terapeuta criado no 4º teste agora é registrado via `fixture.therapistIds.push(...)` — sem nome de campo ad hoc.

  **`tenant-api-key.test.ts`:** as 4 instâncias `new PrismaClientProvider()` inline consolidadas em um único `sharedClient`, criado uma vez no `beforeAll`, desconectado uma vez no `afterAll`. Comentário explícito no código: `TenantContext` continua isolado por teste (`new TenantContext()` por teste, nunca reaproveitado); só a infraestrutura de conexão é compartilhada; nenhum estado de aplicação atravessa entre testes. `afterAll` também tornado resiliente (`sharedClient?.$disconnect()`, `app?.close()`, guarda em `tenantApiKey.deleteMany`).

  **`recurring-blocks-api.test.ts`:** migrado de criação/limpeza manual de Tenant/ClinicSubscription/User para `createDedicatedFixture()`/`createDedicatedUserAndLogin()`/`cleanupDedicatedFixture()` — mesmo mecanismo oficial usado pelos demais arquivos da suíte, elimina a lógica de cleanup duplicada.

  **Evidência quantitativa — 5 execuções completas e consecutivas da suíte crítica, sem nenhuma alteração entre elas:**

  | Execução | Testes | Arquivos | Timeout | Erro de FK | Erro de cleanup |
  |---|---|---|---|---|---|
  | 1 | 70/71 (1 skip doc.) | 16/17 verdes | 0 | 0 | 0 |
  | 2 | 70/71 (1 skip doc.) | 16/17 verdes | 0 | 0 | 0 |
  | 3 | 70/71 (1 skip doc.) | 16/17 verdes | 0 | 0 | 0 |
  | 4 | 70/71 (1 skip doc.) | 16/17 verdes | 0 | 0 | 0 |
  | 5 | 70/71 (1 skip doc.) | 16/17 verdes | 0 | 0 | 0 |

  Zero variação entre execuções — resultado antes desta correção variava entre 39/71 e 45/71 dependendo da execução.

  **Confirmação dos critérios de aceite:**
  - Nenhum `PrismaClient` desnecessário permaneceu — as 4 instâncias ad hoc de `tenant-api-key.test.ts` viraram 1 client compartilhado.
  - Nenhum teardown duplicado permaneceu — `recurring-blocks-api.test.ts` não tem mais cleanup manual próprio.
  - `cleanupDedicatedFixture()` é o único mecanismo de limpeza nos 3 arquivos corrigidos (não foi feita auditoria dos demais 14 arquivos de `test/critical` além destes 3 — fora do escopo desta correção).
  - Paralelização da suíte (`maxWorkers=6`, `connection_limit=4`) **inalterada** — nenhum valor de `test/critical/vitest.config.ts`/`global-setup.ts` foi tocado.
  - Nenhum timeout foi aumentado; nenhum retry foi adicionado; nenhum `sleep`/espera artificial foi introduzido.
  - `pnpm build`, `pnpm --filter @luxora/backend build` e `eslint` limpos nos 4 arquivos alterados.

- **AD-004 — Persistência de `modality` em `Appointment`** (2026-07-22)
  Corrigido bug confirmado na [auditoria técnica definitiva](./docs/AUDITORIA_TECNICA_DEFINITIVA.md#33--modality-silenciosamente-descartado-ao-salvar-appointment-banco): `PrismaAppointmentRepository.upsertAll()` nunca gravava o campo `modality`, então todo agendamento criado como `online` era persistido silenciosamente como `presencial` (default da coluna). Causa raiz real: `Appointment` (domínio) nunca expunha `modality` via getter público, o que por si só já impedia o Repository de referenciá-lo.
  - `apps/backend/src/domain/appointment/appointment.entity.ts` — novo getter `modality`.
  - `apps/backend/src/infrastructure/database/repositories/prisma-appointment.repository.ts` — `modality` incluída em `create` e `update` de `upsertAll()`.
  - Testes: 2 novos em `test/unit/domain/appointment/appointment.entity.test.ts` (verdes); 3 novos em `test/critical/appointment-modality-persistence.test.ts`. **(2026-07-23) Validados contra Postgres real: 3/3 passando.** Não há mais ressalva pendente nesta tarefa.
  - Suíte unitária completa: 51 arquivos / 423 testes, 100% verde. `pnpm build` limpo.
- **Documentação do plano de execução** (2026-07-22) — Kanban atualizado (AD-004 → Concluído), progresso do Epic 2 fechado, este changelog criado.
- **AD-026 — Ambiente de desenvolvimento restaurado. Incidente oficialmente encerrado.** (2026-07-23)
  Decisão arquitetural formalizada em [`ADR-0047`](./docs/02-Arquitetura/ADRs/ADR-0047-docker-engine-nativo-wsl2.md) (status: **ADOTADO**). Registro explícito, por exigência de governança:
  1. **O Docker Desktop NÃO foi corrigido.**
  2. **A causa raiz do defeito do Docker Desktop permanece inconclusiva** (ver "Conhecido, não corrigido" abaixo).
  3. **O ambiente oficial de desenvolvimento no Windows passa a ser Docker Engine nativo no WSL2.**
  4. **A decisão foi motivada por continuidade do projeto** (destravar a Sprint 4), **não por identificação da causa raiz.**
  5. Procedimento completo de instalação e configuração, reproduzível do zero por qualquer novo desenvolvedor, documentado em [`README.md` § Setup local](./README.md#setup-local) e em detalhe na própria `ADR-0047`.
  - Instalado Docker Engine nativo (`docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-compose-plugin`) diretamente na distro WSL2 Ubuntu 26.04, via repositório oficial apt da Docker — contorna por completo o componente do Docker Desktop com defeito. Docker Desktop permanece instalado e inativo; nada foi removido, mudança 100% reversível.
  - `C:\Users\pichau\.wslconfig` criado (`vmIdleTimeout=-1`, `localhostForwarding=true`) — necessário porque a VM do WSL2 se desliga por ociosidade entre sessões sem processo anexado, derrubando o `dockerd` e os containers junto.
  - RLS (15 tabelas) e o índice único parcial de concorrência aplicados manualmente no banco local (mesmo conteúdo de `enable-rls.sql`/`unique-active-appointment.sql`) — ainda não formalizados como migration versionada (ver AD-002, próximo item do backlog).
  - Validação: `docker version`/`info`/`compose ps` funcionais; 9/9 migrations aplicadas; suíte crítica rodando com 39/71 testes passando (falhas restantes são AD-033/AD-034 abaixo, independentes deste incidente e sem relação com o ambiente).
- **AD-002 — RLS e índice de concorrência formalizados como migration versionada** (2026-07-23)
  Nova migration `apps/backend/prisma/migrations/20260723190000_enable_rls/migration.sql`, incorporando o conteúdo de `enable-rls.sql` (RLS + `FORCE` nas 15 tabelas multi-tenant + as 2 policies de exceção) e `unique-active-appointment.sql` (convertido para `CREATE UNIQUE INDEX IF NOT EXISTS`, agora idempotente). Os dois scripts originais são mantidos em `prisma/rls/` só como referência histórica, com nota apontando para a migration real.
  - **Zero mudança de comportamento funcional ou de código de aplicação** — diff restrito a `prisma/migrations/`, aos comentários de nota nos dois scripts antigos, e à documentação (`README.md`).
  - **Validação em banco limpo:** banco descartável (`luxora_clean_test`) criado dentro do mesmo Postgres; `prisma migrate deploy` aplicou as 10 migrations do zero sem erro.
  - **Validação de idempotência:** a mesma migration foi aplicada com sucesso, sem erro, no banco de dev já configurado manualmente nesta mesma sessão (cenário real de "ambiente já existente").
  - **Evidência via catálogo do Postgres** (banco limpo): `pg_policies` retorna as 17 policies esperadas (15× `tenant_isolation` + `auth_lookup_by_email` + `api_key_lookup_by_hash`); `pg_class.relrowsecurity`/`relforcerowsecurity` = `t` nas 15 tabelas; `pg_indexes` confirma `unique_active_appointment_slot` com a definição exata esperada.
  - **Prisma Client** gerado com sucesso após a migration — nenhuma quebra.
  - **Suíte crítica revalidada** no banco de dev: 45 passando / 2 falhando / 24 puladas — os mesmos 2 testes que já falhavam antes (ambos por AD-033, não relacionados a esta mudança), zero regressão nova.
  - `README.md` atualizado: passo manual de RLS removido do Setup local (agora automático via `prisma migrate deploy`); nota adicionada no passo de seed alertando sobre o AD-033.
- **AD-033 — `prisma/seed.ts` corrigido para operar sob RLS real** (2026-07-23)
  Causa raiz confirmada por evidência de código (não hipótese): o script usava um `PrismaClient` bruto, sem transação nem `app.tenant_id` definido em nenhum momento — `PrismaService.forTenant()` (o mecanismo real de produção) nunca era acessível a um script fora do NestJS DI. A policy `tenant_isolation` rejeita todo INSERT com `current_setting('app.tenant_id', true)` retornando `NULL`.
  - Nova função `withTenantContext(tx, tenantId, fn)` centraliza o mecanismo — único ponto do script que define contexto de RLS.
  - `app.tenant_id` definido via `SELECT set_config('app.tenant_id', $1, true)` através do template tag `$executeRaw` do Prisma — bind parameter real, **nenhuma interpolação de string SQL** (diferente de `PrismaService.forTenant()`, que usa `$executeRawUnsafe` com interpolação mitigada por validação de formato UUID — não alterado, fora do escopo desta correção).
  - Exatamente uma transação `prisma.$transaction()` por Tenant, cobrindo a criação do próprio Tenant e de todos os dados que dependem dele — isolamento e rollback parcial por Tenant.
  - **Nenhuma regra de domínio duplicada** — o script continua fazendo só inserts diretos, nenhuma validação de Use Case foi copiada.
  - **Nenhuma policy, migration ou privilégio alterado** — mudança 100% contida em `prisma/seed.ts`.
  - **Idempotência:** confirmado que o seed **já não era idempotente antes desta correção** (uma segunda execução sempre falhava por violação de unicidade de e-mail) — comportamento preservado, não corrigido aqui (fora de escopo; se necessário, abrir novo item de backlog). Efeito colateral observado, não perseguido deliberadamente: como agora há uma transação por Tenant, uma segunda execução falha de forma mais limpa — o Tenant que falha não fica órfão (rollback atômico), diferente do risco teórico que existia antes.
  - **Validação:** seed executado com sucesso contra o banco de dev (idempotência re-confirmada ao falhar corretamente na segunda execução, sem dado órfão); suíte crítica revalidada — **70 passando / 1 pulado / zero falhas reais** (os 2 testes de `multi-tenant-isolation.test.ts` que dependiam de dados seedados agora passam); único item "failed" a nível de arquivo é hook de limpeza do AD-034, já registrado, não um teste real falhando. `pnpm build` e `eslint` limpos.

  **Encerramento — AD-033:**
  1. **Ganho arquitetural (além do bug corrigido):** o projeto agora tem, pela primeira vez, um padrão testado e documentado para qualquer processo que grave dados multi-tenant **fora** do fluxo HTTP/NestJS DI — até aqui, o único caminho de acesso a tabelas com RLS era `PrismaService.forTenant()`, inacessível a scripts standalone. `withTenantContext()` fecha essa lacuna sem abrir uma exceção de segurança para preenchê-la.
  2. **Padrão oficial para scripts futuros que gravam em tabela protegida por RLS:** abrir a própria transação e definir `app.tenant_id` via `set_config('app.tenant_id', $1, true)` (bind parameter do Prisma), nunca por interpolação de string, nunca com `BYPASSRLS`/superusuário. Documentado em [`docs/03-Database/09-Multi-Tenant.md`](./docs/03-Database/09-Multi-Tenant.md), seção "Scripts administrativos e seeds".
  3. **`withTenantContext()` (`apps/backend/prisma/seed.ts`) passa a ser o mecanismo de referência recomendado** para qualquer seed ou script administrativo futuro com a mesma necessidade — não uma solução pontual descartável.
  4. **Limitação conhecida, deliberadamente não corrigida:** `prisma/seed.ts` continua **não idempotente** — uma segunda execução falha por violação de unicidade de e-mail. Comportamento herdado, não introduzido por esta correção; tratamento fica para um item de backlog próprio, se e quando for decidido necessário.

### Adicionado ao backlog (descoberto durante a validação de 2026-07-23)

- **AD-034 — Fragilidade de limpeza (`afterAll`) na suíte crítica sob execução paralela.** `recurring-blocks-api.test.ts`, `subscription-upgrade-downgrade.test.ts` e `tenant-api-key.test.ts` falham em hooks de limpeza (violação de FK, timeout, referência indefinida) quando a suíte completa roda em paralelo — os testes em si passam. Mesma classe de problema já parcialmente endereçada em "Critical Suite stability — Etapa 1/2" (histórico do projeto). **Corrigido em 2026-07-23** — ver entrada "Concluído" acima.
- **AD-035 — 4 arquivos de `test/critical` divergem da arquitetura oficial de Dedicated Fixtures.** Descoberto na auditoria de fechamento da AD-034 (`docs/CICLO_ESTABILIZACAO_INFRAESTRUTURA.md`). Não corrigido — fora do escopo aprovado da AD-034.

### Conhecido, não corrigido

- **Causa raiz do Docker Desktop 4.82.0** permanece inconclusiva — sockets AF_UNIX (`Inference Manager`, `Secrets Engine`) ficando como reparse points NTFS órfãos, sobrevivendo inclusive a reboot completo do Windows. Contornada via AD-026 (Docker Engine nativo no WSL2), não corrigida. Sem impacto prático desde a mudança de arquitetura.
