# Auditoria Técnica Definitiva — Vertex/Luxora

**Status:** Documento oficial. Substitui integralmente qualquer classificação de módulo produzida em turnos anteriores desta mesma sessão de trabalho, incluindo o backlog T001–T089.
**Data:** Julho de 2026.
**Metodologia:** cada um dos 30 módulos abaixo foi revalidado por leitura direta do código-fonte atual do repositório, nesta rodada, sem reaproveitamento de memória de análises anteriores. Nenhuma classificação depende de documentação — onde código e documentação divergem, o código é a fonte da verdade e a divergência está registrada explicitamente na seção 1. Toda linha ✅ cita o(s) arquivo(s) exato(s) onde a implementação foi encontrada; toda linha 🟡/🔴 descreve exatamente o que falta.

---

## 1. Divergências entre Documentação e Código (código prevalece)

| # | Documento | Afirmação | Estado real do código | Veredito |
|---|---|---|---|---|
| D1 | `README.md:131` (princípio "não-negociável") | "Toda tabela multi-tenant tem RLS ativa desde a primeira migration" | `apps/backend/prisma/rls/enable-rls.sql` lista 15 tabelas para RLS, mas grep em todas as 9 pastas de `prisma/migrations/**/*.sql` só encontra `ENABLE ROW LEVEL SECURITY` em **1 migração** (`20260718000000_add_tenant_api_key`). As outras 14 tabelas do array — incluindo `user`, `patient`, `appointment`, `billing`, `payment`, `audit_log` — **não têm RLS aplicada em nenhuma migração real**, apesar de estarem desenhadas no script. | **Contradição confirmada.** O princípio é aspiracional, não implementado. Risco de mesma natureza do bug de superusuário já corrigido nesta mesma linha do README. |
| D2 | `README.md:11` | "302/302 testes unitários do backend" | Contagem fresca: 51 arquivos em `apps/backend/test/unit/**`, ~418 ocorrências de `it(`/`it.each(`. | **Divergência.** Não é regressão — o número real de testes é maior que o documentado (crescimento não refletido no README), mas o dado está desatualizado. |
| D3 | `README.md:11` vs `README.md:114` | Linha 11: "24/24 Testes Críticos + 1 skip documentado". Linha 114: "16 Testes Críticos... #13 revisão de processo... #3 describe.skip" | `apps/backend/test/critical/**` contém exatamente **16 arquivos `*.test.ts`**. | **O próprio README se contradiz internamente** — linha 11 já está desatualizada mesmo em relação à linha 114 do mesmo arquivo. Número real e atual: 16. |
| D4 | `docs/ARCHITECTURE_AUDIT_REPORT.md` (Sprint 3) | "correlationId em só 5 arquivos isolados" | Grep case-insensitive por `correlationId` em todo `apps/backend/src`: **zero ocorrências.** | **Confirmado stale** (já sinalizado por um sub-agente em turno anterior desta sessão, agora reconfirmado de forma independente). Hoje é 0, não 5. |
| D5 | `docs/01-Domain/09-Jornada-do-Paciente-e-do-Contato.md:47` | "reagendamento e consulta exploratória de horários não estão roteados" no `IntentActionRouter` | Leitura completa do `switch` em `intent-action-router.ts:45-56`: roteia exatamente `agendar_consulta`, `cancelar_consulta`, `confirmar_presenca`, `consultar_cobranca`. `remarcar_consulta` cai no `default` (não roteado). | **Confirmado, sem contradição** — a documentação está correta neste ponto. Registrado aqui apenas para deixar explícito que foi checado, não assumido. |
| D6 | `README.md:9` | "Módulos 1–18 implementados" (lista Auth, Multi-Tenant, Pacientes, etc. como prontos) | Dentro dos módulos citados como prontos, há gaps funcionais reais não mencionados: Auth não tem nenhum caminho de aplicação para criar usuários além de `prisma/seed.ts` manual; RLS (Multi-Tenant) real cobre 1/15 tabelas; WhatsApp não tem webhook de entrada. | **Divergência de granularidade** — "implementado" no README significa "rotas principais existem", não "sem lacunas". Registrado para calibrar expectativa do backlog. |

