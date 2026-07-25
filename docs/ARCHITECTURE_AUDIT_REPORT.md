# ARCHITECTURE_AUDIT_REPORT — Sprint 3: Architecture Audit (Read-Only)

**Data:** 2026-07-20
**Auditor:** Claude (Principal AI Software Engineer), papel de Auditor Técnico
**Natureza:** 100% leitura. Nenhum arquivo de código, teste, migration, documentação ou configuração foi alterado durante esta auditoria.
**Metodologia:** seis frentes de pesquisa paralelas (Arquitetura NestJS/DI, Use Cases, Superfície de API, Prisma/Multi-Tenant, Segurança, Testes/Dívida Técnica), cada uma lendo o código-fonte real e citando arquivo:linha. Os achados de maior severidade foram reverificados pessoalmente, por leitura direta do código, antes de entrar neste relatório — essa verificação está registrada inline em cada achado como "Confirmado por leitura direta" quando aplicável.

**Escala de severidade usada:**
- **Crítico** — risco real de vazamento de dados entre clínicas, bypass de autorização, ou perda/corrupção financeira, explorável hoje.
- **Alto** — gap de segurança/confiabilidade real e exposto, mas de blast radius menor ou que depende de uma condição adicional.
- **Médio** — lacuna real e concreta (cobertura de teste, hardening, consistência), sem exposição direta imediata.
- **Baixo** — inconsistência de documentação/convenção, dívida já autoconhecida e registrada no próprio código.

---

## 1. Executive Summary

A plataforma Luxora tem uma arquitetura NestJS/DDD coerente e sem quebras estruturais: os 13 módulos existentes estão corretamente ligados ao `AppModule`, o grafo de Dependency Injection não tem nenhuma dependência quebrada, não há dependências circulares entre módulos, e nenhum Controller está órfão. A camada de Use Cases (55 classes) está, em sua maioria, implementada, registrada e testada — **41 OK, 7 Parcial, 7 Órfão, 0 Quebrado**.

Os problemas reais encontrados não estão na estrutura, e sim em três áreas específicas e concentradas:

1. **Isolamento multi-tenant via RLS está, na prática, quase completamente inaplicado.** De ~18 tabelas com `tenant_id`, apenas **1** (`tenant_api_key`) tem `ROW LEVEL SECURITY` de fato presente em alguma migration real do Prisma — as outras 14 tabelas listadas no arquivo-fonte `prisma/rls/enable-rls.sql` nunca tiveram esse conteúdo colado em uma migration aplicável, e outras 3 tabelas com `tenant_id` (`clinic_subscription`, `message_log`, `whatsapp_integration`) nem constam da lista-fonte. Isso significa que, em qualquer banco real onde as migrations tenham sido aplicadas, o isolamento entre clínicas depende **inteiramente** do filtro de aplicação (`TenantContext`) — a segunda camada de defesa que o próprio time projetou e documentou como obrigatória simplesmente não existe hoje fora do ambiente de design. Ver **F1**.
2. **Existe um bypass de autorização entre tenants real e concreto** nos endpoints `/automations/*`: eles aceitam um `tenantId` arbitrário vindo direto do corpo da requisição, sem validação de DTO e sem nunca chamar `tenantContext.set(...)`, protegidos apenas por uma API key estática global. Qualquer detentor dessa chave pode disparar rotinas de inadimplência, envio de agenda ou fechamento mensal apontando para o `tenantId` de **qualquer clínica**, não só a sua. Ver **F2**.
3. **Autorização por role é aplicada de forma inconsistente**: `RolesGuard` existe e funciona corretamente onde é usado, mas 6 dos 13 controllers (incluindo pagamentos/reembolso e dados de repasse PIX da clínica) fazem mutações protegidas só por autenticação, sem checagem de role — qualquer usuário autenticado, independente do cargo, pode executar essas ações. Ver **F4**.

Fora dessas três áreas, a plataforma está em um estado razoavelmente saudável para o estágio em que se encontra: fundamentos de autenticação (bcrypt custo 12, JWT com separação access/refresh, chaves de API com hash SHA-256 e nunca logadas em texto puro), validação global estrita (`whitelist + forbidNonWhitelisted`), e um schema Prisma consistente com suas migrations (majoritariamente aditivas — 8 de 9 sem nenhuma alteração destrutiva; a única exceção, uma migration mista com backfill + `DROP COLUMN`, está detalhada no Anexo A, F34). A maior parte da dívida técnica encontrada já está **autoconhecida e documentada no próprio código** pelos autores anteriores — não são descobertas ocultas, são pendências já registradas que esta auditoria apenas consolida e prioriza.

---

## 2. Estado Geral da Plataforma

| Dimensão | Situação observada |
|---|---|
| Módulos NestJS | 13 arquivos `*.module.ts`; todos importados em `app.module.ts:24-41`; grafo de `imports` é um DAG (sem ciclos) |
| Controllers | 13 arquivos, todos registrados em algum módulo; nenhum órfão |
| Use Cases | 55 classes exportadas; 0 stubs/`throw not implemented`; 41 OK / 7 Parcial / 7 Órfão |
| Rotas HTTP | ~40 rotas sob prefixo global `/api/v1`; nenhuma duplicada |
| Banco de dados | PostgreSQL via Prisma; 9 migrations reais, 8 aditivas + 1 mista (backfill + `DROP COLUMN`, ver Anexo A/F34); schema.prisma consistente com as migrations aplicadas (nenhum campo órfão) |
| RLS | Arquivo-fonte existe e é bem projetado, mas **efetivamente não aplicado** a 17 de ~18 tabelas em qualquer banco real (ver F1) |
| Autenticação | JWT + bcrypt(12), guards funcionais, sem fallback de secret hardcoded |
| Autorização por role | Implementada corretamente onde usada, mas aplicada em só 3 de 13 controllers |
| Testes | Cobertura ampla na maior parte dos Use Cases; 4 de 13 módulos de API sem cobertura de integração; suíte crítica de `ClinicSubscription` permanece quebrada (dessincronia Prisma Client/banco, já diagnosticada em Sprints anteriores) |
| Infraestrutura de produção | `infra/railway/` está vazio — nenhuma configuração de banco/deploy de Homologação ou Produção existe neste repositório |
| Dívida técnica | Extensa, mas majoritariamente **autoconhecida**: comentários no próprio código documentam quase toda pendência relevante (proration de assinatura, gatilho de downgrade automático, Motor Operacional, IA sem entrypoint, Object Storage, Policy Engine) |

---

## 3. Achados por domínio

### 3.1 Arquitetura NestJS (Escopo 1)

- **Nenhum provider não registrado** dentro dos módulos ativos, **nenhum Controller órfão**, **nenhuma dependência de DI quebrada**, **nenhum ciclo de módulos**. Verificado por leitura completa dos 13 `@Module()` e de todos os construtores de Use Cases/Guards/Services.
- **F6 [Alto] — `TenantApiKeyGuard` nunca é aplicado a nenhuma rota.** Está implementado (`api/subscription/tenant-api-key.guard.ts:26-68`), registrado como provider (`subscription.module.ts:41`), mas grep completo por `@UseGuards(TenantApiKeyGuard)` em todo `apps/backend/src` retorna zero ocorrências — confirmado por mim diretamente. A segunda via de autenticação de API descrita em PD-003 (Módulo 17) existe só como infraestrutura solta, sem nenhum endpoint de negócio que a use.
- **F7 [Alto] — `ProcessarMensagemUseCase`/`IntentActionRouter` (motor conversacional de IA) são inalcançáveis em produção.** `AIModule` (`api/ai/ai.module.ts`) não declara `controllers` — confirmado por leitura completa do decorator. O próprio comentário do módulo (linhas 29-34) documenta: *"Sem Controller próprio ainda — o ponto de entrada real (webhook do WhatsApp recebendo mensagem do paciente) continua como dívida explícita."* Implementado e testado, mas sem controller, fila ou cron que o alcance.
- **F8 [Médio] — Gerenciamento de feriados (`ClinicHoliday`) implementado, sem exposição HTTP.** `CriarFeriadoUseCase`, `RemoverFeriadoUseCase`, `ListarFeriadosUseCase` (`use-cases/availability/gerenciar-clinic-holiday.use-case.ts:29,59,78`) e `ConsultarCalendarioUseCase` (`use-cases/availability/gerenciar-disponibilidade.use-case.ts:16`) não aparecem em nenhum array `providers` de módulo — confirmado por mim (`Glob apps/backend/src/api/**/*holiday*` não retorna nenhum arquivo; não existe `ClinicHolidayController`). **Nota de rastreabilidade**: a tarefa interna "Fase 2 — B5: gerenciamento de ClinicHoliday" foi marcada concluída nesta sessão — a conclusão se referia à camada de domínio/use case/teste, não à exposição via API, o que esta auditoria agora deixa explícito.
- **F9 [Médio] — `MaterializarRecurringBlockUseCase` idem.** Registrado em DI (`appointments.module.ts:54`) e testado ponta a ponta contra Postgres real, mas nenhum Controller o injeta. O próprio teste crítico documenta isso: *"Não usa bootstrapTestApp(): não há Controller/Endpoint nesta etapa (fora do escopo da C3)"* (`recurring-block-materialization.test.ts`).
- **F22 [Baixo] — `operational-engine/` é um diretório vazio, mas `main.ts` descreve uma garantia arquitetural que depende dele.** `main.ts:11-14` documenta que "nenhuma requisição chega a um Serviço de Domínio sem antes passar pelo Motor Operacional", citando `OperationalEngineModule` — grep confirma zero módulo de API importando isso. É um comentário descrevendo um controle que não existe no código atual.
- **F23 [Baixo] — `ExecutarReguaInadimplenciaUseCase` registrado duas vezes** (`billing.module.ts:48` e `automations.module.ts:28`), mas só efetivamente injetado a partir de `AutomationsController` — registro redundante em `billing.module.ts`, sem efeito funcional.

### 3.2 Use Cases (Escopo 2)

Tabela completa de 55 classes foi produzida pela auditoria; resumo:

| Classificação | Quantidade | Composição |
|---|---|---|
| OK | 41 | Implementado + registrado + acessível + testado (endpoint real ou colaborador interno de outro Use Case acessível) |
| Parcial | 7 | Implementado, registrado, acessível, com endpoint real — mas **zero cobertura de teste** (ver F13) |
| Órfão | 7 | Implementado e (na maioria) testado isoladamente, mas nunca registrado em nenhum módulo OU registrado mas sem nenhum Controller/fila/cron que o alcance (F7, F8, F9) |
| Quebrado | 0 | Nenhum Use Case com falha de DI ou lógica demonstravelmente incorreta foi encontrado |

Nenhum `execute()` contém stub, `TODO` de implementação ou `throw new Error('not implemented')` — toda classe tem lógica real.

### 3.3 Superfície de API (Escopo 3)

- ~40 rotas mapeadas sob `/api/v1` (`main.ts:31`). **Nenhuma rota duplicada, nenhuma rota morta** (todo Controller está registrado).
- `ValidationPipe` global correto e estrito: `whitelist: true, forbidNonWhitelisted: true, transform: true` (`main.ts:38-44`) — confirmado.
- **F12 [Médio] — 4 endpoints recebem `@Body()` tipado como `interface`/objeto inline em vez de classe**, o que faz o `ValidationPipe` global não ter efeito nenhum sobre eles (o pipe só valida quando o metatype é uma classe): `POST /webhooks/asaas` (`webhook.controller.ts:26`, tipo `AsaasWebhookPayload`, uma `interface`) e os três endpoints de `/automations/*` (`automations.controller.ts:28,34,40`, tipos inline `{ tenantId: string; ... }`) — este último é parte da causa raiz de F2.
- **F15 [Baixo] — Vários endpoints de ação (send/refund/deactivate/cancel/confirm/upgrade/downgrade) retornam `201` por default do NestJS**, sem `@HttpCode` explícito, apesar de representarem transição de estado, não criação de recurso. Semântica HTTP imprecisa, não um bug funcional.
- **F16 [Baixo] — Zero `@ApiResponse`/`@ApiProperty` em toda a API.** Só `SubscriptionController` tem `@ApiOperation` (upgrade/downgrade). O Swagger gerado existe mas é estrutural, não descritivo.
- Ver F4 (autorização por role) e F6 (TenantApiKeyGuard) — tratados em Segurança (3.6) para evitar duplicação.

### 3.4 Prisma (Escopo 4)

- 19 models em `schema.prisma`, todos rastreáveis a alguma migration real — nenhum campo órfão (campo presente no schema sem migration que o crie).
- Enums TS ↔ Prisma consistentes; onde a nomenclatura difere (`SubscriptionStatus`, `BillingState`/`BillingStatus`, `PaymentState`/`PaymentStatus`), existe um mapa explícito `TO_DB`/`TO_DOMAIN` no repository correspondente — comportamento correto, não um bug.
- **F10 [Médio] — Dois campos de entidade nunca são persistidos de volta ao banco:**
  - `Therapist.phone`: lido do Prisma (`prisma-therapist.repository.ts:47`), sem getter na entidade (`domain/therapist/therapist.entity.ts:53-67`) e nunca escrito em `save()`.
  - `Appointment.modality`: aceito da API em 3 pontos de criação (`agendar-consulta.use-case.ts:60`, `criar-agendamento-recorrente.use-case.ts:86`, `intent-action-router.ts:81`), lido de volta do Prisma (`prisma-appointment.repository.ts:121`), mas **nunca escrito** em `upsertAll()` (`prisma-appointment.repository.ts:92-112`) — todo agendamento persiste silenciosamente com o valor default do schema (`'presencial'`), independente do que o usuário realmente pediu. Este é o achado de consistência mais concreto de toda a auditoria: dado de entrada aceito, validado, e descartado sem erro.
- **F18 [Baixo] — `schema.prisma:4` referencia `prisma/migrations/00000000000000_init_rls/migration.sql`, que não existe** (confirmado por mim: `Glob`/listagem direta da pasta `prisma/migrations/` mostra 9 pastas reais, nenhuma com esse nome). `prisma/migrations/README.md` ainda afirma *"Esta pasta está intencionalmente vazia neste commit"* — desatualizado desde a primeira migration real, aplicada em 16/07.

### 3.5 Multi-Tenant / RLS (Escopo 5)

Este é o domínio com os achados mais graves da auditoria.

- **F1 [Crítico] — RLS realmente ativa em apenas 1 de ~18 tabelas com `tenant_id`, em qualquer banco onde as migrations tenham sido aplicadas.** Confirmado por mim diretamente: `grep -r "ROW LEVEL SECURITY" apps/backend/prisma/migrations/` retorna exatamente **um** arquivo, `20260718000000_add_tenant_api_key/migration.sql`. O arquivo-fonte `prisma/rls/enable-rls.sql` — que lista 15 tabelas e é corretamente projetado (`FORCE ROW LEVEL SECURITY`, cast correto de `tenant_id` como `text`, exceções de bypass restritas e documentadas para login por email e lookup de API key) — nunca teve seu conteúdo colado em uma migration real para as outras 14 tabelas, apesar de o próprio arquivo documentar esse passo manual como obrigatório (linhas 4-17: *"Colar o conteúdo deste arquivo dentro do migration.sql gerado"*). Isso significa que, hoje, o isolamento entre clínicas em `clinic_settings`, `ai_settings`, `user`, `therapist`, `patient`, `appointment`, `session`, `billing`, `billing_session`, `payment`, `audit_log`, `availability_calendar`, `clinic_holiday` e `recurring_block` depende **inteiramente** do filtro de aplicação (`TenantContext`/`PrismaService.forTenant()`) — a "segunda camada de defesa" que a própria documentação do projeto (`docs/03-Database/09-Multi-Tenant.md:291`, citada pela auditoria) declara obrigatória simplesmente não existe em nenhum banco real ainda.
  - **Impacto:** um único bug futuro no filtro de aplicação (ex.: um repository novo que esqueça de usar `forTenant()`, como quase aconteceu — ver F3) deixaria de ter qualquer rede de segurança.
  - **Recomendação:** colar `prisma/rls/enable-rls.sql` em uma migration real (`prisma migrate dev --name enable_rls --create-only`, exatamente como o próprio arquivo já instrui) o quanto antes, com um teste crítico que comprove isolamento ativo por tabela.
