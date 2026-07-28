# Relatório Final de Handoff — AD-007/AD-010 (Canal WhatsApp — Entrada Real)

**Epic:** 8 — Canal WhatsApp (Entrada Real)
**Status:** Implementação tecnicamente validada. **Nenhum commit foi realizado** — aguardando aprovação (governança explícita desta AD).
**Data:** 28 de julho de 2026

---

## 1. Resumo técnico da implementação

Epic 8 ganha seu primeiro ponto de entrada HTTP real — o gap que o próprio `AIModule` documentava como dívida explícita ("o ponto de entrada real continua como dívida explícita"). `POST /webhooks/whatsapp` recebe mensagens reais da Meta, resolve o Tenant, persiste de forma idempotente e despacha o pipeline de IA já existente de forma assíncrona. `IntentActionRouter` passa de 4 para 6 intents roteados.

**Decisão de arquitetura (ADR-0053, Opção A aprovada integralmente):**
- **PD-007 implementado** — resolução de Tenant via `phoneNumberId`: índice único novo em `WhatsAppIntegration.phoneNumberId`.
- **PD-008 implementado em versão mínima** — Bounded Context `Conversation`/`Message` novo, deliberadamente **sem máquina de estados** e **sem escalonamento humano** (restrições explicitamente aprovadas, cortando o desenho mais rico da descoberta original). `MessageLog` permanece intocado — só os fluxos automáticos já existentes (lembrete, cobrança).
- Autenticação de entrada via HMAC-SHA256 (`X-Hub-Signature-256`) sobre o corpo bruto — `WhatsAppWebhookGuard`, estruturalmente diferente do único precedente existente (`AsaasWebhookGuard`, string estática).
- Handshake de verificação `GET /webhooks/whatsapp` — mecanismo sem precedente no código antes desta AD.
- Idempotência de entrada por WAMID (`Message.externalId`, `@unique`), checada antes de qualquer enfileiramento.
- Processamento de IA assíncrono via fila BullMQ nova (`whatsapp-inbound`) — nunca bloqueia a resposta síncrona ao webhook.
- Auditoria `actorType: 'system'` — mesmo precedente de `ProcessarWebhookAssinaturaUseCase`.
- Envio da resposta da IA reaproveita 100% o pipeline de saída já existente (`EnviarMensagemUseCase`/`WhatsAppMessageProvider`/fila `messages`) — nenhuma alteração de comportamento na saída.
- `RemarcarConsultaUseCase`/`ConsultarDisponibilidadeUseCase` (AD-010) já existiam prontos em `AppointmentsModule` — só conectados a `AIModule`/`IntentActionRouter`, nenhuma lógica de agenda nova construída.

**4 achados reais, descobertos e corrigidos durante a implementação/validação (nenhum hipotético):**

