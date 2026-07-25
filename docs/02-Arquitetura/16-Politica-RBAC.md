# 16 — Política de RBAC (fonte única de verdade)

**Status:** Oficial.
**Origem:** AD-003 (`docs/PLANO_DE_EXECUCAO.md`), Design Review aprovado em 23/07/2026.

Este documento é a **única** fonte de verdade sobre qual papel (`admin`, `therapist`, `super_admin`) é exigido em cada rota mutante autenticada da API. Nenhum outro documento (`06-Autenticacao.md`, `04-API/01-Contratos-REST.md`) duplica esta matriz — eles apenas referenciam este arquivo. Se um dia divergirem, este arquivo é o correto.

Mecanismo técnico (inalterado pela AD-003, já existia e já estava em produção via `SubscriptionController`): `JwtAuthGuard` popula `request.userRole` a partir do `role` assinado no JWT (`apps/backend/src/api/auth/jwt-auth.guard.ts`); `RolesGuard` (`api/auth/roles.guard.ts`) compara `request.userRole` contra a metadata do decorator `@Roles(...)` (`api/auth/roles.decorator.ts`) via `Reflector`. Ausência de `@Roles()` = liberado a qualquer autenticado. `super_admin` sempre passa, incondicionalmente, em qualquer rota.

---

## 1. Matriz de autorização — rotas com `@Roles()`

Toda rota desta tabela tem `RolesGuard` na cadeia de `@UseGuards()` do seu Controller e `@Roles(...)` no handler. Nenhuma rota recebe um papel sem estar aqui.

| Controller | Método | Endpoint | Papel(is) | Justificativa | Origem |
|---|---|---|---|---|---|
| `SubscriptionController` | GET | `/subscription` | `admin` | Financeiro/assinatura da própria clínica. | Pré-existente (Módulo 17) |
| `SubscriptionController` | POST | `/subscription` | `admin` | Idem. | Pré-existente |
| `SubscriptionController` | POST | `/subscription/credit-card` | `admin` | Idem — dado de pagamento. | Pré-existente |
| `SubscriptionController` | POST | `/subscription/api-key` | `admin` | Gera credencial de integração — sensível. | Pré-existente |
| `SubscriptionController` | POST | `/subscription/upgrade` | `admin` | Financeiro. | Pré-existente |
| `SubscriptionController` | POST | `/subscription/downgrade` | `admin` | Financeiro. | Pré-existente |
| `AuditLogController` | GET | `/audit-log` | `admin` | Trilha de auditoria — visão administrativa. | Pré-existente |
| `WhatsAppController` | POST | `/whatsapp/connect` | `admin` | Conexão de canal da clínica — configuração. | Pré-existente |
| `ClinicController` | PATCH | `/clinic` | `admin` | Configuração administrativa da clínica. | **AD-003** |
| `ClinicController` | PUT | `/clinic/policies` | `admin` | Política operacional — decisão administrativa. | **AD-003** |
| `ClinicController` | PUT | `/clinic/payment-info` | `admin` | Dado financeiro (chave PIX/beneficiário). | **AD-003** |
| `TherapistsController` | POST | `/therapists` | `admin` | Cadastro de outro membro da equipe — gestão de pessoal, nunca um terapeuta cadastrando/editando outro. | **AD-003** |
| `TherapistsController` | PATCH | `/therapists/:id` | `admin` | Idem. | **AD-003** |
| `TherapistsController` | PUT | `/therapists/:id/availability` | `admin` | Idem — disponibilidade de outro terapeuta é gestão, não autoatendimento. | **AD-003** |
| `BillingController` | POST | `/billings` | `admin` | Financeiro — mesma sensibilidade do padrão já aplicado em `SubscriptionController`. | **AD-003** |
| `BillingController` | POST | `/billings/:id/send` | `admin` | Financeiro. | **AD-003** |
| `PaymentController` | POST | `/payments` | `admin` | Financeiro. | **AD-003** |
| `PaymentController` | POST | `/payments/:id/refund` | `admin` | Financeiro — estorno é ação de maior risco. | **AD-003** |
| `PatientsController` | POST | `/patients` | `admin`, `therapist` | Trabalho operacional do dia a dia — um terapeuta solo precisa cadastrar os próprios pacientes. | **AD-003** |
| `PatientsController` | PATCH | `/patients/:id` | `admin`, `therapist` | Idem. | **AD-003** |
| `PatientsController` | POST | `/patients/:id/deactivate` | `admin`, `therapist` | Idem. | **AD-003** |
| `PatientsController` | POST | `/patients/:id/reactivate` | `admin`, `therapist` | Idem. | **AD-003** |
| `PatientsController` | POST | `/patients/:id/discharge` | `admin`, `therapist` | **Alta é decisão clínica, não administrativa** — cabe ao terapeuta responsável, não só ao admin. | **AD-003** |
| `AppointmentsController` | POST | `/appointments` | `admin`, `therapist` | Gestão da própria agenda — função central do papel `therapist`. | **AD-003** |
| `AppointmentsController` | PATCH | `/appointments/:id/reschedule` | `admin`, `therapist` | Idem. | **AD-003** |
| `AppointmentsController` | POST | `/appointments/:id/cancel` | `admin`, `therapist` | Idem. | **AD-003** |
| `AppointmentsController` | POST | `/appointments/:id/confirm` | `admin`, `therapist` | Idem. | **AD-003** |
| `AppointmentsController` | POST | `/appointments/recurring` | `admin`, `therapist` | Idem. | **AD-003** |
| `RecurringBlocksController` | POST | `/recurring-blocks` | `admin`, `therapist` | Gestão da própria agenda (bloqueios recorrentes). | **AD-003** |