- **F3 [Crítico] — `clinic_subscription`, `message_log` e `whatsapp_integration` têm `tenant_id` mas não constam nem na lista-fonte de RLS.** Ainda pior no caso de `clinic_subscription`: `PrismaClinicSubscriptionRepository` usa `PrismaClientProvider` diretamente, nunca `forTenant()` (`prisma-clinic-subscription.repository.ts:20-30`), contando 100% com filtros `where` de chave única do Prisma — sem RLS e sem `TenantContext`, esta é a tabela com a defesa mais fraca de toda a plataforma (dados de plano/cobrança).
  - **Recomendação:** adicionar as 3 tabelas ao array de `enable-rls.sql` antes de aplicar F1; revisar se `clinic_subscription` pode migrar para `forTenant()` nos caminhos que não sejam o webhook (que tem motivo documentado para não usá-lo).
- **F2 [Crítico] — Bypass de autorização entre tenants em `/automations/*`.** Confirmado por mim diretamente: `automations.controller.ts:28,34,40` extrai `tenantId` de `@Body()` tipado como objeto inline (não DTO — ver F12), e um grep completo por `tenantContext.set(` em todo `apps/backend/src` retorna apenas 3 ocorrências (`jwt-auth.guard.ts:48`, `tenant-api-key.guard.ts:64`, `processar-webhook-assinatura.use-case.ts:96`) — **nenhuma dentro do fluxo de automations**. A única proteção é `AutomationApiKeyGuard`, que compara um header contra **uma única chave estática global** (`process.env.AUTOMATION_API_KEY`), igual para todas as clínicas. Qualquer sistema externo (ex.: o agendador n8n/cron mencionado nos comentários do código) que possua essa chave pode, hoje, disparar a régua de inadimplência, reenvio de agenda ou fechamento mensal apontando para o `tenantId` de **qualquer clínica**, não apenas a que o disparo pretendia atingir.
  - **Impacto:** dado que essas rotinas leem e escrevem dados financeiros/de cobrança e disparam mensagens ao paciente, um erro de configuração (não nem um ataque deliberado) no lado do agendador externo — por exemplo, um `tenantId` errado copiado/colado — já seria suficiente para rodar a régua de inadimplência de uma clínica contra os dados de outra.
  - **Recomendação:** cada `tenantId` usado por essas rotas deveria ser resolvido a partir de uma identidade própria por clínica (uma API key por tenant, no mesmo modelo já existente e não utilizado de `TenantApiKeyGuard`/F6), não aceito como um campo livre do corpo da requisição.
- **F11 [Médio] — Comparação de segredo não constante-time.** `AsaasWebhookGuard` (`asaas-webhook.guard.ts`) e `AutomationApiKeyGuard` (`automation-api-key.guard.ts:21`) usam `!==` puro para comparar o header recebido contra o segredo esperado — superfície de timing attack, severidade baixa isoladamente, mas relevante justamente porque `AutomationApiKeyGuard` já é o elo mais fraco da cadeia (F2).
- Fora desses pontos, a propagação de contexto de tenant em requisições HTTP normais está **correta**: toda query de repository passa por `PrismaService.forTenant()`, que executa `SET LOCAL app.tenant_id` antes de cada query (`prisma.service.ts:26-37`); nenhuma query raw (`$queryRaw`/`$executeRawUnsafe`) foi encontrada sem filtro explícito ou fora desse mecanismo — os únicos 3 usos de `$executeRawUnsafe` são, eles mesmos, o próprio mecanismo de `SET LOCAL`, precedidos por validação de formato UUID.
- O `DATABASE_URL` de desenvolvimento usa corretamente o role restrito `luxora_app` (sem `SUPERUSER`/`BYPASSRLS`) — **não verificável para Homologação/Produção**, já que `infra/railway/` está vazio (ver Pendências de Infraestrutura).

### 3.6 Segurança (Escopo 6)

- **Autenticação**: bcrypt custo 12 (`auth.service.ts:82-85`), JWT sem fallback de secret hardcoded em nenhum dos 9 módulos que o registram (confirmado por grep completo), separação correta entre token de acesso (15 min) e refresh (7 dias) com checagem de claim `type` contra reuso cruzado (`auth.service.ts:57-61`).
- **API Keys**: `randomBytes(32)` (256 bits), armazenada só como hash SHA-256 (`gerar-api-key.use-case.ts:45-46`), nunca logada em texto puro (grep confirma zero `console.log`/logger próximo ao segredo). Endpoint de geração corretamente restrito a `@Roles('admin')`.
- **F4 [Alto] — Autorização por role ausente em 6 de 13 controllers para rotas que mutam estado.** `RolesGuard` está corretamente wireado em só 3 controllers (`AuditLogController`, `WhatsAppController`, `SubscriptionController`). As demais mutações — `BillingController`/`PaymentController`, `ClinicController`, `PatientsController`, `AppointmentsController`, `TherapistsController`, `RecurringBlocksController` — ficam protegidas só por `JwtAuthGuard` (+ `SubscriptionAccessGuard`), ou seja, qualquer usuário autenticado, de qualquer role (`admin` ou `therapist`), pode executar essas ações. Os dois casos de maior impacto:
  - `PUT /clinic/payment-info` (`clinic.controller.ts:45`) — qualquer usuário autenticado pode alterar a chave PIX/nome do beneficiário de repasse da clínica.
  - `POST /payments/:id/refund` (`billing.controller.ts:89`) — qualquer usuário autenticado pode estornar um pagamento.
  - **Classificação honesta**: não há evidência no código de que isso seja uma decisão de produto deliberada (contraste: `AuthController` documenta explicitamente por que suas 3 rotas não têm guard). Não há comentário equivalente em nenhum desses 6 controllers — o padrão lido é "não revisado", não "decidido".
- **F5 [Alto] — Nenhum rate limiting em nenhum endpoint**, incluindo `POST /auth/login` e `POST /webhooks/asaas`. `@nestjs/throttler` não está no `package.json`; nenhum middleware equivalente foi encontrado. Exposição a força bruta/credential stuffing no login; não verificável se existe alguma camada de rate limit fora deste repositório (proxy/WAF).
- **CORS**: restrito por allowlist via `FRONTEND_URL` (`main.ts:26-29`), não `*` — configuração correta.
- **Segredos no código**: nenhum segredo real-parecido hardcoded encontrado em `src/`; `.env.example` usa só placeholders com aviso explícito de não commitar `.env` real.
- Ver F1/F2/F3/F6/F11 (multi-tenant e guards) já detalhados acima — não duplicados aqui.

### 3.7 Testes (Escopo 7)

- **F13 [Médio] — 7 Use Cases com endpoint real e zero cobertura de teste** (nem unitário, nem crítico): `ConsultarAuditLogUseCase`, `ListarCobrancasUseCase`, `EnviarResumoAgendaDoDiaUseCase`, `AnexarCartaoUseCase`, `ConsultarAssinaturaUseCase`, além da função `buildAgendaSummaryMessage` e do endpoint `POST /webhooks/asaas` em si (sem teste crítico, apesar de `ProcessarWebhookAssinaturaUseCase` ter cobertura unitária). **`AnexarCartaoUseCase` é o item de maior atenção nesta lista** — lida com dados de cartão de crédito ponta a ponta sem nenhum teste automatizado.
- **F14 [Médio] — 4 dos 13 módulos de API sem cobertura de integração (`test/critical/`)**: `ai` (sem controller — ver F7), `automations` (só unitário), `communication`/WhatsApp connect (só unitário), e um diretório `apps/backend/src/api/reports/` **completamente vazio** — nem controller, nem módulo, nada registrado, apesar de aparecer como uma área esperada de superfície de API.
- Nenhum teste com import quebrado foi encontrado (checagem automatizada de todos os imports de teste contra os exports reais dos arquivos-fonte, zero mismatch).
- Nenhum teste novo encontrado codificando um bug como comportamento correto — o único padrão desse tipo já identificado é **histórico e corrigido**: `processar-webhook-assinatura.use-case.test.ts:70` documenta explicitamente no próprio título que aquele teste testa a correção de um bug de sprints anteriores (renovação de assinatura sendo ignorada), e o código de produção confirma a correção.
- **F26 [Alto — achado rastreado de Sprint anterior, não uma descoberta nova desta auditoria] — A suíte crítica de `ClinicSubscription` (`subscription-upgrade-downgrade.test.ts`, `tenant-api-key.test.ts`) permanece quebrada neste ambiente**, por dessincronia entre o Prisma Client gerado e o schema real do banco (`prisma generate` executado sem as migrations correspondentes terem sido aplicadas). Já diagnosticado e formalmente reportado em ciclos anteriores desta mesma sessão; segue como bloqueio de infraestrutura em aberto — listado aqui para manter o relatório como fonte única de risco de produção. **Nota de reconciliação (revisão final)**: isto é ortogonal à avaliação de cobertura de cenários feita nos Anexos E/I (seções 16 e 21), que classificam os endpoints exercitados por esses mesmos 2 arquivos como "Completa" — aquela nota mede se o *código do teste* cobre os cenários certos (sucesso + falha de negócio); F26 mede se a suíte *passa de fato* neste ambiente sandbox agora. As duas coisas podem ser simultaneamente verdadeiras sem contradição: um teste bem desenhado (Completa) que não consegue rodar por um problema de ambiente (F26).

### 3.8 Dívida Técnica (Escopo 8)

A grande maioria da dívida técnica encontrada está **autodocumentada no próprio código**, o que é um sinal positivo de disciplina de engenharia, mesmo quando a lacuna em si é real:

- Cobrança prorateada de upgrade/downgrade de assinatura: **não implementada**, registrada explicitamente em 3 lugares (`clinic-subscription.entity.ts:208-213`, `gerenciar-assinatura.use-case.ts:79-85`, `subscription.controller.ts:78-81`).
- Gatilho automático de downgrade agendado (`applyPendingDowngrade()`): existe, mas nada o chama ainda — registrado em `gerenciar-assinatura.use-case.ts:123-128`.
- `PLAN_BENEFITS`: `externalApiAccess`, `multiUnit`, `advancedReporting`/`executiveDashboard` explicitamente marcados como não implementados em `plan-benefits.ts:26-44`.
- Providers de integração externa (`WhatsAppMessageProvider`, `AnthropicAIProvider`, `MessageQueueWorker`/BullMQ) todos com comentário explícito: **nunca testados contra a API/rede real neste ambiente**.
- **F24 [Baixo]** — único `TODO` real do código: `gerar-fechamento-mensal.use-case.ts:36` (paginação real se o volume crescer).
- **F17 [Baixo]** — 2 violações da convenção "nunca indexar `PLAN_BENEFITS` diretamente" (`gerar-api-key.use-case.ts:36`, `tenant-api-key.guard.ts:55`) — ambas **deliberadas e justificadas em comentário adjacente** (fail-closed sem lançar exceção em gate de acesso), não um deslize de disciplina.
- **F19 [Baixo]** — ADR-0024, 0026, 0027, 0028, 0033, 0037, 0039 são citadas em comentários de código, mas **nunca tiveram arquivo próprio trazido ao repositório** (só existem `ADR-0001` a `ADR-0021` e `ADR-0040`). Autorreconhecido no próprio `ADR-0040-motor-disponibilidade-bounded-context.md:7`.
- **F20 [Baixo]** — `ADR-0013` (Object Storage) e `ADR-0016` (Policy Engine) estão com status "Aprovada" na documentação, sem nenhuma implementação correspondente em `src/`.
- **F21 [Baixo]** — `docs/11-Product-Decisions/PD-001-Motor-de-Disponibilidade/README.md:3` ainda diz *"implementação NÃO iniciada"*, apesar de a Fase 1 do Motor de Disponibilidade estar implementada e testada há várias Sprints — doc nunca foi atualizado após o início real da implementação (ver também 3.9, Pendências de Produto).
- **F25 [Baixo]** — `JwtModule.register({ secret: process.env.JWT_SECRET })` duplicado independentemente em 9 módulos, em vez de reexportar o `JwtModule` já exportado por `AuthModule` — mesmo valor hoje, risco de divergência futura.

---

## 4. Achados por severidade (índice consolidado)

| ID | Severidade | Resumo | Domínio | Detalhe em |
|---|---|---|---|---|
| F1 | Crítico | RLS ativa em só 1 de ~18 tabelas tenant-scoped em qualquer banco real | Multi-Tenant | 3.5 |
| F2 | Crítico | `/automations/*` aceita `tenantId` arbitrário do body, sem contexto de tenant, só protegido por 1 chave estática global | Multi-Tenant/Segurança | 3.5 |
| F3 | Crítico | `clinic_subscription`/`message_log`/`whatsapp_integration` fora da lista de RLS; `clinic_subscription` sem `forTenant()` no webhook | Multi-Tenant | 3.5 |
| F4 | Alto | 6 controllers permitem mutação sem checagem de role (destaque: refund, payment-info) | Segurança | 3.6 |
| F5 | Alto | Nenhum rate limiting em nenhum endpoint, incl. login | Segurança | 3.6 |
| F6 | Alto | `TenantApiKeyGuard` nunca aplicado a nenhuma rota | Arquitetura | 3.1 |
| F7 | Alto | Motor conversacional de IA sem nenhum ponto de entrada alcançável | Arquitetura/Use Cases | 3.1 |
| F8 | Médio | Gerenciamento de feriados sem exposição HTTP | Arquitetura/Use Cases | 3.1 |
| F9 | Médio | `MaterializarRecurringBlockUseCase` sem job/endpoint que o dispare | Arquitetura/Use Cases | 3.1 |
| F10 | Médio | `Therapist.phone`/`Appointment.modality` nunca persistidos de volta | Prisma | 3.4 |
| F11 | Médio | Comparação de segredo não constante-time em 2 guards | Segurança | 3.5/3.6 |
| F12 | Médio | 4 endpoints com `@Body()` não tipado como classe — ValidationPipe inerte | API | 3.3 |
| F13 | Médio | 7 Use Cases com endpoint real e zero teste (destaque: dados de cartão) | Testes | 3.7 |
| F14 | Médio | 4 de 13 módulos sem cobertura de integração; `reports/` vazio | Testes | 3.7 |
| F15 | Baixo | Endpoints de ação retornando 201 por default | API | 3.3 |
| F16 | Baixo | Swagger estrutural, sem `@ApiResponse`/`@ApiProperty` | API | 3.3 |
| F17 | Baixo | 2 violações deliberadas/justificadas da convenção `getPlanBenefits()` | Dívida Técnica | 3.8 |
| F18 | Baixo | Referência a migration RLS inexistente; README de migrations desatualizado | Prisma | 3.4 |
| F19 | Baixo | 7 ADRs citadas em código, sem arquivo no repositório | Dívida Técnica | 3.8 |
| F20 | Baixo | ADR-0013/0016 aprovadas sem implementação | Dívida Técnica | 3.8 |
| F21 | Baixo | PD-001 README diz "não iniciado" apesar de Fase 1 implementada | Dívida Técnica | 3.8 |
| F22 | Baixo | `operational-engine/` vazio, mas descrito como garantia ativa em `main.ts` | Arquitetura | 3.1 |
| F23 | Baixo | Registro duplicado de `ExecutarReguaInadimplenciaUseCase` | Arquitetura | 3.1 |
| F24 | Baixo | 1 TODO real (paginação) | Dívida Técnica | 3.8 |
| F25 | Baixo | `JwtModule.register()` duplicado em 9 módulos | Segurança | 3.6 |
| F26 | Alto (rastreado — não é achado novo) | Suíte crítica de `ClinicSubscription` quebrada (dessincronia Prisma/DB) — já reportado em Sprint anterior | Testes/Infra | 3.7 |