---

## 2. Tabela-resumo — 30 módulos

| # | Módulo | Veredito | Evidência-chave |
|---|---|---|---|
| 1 | Auth | 🟡 Parcial | `auth.controller.ts`, `auth.service.ts` sólidos (bcrypt=12, sem fallback de secret, refresh com type-check); sem revogação de token, sem rate limit |
| 2 | Usuários (staff) | 🔴 Não iniciado | Nenhum Controller/Use Case existe; `AuthService.hashPassword` é código morto; único ponto de criação de `User` é `prisma/seed.ts` |
| 3 | Clínicas | 🟡 Parcial | CRUD completo em `clinic.use-cases.ts`/`clinic.controller.ts`; `RolesGuard` nem está na cadeia de guards do controller |
| 4 | Tenant/RLS | 🟡 Parcial | `TenantContext`+`PrismaService.forTenant()` sólidos na aplicação; RLS real no banco só em 1/15 tabelas (ver D1) |
| 5 | Segurança | 🟡 Parcial | ValidationPipe/CORS corretos em `main.ts`; `@nestjs/throttler` ausente; 21 rotas mutantes sem `@Roles` (lista completa na seção 3.5) |
| 6 | Pacientes | ✅ Completo | 5 use cases em `use-cases/patient/*.ts`, 7 rotas em `patients.controller.ts`, 4 arquivos de teste cobrindo todos os use cases |
| 7 | Contact | 🔴 Não iniciado | Zero código em `src/` ou `schema.prisma` — existe só em `docs/01-Domain/06-13` (fase de arquitetura, congelada) |
| 8 | Agenda/Motor de Disponibilidade | 🟡 Parcial | Domínio+use case+migração reais em `availability-calendar.entity.ts`; `AvailabilityException` não tem campo/tabela de persistência — perdida a cada restart |
| 9 | Appointment | ✅ Completo | 5 use cases, 7 rotas, `IntentActionRouter` roteia 4 intents conforme documentado |
| 10 | Sessões | 🟡 Parcial | Criação automática ao confirmar consulta funciona; `ConfirmarConsultaUseCase` confirmado (linha a linha) que NÃO chama billing; estados `Faturada`/`Recebida` são código morto — nenhum use case os alcança |
| 11 | Financeiro (view) | 🟡 Parcial | `financeiro/page.tsx` só leitura — sem criar/marcar pago/enviar cobrança apesar dos endpoints existirem no backend |
| 12 | Billing | 🟡 Parcial | 4 use cases implementados e majoritariamente testados; `ListarCobrancasUseCase` tem zero cobertura de teste |
| 13 | Payment | 🟡 Parcial | Idempotência e reconciliação funcionam; rota de estorno sem `@Roles`; nenhum webhook de confirmação de pagamento de paciente (só manual) |
| 14 | Dashboard | 🔴 Não iniciado | Backend: zero controller/rota/módulo — só um flag `executiveDashboard` em `plan-benefits.ts`. Frontend: reempacotamento client-side de `/patients`+`/billings`, sem agregação real |
| 15 | IA | 🟡 Parcial | `ProcessarMensagemUseCase` completo (roteamento, teto de custo, auditoria); `ai.module.ts` não declara nenhum controller — sem ponto de entrada HTTP |
| 16 | WhatsApp | 🟡 Parcial | Conexão/envio implementados (`whatsapp.controller.ts`, `whatsapp-message.provider.ts`); nenhum webhook de recepção de mensagem existe; envio marcado no próprio código como não testado contra API real |
| 17 | Prompt Engine | ✅ Completo | `system-prompt.builder.ts` genuinamente dinâmico por tenant, alimentado por `ClinicRepository`/`TherapistRepository` em `anthropic-ai.provider.ts` |
| 18 | Notificações (internas) | 🔴 Não iniciado | Zero biblioteca, zero serviço; único "achado" é uma string genérica de erro que não é backed por nenhum mecanismo real |
| 19 | Auditoria | 🟡 Parcial | Escrita/imutabilidade bem testada (`audit-immutability.test.ts`); caminho de leitura (`ConsultarAuditLogUseCase`, `GET /audit-log`) sem nenhuma cobertura de teste |
| 20 | Configurações | 🟡 Parcial | `ClinicSettings` real e usado; `AiSettings` é schema morto (zero uso em código); `WhatsAppIntegration.accessToken` em texto plano, auto-documentado como não pronto para produção |
| 21 | Frontend | 🟡 Parcial | 9 páginas, todas com dados reais (sem mock); `isError` tratado em só 1/9 páginas; sem Update/Delete de Pacientes/Appointments; `react-hook-form`/`zod` instalados mas 100% não usados; token de auth só em memória |
| 22 | API | 🟡 Parcial | 49 rotas em 13 controllers, `ValidationPipe` global correto; 21 rotas mutantes autenticadas sem `@Roles` (RBAC seletivo, não sistemático) |
| 23 | Banco | 🟡 Parcial | 20 models ↔ 20 tabelas ↔ 9 migrações, consistentes; bug confirmado: `PrismaAppointmentRepository.upsertAll()` nunca grava `modality` — todo appointment "online" persiste como "presencial" |
| 24 | Testes Unitários | 🟡 Parcial | 51 arquivos / ~418 `it()` no backend; **0 arquivos de teste no frontend** apesar de `vitest` configurado |
| 25 | Testes Integração | 🟡 Parcial | `test/integration/` vazio (`passWithNoTests: true`, job de CI é no-op documentado); cobertura real de integração está em `test/critical` (16 arquivos) |
| 26 | Testes E2E | 🔴 Não iniciado | Nenhum Playwright/Cypress em lugar nenhum do repositório |
| 27 | Logs | 🟡 Parcial | `Logger` do NestJS usado em só 5 arquivos; sem pino/winston |
| 28 | Observabilidade | 🔴 Não iniciado | Zero `correlationId` (ver D4); sem OpenTelemetry/Prometheus |
| 29 | Deploy | 🔴 Não iniciado | `infra/railway/` vazio; único Dockerfile é o do backend; nenhum config de Railway/Nixpacks |
| 30 | CI/CD | 🟡 Parcial | `ci.yml` real com 4 jobs (lint/unit/integration-stub/critical); CD completamente ausente |