1. **Importar `Response` de `'express'` diretamente no Controller quebrou a resolução de módulo do Vitest** (`Failed to load url express` — `express` é dependência transitiva neste projeto, não direta) — derrubou 18 arquivos da suíte crítica de uma vez, não só o novo. Corrigido eliminando o import: o handshake de verificação (`GET`) retorna a string do `hub.challenge` diretamente — o `RouterResponseController` padrão do Nest já produz texto puro (nunca `JSON.stringify`) para um retorno primitivo — e o caminho de falha usa `ForbiddenException`. Mesmo resultado observável, sem a dependência direta.
2. **Habilitar RLS em `whatsapp_integration` quebrou `WhatsAppMessageProvider.send()` (fluxo de saída já existente, não tocado por esta AD).** Esse Provider consulta a tabela deliberadamente FORA de `TenantContext` (pode rodar em worker de fila, sem requisição HTTP), filtrando por `tenantId` explícito no `WHERE` — um padrão legítimo e pré-existente, confirmado por leitura do próprio código. Com RLS forçada e `app.tenant_id` nunca setado nesse caminho, a consulta passou a devolver zero linhas sempre — capturado pelo Teste Crítico [AD-005] rodando de verdade (`WhatsAppMessageProvider decifra corretamente antes de enviar`), não hipoteticamente. Corrigir o Provider está fora de escopo (restrição aprovada: preservar a arquitetura de saída existente). Corrigido com uma migration corretiva (`20260728173344_revert_whatsapp_integration_rls`) que reverte a RLS só dessa tabela, mantendo RLS normalmente em `conversation`/`message` (sem esse mesmo conflito — único caminho de acesso ali é `PrismaService.forTenant()`). O lookup de Tenant por `phoneNumberId` passou a usar `PrismaClientProvider` direto — o mesmo padrão já estabelecido por `WhatsAppMessageProvider` para esta mesma tabela.
3. **`??` (nullish coalescing) no próprio teste unitário mascarava um cenário real.** `integration: null` explícito (caso de teste "phoneNumberId sem Tenant conectado") caía no valor padrão via `??`, que trata `null` e `undefined` como equivalentes — o teste nunca exercitava o caminho que deveria validar. Corrigido com checagem explícita de presença da chave (`'integration' in opts`).
4. **`SlotNotAvailableError.message` não contém o `code` (`SLOT_NOT_AVAILABLE`), contém o texto humano** — confirmado lendo o `HttpException.initMessage()` instalado (`@nestjs/common`), não presumido: quando a resposta é um objeto com `.message` string, `this.message` recebe esse texto, não o `code`. Ajustada a asserção do teste antes de confiar nela.

**Achado adicional, sinalizado explicitamente na fase de design detalhado (não estava nos 8 princípios pré-aprovados na descoberta):** `PatientRepository.findByPhone()` — sem resolver `patientId` a partir do número do remetente, **nenhum** dos 6 intents de ação executaria de verdade para uma mensagem real (sempre `patientId: undefined`), deixando todo o trabalho de AD-010 funcionalmente morto na prática. Implementado mínimo e determinístico: `findFirst` por `(tenantId, phone)` (via `PrismaService.forTenant()`, já dentro do Tenant resolvido), `@@index` novo em `Patient` para a performance dessa consulta nova. Números sem `Patient` correspondente seguem com `patientId: null` — comportamento já antecipado por todo o pipeline de IA (`patientId?: string` opcional), sem precisar do Aggregate `Contact` (Epic 9).

## 2. Arquivos criados

**Domínio/aplicação:**
- `apps/backend/src/domain/communication/conversation.entity.ts` — `Conversation`, `Message`, `ConversationMessageRecordedEvent`.
- `apps/backend/src/domain-services/communication/conversation.repository.ts` — interface.
- `apps/backend/src/infrastructure/database/repositories/prisma-conversation.repository.ts` — implementação.
- `apps/backend/src/api/communication/whatsapp-webhook.guard.ts` — `WhatsAppWebhookGuard` (HMAC-SHA256).
- `apps/backend/src/api/communication/whatsapp-webhook.controller.ts` — `GET`/`POST /webhooks/whatsapp`.
- `apps/backend/src/infrastructure/messaging/whatsapp-inbound-queue.producer.ts` — fila de entrada.
- `apps/backend/src/infrastructure/messaging/whatsapp-inbound-queue.worker.ts` — worker (usa `ModuleRef`/`ContextIdFactory` para resolver `TenantContext`/`ProcessarMensagemUseCase` fora do contexto de requisição HTTP — mecanismo padrão do NestJS, não um mecanismo novo).
- `apps/backend/src/use-cases/communication/receber-mensagem-whatsapp.use-case.ts` — parte síncrona do webhook.
- `apps/backend/src/use-cases/communication/processar-mensagem-whatsapp.use-case.ts` — parte assíncrona (worker).