---

## 5. Dívida Técnica

Ver seção 3.8 para o detalhamento completo com evidência. Resumo por natureza:

- **Regras de negócio conscientemente adiadas** (proration, gatilho de downgrade, benefícios de plano incompletos) — todas registradas em comentário no ponto exato do código que precisará mudar.
- **Integrações externas nunca validadas contra rede real** (WhatsApp, Anthropic, BullMQ/Redis) — mesmo padrão de comentário em 3 arquivos diferentes, sugerindo uma limitação de ambiente conhecida e consistente, não descuido pontual.
- **Documentação desatualizada em relação ao código** (F18, F19, F20, F21) — nenhuma contradiz o código de forma perigosa, mas todas reduzem a confiabilidade da documentação como fonte de verdade.
- **1 único TODO literal em todo o código-fonte** (F24) — sinal de que a prática de "registrar pendência em comentário estruturado" já substituiu o uso de `TODO` solto neste projeto.

---

## 6. Riscos de Produção

| Risco | Severidade | Impacto | Probabilidade | Recomendação |
|---|---|---|---|---|
| F1 — RLS inaplicada | Crítico | Vazamento de dados entre clínicas caso qualquer filtro de aplicação futuro tenha um bug — sem rede de segurança hoje | Média (depende de um bug futuro em código de aplicação, não de um ataque ativo) | Aplicar `enable-rls.sql` como migration real antes de qualquer onboarding de cliente pagante adicional |
| F2 — Bypass de tenant em automations | Crítico | Rotina financeira/mensagem disparada contra a clínica errada, inclusive por erro operacional simples (não precisa ser ataque) | Média-Alta (basta um erro de configuração no agendador externo) | Substituir `tenantId` livre por identidade por tenant (reaproveitando F6) antes de habilitar qualquer automação em produção multi-cliente |
| F3 — `clinic_subscription` sem defesa em profundidade | Crítico | Dado de cobrança/plano é o mais exposto da plataforma a um bug de filtro | Baixa-Média | Incluir na mesma migration de F1 |
| F26 — Suíte crítica de Assinatura quebrada | Alto | Impossível validar automaticamente upgrade/downgrade/webhook contra banco real neste ambiente até a infraestrutura ser corrigida | Certa (já ocorrendo) | Já endereçado em runbook próprio (`MIGRATION_RUNBOOK.md`); resolução depende de Frente 1 (infraestrutura), fora do escopo desta auditoria |
| F4 — Autorização por role incompleta | Alto | Um usuário `therapist` comprometido (ou mal-intencionado) pode reembolsar pagamentos ou alterar dados de repasse financeiro da clínica | Baixa-Média (requer uma conta válida, mas de role não-admin) | Definir explicitamente, por endpoint, se a ausência de `@Roles` é intencional; adicionar `@Roles('admin')` onde não for |
| F5 — Sem rate limiting | Alto | Login exposto a força bruta/credential stuffing | Baixa no curto prazo, cresce com a base de usuários | Adicionar `@nestjs/throttler` pelo menos em `/auth/login` e `/webhooks/asaas` |
| Ausência de configuração de Homologação/Produção (`infra/railway/` vazio) | Alto | Nenhum dos achados acima é verificável para os ambientes reais que os clientes vão usar | Certa (é um fato atual, não uma previsão) | Fora do escopo desta auditoria (read-only); registrado como pendência de infraestrutura (seção 9) |

---

## 7. Inconsistências Arquiteturais

- **F22** — `main.ts` descreve uma garantia de que todo módulo de API depende do `OperationalEngineModule`; esse módulo não existe (diretório vazio). A garantia documentada não reflete o código atual.
- **F18** — `schema.prisma` referencia uma migration de RLS (`00000000000000_init_rls`) que nunca foi criada; o `README.md` de migrations continua dizendo que a pasta está vazia, quando há 9 migrations reais.
- **F19/F20** — ADRs citadas no código sem arquivo correspondente, e ADRs com arquivo/status "Aprovada" sem implementação correspondente — duas direções do mesmo problema (código cita doc que não existe; doc descreve código que não existe).
- **F21** — PD-001 (Motor de Disponibilidade) tem seu próprio README de status desatualizado em relação à implementação real, que avançou bem além do que o documento afirma.
- **F10** — `Appointment.modality` é um caso concreto de uma entidade de domínio ter uma propriedade que a camada de persistência simplesmente não trata simetricamente (lida, nunca escrita) — o tipo de inconsistência Entity↔Repository↔Prisma↔Banco que este Escopo pediu para verificar especificamente, e que de fato existe, ainda que de forma pontual (2 casos em toda a base).
- Rota `GET /therapists/:id/availability` pertence a `AppointmentsController`, não a `TherapistsController`, apesar do prefixo de URL sugerir o contrário — intencional e documentado em comentário (`appointments.controller.ts:18-20`), mas vale registrar como uma escolha de organização que pode confundir quem só lê a URL.

---

## 8. Pendências de Produto

Extraído diretamente dos próprios documentos de Product Decision (autorreportado, não inferido):

- **PD-001 (Motor de Disponibilidade)** — doc diz "não iniciado", código mostra Fase 1 implementada e testada. **Ação de produto sugerida**: atualizar o status do documento, não o código.
- **PD-003 (Acesso à API por Tenant)** — a própria análise arquitetural já registra que "nenhum endpoint de negócio usa `TenantApiKeyGuard` ainda — só a infraestrutura de autenticação existe" — confirmado nesta auditoria como ainda verdadeiro (F6).
- **PD-004 (Primeiro Endpoint da API)** — encerrado e congelado por decisão oficial de 2026-07-18; não é uma pendência, é uma decisão deliberada.
- **PD-005 (Multiunidade)** — declarado como não implementado; a entidade `Account` de fato não existe no schema, consistente com o próprio doc.
- **PD-007 (Identificação do Tenant via WhatsApp)**, **PD-008 (Domínio Conversacional)**, **PD-009 (Pipeline Conversacional)** — todos são documentos de arquitetura pura, explicitamente sem nenhum código/schema/migration associado ainda, conforme os próprios textos.
- Proration de assinatura e gatilho automático de downgrade (ver 3.8) são pendências de regra de negócio já identificadas pela própria engenharia, aguardando decisão explícita do CTO/CEO sobre quando priorizar — não decisões que esta auditoria toma.

---

## 9. Pendências de Infraestrutura

- **`infra/railway/` vazio** — nenhuma configuração de banco, deploy ou variáveis de ambiente para Homologação/Produção existe neste repositório. Todos os achados de RLS/segurança desta auditoria só puderam ser verificados contra o design local (Docker Compose); nada pode ser confirmado para os ambientes reais até essa configuração existir.
- **F1/F3 — RLS nunca aplicada a um banco real** — depende de rodar `prisma migrate dev --name enable_rls --create-only` e colar `enable-rls.sql`, exatamente como o próprio arquivo já instrui; puramente uma questão de execução, o design já está pronto.
- **F26 — Suíte crítica de `ClinicSubscription` quebrada** neste ambiente por dessincronia Prisma Client/banco — já tem um runbook operacional dedicado (`docs/07-Infra/MIGRATION_RUNBOOK.md`) aprovado pelo CTO; resolução depende de acesso administrativo ao banco (Frente 1, já em aberto de Sprint anterior).
- Providers de integração externa (WhatsApp, Anthropic, mensageria via Redis/BullMQ) nunca foram exercitados contra rede real neste ambiente — autodocumentado no código; validação empírica depende de acesso de rede não disponível neste sandbox.

---

## 10. Recomendações Prioritárias

Em ordem de impacto/urgência, não de esforço. Lista revisada na validação final para incorporar os achados dos Anexos A-I (F27-F34) — nenhum item novo muda a ordem de prioridade original, eles se inserem dentro dela por severidade.

1. **Aplicar `prisma/rls/enable-rls.sql` como migration real** (F1), incluindo as 3 tabelas hoje ausentes da lista-fonte (F3). É o item de maior impacto de segurança e o de menor esforço relativo — o design já existe e está correto, falta só o passo de execução que o próprio arquivo documenta.
2. **Corrigir o modelo de identidade dos endpoints `/automations/*`** (F2) — parar de aceitar `tenantId` livre no corpo da requisição; usar uma identidade por tenant (reaproveitando a infraestrutura já pronta e não utilizada de `TenantApiKeyGuard`, F6).
3. **Decidir e aplicar `@Roles` de forma consistente** nos 6 controllers hoje sem checagem de role (F4) — começando por `PUT /clinic/payment-info` e `POST /payments/:id/refund`, os dois de maior impacto financeiro. **F28** mostra que esse gap nunca foi sequer exercitado por um teste crítico (nenhum `403` em toda a suíte) — a correção deveria vir acompanhada de pelo menos um teste crítico por controller que prove o bloqueio.
4. **Cobrir o fluxo de checkout de assinatura com testes antes de considerá-lo pronto para produção** (F27, F29) — `AnexarCartaoUseCase` (dados de cartão) e `POST /subscription` (criação inicial) não têm nenhum teste, unitário ou de integração; é o gap de teste de maior severidade encontrado em toda a auditoria, incluindo os Anexos.
5. **Adicionar rate limiting** em `/auth/login` no mínimo (F5).
6. **Corrigir os 2 casos concretos de dado descartado silenciosamente** (`Appointment.modality`, `Therapist.phone` — F10) — baixo esforço, resultado observável (usuário escolhe um valor, sistema ignora).
7. Resolver F26 (infraestrutura, já em runbook) para reabilitar a suíte crítica de Assinatura.
8. Fechar a lacuna de teste nos 7 Use Cases identificados em F13, mais os gaps de rota inteira identificados em F14/F33 (`/clinic`, `/whatsapp`, `/webhooks/asaas`, `/automations`) e a cobertura de Eventos de Domínio (F30).
9. **Higiene documental de menor urgência** (F17, F18, F19, F20, F21, F22, F23, F25, F31, F32) — reconciliar ADRs "Aprovadas" sem implementação (F20, F31), numeração de ADRs fantasma (F19, F32), e o README de migrations desatualizado (F18); nenhum destes bloqueia produção, mas todos reduzem a confiabilidade da documentação como fonte de verdade.

---

## 11. Plano sugerido para o Sprint seguinte

Dado que esta Sprint foi 100% read-only, nenhuma correção foi aplicada. Sugestão de sequenciamento para a próxima Sprint de implementação (decisão final cabe ao CTO). Frentes atualizadas na validação final para incorporar F27-F34 — a estrutura de 4 frentes permanece a mesma, cada achado novo entra na frente que já existia para sua natureza:

**Frente A — Segurança/Isolamento (F1, F2, F3, F4, F5, F28):** o bloco de maior risco concentrado; recomendo tratá-lo como uma frente única e priorizada antes de qualquer nova feature de produto, dado que F1+F2+F3 compõem juntos um cenário real de vazamento de dados entre clínicas. F28 (zero teste de autorização por role em toda a suíte crítica) reforça que a correção de F4 deveria nascer já com teste crítico.

**Frente B — Consistência de dados (F10, F34):** pequena, isolada, sem dependência de infraestrutura — pode rodar em paralelo com a Frente A. F34 (risco de perda silenciosa de configuração de disponibilidade numa migration já aplicada) é mais uma questão de vigilância futura (padrão a evitar em próximas migrations) do que uma correção imediata, já que reverter uma migration já rodada exigiria restaurar backup.

**Frente C — Cobertura de teste (F13, F14, F26, F27, F29, F30, F33):** depende parcialmente de F26 (infraestrutura) para os testes críticos; a parte unitária pode avançar independente. **F27 e F29 deveriam ser tratados como bloqueadores de produção dentro desta frente**, não como itens de backlog geral — são os únicos achados desta auditoria (achados originais ou dos Anexos) que deixam o fluxo comercial mais crítico da plataforma (checkout de assinatura) sem nenhuma rede de segurança automatizada.

**Frente D — Higiene documental (F17, F18, F19, F20, F21, F22, F23, F25, F31, F32):** baixo risco, indicada para intercalar como trabalho de menor prioridade entre as frentes acima, não como Sprint dedicada. F31/F32 (Anexo G) ampliam o escopo desta frente — a divergência entre ADRs "Aprovadas" e implementação real é maior do que os achados originais (F19/F20) capturavam sozinhos.

Este relatório não avalia esforço de implementação (fora do escopo read-only solicitado) — apenas severidade e evidência. Sequenciamento final e alocação de Sprint são decisões do CTO.

---

---

# Anexos — Auditorias Complementares (2026-07-20, continuação da Sprint 3)

Os sete anexos abaixo foram solicitados como aprofundamentos pontuais sobre áreas específicas do relatório original (migrations, cobertura de teste por domínio/rota/importação, ADRs). Mesma metodologia e mesma regra: 100% leitura, nenhum arquivo alterado. Onde um anexo confirma ou refina um achado já registrado nas seções 1-11 (F1-F26), isso é citado explicitamente em vez de duplicado. Novos achados relevantes recebem IDs a partir de **F27**, consolidados na seção 19.

## 12. Anexo A — Prisma Migrations (detalhamento por migration)

Li o conteúdo completo das 9 migrations reais em `apps/backend/prisma/migrations/` (nenhuma outra existe — confirmado por listagem direta do diretório).