**Contagem:** ✅ Completo: 3 · 🟡 Parcial: 20 · 🔴 Não iniciado: 7.

---

## 3. Achados críticos com evidência linha-a-linha

### 3.1 — RLS real cobre 1 de 15 tabelas desenhadas (Tenant/RLS, D1)
`apps/backend/prisma/rls/enable-rls.sql:29-33` lista 15 tabelas. Grep em `prisma/migrations/**/*.sql` por `ROW LEVEL SECURITY` só retorna `20260718000000_add_tenant_api_key/migration.sql:21-29`. As 8 outras pastas de migração (`init`, `add_availability_calendar`, `add_clinic_holiday`, `add_recurring_block`, `add_recurring_block_id_to_appointment`, `add_past_due_since...`, `add_pending_plan...`, `add_individual_completo...`) não contêm nenhuma instrução de RLS. `user`, `patient`, `appointment`, `session`, `billing`, `payment`, `audit_log` — sem RLS ativa no banco hoje.

### 3.2 — Nenhum caminho de aplicação cria um `User` (Módulo Usuários)
Grep exaustivo em `src/` por `UsersController|user.use-case|CreateUser` → zero resultados. `.user.create(` só aparece em `prisma/seed.ts` e em fixtures de teste. `AuthService.hashPassword` (`auth.service.ts:82`) nunca é chamado por nenhum outro arquivo de produção. Não existe `use-cases/user/` nem fluxo de onboarding/signup que crie o primeiro admin de uma clínica nova.