**Migrations:**
- `apps/backend/prisma/migrations/20260728161842_whatsapp_conversation_and_tenant_lookup/migration.sql`
- `apps/backend/prisma/migrations/20260728173344_revert_whatsapp_integration_rls/migration.sql` (achado #2)

**Testes:**
- `apps/backend/test/unit/domain/communication/conversation.entity.test.ts` (5 testes)
- `apps/backend/test/unit/api/communication/whatsapp-webhook.guard.test.ts` (6 testes)
- `apps/backend/test/unit/use-cases/communication/receber-mensagem-whatsapp.use-case.test.ts` (8 testes)
- `apps/backend/test/unit/use-cases/communication/processar-mensagem-whatsapp.use-case.test.ts` (4 testes)
- `apps/backend/test/critical/whatsapp-webhook.test.ts` (10 testes, Postgres/Redis reais)

**Documentação:**
- `docs/02-Arquitetura/ADRs/ADR-0053-canal-whatsapp-entrada-real.md`
- `docs/AD-007-AD-010-RELATORIO-HANDOFF.md` (este documento)

## 3. Arquivos modificados

- `apps/backend/prisma/schema.prisma` — modelos `Conversation`/`Message`, `@unique` em `WhatsAppIntegration.phoneNumberId`, `@@index` novo em `Patient(tenantId, phone)`.
- `apps/backend/prisma/rls/enable-rls.sql` — `conversation`/`message` cobertos por RLS; `whatsapp_integration` explicitamente excluído, com nota do achado #2.
- `apps/backend/src/api/communication/communication.module.ts` — registra `ReceberMensagemWhatsAppUseCase`, `WhatsAppWebhookGuard`, `WhatsAppWebhookController`, `CONVERSATION_REPOSITORY`, `PATIENT_REPOSITORY`, `AuditService`, `WhatsAppInboundQueueProducer`.
- `apps/backend/src/api/ai/ai.module.ts` — registra `RemarcarConsultaUseCase`, `ConsultarDisponibilidadeUseCase`, `ProcessarMensagemWhatsAppUseCase`, `WhatsAppInboundQueueWorker`.
- `apps/backend/src/domain-services/patient-ops/patient.repository.ts`, `apps/backend/src/infrastructure/database/repositories/prisma-patient.repository.ts` — `findByPhone()` novo (achado adicional, §1).
- `apps/backend/src/infrastructure/ai/anthropic-ai.provider.ts` — `consultar_disponibilidade` adicionado à lista de intents possíveis do prompt.
- `apps/backend/src/use-cases/ai/intent-action-router.ts` — 2 novos `case`s (`remarcar_consulta`, `consultar_disponibilidade`).
- `apps/backend/src/main.ts` — `rawBody: true` em `NestFactory.create()`.
- `apps/backend/test/critical/support/bootstrap-app.ts` — espelha `rawBody: true`.
- `apps/backend/test/unit/use-cases/ai/intent-action-router.test.ts` — 6 testes novos (4 dos 2 intents + 1 de `SlotNotAvailableError` + ajuste do construtor).
- `.env.example`, `.env`, `apps/backend/.env` — `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
- `docs/02-Arquitetura/ADRs/README.md` — índice atualizado.

## 4. Resultado das validações

| Verificação | Resultado |
|---|---|
| Migrations | 2 aplicadas (`20260728161842`, `20260728173344`) — `prisma migrate status`: "Database schema is up to date!" |
| `nest build` | Exit 0, limpo |
| `eslint` | Exit 0, sem erros |
| Suíte unitária completa | 60 arquivos, **499/499 testes, 0 falhas** (era 470/470 antes desta AD) |
| Suíte crítica completa (Postgres/Redis reais, `/root/luxora-app`) | 26 arquivos (25 passaram, 1 skip documentado pré-existente e não relacionado), **177/178 testes, 0 falhas** (era 167/168 antes desta AD) |

## 5. Confirmações explícitas (restrições aprovadas)

- **Nenhuma funcionalidade além do escopo aprovado** — sem multi-canal (`Conversation` sem campo `channel`), sem escalonamento humano (sem estado/evento de escalonamento), sem DLQ (mesma lacuna pré-existente da fila de saída, não introduzida nem fechada aqui).
- **Migrations apenas as previstas na ADR** — `Conversation`/`Message`/índice único, mais a migration corretiva do achado #2 (não prevista na ADR original, mas dentro do mesmo escopo técnico — corrige um efeito colateral da própria implementação, não expande funcionalidade).
- **Fluxo de saída 100% inalterado em comportamento** — `WhatsAppMessageProvider`/`EnviarMensagemUseCase`/`MessageLog`/fila `messages` continuam exatamente como antes; a resposta da IA reaproveita esse pipeline sem modificá-lo.
- **Nenhum mecanismo paralelo de auditoria ou idempotência** — entrada usa `actorType: 'system'` (mesmo padrão de `ProcessarWebhookAssinaturaUseCase`) e idempotência por WAMID seguindo a mesma estrutura de 2-3 camadas já validada na saída (checagem explícita + `@unique` + `jobId` do BullMQ).
- **Tenant resolvido via PD-007** (`phoneNumberId` + índice único) — sem alterar o modelo de autenticação existente (`JwtAuthGuard`/`TenantApiKeyGuard` intocados).
- **Persistência de `Conversation`/`Message` no padrão de `BillingRepository`** — `save()` grava só o cabeçalho, `appendMessages()` grava as entidades filhas, dois métodos, nunca um `save()` cascateando.

## 6. Riscos remanescentes

- **AD-027 permanece pendente** — testes contra a API real da Meta/Anthropic dependem de credenciais externas, fora do alcance deste ambiente (mesma categoria de limitação já documentada para `WhatsAppMessageProvider`/`AnthropicAIProvider`, "NÃO TESTADO CONTRA A API REAL").
- **`WhatsAppInboundQueueWorker` usa `ModuleRef`/`ContextIdFactory`** — mecanismo padrão do NestJS para resolver providers `Scope.REQUEST` fora de uma requisição HTTP real, necessário porque `ProcessarMensagemUseCase`/`IntentActionRouter` (reaproveitados sem alteração, por restrição aprovada) dependem transitivamente de `TenantContext` ambiente. Nenhum outro worker deste código-base usa esse padrão hoje (`MessageQueueWorker` nunca precisou, porque `EnviarMensagemUseCase` recebe `tenantId` explícito) — primeira aplicação deste mecanismo no projeto, vale atenção extra numa eventual revisão de código.
- **Cancelamento/reversão de conversa, teto de custo real por conversa (RNF-021) e escalonamento humano permanecem fora do domínio `Conversation`** — deliberadamente, por restrição aprovada; PD-008 original havia esboçado isso, mas está fora do escopo desta AD.
- **`whatsapp_integration` permanece sem RLS** (achado #2) — mitigação de risco: a tabela só guarda `phoneNumberId`/`accessToken` (cifrado) por Tenant; todo acesso de aplicação já filtra por `tenantId` explícito no código (`WhatsAppMessageProvider`, `ConectarWhatsAppUseCase`, `ReceberMensagemWhatsAppUseCase`) — sem RLS como segunda camada, mas sem regressão em relação ao que já existia antes desta AD (a tabela nunca teve RLS).

## 7. ADR / registro correspondente

**[`ADR-0053`](docs/02-Arquitetura/ADRs/ADR-0053-canal-whatsapp-entrada-real.md) — Status: ADOTADA E IMPLEMENTADA.** Documento completo com a descoberta técnica, a decisão-fork (Opção A aprovada), o desenho técnico detalhado por seção, o plano de implementação, e o registro formal de todas as aprovações (descoberta, ADR definitiva, autorização de implementação) — ver seção "Histórico" da própria ADR.

## 8. Estado do repositório

Nenhuma ação de `git add`, `git commit` ou `git push` foi realizada. Todos os arquivos criados/modificados listados nas seções 2 e 3 estão no working tree, sincronizados e verificados byte-a-byte (`diff`) entre a cópia de referência (`C:\Users\pichau\Desktop\luxora-app\luxora-app`) e o repositório canônico de execução (`/root/luxora-app`, WSL2/ext4). As 2 migrations foram aplicadas em ambas as cópias e confirmadas via `prisma migrate status`.

Aguardando sua aprovação para o commit desta AD.