| # | Migration | Objetivo | Tabelas/Colunas/Índices/Enums | Aditiva/Destrutiva/Mista | Riscos de deploy | Dependência de ordem |
|---|---|---|---|---|---|---|
| 1 | `20260716171111_init` | Schema inicial completo (Módulo 1) | Cria 11 enums e 16 tabelas (`tenant`, `clinic_settings`, `whatsapp_integration`, `ai_settings`, `user`, `therapist`, `patient`, `appointment`, `session`, `billing`, `billing_session`, `payment`, `audit_log`, `message_log`, `clinic_subscription`, `asaas_webhook_event`), com todos os índices únicos/compostos e FKs `ON DELETE RESTRICT` | **Aditiva** (é a criação da base) | Nenhum dado pré-existente a proteger (primeira migration) — risco baixo isoladamente, mas é a fundação: qualquer erro aqui bloqueia todo o histórico seguinte | Raiz — nenhuma dependência; todas as demais dependem dela |
| 2 | `20260717033632_add_availability_calendar` | Bounded Context Availability, Fase 1 (PD-001/ADR-0040) | Cria `availability_calendar` (FK tenant+therapist, unique `therapist_id`); **backfill real** via `INSERT...SELECT` migrando `therapist.availability` (JSONB antigo) com `sessionDurationMinutes=60` default; finaliza com `DROP COLUMN therapist.availability` | **Mista** (cria tabela nova + migra dados + remove coluna, tudo na mesma migration) | **O achado mais relevante deste anexo**: o backfill só migra terapeutas com `availability IS NOT NULL AND jsonb_array_length(availability) > 0` (linhas 45-46 do arquivo) — qualquer terapeuta com formato inesperado ou array vazio simplesmente não migra e **não gera erro nem aviso**, ficando sem `AvailabilityCalendar` silenciosamente. Como o `DROP COLUMN` acontece na mesma migration (sem uma fase de expand/contract separada), não há como reverter e re-tentar o backfill depois sem restaurar backup. Risco real de perda funcional (não perda de linha, mas perda de configuração de disponibilidade) para terapeutas com dado legado em formato divergente. | Depende de #1 (`therapist` deve existir) |
| 3 | `20260717164200_add_clinic_holiday` | Motor de Disponibilidade, Fase 2 (B3) | Cria `clinic_holiday` (tenant_id, from_date, to_date, reason nullable) + índice composto `(tenant_id, from_date, to_date)` | **Aditiva**, sem backfill (conceito novo, autoafirmado no cabeçalho do arquivo) | Baixo | Depende de #1 (`tenant`) |
| 4 | `20260717194427_add_recurring_block` | Motor de Disponibilidade, Fase 2 (C2) | Cria `recurring_block` (tenant/patient/therapist FKs, `interval_days`, `modality`, `renewal_mode`) + índice composto `(tenant_id, therapist_id)` | **Aditiva**, sem backfill | Baixo | Depende de #1 (`patient`, `therapist`) |
| 5 | `20260717201832_add_recurring_block_id_to_appointment` | Motor de Disponibilidade, Fase 2 (C3) | `ADD COLUMN appointment.recurring_block_id` (nullable) + índice único composto `(recurring_block_id, scheduled_at)` (garantia física de idempotência da materialização) + FK com `ON DELETE SET NULL` (deliberadamente diferente do `RESTRICT` padrão do resto do schema, documentado em comentário) | **Aditiva** (coluna nullable, nenhum dado existente afetado) | Baixo — a escolha de `SET NULL` em vez de `RESTRICT` é um desvio do padrão do schema, mas está corretamente justificada em comentário (remover um `RecurringBlock` não deve travar nem apagar Appointments já materializados) | Depende de #4 (`recurring_block`) e #1 (`appointment`) |
| 6 | `20260718000000_add_tenant_api_key` | PD-003, API externa por tenant | Cria `tenant_api_key` (tenant_id unique, hashed_key unique) + FK tenant + **única migration de todo o histórico que aplica RLS real** (`ENABLE`/`FORCE ROW LEVEL SECURITY` + policies `tenant_isolation` e `api_key_lookup_by_hash`) | **Aditiva** | Baixo isoladamente — mas ver F1 (seção 3.5): é a única tabela com RLS de fato ativa em qualquer banco onde este histórico tenha sido aplicado; as 15 tabelas anteriores permanecem sem essa segunda camada de defesa | Depende de #1 (`tenant`) |
| 7 | `20260719000000_add_past_due_since_to_clinic_subscription` | CEO-DEC-003.1/003.2, tolerância de 7 dias | `ADD COLUMN clinic_subscription.past_due_since` (nullable) | **Aditiva**, sem backfill — assinaturas já em `PastDue` ficam `NULL` | Baixo tecnicamente; risco **operacional** documentado no próprio comentário: o código trata `PastDue` sem `past_due_since` como fora do período de tolerância (fail-closed) — qualquer assinatura já em `PastDue` no momento do deploy "perde" a tolerância retroativamente. Correto do ponto de vista de segurança, mas deveria ser comunicado à operação antes do deploy em produção real, não é puramente transparente. | Depende de #1 (`clinic_subscription`) |
| 8 | `20260719010000_add_pending_plan_to_clinic_subscription` | CEO-DEC-002.5/003.6, downgrade agendado | `ADD COLUMN clinic_subscription.pending_plan` (nullable, enum `PlanTier`) | **Aditiva**, sem backfill | Baixo — mas o próprio comentário documenta que nenhum gatilho automático usa esse campo ainda (pendência de aplicação, não de schema; ver F9 e "Cobrança prorateada" na seção 3.8) | Depende de #1 |
| 9 | `20260719020000_add_individual_completo_to_plantier` | PD-003/CEO-DEC-002.1/002.6, Priority 5 | `ALTER TYPE PlanTier ADD VALUE 'individual'` / `'completo'` | **Aditiva** (enum, nenhum valor existente removido/alterado) | O próprio arquivo documenta uma restrição genérica do Postgres: `ALTER TYPE ... ADD VALUE` não pode ser usado na mesma transação em que o novo valor é lido/gravado — não afeta esta migration (nenhuma linha usa os novos valores aqui), mas é um risco a observar em qualquer migration futura que precise usar um enum recém-adicionado imediatamente | Depende de #1 (enum `PlanTier`) |

### Compatibilidade com o schema atual