### 3.3 — `modality` silenciosamente descartado ao salvar Appointment (Banco)
`apps/backend/src/infrastructure/database/repositories/prisma-appointment.repository.ts`, método `upsertAll` (linhas 92-112) — os blocos `create` e `update` do `client.appointment.upsert()` **não incluem `modality`**, apesar da entidade de domínio carregar esse valor (`appointment.entity.ts:50`) e o DTO de entrada exigi-lo (`appointment.dto.ts:14,37`). `toDomain()` lê `modality` de volta corretamente, mas a escrita nunca grava — todo appointment novo recebe o default do Postgres (`'presencial'`) e nunca muda, mesmo que o cliente peça `'online'`.

### 3.4 — Session nunca alcança `Faturada`/`Recebida` (Sessões)
`ConfirmarConsultaUseCase` (`gerenciar-consulta.use-case.ts:88-114`) lido linha a linha: injeta apenas `AppointmentRepository`, `SessionRepository`, `AuditService` — não referencia `GerarCobrancaUseCase` nem `BillingRepository`. Nenhum arquivo em `billing.use-cases.ts` injeta `SessionRepository`. Resultado: toda `Session` fica permanentemente em `'Realizada'`; os estados `'Faturada'`/`'Recebida'` do state machine (`session.entity.ts:16-17`) são inalcançáveis por qualquer código atual.

### 3.5 — 21 rotas mutantes sem controle de papel (Segurança/API)
Guard `roles.guard.ts:24-26` retorna `true` sem `@Roles` — ausência de decorator equivale a "qualquer usuário autenticado, qualquer papel, permitido". Rotas confirmadas sem `@Roles` em nenhum ponto da cadeia:

`PATCH /clinic` · `PUT /clinic/policies` · `PUT /clinic/payment-info` · `POST /patients` · `PATCH /patients/:id` · `POST /patients/:id/deactivate` · `POST /patients/:id/reactivate` · `POST /patients/:id/discharge` · `POST /therapists` · `PATCH /therapists/:id` · `PUT /therapists/:id/availability` · `POST /appointments` · `PATCH /appointments/:id/reschedule` · `POST /appointments/:id/cancel` · `POST /appointments/:id/confirm` · `POST /appointments/recurring` · `POST /recurring-blocks` · `POST /billings` · `POST /billings/:id/send` · `POST /payments` · `POST /payments/:id/refund`

Controllers com RBAC de fato: `AuditLogController`, `WhatsAppController.connect`, e todo `SubscriptionController` (único com cobertura 6/6).

### 3.6 — `WhatsAppIntegration.accessToken` em texto plano (Configurações)
`schema.prisma:93-113`, comentário do próprio modelo: *"accessToken fica em texto plano no banco por ora... Precisa de endurecimento antes de produção real com clientes pagantes"* — dívida auto-documentada, não corrigida.

---

## 4. Correções em relação à classificação do turno imediatamente anterior

O turno anterior desta mesma sessão produziu uma tabela de 29 módulos e um backlog T001–T089 sem revalidação de código linha-a-linha em todos os itens. Este documento os substitui integralmente. Não foi possível fazer um diff item-a-item contra o conteúdo exato daquele turno (não preservado verbatim no contexto desta revalidação), mas as correções abaixo são as que a evidência fresca desta rodada torna explícitas e verificáveis:

- **Tenant/RLS**: qualquer classificação anterior como "✅ Completo" ou que não destacasse a lacuna de 14/15 tabelas sem RLS aplicada em migração real estava incorreta — corrigido para 🟡 Parcial com a ressalva do item D1/3.1.
- **Usuários**: se classificado anteriormente como parte de "Auth ✅", isso está incorreto — é um módulo funcionalmente ausente (🔴), não uma variação de Auth.
- **`correlationId`**: qualquer citação de "5 arquivos" (herdada do `ARCHITECTURE_AUDIT_REPORT.md`) está obsoleta — o valor real e atual é zero.
- **Sessões/Billing**: qualquer classificação que tratasse a ligação Session↔Billing como resolvida pela criação automática de Session (Módulo B da Fase 2) está incompleta — a criação automática existe, mas o fechamento do ciclo (transição para `Faturada`/`Recebida`) não existe em nenhum caminho de código.

---

## 5. Backlog Definitivo (substitui T001–T089)