**Total: 29 rotas** (8 pré-existentes + 21 adicionadas pela AD-003).

Resumo da política, conforme aprovado no Design Review:
- **Financeiro e gestão de equipe** (`Clinic`, `Therapists`, `Billing`, `Payment`, `Subscription`, `AuditLog`, `WhatsApp`) permanecem exclusivos de `admin`.
- **Agenda e gestão clínica operacional** (`Appointments`, `RecurringBlocks`, a maioria de `Patients`) ficam acessíveis a `admin` **e** `therapist`.
- **`discharge`** (alta de paciente) foi classificado deliberadamente como decisão clínica, não administrativa — por isso `admin`+`therapist`, mesmo estando em `PatientsController`.
- `super_admin` passa em todas as 29 rotas, sempre — comportamento do `RolesGuard`, não uma exceção desta matriz.

---

## 2. Rotas intencionalmente abertas a qualquer usuário autenticado

Leitura (`GET`) dentro do próprio Tenant — qualquer usuário autenticado do Tenant pode consultar, independente do papel. Isto é uma decisão, não uma lacuna: não recebem `@Roles()` porque a intenção é que **todo** membro autenticado da clínica possa ler estes dados.

| Controller | Método | Endpoint |
|---|---|---|
| `AppointmentsController` | GET | `/appointments` |
| `AppointmentsController` | GET | `/therapists/:id/availability` |
| `ClinicController` | GET | `/clinic` |
| `TherapistsController` | GET | `/therapists` |
| `TherapistsController` | GET | `/therapists/:id` |
| `PatientsController` | GET | `/patients` |
| `PatientsController` | GET | `/patients/:id` |
| `BillingController` | GET | `/billings` |
| `BillingController` | GET | `/billings/:id` |
| `PaymentController` | GET | `/payments/:id` |
| `RecurringBlocksController` | GET | `/recurring-blocks` |

**Total: 11 rotas.**

---

## 3. Rotas fora do escopo de RBAC (autenticação não é `JwtAuthGuard`)

Estas rotas não representam um usuário humano com papel — a política de papéis (`admin`/`therapist`/`super_admin`) não se aplica a elas por definição. Listadas aqui só para que a auditoria de completude (seção 4) feche 100% dos Controllers da API, não apenas os protegidos por `JwtAuthGuard`.

| Controller | Rotas | Guard | Motivo |
|---|---|---|---|
| `AuthController` | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout` | nenhum | É o próprio mecanismo de obter/renovar o JWT — não pode exigir o JWT que ainda não existe. |
| `AutomationsController` | 4 rotas (`agenda-summary/*`, `inadimplencia/execute`, `fechamento-mensal/generate`) | `AutomationApiKeyGuard` | Chamado por automação/cron interno, não por um usuário logado — não há `role` de usuário no contexto. |
| `HealthController` | `GET /health` | nenhum | Probe de infraestrutura. |
| `WebhookController` | `POST /webhooks/asaas` | `AsaasWebhookGuard` | Chamado pela Asaas externamente; autenticação por assinatura do payload, não por sessão de usuário. |

**Total: 9 rotas fora de escopo.**

---

## 4. Auditoria de completude

Contagem sobre os 13 Controllers de `apps/backend/src/api/**/*.controller.ts`, sem amostragem — todos.

| Métrica | Valor |
|---|---|
| Total de Controllers na API | 13 |
| Controllers autenticados via `JwtAuthGuard` (usuário humano) | 10 |
| Controllers fora do escopo RBAC (auth não-JWT ou pública, por desenho documentado no próprio arquivo) | 4 |
| Total de rotas autenticadas via `JwtAuthGuard` | **40** |
| Rotas com `@Roles()` explícito (seção 1) | **29** (8 pré-existentes + 21 da AD-003) |
| Rotas intencionalmente abertas a qualquer autenticado — leitura (seção 2) | **11** |
| Rotas mutantes sem nenhuma política — o gap original da AD-003 | **0** (eram 21 antes da implementação) |

`29 + 11 = 40` — reconcilia exatamente com o total de rotas `JwtAuthGuard`. Nenhuma rota mutante autenticada ficou sem política explícita.

---

## 5. Lógica de RBAC espalhada em condicionais — verificação

Busca no código-fonte de `apps/backend/src` por qualquer leitura de papel de usuário fora do mecanismo oficial (`request.userRole ===`, `.role === '...'`, uso de `LuxoraRole`): os únicos 3 arquivos que tocam nisso são `jwt-auth.guard.ts` (atribui o papel a partir do JWT), `roles.guard.ts` (compara contra `@Roles()`) e `roles.decorator.ts` (declara o tipo/metadata). **Nenhuma lógica de RBAC replicada em condicionais de Use Case, Controller ou Domain foi encontrada.** Não há dívida técnica a registrar neste ponto — requisito de verificação da AD-003 cumprido, sem achado.

---

## Documentos relacionados

- `docs/02-Arquitetura/06-Autenticacao.md` — princípios de autenticação/autorização (não repete esta matriz).
- `docs/04-API/01-Contratos-REST.md` — contratos REST por módulo (não repete esta matriz).
- `apps/backend/src/api/auth/roles.guard.ts`, `roles.decorator.ts`, `jwt-auth.guard.ts` — implementação.
- `docs/PLANO_DE_EXECUCAO.md` — AD-003.