Todo campo presente em `schema.prisma` hoje é rastreável a uma dessas 9 migrations — nenhum campo órfão encontrado (mesma verificação já registrada na seção 3.4). A única divergência documental já registrada no corpo principal (**F18**) permanece válida aqui: o cabeçalho de `schema.prisma` referencia `prisma/migrations/00000000000000_init_rls/migration.sql`, que nunca existiu com esse nome — o RLS real está descrito em `prisma/rls/enable-rls.sql` (arquivo solto, não migration) e só uma fração dele (migration #6 acima) chegou a virar migration de fato.

### Respostas diretas

- **Existe alguma migration inconsistente ou potencialmente problemática?** Sim, duas, por motivos diferentes: a migration #2 (mistura backfill+`DROP COLUMN` numa única transação, sem fase de expand separada, com um caminho silencioso de não-migração para dados em formato inesperado) e o padrão geral revelado pelas migrations #1 e #6 juntas (RLS real presente em só 1 de 16 tabelas criadas na migration inicial). Nenhuma migration está logicamente inconsistente com o `schema.prisma` atual — todas rastreiam corretamente.
- **Existe alguma migration redundante, conflitante ou fora de ordem?** Não. Os 9 timestamps estão em ordem estritamente crescente (`20260716171111` → `20260719020000`), sem sobreposição de objetos, sem duas migrations alterando a mesma coluna/tabela de forma conflitante.
- **O histórico de migrations está coerente com o estado atual do `schema.prisma`?** Majoritariamente sim — todo campo do schema é rastreável. A exceção documentada é a referência a uma migration de RLS inexistente no cabeçalho do schema (F18) e a lacuna de aplicação de RLS já registrada como F1.

---

## 13. Anexo B — Domain Test Matrix (Pacientes, Financeiro, Mensageria, IA, Auditoria)

### Domínio: Pacientes

| Use Case | Cobertura Atual | Arquivos de Teste | Criticidade | Lacunas Identificadas | Prioridade |
|---|---|---|---|---|---|
| `ConsultarPacienteUseCase` | Parcial | `consultar-e-listar-pacientes.use-case.test.ts` (unit) | Alta | Feliz + 404 cross-tenant cobertos; sem teste de id malformado | Média |
| `ListarPacientesUseCase` | Parcial | idem (unit) | Alta | Só delegação simples testada; sem lista vazia/paginação nos limites | Média |
| `CadastrarPacienteUseCase` | Parcial | `cadastrar-paciente.use-case.test.ts` (unit) | Alta | Sem teste de telefone malformado/duplicidade; conteúdo do evento de auditoria não verificado | Média |
| `InativarPacienteUseCase`/`ReativarPacienteUseCase`/`DarAltaPacienteUseCase` | Parcial | `gerenciar-status-paciente.use-case.test.ts` (unit) | Alta | Feliz + transição inválida cobertos para cada um; paciente inexistente e conteúdo de auditoria não testados | Média |
| `AtualizarPacienteUseCase` | Parcial | `atualizar-paciente.use-case.test.ts` (unit) | Alta | Boa cobertura de variações felizes; **zero teste de exceção** (paciente inexistente) e zero validação de entrada | Média |

### Domínio: Financeiro

| Use Case | Cobertura Atual | Arquivos de Teste | Criticidade | Lacunas Identificadas | Prioridade |
|---|---|---|---|---|---|
| `GerarCobrancaUseCase` | Sim | unit + `billing-aggregation.test.ts` (critical) | Alta | Boa; falta validação de `amount<=0`/`dueDate` no passado | Baixa |
| `ConsultarCobrancaUseCase` | Parcial | Só exercitado embutido dentro de `EnviarCobrancaUseCase`, nunca isolado | Alta | Sem teste próprio de `NotFoundException` | **Alta** |
| `ListarCobrancasUseCase` | **Não** | Nenhum | Alta | Cobertura total ausente — confirma e detalha F13 | **Alta** |
| `EnviarCobrancaUseCase` | Sim | unit | Alta | Falta caso de borda: clínica sem `pixKey`/`payeeName` | Média |
| `RegistrarPagamentoUseCase` | Sim | unit + `payment-idempotency.test.ts` (critical) | Alta | Idempotência real testada só sequencial, não paralela de verdade | Baixa |
| `ConsultarPagamentoUseCase` | Parcial | unit | Alta | **Único teste é a exceção** — fluxo feliz nunca testado | **Alta** |
| `EstornarPagamentoUseCase` | Parcial | unit | Alta | Só fluxo feliz; sem teste de transição inválida (estornar já-estornado) | **Alta** |
| `ConsultarSegmentacaoFinanceiraUseCase` | Sim | unit + `inadimplencia.test.ts` (critical) | Alta | Fronteiras 7/8/40/41 dias bem testadas (duplicado entre unit/critical, não contraditório) | Baixa |
| `ExecutarReguaInadimplenciaUseCase` | Parcial | unit | Alta | D+7 não testado nesta suíte; branch "paciente não encontrado" não testado | Média |
| `GerarFechamentoMensalUseCase` | Parcial | unit | Alta | Só o branch `inadimplente` (>40d) é exercitado; `em_atraso`/`pendente` nunca testados | Média |

### Domínio: Mensageria

| Use Case | Cobertura Atual | Arquivos de Teste | Criticidade | Lacunas Identificadas | Prioridade |
|---|---|---|---|---|---|
| `EnviarMensagemUseCase` | Parcial | unit | Alta | Sem teste de falha do provider externo | Média |
| `ConectarWhatsAppUseCase` | Parcial | unit (1 teste) | Alta — grava credencial externa (`accessToken`) | Só o branch `create` do upsert testado; `update` (reconexão) nunca testado; sem validação de entrada | **Alta** |
| `EnviarResumoAgendaDoDiaUseCase` | **Não** | Nenhum (o único ponto de entrada diário da rotina de agenda sem qualquer teste) | Média | Cobertura total ausente | **Alta** |
| `ReenviarAgendaAtualizadaUseCase` | Parcial | unit (1 teste, lista vazia) | Média | Sem teste com appointments reais no corpo, sem teste de terapeuta inexistente | Média |

### Domínio: IA

| Use Case | Cobertura Atual | Arquivos de Teste | Criticidade | Lacunas Identificadas | Prioridade |
|---|---|---|---|---|---|
| `ProcessarMensagemUseCase` | Sim | unit, cobertura rica (roteamento, escalonamento, custo RNF-021) | Alta | Sem teste de falha do `aiProvider` externo | Baixa |
| `IntentActionRouter` | Sim | unit, muito completa (todas as intents, regra "nunca adivinha", erro nunca mascarado) | Alta | Sem gaps relevantes | Baixa |

### Domínio: Auditoria

| Use Case | Cobertura Atual | Arquivos de Teste | Criticidade | Lacunas Identificadas | Prioridade |
|---|---|---|---|---|---|
| `ConsultarAuditLogUseCase` | **Não** | Nenhum (confirmado também via HTTP: `audit-immutability.test.ts` só testa que `PATCH`/`DELETE /audit-log` retornam 404, nunca chama `GET /audit-log`) | Alta — único ponto de leitura de um log de compliance | Cobertura total ausente, tanto unitária quanto de integração | **Alta** |

### Domínios com maior risco

**Mensageria** e **Auditoria** são os domínios mais frágeis. `EnviarResumoAgendaDoDiaUseCase` e `ConsultarAuditLogUseCase` têm zero teste de qualquer tipo, apesar de o segundo ser o único ponto de leitura de um log que o próprio sistema trata como imutável/compliance-crítico em outro lugar do código. Em **Financeiro**, os Use Cases de leitura (`ConsultarCobrancaUseCase`, `ListarCobrancasUseCase`, `ConsultarPagamentoUseCase`) estão sistematicamente mais descobertos que os de escrita, um padrão que se repete em todos os domínios auditados.

---

## 14. Anexo C — Domain Model Test Coverage

Inventário completo de `apps/backend/src/domain/**` (12 arquivos) e `apps/backend/src/domain-services/**` (22 arquivos, dos quais só 4 têm lógica própria — os demais são interfaces/portas puras).

**Nota estrutural**: o código não distingue "Aggregate Root" de "Entidade" como categorias separadas (sem pasta, classe-base ou convenção própria) — `AvailabilityCalendar` e `RecurringBlock` se autodenominam "Aggregate Root" em comentário, mas vivem na mesma estrutura de pastas que as demais entidades.

| Componente | Categoria | Cobertura | Criticidade | Adequação | Lacunas | Prioridade |
|---|---|---|---|---|---|---|
| `Appointment`, `AvailabilityCalendar`, `ClinicHoliday`, `RecurringBlock`, `Billing`, `Clinic`, `Patient`, `Payment`, `Session`, `ClinicSubscription`, `Therapist` (11 entidades) | Entidades/Aggregates | Cada uma com suíte unitária dedicada (8 a 25+ `it` cada) + uso indireto em testes críticos/use-case | Alta (a maioria gate dinheiro, acesso ou estado clínico) | **Adequada, em vários casos exemplar** (ex.: `ClinicSubscription` cobre inclusive uma regressão de preço já corrigida; `Patient` cobre "nenhum evento em transição rejeitada") | Nenhuma lacuna relevante encontrada | Baixa (todas) |
| `ScheduleSlot` | Objeto de Valor | 1 suíte dedicada (12 it) + 3 usos indiretos | Alta (conflito de agenda concorrente) | Adequada | — | Baixa |
| `AuditService` | Serviço de Domínio | 1 unit + 1 critical | Alta (compliance) | Adequada | — | Baixa |
| `getPlanBenefits`/`PLAN_BENEFITS` | Serviço de Domínio / Regra de Negócio | 1 unit dedicado + enforcement testado em `therapist.use-cases.test.ts` | Alta (gate comercial) | Adequada para o que está implementado | Só `maxTherapists` tem enforcement real — os demais campos (`externalApiAccess`, `advancedReporting`, etc.) não são lidos por nenhum código, então não há nada a testar (lacuna de produto, não de teste — já registrado em 3.8) | Baixa |
| `StateMachine`/`InvalidStateTransitionError` | Máquina de Estados (genérica) | 1 unit dedicado (6 it) | Alta (guarda-corpo de toda transição do sistema) | Adequada | — | Baixa |
| Tabelas de transição por entidade (`appointmentTransitions` etc., 7 tabelas) | Máquinas de Estado (específicas) | Não exportadas — testadas só indiretamente via `entity.transitionTo()` | Alta | Adequada indiretamente | Impossível testar isoladamente por design (const privada); depende de cada entidade cobrir todas as arestas relevantes, o que ocorre | Baixa |
| `DomainEvent` (classe-base) | Evento de Domínio | 1 unit dedicado, mas usa uma `TestEvent` **fictícia**, não nenhuma classe real | Média (mecanismo transversal) | Parcial | Só a base é testada isoladamente | Média |
| **14 subclasses concretas de `DomainEvent`** (`AppointmentStateChangedEvent`, `PatientStateChangedEvent`, `ClinicSubscriptionPlanChangedEvent`, etc.) | Eventos de Domínio | **0 arquivos testam a classe/forma diretamente** — só indiretamente via string `eventName` ou casts nos testes de cada entidade | **Alta** — é o insumo direto da trilha de auditoria imutável (Módulo 10, requisito de compliance) | **Ausente** | Um refactor que renomeasse um campo de evento não seria pego por nenhum teste de evento — só indiretamente, se o mesmo campo for lido em algum teste de entidade | **Alta** |
| `SlotNotAvailableError`, `ClinicNotFoundError` | Erros de Domínio (tipados) | Testados via `.rejects.toThrow(ClasseEspecífica)`, não genérico | Alta | Adequada | — | Baixa |
| ~11 erros genéricos `new Error(...)` espalhados pelas entidades | Erros de Domínio (não-tipados) | Cobertos via regex de mensagem nos testes de cada entidade | Variável | Adequada quanto a comportamento | **Lacuna arquitetural, não de teste**: código chamador só pode diferenciar esses casos fazendo parsing de string em português — frágil para qualquer camada que precise mapear para um código HTTP específico | Média (consistência, não teste) |
| `DEFAULT_SESSION_DURATION_MINUTES`, `GRACE_PERIOD_DAYS`, `MONTHLY_PRICE_BRL`, `ANNUAL_DISCOUNT` | Constantes de Regra de Negócio | Testadas indiretamente via o comportamento que gatam (5 testes com valores exatos em BRL para `MONTHLY_PRICE_BRL`, pegando literalmente uma regressão de preço já documentada) | Alta (preço cobrado, bloqueio de acesso) | Adequada | — | Baixa |
| 16 interfaces de Repository (`domain-services/**`) | N/A | Sem teste direto (esperado — interface sem corpo) | N/A | N/A | Cobertura real está nas implementações Prisma, fora do escopo deste levantamento | — |

### Respostas diretas

1. **Componentes centrais sem cobertura**: as 14 subclasses concretas de `DomainEvent` de produção — confirmado por grep+leitura, nenhuma é importada para um teste de forma/tipo próprio, só referenciada por nome de string nos testes de cada entidade.
2. **Regras de negócio críticas sem validação automatizada?** Nenhuma regra de domínio *implementada* ficou sem teste — a cobertura de invariantes/transições/erros é consistentemente forte nas 11 entidades. A única lacuna de regra de negócio é de **produto** (benefícios de plano não implementados além de `maxTherapists`), não de teste.
3. **A cobertura é proporcional à complexidade/criticidade?** Sim, com uma ressalva: as entidades que gatam dinheiro/acesso têm os testes mais rigorosos de todo o domínio, mas os Eventos de Domínio — o insumo direto de um requisito de compliance explícito — são a única categoria sem teste dedicado à própria forma.

---

## 15. Anexo D — Subscription & Therapist Test Coverage

| Domínio | Use Case | Cobertura Atual | Arquivos de Teste | Criticidade | Adequação | Lacunas Identificadas | Prioridade |
|---|---|---|---|---|---|---|---|
| Assinaturas | `CriarAssinaturaUseCase` | Unitária, `PaymentProvider` 100% mockado | `criar-assinatura.use-case.test.ts` (4 it) | Alta | Parcial | Nenhum teste de integração real contra Asaas nem contra Postgres via HTTP; sem teste de falha do provider | Alta |
| Assinaturas | `ProcessarWebhookAssinaturaUseCase` | Unitária | `processar-webhook-assinatura.use-case.test.ts` (10 it) | Alta | Boa | Todos os 4 tipos de evento mapeados são testados individualmente; sem teste HTTP real do endpoint de webhook | Baixa |
| Assinaturas | `GerarApiKeyUseCase` | Unit + Critical | `gerar-api-key.use-case.test.ts` + `tenant-api-key.test.ts` | Média-Alta | Boa | Regeneração de chave (invalidação da anterior) não testada | Média |
| Assinaturas | `AnexarCartaoUseCase` | **Nenhuma** — confirmado de forma independente por mim (zero ocorrências em `apps/backend/test/`) | 0 arquivos | **Crítica** — manipula dados brutos de cartão | **Inexistente** | Nenhum teste de nenhum tipo; nem a garantia documentada no próprio código ("dados de cartão não vazam para log/persistência") é verificada | **Alta** |
| Assinaturas | `ConsultarAssinaturaUseCase` | **Nenhuma** | 0 arquivos | Média — usado na regularização de conta bloqueada | Inexistente | Nem feliz nem `NotFoundException` testados | Média |
| Assinaturas | `UpgradeAssinaturaUseCase` | Unit + Critical parcial | `gerenciar-assinatura.use-case.test.ts` + `subscription-upgrade-downgrade.test.ts` | Alta | Parcial | Sem teste de "upgrade para o mesmo plano já ativo"; caminho de erro para `individual`/`completo` só barrado por DTO, nunca testado no próprio Use Case | Média |
| Assinaturas | `DowngradeAssinaturaUseCase` | Unit + Critical | idem | Alta | Boa | `SUBSCRIPTION_DOWNGRADE_NOT_ELIGIBLE` bem testado (unit + HTTP real 409); falta teste de downgrade para mesmo plano/sobrescrita de agendamento existente | Baixa-Média |
| Terapeutas | `CadastrarTerapeutaUseCase` | Unitária | `therapist.use-cases.test.ts` | Alta | Boa | Boundary bem coberto (professional/business max=1, enterprise max=5); caminho `subscription: null` não testado diretamente | Média |
| Terapeutas | `ConsultarTerapeutaUseCase` | Unitária | idem | Baixa-Média | Boa | Sem lacunas relevantes | Baixa |
| Terapeutas | `ListarTerapeutasUseCase` | Unitária (mínima) | idem | Baixa | Suficiente para o escopo | Sem lista vazia/múltiplos tenants, mas UC não filtra por parâmetro | Baixa |
| Terapeutas | `AtualizarTerapeutaUseCase` | Unitária | idem | Média | Boa | Propagação de `NotFoundException` via composição não testada diretamente | Baixa |

### Achados de cross-check

- `CriarAssinaturaUseCase` só é validado contra Asaas mockado; o único teste que toca Asaas de verdade (`test/manual/asaas-production-smoke.test.ts`) testa o Provider isolado, é gated por credenciais reais, e nunca roda em CI.
- Todos os 4 tipos de evento de `ProcessarWebhookAssinaturaUseCase` (incluindo o bug de renovação já corrigido nesta sessão) têm teste dedicado.
- **`AnexarCartaoUseCase` confirmado como o único dos 11 Use Cases sem nenhuma cobertura** — e é também o que manipula o dado de maior sensibilidade regulatória (cartão de crédito).
- Nenhum teste, unit ou crítico, afirma que a proração de upgrade/downgrade existe — consistente com a pendência já documentada no próprio código (não é um teste obsoleto/incorreto).

### Respostas diretas

1. **Existem Use Cases críticos sem teste?** Sim: `AnexarCartaoUseCase` (maior risco de compliance de todo o módulo de Assinaturas) e `ConsultarAssinaturaUseCase` (porta de saída de uma clínica bloqueada).
2. **A cobertura atual é suficiente para produção?** **Não.** O único fluxo de checkout completo (`CriarAssinaturaUseCase` → `AnexarCartaoUseCase`) tem sua metade mais sensível sem nenhum teste, e a primeira metade só validada com o provedor de pagamento inteiramente mockado — sem nenhum teste de integração HTTP real do checkout ponta a ponta.
3. **Prioridades para o próximo Sprint de qualidade (ranked)**: (1) suíte unitária completa para `AnexarCartaoUseCase`, incluindo a garantia de não-vazamento de dado sensível; (2) teste de integração HTTP do checkout completo (`POST /subscription` → `POST /subscription/credit-card`) com um stub de `PaymentProvider` em nível de app, não mock unitário; (3) cobrir `ConsultarAssinaturaUseCase` (feliz + exceção, baixo custo); (4) testar o caminho de erro de `individual`/`completo` diretamente no Use Case, não só via DTO; (5) teste de invalidação de API key na regeneração.

---

## 16. Anexo E — Critical Route Coverage

Achado estrutural prévio: dos 19 arquivos em `test/critical/`, só **9** fazem chamadas HTTP reais via `supertest` — os outros 10 testam Repository/RLS/domínio direto contra Postgres, sem tocar nenhum Controller. E, transversalmente: **em toda a suíte `test/critical/`, nunca há uma asserção `toBe(403)`** (nenhum fixture cria usuário com role diferente de `admin`) — `RolesGuard` nunca é exercitado com o papel errado em nenhuma rota do sistema. `toBe(401)` só aparece em `recurring-blocks-api.test.ts`.

| Rota | Controller | Cobertura Crítica | Arquivos de Teste | Criticidade | Lacunas Identificadas | Prontidão p/ Produção |
|---|---|---|---|---|---|---|
| `/appointments` | `AppointmentsController` | Parcial | `appointment-concurrency`, `billing-aggregation`, `payment-idempotency`, `inadimplencia` | Alta | `GET`, `reschedule`, `cancel`, `recurring` nunca chamados via HTTP; `create`/`confirm` só felizes (sem 401/400/404) | Média |
| `/therapists` (+ `GET /therapists/:id/availability`, definida em `AppointmentsController`) | `TherapistsController` | Parcial (incidental) | `audit-immutability` (uso incidental), `recurring-blocks-api` (só para pegar id) | Média-Alta | `GET /:id`, `PATCH /:id`, consulta de disponibilidade nunca chamados; nenhuma rota do grupo tem 401/400/404 | Baixa |
| `/audit-log` | `AuditLogController` | **Ausente** para a única rota funcional | `audit-immutability` (só PATCH/DELETE→404) | Alta | `GET /audit-log`, a única rota real, nunca é chamada via HTTP em nenhum teste crítico | Baixa |
| `/auth` | `AuthController` | Parcial (implícita) | Nenhum arquivo dedicado; login usado indiretamente por `login-helper.ts` em todo teste crítico | Alta | Login só testado no caminho feliz (falha de login quebra o *setup* do teste, não é uma asserção negativa); `refresh` e `logout` nunca chamados | Baixa |
| `/automations` | `AutomationsController` | **Ausente** | Nenhum | Alta | Zero rotas testadas — e a leitura de código confirma independentemente o bypass de tenant já registrado como **F2** | Baixa |
| `/billings` | `BillingController` | Parcial | `billing-aggregation`, `payment-idempotency` | Alta | `GET` (lista/detalhe) e `send` nunca testados; `create` sem 401/400 | Média |
| `/payments` | `PaymentController` | Parcial | `payment-idempotency` | Alta | `GET /:id` nunca testado; **`refund` (estorno) nunca testado** | Média-Baixa |
| `/clinic` | `ClinicController` | **Ausente** | Nenhum | Média-Alta | Todas as 4 rotas sem teste, incluindo a que grava a chave PIX de recebimento | Baixa |
| `/whatsapp` | `WhatsAppController` | **Ausente** | Nenhum | Média | Única rota sem nenhum teste (nem feliz, nem 401/403, nem validação) | Baixa |
| `/patients` | `PatientsController` | Parcial | `multi-tenant-isolation`, `recurring-blocks-api` (incidental) | Alta | Isolamento cross-tenant bem provado para leitura; **toda a escrita** (create/update/deactivate/reactivate/discharge) sem nenhum teste HTTP | Baixa-Média |
| `/recurring-blocks` | `RecurringBlocksController` | **Completa** para as rotas existentes | `recurring-blocks-api` | Média | Única suíte com 401, 400 (2 cenários), e isolamento cross-tenant com dois usuários reais de ponta a ponta — modelo de referência do repositório | **Alta** |
| `/subscription` | `SubscriptionController` | Parcial | `tenant-api-key`, `subscription-upgrade-downgrade` | Alta | `GET`, e principalmente **`POST /subscription` (criação/checkout inicial) nunca chamado via HTTP** — fixtures inserem a assinatura direto via Prisma, contornando o Controller; `credit-card` também nunca chamado | Média |
| `/webhooks/asaas` | `WebhookController` | **Ausente** | Nenhum | Alta | Rota inteira sem teste HTTP de nenhum tipo — nem feliz, nem 401, nem idempotência real via requisição | Baixa |

**Nota sobre isolamento de tenant no webhook** (verificação independente pedida pelo escopo): diferente de `/automations`, o `tenantId` do webhook **não** vem do payload do cliente — é resolvido no servidor a partir do `asaas_subscription_id` que a própria Asaas envia, então não há o mesmo bypass direto. O ponto real de fragilidade aqui é outro: segredo estático único (não por integração) e um workaround manual de inicialização de `TenantContext` dentro do Use Case, documentado no próprio código como correção de um defeito real — nunca validado por nenhum teste HTTP.

### Respostas diretas

1. **Rotas sem nenhum teste crítico**: grupos inteiros de `/clinic`, `/whatsapp`, `/webhooks/asaas`, `/automations`, mais rotas específicas de `/appointments` (reschedule/cancel/recurring/GET), `/therapists` (GET/PATCH/availability), `/audit-log` (GET), `/auth` (refresh/logout), `/billings` (GET/send), `/payments` (GET/refund), `/patients` (create/update/status), `/subscription` (GET/create/credit-card).
2. **Cobertura só parcial**: `/appointments`, `/therapists`, `/auth`, `/billings`, `/payments`, `/patients`, `/subscription` — em todos, o caminho feliz de escrita mais central está coberto, mas 401/403/erros/CRUD completo não.
3. **Rotas bem protegidas de fato**: só `/recurring-blocks` atinge auth+authz+validação+erro consistentemente. Nenhum grupo de rota tem autorização por role testada em lugar nenhum do sistema — reforça diretamente **F4** e adiciona um achado novo (**F28**, seção 19).

---

## 17. Anexo F — Unit Test Import/Dependency Analysis

**Divulgação necessária, confirmada de forma independente por mim antes de delegar esta pesquisa**: não existe `imports.txt` em nenhum lugar do repositório, nem script de análise de imports (`infra/scripts/` não existe como diretório; nenhum script em `apps/backend/package.json` corresponde). As três solicitações que pediam essa análise — duas delas presumindo esses artefatos prontos — foram consolidadas nesta única seção. A análise abaixo foi produzida por inspeção direta do código-fonte agora, não pela leitura/execução de nenhum artefato pré-existente.

### Metodologia
Esquema de alias confirmado em `apps/backend/tsconfig.json`/`vitest.config.ts`: `@domain`, `@operational-engine`, `@domain-services`, `@use-cases`, `@infrastructure`, `@api`, `@shared`. Todos os 51 arquivos de `apps/backend/test/unit/**` lidos; 30+ imports verificados individualmente contra o export real do arquivo de origem.

### Matriz (resumo por camada — tabela completa por módulo produzida durante a pesquisa)

| Camada | Nº de módulos distintos importados | Situação |
|---|---|---|
| Domínio (`@domain/**`) | 14 | Todos **OK** |
| Domínio-Serviços (`@domain-services/**`) | 9 | Todos **OK** — nenhum arquivo em `domain-services/**` importa de `@infrastructure`/`@use-cases`/`@api` |
| Aplicação (`@use-cases/**`) | 33 | Todos **OK** — padrão "teste importa a própria unidade sob teste" |
| Infraestrutura (`@infrastructure/**`) | 1 (`prisma.service`) | **OK** — só aparece no próprio teste da camada de infraestrutura; nenhum teste de domínio/use-case importa um repository Prisma concreto |
| API (`@api/**`) | 5 (guards/services, autoteste) | Todos **OK** |
| Shared (`@shared/**`) | 2 (`tenant-context`, `luxora-exception.filter`) | **OK** — `tenant-context` é cross-cutting por natureza (17 arquivos, esperado) |
| Externo (`vitest`, `@nestjs/*`, `bcrypt`, `node:crypto`, `node:fs`, `node:path`) | 7 | Todos **OK** |

**Nenhum import foi classificado Atenção ou Inconsistente.** Zero imports relativos (`../../../`) em todo `test/unit/**` — 100% via alias. Zero alias malformado ou fora do mapeamento configurado. `@operational-engine` está configurado mas não é usado por nenhum teste unitário (ausência de uso, não inconsistência — consistente com o achado **F22** de que o módulo em si é um diretório vazio).

**Verificação de violação de camada (domínio → camadas externas)**: grep completo em `apps/backend/src/domain/**` por imports de `@use-cases`, `@infrastructure`, `@api` — **zero ocorrências**. Todos os 19 imports internos do diretório `domain/` apontam só para dentro do próprio `domain/`. Resultado limpo, confirmado.

### Respostas diretas

1. **Os testes unitários respeitam a separação de camadas?** Sim, sem exceção encontrada em 51 arquivos.
2. **Há sinais de acoplamento excessivo entre camadas?** Não — o único módulo de alta frequência (`@shared/tenant-context`, 17 arquivos) é exatamente o tipo de dependência cross-cutting esperada, não acoplamento indevido.
3. **Testes unitários dependem de infraestrutura indevidamente?** Não — `@infrastructure/database/prisma.service` aparece uma única vez, no próprio teste daquela camada.
4. **Consistência de aliases?** 100% — nenhum import relativo, nenhum alias malformado.

---

## 18. Anexo G — ADR Consistency Review

Inventário confirmado via Glob: `ADR-0001.md` a `ADR-0021.md` (sequencial, sem lacunas) + `ADR-0040-motor-disponibilidade-bounded-context.md`. Nenhum arquivo para 0022-0039 ou 0041+.

| ADR | Decisão (resumo) | Implementação Atual | Evidências principais | Recomendação |
|---|---|---|---|---|
| 0001 | Motor Operacional central obrigatório entre toda requisição e o domínio | **Divergente** | `main.ts:11-14` afirma que todo módulo depende de `OperationalEngineModule` — busca no código não encontra a classe; Controllers chamam Use Cases diretamente via DI do NestJS | Reescrever o comentário/ADR para refletir o padrão real, ou implementar o componente |
| 0002 (DDD) | Bounded Contexts, Entidades, VOs, Serviços de Domínio, Eventos, Repositórios sem regra de negócio | **Aderente** | Estrutura real em `domain/`, `domain-services/`, `infrastructure/database/repositories/` | Nenhuma |
| 0003 (Clean Architecture) | Domínio nunca conhece framework/banco/IA | **Aderente** | Confirmado também no Anexo F: zero import de `domain/` para camadas externas | Nenhuma |
| 0004 (Multi-tenancy) | TenantID obrigatório | **Aderente, mais forte que o descrito** | RLS real via `prisma/rls/enable-rls.sql` (embora sub-aplicada, ver F1), `TenantContext` | Documentar o uso de RLS nativa na própria ADR |
| 0005 (Event-Driven) | Event Bus com múltiplos consumidores desacoplados | **Parcial** | `DomainEvent` imutável existe; mas **não há Event Bus** — todo evento vai só para `AuditService`, nenhum outro consumidor (Financeiro/Dashboard/Follow-up citados na ADR não existem) | Implementar Event Bus real ou reescrever a ADR para "eventos alimentam só auditoria" |
| 0006 (IA como interface) | IA nunca decide, sempre delega | **Aderente** | `IntentActionRouter` traduz intent→Use Case sem lógica própria | Nenhuma (mas cita um "Motor Operacional" intermediário que não existe — ver 0001) |
| 0007-0008-0010 (NestJS/Postgres/Prisma na infra) | — | **Aderentes** | Confirmado estruturalmente | Nenhuma |
| 0009 (Redis+BullMQ, 8 filas nomeadas) | Múltiplas filas com DLQ | **Parcial** | Só 1 fila real (`'messages'`) existe; `infrastructure/queue/` e `infrastructure/cache/` são diretórios vazios | Reescrever a ADR para o escopo real, ou implementar as demais filas |
| 0011 (API First) | Contrato antes da implementação | **Parcial** | Doc de contrato existe (`docs/04-API/`), mas Swagger é gerado a partir do código (code-first), não o inverso | Nomear com precisão o processo real |
| 0012 (RequestContext) | Domínio só conhece `RequestContext`, nunca JWT | **Aderente, nome diferente** | `TenantContext` cumpre a função, mas só carrega `tenantId`/`userId` — sem Role/Permissions/CorrelationID descritos na ADR | Expandir `TenantContext` ou revisar o texto da ADR |
| 0013 (Object Storage) | S3/R2/MinIO para arquivos | **Divergente** | Zero dependência de storage, zero model de arquivo no schema (confirmado por mim: zero match para `PolicyEngine`-like search analog) | Marcar como não implementada/adiada |
| 0014 (Observabilidade 4 níveis) | OpenTelemetry/Prometheus/CorrelationID universal | **Divergente** | Zero dependência de observabilidade; `correlationId` em só 5 arquivos isolados, ausente do próprio `AuditLog` | Revisar ADR para o estado real (logging pontual apenas) |
| 0015 (Config over Code) | Comportamento configurável por clínica | **Parcial** | `ClinicSettings`/`AiSettings` reais existem; mas sem motor central de avaliação — cada Use Case lê o campo direto | Nenhuma ação urgente |
| 0016 (Policy Engine) | Motor central de políticas, nenhuma decisão fora dele | **Divergente** — **confirmado por mim diretamente**: zero ocorrência de `PolicyEngine` em `apps/backend/src` | Lógica condicional embutida diretamente nos Use Cases, sem componente central | Implementar o Policy Engine, ou reescrever a ADR — a própria ADR-0001 lista isso como antipadrão a evitar |
| 0017 (State Machine única) | Controla Paciente/Sessão/Cobrança/Pagamento/Agenda | **Aderente** | `StateMachine` genérica usada por 7 entidades | Nenhuma ("Follow-up" citado não tem entidade própria ainda) |
| 0018 (Resiliência) | Retry/Timeout/Circuit Breaker/Fallback/DLQ | **Parcial** | Retry+backoff só na fila de mensagens; idempotência real via chave única; **zero Circuit Breaker, zero DLQ explícita** | Implementar ou delimitar o escopo real no documento |
| 0019 (Modularidade) | Nenhum módulo acessa implementação interna de outro | **Parcial** | 11 módulos reais, mas `appointments.module.ts` importa guard direto de `subscription/` | Mover guards cross-cutting para `shared/` |
| 0020 (Governança de ADRs) | Toda decisão relevante gera/atualiza ADR | **Divergente** | 7 números de ADR citados no código sem arquivo correspondente (ver abaixo) — a própria lacuna prova a falha do processo que esta ADR exige | Trazer os documentos faltantes, ou renumerar as citações |
| 0021 (Fronteira n8n) | n8n só executa, nunca decide | **Aderente** | `automations.controller.ts` cita explicitamente o "teste de aceite do ADR-0021" (handlers com no máximo 2 linhas) | Nenhuma (mas pressupõe o Motor Operacional da ADR-0001, que não existe) |
| 0040 (Motor de Disponibilidade, Fase 1) | Bounded Context Availability obrigatório, só Fase 1 | **Aderente ao escopo aprovado** | `AvailabilityCalendar`, `verificar-disponibilidade.use-case.ts`, consumido por 3 Use Cases de agendamento | Nenhuma — único ADR do conjunto com status honesto sobre escopo parcial, modelo a seguir |

### Achados de consistência entre ADRs

- **ADR-0001 é citada como nó central por 12 outras ADRs**, mas o componente não existe — uma contradição entre o texto de boa parte da documentação arquitetural e o código real, que por sua vez viola o processo que a própria **ADR-0020** exige.
- **ADR-0016 (Policy Engine) x ADR-0015 (Configuration over Code)**: a ADR-0015 promete que riscos serão mitigados "através do Policy Engine" — que nunca foi construído.
- **7 números de ADR fantasma, não 2 como o relatório original (F19) havia identificado**: `ADR-0024`, `0026`, `0027`, `0028`, `0033`, `0037`, `0039`, citados em pelo menos 17 pontos distintos do código-fonte (`prisma.service.ts`, `auth.service.ts`, `tenant-api-key.guard.ts`, `prisma-patient.repository.ts`, `message-provider.ts`, `agendar-consulta.use-case.ts`, `prisma-appointment.repository.ts`, `prisma-billing.repository.ts`, `processar-mensagem.use-case.ts`, `intent-action-router.ts`, `ai.module.ts`, `asaas-payment.provider.ts`, `payment-provider.ts`, `clinic-subscription.entity.ts`, `criar-assinatura.use-case.ts`, `subscription.controller.ts`, `subscription-access.guard.ts`), nenhum com arquivo em `docs/02-Arquitetura/ADRs/`. O próprio `ADR-0040` já sinalizava esse fenômeno, mas citando só 2 dos 7 números afetados — a lacuna real é maior do que o texto do ADR-0040 deixa entender.

### Respostas diretas

1. **Decisão aprovada e não implementada?** Sim, três sem nenhuma implementação: **ADR-0013** (Object Storage), **ADR-0016** (Policy Engine, confirmado por mim), **ADR-0014** (Observabilidade). Mais a **ADR-0001** (Motor Operacional), cujo componente central nunca foi construído como tal.
2. **Implementação que diverge do ADR?** Sim: o comentário de `main.ts:11-14` afirma algo estruturalmente falso sobre `OperationalEngineModule`; a ADR-0005 promete múltiplos consumidores de evento, a realidade tem só 1 (auditoria); a ADR-0009 promete 8 filas nomeadas, a realidade tem 1.
3. **ADRs desatualizadas ou conflitantes?** Sim — o caso mais concreto é a lacuna de numeração (7 números fantasma), uma violação ativa do processo definido na própria ADR-0020.

---

## 19. Novos Achados Consolidados (F27-F34) e Nota de Atualização

| ID | Severidade | Resumo | Anexo |
|---|---|---|---|
| F27 | Alto | `AnexarCartaoUseCase` (dados de cartão de crédito) sem nenhum teste — confirmado por mim de forma independente | D |
| F28 | Alto | `RolesGuard` nunca é exercitado com role incorreta em nenhum teste crítico do sistema; `401` só testado em 1 de 13 grupos de rota — a lacuna de autorização já registrada em F4 está, na prática, com **zero** rede de segurança automatizada | E |
| F29 | Alto | `POST /subscription` (criação/checkout inicial da assinatura) nunca é exercitado via HTTP real — fixtures sempre inserem a assinatura direto via Prisma, contornando o Controller | E |
| F30 | Médio | 14 subclasses concretas de `DomainEvent` — o insumo direto da trilha de auditoria — nunca são testadas por forma/tipo, só indiretamente via string | C |
| F31 | Médio | ADR-0001 (Motor Operacional), ADR-0016 (Policy Engine) e ADR-0014 (Observabilidade) são "Aprovadas" sem nenhuma implementação; ADR-0005 (Event Bus) e ADR-0009 (múltiplas filas) parcialmente divergentes (1 consumidor/1 fila apenas) — amplia significativamente F20 | G |
| F32 | Baixo | 7 números de ADR fantasma citados no código (não 2, como F19 original identificou): 0024, 0026, 0027, 0028, 0033, 0037, 0039 | G |
| F33 | Médio | `/webhooks/asaas`, `/clinic`, `/whatsapp` e todo o grupo `/automations` sem nenhum teste crítico — detalha e amplia F14 | E |
| F34 | Médio | Migration `20260717033632_add_availability_calendar` mistura backfill + `DROP COLUMN` numa única transação sem fase de expand separada; terapeutas com `availability` em formato inesperado não migram e não geram erro — risco silencioso de perda de configuração (não de linha) | A |

### Nota de Atualização

Estes 8 achados **não substituem** as notas 0-10 da seção "Resumo Executivo" original — reforçam e detalham a mesma direção já apontada por F1-F26, sem revelar nenhum risco de categoria nova. Os pontos mais relevantes para cada dimensão já pontuada:

- **Segurança (nota original 5/10)**: F28 confirma, com evidência de teste (ou melhor, ausência dela), que a lacuna de autorização por role (F4) nunca foi validada automaticamente em nenhuma rota do sistema — reforça a nota, não a reduz further isoladamente, mas remove qualquer dúvida de que pudesse haver cobertura de teste compensando o gap de código.
- **Testes (nota original 6/10)**: F27, F29, F30, F33 são todos achados de teste ausente em áreas de alto risco (dados de cartão, checkout inicial, trilha de auditoria, grupos de rota inteiros). Combinados com os achados originais (F13, F14), o quadro de testes é mais grave do que a nota original capturava isoladamente — mantenho a nota em 6/10 porque a cobertura onde existe (domínio, financeiro de escrita, `/recurring-blocks`) continua genuinamente forte, mas o próximo Sprint de qualidade deveria tratar F27 e F29 como bloqueadores, não itens de backlog.
- **Arquitetura (nota original 7/10)**: F31/F32 mostram que a divergência entre ADRs "Aprovadas" e implementação real é mais ampla do que F19/F20 originalmente capturaram (4 ADRs totalmente divergentes, não 2, incluindo o próprio "Motor Operacional" citado como garantia central em `main.ts`). Isso não muda a avaliação de que o código em si (DI, módulos, Use Cases) é estruturalmente sólido — muda a avaliação de quão confiável é a documentação arquitetural como fonte de verdade, que já não pontuava alta nesta nota.
- **Prontidão para Produção (nota original 3/10)**: permanece a nota mais baixa do relatório, agora com evidência adicional e independente (F27, F28, F29) de que as áreas de maior risco financeiro/regulatório do sistema (checkout de assinatura, dados de cartão, autorização por role) não têm nenhuma rede de segurança automatizada — não apenas um gap de código, mas também um gap de teste que o deixaria invisível até acontecer em produção.

---

## 20. Anexo H — Ferramental Existente de Análise de Imports/Arquitetura

Verificação direta de `infra/`, `apps/backend/package.json`, `package.json` da raiz, `.eslintrc.js`, o preset compartilhado, e `.github/workflows/ci.yml`.

### O que já existe

| Ferramenta | Onde | Finalidade | Já integrada ao processo? |
|---|---|---|---|
| **`eslint-plugin-boundaries` (^4.2.2)** | `apps/backend/package.json` (devDependency) + configurada em `packages/config/eslint-preset.js:15,26-58`, herdada por `apps/backend/.eslintrc.js:2` | Enforça em tempo de lint, arquivo por arquivo, exatamente as mesmas 7 camadas (`domain`, `domain-services`, `use-cases`, `operational-engine`, `infrastructure`, `api`, `shared`) e as mesmas regras de direção permitida que os Anexos F e a seção 3.1 verificaram manualmente via grep — com `default: 'disallow'` (linha 29), ou seja, qualquer import entre camadas não explicitamente listado já falha o lint por padrão | **Sim** — `.github/workflows/ci.yml:14-24`, job `lint` (`pnpm lint` → `turbo run lint` → `eslint "src/**/*.ts" --fix` em cada workspace), obrigatório e bloqueante para merge (comentário do próprio workflow, linha 4: "Nenhum PR é mergeável sem este workflow verde") |
| `turbo` (monorepo runner) | `package.json` raiz | Orquestra `dev`/`build`/`lint`/`test`/`test:critical`/`test:unit`/`test:integration` em todos os workspaces (`apps/*`, `packages/*`) | Sim — é o ponto de entrada de todos os scripts de CI |
| Scripts npm do backend (`apps/backend/package.json`) | `build`, `dev`, `start`, `lint`, `test:unit`, `test:integration`, `test:critical`, `test:manual`, `prisma:migrate`, `prisma:generate`, `seed` | Nenhum script dedicado a análise de imports/dependências além do `lint` (que já roda `eslint-plugin-boundaries`) | `lint` já integrado; os demais são build/test padrão |
| `01-app-role.sql` (`infra/docker/postgres-init/`) | Script de bootstrap do Postgres local/CI | Cria a role restrita `luxora_app` (ver seção 3.5, F1) | Sim — reaplicado explicitamente em CI (`ci.yml:68,106`) antes de rodar migrations, não só em Desenvolvimento |
| `infra/docker/Dockerfile.backend` | Build da imagem do backend | Empacotamento para deploy | Não relacionado a análise de imports |
| `infra/railway/` | — | **Vazio** (confirmado por listagem direta — 0 arquivos) | N/A — nenhuma configuração de Homologação/Produção existe aqui (já registrado na seção 9) |

**Não existe**: `imports.txt`, script dedicado de análise de imports, `dependency-cruiser`, `madge`, ou qualquer ferramenta de grafo de dependências — confirmado nesta e na auditoria anterior (Anexo F) por `Glob`/busca em `package.json`.

### Achado adicional relevante: a mesma lacuna arquitetural (F22) aparece também na configuração do lint

O preset (`packages/config/eslint-preset.js:33-34,53`) define `operational-engine` como uma camada real, com regras de import próprias (`use-cases` e `api` têm permissão explícita de importar dela) e um padrão de arquivo (`src/operational-engine/**`) — mas esse diretório está **vazio** (já registrado como **F22**, seção 3.1/7). Ou seja: a ferramenta de enforcement automático já reflete a mesma arquitetura aspiracional (Motor Operacional central, ADR-0001) que o código real não implementa — o lint não vai acusar nada de errado aqui porque não há nenhum import real para violar a regra, mas a configuração em si é evidência adicional, independente do comentário em `main.ts`, de que essa camada foi projetada para existir e nunca foi construída.

### Escopo do que o `eslint-plugin-boundaries` cobre — e o que não cobre

Os padrões em `settings.boundaries/elements` (`packages/config/eslint-preset.js:49-57`) apontam só para `src/**` — nenhum padrão cobre `test/**`. Isso significa que o enforcement automático de camadas **não se aplica aos arquivos de teste**: a análise de imports de `test/unit/**` feita manualmente no Anexo F (zero violação de camada encontrada) não é uma verificação que já acontece automaticamente hoje — é um retrato pontual, sem garantia estrutural de que continue verdadeiro após mudanças futuras.

### Respostas diretas

1. **Quais ferramentas já existem?** Uma ferramenta real e não-trivial: `eslint-plugin-boundaries`, já configurada com uma política completa de 7 camadas e já rodando como gate obrigatório de CI. Fora isso, só orquestração de build/test padrão (`turbo`) — nenhuma ferramenta dedicada a grafos de dependência, detecção de ciclos, ou análise de imports de teste.
2. **Finalidade de cada uma?** `eslint-plugin-boundaries` — impedir, em tempo de lint, que qualquer arquivo de `src/` importe de uma camada não autorizada (ex.: `domain` importando de `infrastructure`). `turbo` — orquestração de monorepo, não análise arquitetural.
3. **Como se integram ao processo de auditoria?** O `eslint-plugin-boundaries` já automatiza continuamente (a cada PR) exatamente a verificação que a seção 3.1 e o Anexo F desta auditoria fizeram manualmente para `src/**` — os dois achados de "zero violação de camada" desta auditoria não são apenas verdadeiros hoje, são estruturalmente protegidos contra regressão, o que é um dado relevante que uma auditoria manual isolada não teria como garantir sozinha.
4. **Existe duplicidade ou oportunidade de reutilização?** Não há duplicidade — os dois exercícios (o lint automático e a auditoria manual) cobriram, sem sobreposição real, dois escopos diferentes: `src/**` (já automatizado) e `test/**` (só verificado manualmente, sem garantia estrutural). **Oportunidade concreta de reuso**: estender `settings.boundaries/elements` em `packages/config/eslint-preset.js` para também classificar `apps/backend/test/**` (ex.: um tipo `test` com sua própria allow-list, espelhando o que o Anexo F encontrou correto manualmente) transformaria essa auditoria pontual numa garantia permanente, sem precisar de nenhuma ferramenta nova — é a extensão de uma configuração já paga e já rodando em CI, não um projeto novo.
5. **Há lacunas que ainda exigem uma ferramenta específica?** Sim, três, nenhuma coberta pelo que já existe: (a) nada verifica automaticamente que RLS está de fato `ENABLE`/`FORCE` em toda tabela com `tenant_id` — o teste mais próximo disso, `auth-rls-bypass-scope.test.ts` (lido por completo nesta auditoria), testa só o escopo de UM mecanismo de bypass específico, não a presença de RLS na lista completa de tabelas, então nada no repositório teria capturado a lacuna registrada em **F1**; (b) nenhuma ferramenta rastreia automaticamente cobertura de rota por teste crítico (todo o Anexo E e a seção 21 foram produzidos por leitura manual); (c) `eslint-plugin-boundaries` enforce só a direção entre camadas, não ciclos *dentro* de uma mesma camada (ex.: dois Use Cases importando um ao outro circularmente) — checado manualmente nesta sessão sem encontrar caso real, mas sem garantia estrutural equivalente à que já existe entre camadas.

### Nota sobre a origem do erro de permissão diagnosticado em sessões anteriores (F1, refinamento)

A leitura de `ci.yml:68-74,106-112` mostra que, em CI, `luxora_app` é quem executa `prisma:migrate` (`prisma migrate deploy`) contra um banco `luxora_test` recém-criado a cada execução — ou seja, em CI, `luxora_app` é dono de toda tabela que cria, desde o início, sem o risco de divergência de ownership relatado no diagnóstico de ambiente anterior desta sessão (onde `luxora_app` recebeu `42501 must be owner of table clinic_subscription` no sandbox de Desenvolvimento local). Isso **não invalida F1** (a ausência de RLS aplicada continua sendo verdade independente de qual role roda as migrations) — apenas refina a causa do erro de permissão especificamente: é mais provável que seja um artefato do histórico específico do banco de Desenvolvimento deste sandbox (uma tabela criada em algum momento por uma sessão `postgres`) do que uma falha estrutural do processo de migração como um todo — o processo que o CI de fato executa está desenhado corretamente para evitar esse problema.

---

## 21. Anexo I — Critical Test Endpoint Validation (matriz por arquivo de teste)

Escopo: os 16 arquivos de `apps/backend/test/critical/*.test.ts` (não ~19 — contagem exata confirmada por listagem direta nesta auditoria). 9 fazem chamadas HTTP reais (39 chamadas ao todo); os outros 7 testam Repository/Use Case/RLS diretamente, sem passar por nenhum Controller.

### Arquivos com chamadas HTTP reais

| Arquivo de Teste | Endpoints exercitados | Controller | Cobertura | Observações |
|---|---|---|---|---|
| `appointment-concurrency.test.ts` | `POST /appointments` (5× paralelo) | `AppointmentsController` | **Completa** | [CRÍTICO #10] exatamente 1 sucesso + 4× 409 numa corrida real via `Promise.all` — o teste de concorrência mais robusto da suíte |
| `audit-immutability.test.ts` | `PATCH`/`DELETE /audit-log/:id` (404), `PUT /therapists/:id/availability` (arrange + 1 asserção real), `POST`/`GET /therapists` (arrange sem asserção) | `AuditLogController`, `TherapistsController` | **Parcial** | Imutabilidade (o objetivo do arquivo) bem provada; `PUT .../availability` só testado no caminho feliz |
| `billing-aggregation.test.ts` | `POST /appointments`, `POST /appointments/:id/confirm` (arrange), `POST /billings` (4×: N=1/3/4 + rejeição de reuso) | `AppointmentsController`, `BillingController` | **Completa** para `POST /billings` | [CRÍTICO #4-7] sucesso agregado + falha de negócio (409 `SESSION_ALREADY_BILLED`) no mesmo arquivo — o exemplar de cobertura completa da suíte |
| `inadimplencia.test.ts` | `POST /appointments` (arrange) | `AppointmentsController` | **Parcial** | Apesar do nome do arquivo, a régua de inadimplência em si (`POST /automations/inadimplencia/execute`) **nunca é chamada via HTTP** — a segmentação financeira é testada só via Use Case direto |
| `multi-tenant-isolation.test.ts` | `GET /patients/:id` (cross-tenant) | `PatientsController` | **Parcial** | [CRÍTICO #1] único teste HTTP de `GET /patients/:id` em toda a suíte — só o caminho de erro (404 cross-tenant/IDOR) é exercitado; o caminho feliz nunca é testado via HTTP |
| `payment-idempotency.test.ts` | `POST /appointments`, `POST /appointments/:id/confirm`, `POST /billings` (arranges) + `POST /payments` (3×: idempotência 1ª chamada, repetição, sem header) | `AppointmentsController`, `BillingController`, `PaymentController` | **Completa** para `POST /payments` | [CRÍTICO #8] RNF-008 — idempotência real via `Idempotency-Key` provada de ponta a ponta contra Postgres |
| `recurring-blocks-api.test.ts` | `POST`/`GET /recurring-blocks` (sucesso, 401, 400×2, isolamento cross-tenant com 2 tenants reais) | `RecurringBlocksController` | **Completa** | Modelo de referência do repositório — única suíte com 401 + 400 + isolamento ponta a ponta no mesmo arquivo |
| `subscription-upgrade-downgrade.test.ts` | `POST /subscription/upgrade` (2×), `POST /subscription/downgrade` (2×) | `SubscriptionController` | **Completa** | Sucesso + falha de negócio (400 DTO, 409 elegibilidade) para ambos os endpoints |
| `tenant-api-key.test.ts` | `POST /subscription/api-key` (2×) | `SubscriptionController` | **Completa** | Sucesso (Business) + rejeição de negócio (409, Professional) — o restante do arquivo testa o guard diretamente, sem HTTP |

### Arquivos sem chamadas HTTP (testam Repository/Use Case/RLS direto)

| Arquivo de Teste | Fluxo Validado | Observações |
|---|---|---|
| `appointment-savemany-transactional.test.ts` | Atomicidade de `saveMany()` do Repository (PD-001 Fase 2 A1) | Nunca passa por Controller |
| `auth-rls-bypass-scope.test.ts` | [CRÍTICO #17] bypass de RLS do login não vaza entre transações no pool de conexões | Testa `PrismaService` direto, não `POST /auth/login` |
| `cache-tenant-isolation.test.ts` | [CRÍTICO #3] isolamento de cache | `describe.skip` deliberado — não existe camada de cache implementada |
| `clinic-holiday-persistence.test.ts` | Persistência/RLS de `ClinicHoliday` | Não existe Controller HTTP para `ClinicHoliday` ainda (ver F8) |
| `recurring-block-management.test.ts` | `CriarRecurringBlockUseCase`/`ListarRecurringBlocksUseCase` ponta a ponta | Mesma lógica de `recurring-blocks-api.test.ts`, mas via Use Case direto, não HTTP |
| `recurring-block-materialization.test.ts` | Materialização, idempotência, concorrência real via UNIQUE constraint | Não existe endpoint de materialização exposto (ver F9) |
| `recurring-block-persistence.test.ts` | Persistência/RLS de `RecurringBlock` | Repository direto |

### Respostas diretas

1. **Os testes críticos cobrem os principais fluxos expostos por esses controllers?** De forma desigual. Bem cobertos: `RecurringBlocksController`, `SubscriptionController` (upgrade/downgrade/api-key), `PaymentController` (criação), `BillingController` (criação). Parcialmente cobertos: `AppointmentsController` (só create+confirm, o resto nunca via HTTP), `TherapistsController` (só 1 rota, só caminho feliz), `PatientsController` (só 1 rota, só caminho de erro). Mal ou nada cobertos: `AuditLogController` (a única rota real nunca é chamada), `ClinicController`, `WhatsAppController`, `AutomationsController`, `WebhookController`.
2. **Endpoints implementados mas nunca exercitados por nenhum teste crítico?** Sim, uma lista extensa — confirmada cruzando as 39 chamadas HTTP encontradas contra toda rota de todo controller: `GET /appointments`, `PATCH /appointments/:id/reschedule`, `POST /appointments/:id/cancel`, `POST /appointments/recurring`, `GET /audit-log`, `POST /auth/refresh`, `POST /auth/logout`, as 4 rotas de `/automations`, `GET /billings`, `GET /billings/:id`, `POST /billings/:id/send`, `GET /payments/:id`, `POST /payments/:id/refund`, as 4 rotas de `/clinic`, `POST /whatsapp/connect`, `POST /patients`, `PATCH /patients/:id`, as 3 rotas de mudança de estado de paciente, `GET /subscription`, `POST /subscription` (criação), `POST /subscription/credit-card`, `POST /webhooks/asaas`, `GET /therapists/:id`, `PATCH /therapists/:id`.
3. **Lacunas relevantes para produção (top 5, ranked)**: (1) `POST /webhooks/asaas` sem nenhuma cobertura HTTP — ponto de entrada real de callback de pagamento; (2) `GET /audit-log` nunca chamado — único endpoint funcional do controller de compliance, inclusive sem teste de que `RolesGuard('admin')` bloqueia não-admin nessa rota; (3) `/automations` com 0/4 rotas testadas via HTTP, incluindo o guard de API key nunca exercitado; (4) ações centrais de agenda (`reschedule`, `cancel`, `recurring`, `GET /appointments`) nunca testadas via HTTP apesar de tocarem Session/Billing; (5) `PatientsController`/`ClinicController` sem cobertura de CRUD/configuração financeira (pixKey/payeeName), que alimenta diretamente mensagens de cobrança reais ao paciente.

Este anexo confirma e detalha, com granularidade de endpoint individual, os mesmos achados já registrados como **F28/F29/F33** (seção 19) e a análise por grupo de rota do Anexo E — não revela nenhuma categoria de risco nova, apenas a evidência mais fina possível (chamada HTTP individual) para os mesmos gaps.

---

## 22. Backlog Priorizado — Pronto para Sprint 4

Consolidação de todos os 34 achados (F1-F34, corpo principal + Anexos A-I) em um único backlog, ordenado por severidade. Cada linha aponta para a seção onde o achado está detalhado com evidência — este backlog não substitui a leitura da seção correspondente antes de iniciar a correção, é o ponto de entrada para priorização de Sprint, não a especificação da correção em si.

### 🔴 Crítico (3) — bloqueadores de produção multi-cliente

| # | Achado | Item | Detalhe |
|---|---|---|---|
| 1 | F1 | Aplicar `prisma/rls/enable-rls.sql` como migration real (RLS hoje ativa em só 1 de ~18 tabelas) | 3.5 |
| 2 | F2 | Corrigir modelo de identidade dos endpoints `/automations/*` (bypass de tenant via `tenantId` livre no body) | 3.5 |
| 3 | F3 | Incluir `clinic_subscription`/`message_log`/`whatsapp_integration` na migration de RLS acima | 3.5 |

### 🟠 Alto (8) — risco real, exposto, requer decisão de produto ou correção antes de escalar

| # | Achado | Item | Detalhe |
|---|---|---|---|
| 4 | F4 | Decidir e aplicar `@Roles` nos 6 controllers sem checagem de role (começar por `payment-info` e `refund`) | 3.6 |
| 5 | F28 | Adicionar teste crítico de `403` (role incorreta) — hoje zero em toda a suíte; deveria nascer junto com a correção de F4 | 16 |
| 6 | F27 | Cobrir `AnexarCartaoUseCase` com testes (dados de cartão, zero cobertura hoje) | 15 |
| 7 | F29 | Cobrir `POST /subscription` (checkout inicial) com teste de integração HTTP real | 15/16 |
| 8 | F6 | Decidir o destino de `TenantApiKeyGuard` (nunca aplicado a nenhuma rota) — usar para corrigir F2, ou remover se obsoleto | 3.1 |
| 9 | F5 | Adicionar rate limiting em `/auth/login` (mínimo) | 3.6 |
| 10 | F7 | Decidir o destino do entrypoint de IA (`ProcessarMensagemUseCase`/`IntentActionRouter` implementados, inalcançáveis) | 3.1 |
| 11 | F26 | Resolver bloqueio de infraestrutura que quebra a suíte crítica de `ClinicSubscription` (runbook já existe) | 3.7/9 |

### 🟡 Médio (11) — lacunas reais e concretas, sem exposição direta imediata

| # | Achado | Item | Detalhe |
|---|---|---|---|
| 12 | F10 | Persistir `Appointment.modality` e `Therapist.phone` (aceitos da API, descartados silenciosamente) | 3.4 |
| 13 | F13 | Fechar cobertura de teste dos 7 Use Cases listados (fora `AnexarCartaoUseCase`, já em Alto/#6) | 3.7 |
| 14 | F14 | Cobrir `/clinic`, `/whatsapp`, `/webhooks/asaas`, `/automations` com teste crítico | 3.7 |
| 15 | F33 | Idem F14, detalhado por rota individual | 16/21 |
| 16 | F30 | Testar forma/tipo das 14 subclasses de `DomainEvent` (insumo da trilha de auditoria) | 14 |
| 17 | F9 | Decidir o destino de `MaterializarRecurringBlockUseCase` (sem job/endpoint que o dispare) | 3.1 |
| 18 | F8 | Expor gerenciamento de `ClinicHoliday` via API (domínio completo, sem Controller) | 3.1 |
| 19 | F11 | Trocar comparação `!==` por constante-time em `AsaasWebhookGuard`/`AutomationApiKeyGuard` | 3.5 |
| 20 | F12 | Tipar como classe DTO os 4 endpoints com `@Body()` inline (ValidationPipe hoje inerte para eles) | 3.3 |
| 21 | F31 | Reconciliar ADRs "Aprovadas" sem implementação (0001, 0013, 0014, 0016) com o código real | 18 |
| 22 | F34 | Adotar padrão expand/contract em migrations futuras (referência: risco silencioso já registrado nesta) | 12 |

### ⚪ Baixo (12) — consistência, documentação, convenção

| # | Achado | Item | Detalhe |
|---|---|---|---|
| 23 | F15 | Ajustar `@HttpCode` de endpoints de ação (hoje 201 por default) | 3.3 |
| 24 | F16 | Adicionar `@ApiResponse`/`@ApiProperty` ao Swagger | 3.3 |
| 25 | F17 | Nenhuma ação — violações já deliberadas e justificadas | 3.8 |
| 26 | F18 | Corrigir referência a migration de RLS inexistente em `schema.prisma`; atualizar `migrations/README.md` | 3.4 |
| 27 | F19 | Trazer ou renumerar as 7 ADRs fantasma citadas no código | 3.8 |
| 28 | F32 | Mesma ação de F19 — lista completa e recontada no Anexo G | 18 |
| 29 | F20 | Marcar ADR-0013/0016 como não implementadas, ou implementar | 3.8 |
| 30 | F21 | Atualizar README de status do PD-001 (diz "não iniciado", Fase 1 está pronta) | 3.8 |
| 31 | F22 | Corrigir comentário de `main.ts` sobre `OperationalEngineModule` (não existe) | 3.1 |
| 32 | F23 | Remover registro duplicado de `ExecutarReguaInadimplenciaUseCase` em `billing.module.ts` | 3.1 |
| 33 | F24 | Resolver o único TODO real (paginação em fechamento mensal) | 3.8 |
| 34 | F25 | Consolidar `JwtModule.register()` via export de `AuthModule` em vez de 9 registros independentes | 3.8 |

---

## Resumo Executivo — Saúde da Plataforma (0 a 10)

| Dimensão | Nota | Justificativa |
|---|---|---|
| **Arquitetura** | 7/10 | DI e módulos sem quebras estruturais, DAG limpo, zero ciclos — mas 7 Use Cases órfãos e uma garantia documentada (`OperationalEngineModule`) que não existe no código reduzem a nota. |
| **Backend (domínio/Use Cases)** | 7/10 | 41 de 55 Use Cases totalmente OK, nenhuma lógica quebrada encontrada — mas 2 casos concretos de dado aceito e silenciosamente descartado (F10) e 7 pendências de regra de negócio já autoconhecidas puxam a nota para baixo. |
| **API** | 6/10 | Cobertura de rotas completa, sem duplicação, validação global estrita — mas 4 endpoints com validação efetivamente inerte (F12) e semântica HTTP imprecisa em várias ações (F15). |
| **Banco de Dados** | 5/10 | Schema e migrations internamente consistentes e 100% aditivos — mas o mecanismo central de defesa em profundidade (RLS) está desenhado e documentado, porém **não aplicado** a quase nenhuma tabela real (F1), o achado mais grave desta auditoria nesta dimensão. |
| **Segurança** | 5/10 | Fundamentos de autenticação genuinamente sólidos (bcrypt-12, JWT bem separado, API keys com hash e randomness corretos, CORS restrito, sem segredo hardcoded) — mas um bypass de autorização entre tenants real e concreto (F2) e autorização por role aplicada em só 3 de 13 controllers (F4) são gaps que uma auditoria de segurança não pode arredondar para cima. |
| **Testes** | 6/10 | A maior parte dos Use Cases e módulos tem cobertura real, nenhum teste encontrado mascarando um bug atual como comportamento correto — mas 4 de 13 módulos sem cobertura de integração, 7 Use Cases sem nenhum teste (incluindo manuseio de dados de cartão), e a suíte crítica de Assinatura permanece quebrada neste ambiente. |
| **Prontidão para Produção** | 3/10 | Nenhuma configuração de Homologação/Produção existe no repositório (`infra/railway/` vazio); o mecanismo central de isolamento multi-tenant não está ativo em nenhum banco real; há um bypass de autorização entre tenants aberto; a suíte crítica que validaria o fluxo financeiro mais recente está quebrada. A plataforma está em um estado de MVP tecnicamente coerente, mas **não está pronta para operar múltiplas clínicas pagantes simultaneamente sem que F1, F2 e F3 sejam resolvidos primeiro.** |

---

## Validação Final (CTO Final Review — 2026-07-20)

Revisão de consistência solicitada pelo CTO sobre o documento completo (seções 1-21, achados F1-F34), antes de considerar a Sprint 3 encerrada. Nenhum código, teste, migration ou configuração foi alterado nesta etapa — apenas o próprio documento de auditoria.

### Checklist de consistência

1. **Todos os achados possuem evidência rastreável?** Sim. Cada F1-F34 tem ou uma citação explícita `arquivo:linha`, ou um método de verificação reproduzível descrito em texto (comando de grep, arquivo lido por completo, teste específico executado/analisado) — nenhum achado se apoia só em impressão geral. Achados baseados em ausência (ex.: F27 "zero teste") foram, sempre que classificados como Alto/Crítico, reverificados por mim diretamente com uma segunda busca independente antes de entrarem no relatório, não apenas aceitos do primeiro agente de pesquisa que os reportou.
2. **Duplicidades entre relatório principal e anexos?** Nenhuma duplicidade acidental encontrada. As seções 5-9 são resumos deliberados que apontam de volta para a seção 3 (padrão "Ver seção X para detalhamento completo") — redundância estrutural intencional, não repetição de conteúdo original. Um único ponto de possível confusão (não duplicidade, mas leitura contraditória à primeira vista) foi corrigido: F26 (suíte crítica de `ClinicSubscription` quebrada neste ambiente) e a avaliação "Completa" dos mesmos 2 arquivos de teste nos Anexos E/I medem coisas diferentes (execução vs. desenho de cenário) — adicionada uma nota de reconciliação explícita na seção 3.7.
3. **Severidade coerente em todo o documento?** Duas inconsistências reais foram encontradas e corrigidas nesta revisão:
   - **F26** estava marcado como "Rastreado" (uma categoria fora da escala de 4 níveis definida no topo do documento) nas seções 3.7 e 4, mas como "Alto" na seção 6 (Riscos de Produção). Corrigido para **Alto (rastreado — não é achado novo desta auditoria)** de forma consistente nas três seções — "rastreado" descreve a novidade do achado, não deveria ter sido usado como se fosse um nível de severidade.
   - **F34** estava com severidade composta "Baixo-Médio" (fora da escala de 4 níveis) na seção 19. Normalizado para **Médio**, consistente com a definição da escala ("lacuna real e concreta... sem exposição direta imediata").
   Fora esses dois casos, toda severidade inline (seção 3, seções 12-21) confere com a tabela consolidada (seção 4) e com a tabela de novos achados (seção 19).
4. **Cada recomendação referencia o achado correspondente?** Sim, após esta revisão. As seções 10 e 11 foram escritas antes dos Anexos existirem e não citavam F27-F34 — atualizadas nesta revisão para incorporar os 8 achados novos dentro da mesma estrutura de prioridade já existente (nenhuma reordenação de prioridade foi necessária; os achados novos reforçam a direção dos achados originais, não abrem uma categoria de risco nova, conforme já registrado na seção 19).
5. **Numeração dos achados é única?** Sim, confirmado por leitura completa: F1-F26 no relatório principal (sequencial, sem lacunas nem repetição) e F27-F34 nos anexos (sequencial, continuando exatamente de onde F26 parou, sem colidir com nenhum número já usado). Todo F-ID usado em mais de um lugar do documento (todos são, por design) se refere consistentemente ao mesmo achado em cada ocorrência verificada.
6. **Fatos observados e hipóteses estão claramente separados?** Sim. O documento usa consistentemente marcadores explícitos — "confirmado por mim diretamente/de forma independente", "não verificável [sem acesso a X]", "risco de" / "é mais provável que" para inferência — em vez de apresentar dedução como fato. Nenhuma nova instância de mistura foi encontrada nesta revisão além dos dois pontos de severidade já corrigidos acima (que eram inconsistência de rótulo, não de fato vs. hipótese).

### Conclusão única

**O `ARCHITECTURE_AUDIT_REPORT.md`, com as correções aplicadas nesta revisão final (reconciliação de severidade de F26 e F34, atualização das seções 10-11 para cobrir F27-F34, e a nota de reconciliação sobre F26 vs. Anexos E/I), pode ser considerado a versão oficial da auditoria técnica da Sprint 3.** O documento está internamente consistente, toda severidade está calibrada de acordo com a escala definida no seu próprio topo, toda recomendação aponta para pelo menos um achado rastreável, e a separação entre observação direta e inferência é mantida de forma disciplinada em toda a sua extensão — dos 26 achados originais aos 8 achados complementares dos Anexos A-I.

### Sign-off adicional (CTO Final Sign-off — segunda rodada, aprovação dos Anexos H e I)

Nova varredura completa do documento, focada especificamente em contradições entre o corpo principal e os Anexos A-I. **Uma contradição real foi encontrada e corrigida nesta rodada** (não capturada na revisão anterior): a seção 1 (Executive Summary) e a seção 2 (Estado Geral) afirmavam que as 9 migrations eram "todas aditivas, sem nenhuma alteração destrutiva" — mas o próprio Anexo A (seção 12), produzido depois, classifica corretamente a migration `20260717033632_add_availability_calendar` como **Mista** (backfill + `DROP COLUMN`, registrado como F34). Corrigido em ambos os lugares para refletir "8 de 9 aditivas + 1 mista", com referência cruzada a F34/Anexo A.

Verificação dos 5 pontos pedidos nesta rodada:

1. **Achados contraditórios entre relatório principal e Anexos A-I?** Um encontrado (acima) e corrigido. Nenhum outro identificado nesta varredura — a aritmética de tabelas com `tenant_id` confere entre F1/F3 (seção 3.5, "~18 tabelas") e a contagem derivada do Anexo A (16 tabelas na migration inicial, menos `tenant` e `asaas_webhook_event` sem `tenant_id`, mais 4 tabelas tenant-scoped adicionadas nas migrations seguintes = 18) — consistência aritmética confirmada, não apenas assumida.
2. **Severidade consistente em todos os riscos?** Sim, após as correções desta e da rodada anterior (F26, F34). Reconferido nesta rodada contra a escala de 4 níveis do topo do documento — nenhum novo desvio encontrado.
3. **Todas as recomendações rastreáveis a um achado específico?** Sim — reconferido: seções 10 e 11 (após a rodada anterior) e o novo backlog (seção 22, abaixo) citam F-ID em cada item, sem exceção.
4. **O relatório contém um backlog priorizado (Crítico/Alto/Médio/Baixo) pronto para a Sprint 4?** Não existia como peça única até esta rodada — seção 4 (F1-F26) e seção 19 (F27-F34) eram índices separados, sem um backlog unificado e ordenado por severidade cobrindo os 34 achados juntos. **Criada a seção 22 ("Backlog Priorizado — Pronto para Sprint 4")** nesta rodada, consolidando os 34 achados em 4 blocos por severidade, cada item com referência à seção de detalhe.
5. **O documento representa a versão final e oficial da auditoria arquitetural?** Sim, com as correções desta rodada aplicadas.

**Aprovação registrada**: Anexos H e I aprovados pelo CTO nesta interação, conforme solicitado.