Numeração própria (`AD-XXX`) para evitar qualquer confusão com o backlog anterior, que fica formalmente descontinuado por este documento. Priorização por risco real (segurança/integridade de dados > funcionalidade ausente que bloqueia operação > dívida técnica > polimento).

### Crítico — bloqueia operação segura em produção

| # | Item | Módulo |
|---|---|---|
| AD-001 | Implementar gestão de Usuários (staff): Controller + Use Cases de criar/listar/atualizar/desativar `User`, incluindo o fluxo de provisionamento do primeiro admin de uma clínica nova (hoje só existe via seed manual) | Usuários |
| AD-002 | Aplicar RLS real (via migração, não só script) nas 14 tabelas restantes: `user`, `patient`, `therapist`, `appointment`, `session`, `billing`, `billing_session`, `payment`, `audit_log`, `availability_calendar`, `clinic_holiday`, `recurring_block`, `clinic_settings`, `ai_settings` | Tenant/RLS |
| AD-003 | Adicionar `RolesGuard`+`@Roles` às 21 rotas mutantes listadas na seção 3.5, com política explícita de quais papéis podem fazer o quê (começar por `clinic/payment-info`, `payments/:id/refund`, `patients/:id/discharge`) | Segurança/API |
| AD-004 | Corrigir `PrismaAppointmentRepository.upsertAll()` para gravar `modality` no create e no update | Banco |
| AD-005 | Criptografar `WhatsAppIntegration.accessToken` em repouso (hoje texto plano) | Configurações |
| AD-006 | Instalar e configurar `@nestjs/throttler`, no mínimo em `/auth/login` | Segurança |

### Alto — funcionalidade ausente que bloqueia o fluxo principal do produto

| # | Item | Módulo |
|---|---|---|
| AD-007 | Implementar webhook de recepção de mensagens do WhatsApp + controller para o módulo IA (hoje `ai.module.ts` não tem nenhum ponto de entrada HTTP) | IA/WhatsApp |
| AD-008 | Persistência de `AvailabilityException` (campo/tabela — hoje só existe em memória, perdida a cada restart) | Agenda |
| AD-009 | Ligar `Session` ao ciclo de `Billing`: transicionar para `Faturada` ao gerar cobrança e `Recebida` ao confirmar pagamento | Sessões/Billing |
| AD-010 | Rotear `remarcar_consulta` (reagendamento) e consulta exploratória de horários no `IntentActionRouter` (gap já registrado no Marco 1) | IA |
| AD-011 | Escrever testes reais em `test/integration/` ou formalizar que `test/critical` é a suíte de integração oficial e ajustar o job de CI para não ser um no-op silencioso | Testes |
| AD-012 | Introduzir Playwright ou Cypress e cobrir pelo menos o fluxo Login→Agenda→Pacientes→Financeiro | Testes E2E |
| AD-013 | Persistir token de autenticação no frontend (hoje memory-only, perdido a cada reload) | Frontend |
| AD-014 | Adicionar tratamento de `isError` nas 8 páginas que não têm (hoje falha de rede é indistinguível de "sem dados") | Frontend |
| AD-015 | Adicionar ações de mutação de estado no frontend (confirmar/cancelar consulta, marcar cobrança como paga, enviar cobrança) — endpoints já existem no backend | Frontend |
| AD-016 | Implementar `correlationId` de ponta a ponta + exportador de métricas (OpenTelemetry ou Prometheus) | Observabilidade |
| AD-017 | Definir e implementar pipeline de deploy real (Dockerfile de frontend, config Railway, job de CD) | Deploy |

### Médio — dívida técnica registrada e não bloqueante

| # | Item | Módulo |
|---|---|---|
| AD-018 | Implementar o Aggregate `Contact` (banco→domínio→repositório→casos de uso→API), seguindo a ordem definida em `docs/01-Domain/08-Contact-e-Identidade-de-Comunicacao.md` | Contact |
| AD-019 | Construir Dashboard como feature real de backend (endpoint de agregação dedicado, não reempacotamento client-side de `/patients`+`/billings`) | Dashboard |
| AD-020 | Adicionar ações de mutação na tela Financeiro (criar cobrança, marcar como paga, registrar pagamento, estorno) | Financeiro |
| AD-021 | Implementar notificações internas (staff-facing) — hoje inexistente | Notificações |
| AD-022 | Escrever teste de cobertura do caminho de leitura de Auditoria (`ConsultarAuditLogUseCase`, `GET /audit-log`) | Auditoria |
| AD-023 | Decidir: adotar `react-hook-form`/`zod` de fato no frontend, ou remover as dependências mortas | Frontend |
| AD-024 | Resolver a colisão de nome `Patient.Novo`/`Identificado` vs `Contact.Novo`/`Identificado` (risco registrado no Marco 1, ainda em aberto) | Contact/Pacientes |
| AD-025 | Decidir destino de `AiSettings` (schema morto, zero uso em código) — implementar teto de custo dinâmico ou remover o modelo | IA/Configurações |
| AD-026 | Resolver o bloqueio de ambiente Docker local (Sprint 4 Fase 0 — pendente desde investigação anterior desta sessão, causa raiz não resolvida) | Infra |
| AD-027 | Testes de webhook do WhatsApp e do provider de mensageria contra a API real (hoje explicitamente não testados, por falta de rede no ambiente) | WhatsApp |

### Baixo — polimento e consistência documental

| # | Item | Módulo |
|---|---|---|
| AD-028 | Implementar `middleware.ts` no Next.js para proteção de rota no nível de framework (hoje só client-side via `enabled: !!token`) | Frontend |
| AD-029 | Criar páginas de Terapeutas e Auditoria no frontend (endpoints já existem no backend) | Frontend |
| AD-030 | Corrigir `README.md`: números de teste desatualizados (D2, D3) e princípio de RLS não-negociável (D1) para refletir o estado real, ou marcar como meta explícita não atingida | Documentação |
| AD-031 | Escrever testes unitários/componente para o frontend (hoje zero, apesar de `vitest` configurado) | Testes |
| AD-032 | Testes dedicados para `PatientsController`/`AppointmentsController` (hoje cobertos só indiretamente via use case) | Testes |

---

## 6. Anexo — Auditoria de Migrations (revisão dedicada)

Revisão dedicada das 9 migrations, do `schema.prisma` completo e dos scripts SQL fora do histórico de migrations, respondendo diretamente às 4 perguntas de verificação levantadas.

### 6.1 — Sequência cronológica

As 9 pastas, em ordem de nome:

1. `20260716171111_init`
2. `20260717033632_add_availability_calendar`
3. `20260717164200_add_clinic_holiday`
4. `20260717194427_add_recurring_block`
5. `20260717201832_add_recurring_block_id_to_appointment`
6. `20260718000000_add_tenant_api_key`
7. `20260719000000_add_past_due_since_to_clinic_subscription`
8. `20260719010000_add_pending_plan_to_clinic_subscription`
9. `20260719020000_add_individual_completo_to_plantier`

**Ordem lógica: consistente.** Cada migration só referencia tabelas/colunas/enums já criados por uma migration anterior — nenhuma `ALTER`/`FOREIGN KEY` aponta para algo que ainda não existe no momento em que roda:
- `add_availability_calendar` cria a tabela nova, faz backfill a partir de `therapist.availability`, **e só então** dropa a coluna antiga — ordem correta dentro do próprio arquivo (create → backfill → drop).
- `add_recurring_block_id_to_appointment` referencia `recurring_block`, que já existe desde a migration anterior (`add_recurring_block`).
- `add_pending_plan_to_clinic_subscription` usa o enum `PlanTier`, que existe desde `init`.
- `add_individual_completo_to_plantier` adiciona valores ao enum sem usá-los na mesma transação — correto, já que o Postgres proíbe `ALTER TYPE ... ADD VALUE` e uso do novo valor na mesma transação (o próprio comentário do arquivo, linhas 12-14, documenta essa restrição corretamente).

**Ressalva encontrada, não um erro de ordem, mas um desvio de processo:** as 4 migrations mais recentes têm timestamps suspeitosamente redondos — `20260718000000` (18:00:00:00), `20260719000000`, `20260719010000` (01:00:00), `20260719020000` (02:00:00) — diferente das 5 primeiras, que têm segundos "orgânicos" típicos de geração real pelo Prisma CLI (`171111`, `033632`, `164200`, `194427`, `201832`). `migrations/README.md:15` instrui explicitamente: *"Não gerar essa migration manualmente ou com timestamp inventado — deixar o Prisma CLI gerar o timestamp real evita qualquer risco de ordenação incorreta entre ambientes."* Os timestamps redondos das 4 últimas migrations são consistentes com terem sido nomeadas manualmente, não geradas pelo `prisma migrate dev` — o oposto do que o próprio processo documentado exige. Isso **não quebra a ordem cronológica** (todas continuam em sequência ascendente correta) e não impede a aplicação, mas é um desvio do processo declarado, registrado aqui por transparência.

### 6.2 — Paridade schema.prisma ↔ migrations (tabelas e colunas)

Reconstrução manual do estado final de todas as 20 tabelas a partir das 9 migrations, campo a campo, contra as 20 `model` do `schema.prisma` atual: **paridade total confirmada, sem nenhuma divergência.** Nenhum campo do schema está órfão de migration; nenhuma migration cria algo que o schema não declara. Casos que exigiram atenção específica (evolução em mais de uma migration) e foram confirmados corretos:
- `Therapist`: tinha `availability JSONB` no `init`, removida em `add_availability_calendar` — schema atual não tem esse campo. ✅
- `Appointment`: `modality`/`state`/`recurring` do `init` + `recurring_block_id` (nullable) de `add_recurring_block_id_to_appointment` — bate exatamente com o model `Appointment` atual, incluindo o `@@unique([recurringBlockId, scheduledAt])`. ✅
- `ClinicSubscription`: campos base do `init` + `past_due_since` + `pending_plan` das duas migrations de PD-004 — bate com o model atual. ✅
- `PlanTier`: 3 valores no `init` + `individual`/`completo` na última migration — bate com o enum atual (5 valores). ✅

### 6.3 — Scripts SQL manuais fora do histórico oficial de migrations

**Três artefatos identificados, nenhum deles dentro de `prisma/migrations/`:**

1. **`apps/backend/prisma/rls/enable-rls.sql`** — habilita RLS em 15 tabelas (loop `DO $$ ... FOREACH`). Seu próprio cabeçalho (linhas 1-17) admite explicitamente: *"Este arquivo NÃO é uma migration do Prisma em si... é o conteúdo-fonte a ser colado"* dentro de uma migration criada manualmente via `--create-only`. **Confirmado: isso nunca foi feito** — nenhuma das 9 migrations reais contém o conteúdo deste arquivo. A única tabela que tem RLS de fato aplicada em migração real é `tenant_api_key`, e isso aconteceu porque sua própria migration (`add_tenant_api_key/migration.sql:21-29`) embutiu a lógica de RLS diretamente inline — não por colar `enable-rls.sql`. As outras 14 tabelas do array (`user`, `patient`, `appointment`, `billing`, `payment`, `audit_log` etc.) permanecem sem RLS em qualquer ambiente reconstruído só a partir das migrations.
2. **`apps/backend/prisma/rls/unique-active-appointment.sql`** — cria o índice único parcial `unique_active_appointment_slot` (proteção contra dupla-reserva concorrente, Teste Crítico #10). Mesmo padrão do item anterior: cabeçalho próprio (linhas 4-6) diz explicitamente que precisa ser colado numa migration via `--create-only`. **Confirmado por leitura de todas as 9 migrations: esse índice não existe em nenhuma delas.** Sem aplicação manual deste arquivo, a proteção contra dupla-reserva concorrente no banco não existe — resta só a checagem em memória (`ScheduleSlot.overlapsWith()`), que o próprio comentário do arquivo (linhas 17-21) descreve como insuficiente sob concorrência real.
3. **`infra/docker/postgres-init/01-app-role.sql`** (referenciado em `README.md:66,69`) — cria a role `luxora_app`, sem privilégio de superusuário. Não é uma migration Prisma; é um script de bootstrap do próprio Postgres, executado automaticamente pela imagem oficial **apenas** na primeira inicialização de um volume Docker vazio (via `docker-entrypoint-initdb.d`). Contra qualquer banco pré-existente (inclusive um ambiente gerenciado como Railway), precisa ser rodado manualmente — o próprio README já documenta esse fallback. Sem esta role, a aplicação se conectaria como `postgres` (superusuário), e RLS é **ignorada incondicionalmente para superusuários no Postgres** — o mesmo bug de segurança real já corrigido uma vez neste projeto (ver `README.md:15`).

**Achado adicional de documentação obsoleta:** `apps/backend/prisma/migrations/README.md` ainda afirma *"Esta pasta está intencionalmente vazia neste commit"* e instrui a gerar a migration inicial — descrição válida quando foi escrita, hoje **falsa** (a pasta tem 9 migrations reais). O comentário no topo do próprio `schema.prisma:3-4` também referencia um caminho `prisma/migrations/00000000000000_init_rls/migration.sql` que **não existe** — nenhuma migration com esse nome ou próxima disso foi criada; o padrão real ficou sendo embutir RLS pontualmente dentro da migration de cada tabela nova (só funcionou para `tenant_api_key`), não uma migration `_init_rls` dedicada como o comentário sugere.

### 6.4 — O projeto pode ser reconstruído do zero rodando só as migrations?

**Não.** Rodar `prisma migrate deploy` (ou `migrate dev`) do zero contra um Postgres vazio reconstrói corretamente as 20 tabelas, todas as colunas, FKs, enums e índices "normais" (7.2 confirma paridade total) — essa parte é 100% automatizada e íntegra. Mas três garantias que o projeto declara como não-negociáveis ou críticas **não existem** ao final desse processo, e exigem intervenção manual adicional, hoje documentada como passo separado no próprio `README.md` (seção "Setup local", passos 3 e 5):

- **Isolamento multi-tenant (RLS)** — ativo em 1 de 15 tabelas desenhadas (só `tenant_api_key`); as demais 14, incluindo `user`, `patient`, `billing`, `payment`, `audit_log`, ficam sem RLS até alguém rodar `enable-rls.sql` manualmente contra o banco.
- **Proteção contra dupla-reserva concorrente** — o índice único parcial de `unique-active-appointment.sql` não existe até ser colado manualmente numa migration ou rodado direto contra o banco.
- **Role de aplicação sem privilégio de superusuário** — só é criada automaticamente em um volume Docker Compose vazio na primeira subida; em qualquer outro ambiente (Railway, banco já existente) precisa do comando manual documentado no README.

Isso **não é uma descoberta nova isolada** — o próprio README já admite esses passos manuais e o Módulo 1 (`migrations/README.md`) sempre documentou a limitação. Mas está formalmente confirmado agora, por leitura direta de todas as migrations: hoje, `migrate deploy` sozinho entrega um banco com schema correto porém **sem isolamento de tenant real e sem proteção de concorrência de agenda** — ambos dependentes de passos fora do histórico versionado de migrations. Isso reforça e refina o item **AD-002** do backlog (seção 5) — a correção não é só "aplicar RLS nas 14 tabelas", é também "trazer `unique-active-appointment.sql` para dentro do histórico de migrations", já que os dois têm exatamente o mesmo problema estrutural.

---

## 7. Critério de encerramento desta auditoria

- [x] Todos os 30 módulos revalidados por leitura direta do código atual, nesta rodada.
- [x] Toda classificação ✅ cita arquivo(s) exato(s).
- [x] Toda classificação 🟡/🔴 descreve exatamente o que falta.
- [x] Divergências entre documentação e código registradas explicitamente (seção 1), com o código tratado como fonte da verdade.
- [x] Correções em relação a classificações anteriores desta sessão registradas (seção 4).
- [x] Backlog reconstruído a partir da evidência fresca, não herdado por suposição (seção 5).

**Esta é a auditoria técnica oficial do projeto Vertex/Luxora e a base para a fase de implementação.**
