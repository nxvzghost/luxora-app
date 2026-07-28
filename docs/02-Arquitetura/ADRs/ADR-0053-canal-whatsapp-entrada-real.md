# ADR-0053 — Canal WhatsApp: Entrada Real (Webhook, Auth, Idempotência, Retries, Auditoria)

**Status:** ADOTADA E IMPLEMENTADA — decisão de arquitetura (Opção A) e escopo aprovados em 28/07/2026; implementação autorizada na mesma data e concluída, validada (build/lint/unit/critical) e sincronizada Windows↔WSL. AD-027 (testes contra a API real da Meta) permanece pendente, bloqueada por credenciais externas — ver "Histórico".
**Origem:** Epic 8 (`docs/PLANO_DE_EXECUCAO.md`) — AD-007 (webhook de recepção), AD-010 (rotear `remarcar_consulta`/consulta de horários), AD-027 (testes contra a API real).
**Data:** 28 de julho de 2026

## Objetivo

Definir a arquitetura técnica completa e o plano de implementação do único ponto de entrada HTTP real que falta para o módulo de IA: hoje `ProcessarMensagemUseCase` funciona e `IntentActionRouter` roteia 4 de 6 intents esperados, mas **nenhum caminho de aplicação recebe uma mensagem real do WhatsApp**.

## Decisão de escopo (aprovada — não está mais em aberto)

**Opção A aprovada integralmente:** implementar PD-007 (identificação de Tenant) e a versão mínima de PD-008 (`Conversation`/`Message`, 1 canal) dentro do mesmo ciclo de implementação do webhook. A tabela de alternativas (B/C) que motivou esta escolha permanece registrada na seção "Alternativas consideradas" só como histórico da decisão — não é mais uma bifurcação em aberto.

### Restrições arquiteturais aprovadas (vinculantes para a implementação)

1. Não criar funcionalidades além do mínimo necessário para suportar entrada real do WhatsApp.
2. Não expandir para múltiplos canais.
3. Não implementar escalonamento humano.
4. Não implementar Dead Letter Queue.
5. Não alterar comportamentos existentes de saída (`WhatsAppMessageProvider`, `EnviarMensagemUseCase`, `MessageLog`, fila `messages`).
6. Não introduzir mecanismos paralelos de auditoria ou idempotência — tudo reaproveita os padrões já validados em produção.

Estas restrições eliminam, explicitamente, itens que a análise de descoberta havia mencionado como benefício futuro possível (ex.: `ConversaEscalonadaParaHumano`, correção do teto de custo por conversa) — **nenhum dos dois está no escopo desta ADR.** `Conversation` nesta implementação **não tem máquina de estados** (sem `Ativa`/`Escalada`/`Encerrada`) — é um agregado de identidade/agrupamento, não um agregado de ciclo de vida. Isso é uma simplificação deliberada em relação ao desenho mais rico que PD-008 havia esboçado, exigida pelas restrições 1 e 3 acima.

---

## Contexto (confirmado por leitura direta do código-fonte e de 2 Product Decisions já aprovadas)

**O que já existe e funciona, sem alteração necessária:**
- `WhatsAppMessageProvider` — envia via Meta Cloud API real, credencial por Tenant (`WhatsAppIntegration`, 1:1, `accessToken` cifrado em repouso via `TokenCipherService`, AD-005).
- `EnviarMensagemUseCase` + `MessageQueueProducer`/`Worker` (BullMQ) — idempotência de saída em 3 camadas já validadas (checagem contra `MessageLog.idempotencyKey`, `@unique` no banco, `jobId` no BullMQ, retry `attempts: 3, backoff: exponential 2000ms`).
- `ProcessarMensagemUseCase` — pipeline de IA completo, mas `conversationHistory: ConversationMessage[]` precisa ser montado à mão pelo chamador a cada chamada.
- `IntentActionRouter` — roteia 4 de 6 intents. `RemarcarConsultaUseCase`/`ConsultarDisponibilidadeUseCase` (AD-010) **já existem e já funcionam** em `AppointmentsModule`, só não estão conectados a `AIModule`/`IntentActionRouter` — AD-010 é fiação, não construção.

**O que não existe e é o gap real desta ADR:**
- Nenhum endpoint HTTP recebe mensagem do WhatsApp.
- Nenhum lookup `phoneNumberId → tenantId` — `WhatsAppIntegration.phoneNumberId` não tem `@unique`/`@@index`. Recomendação já aprovada em PD-007, nunca implementada.
- Nenhuma entidade representa uma conversa — `MessageLog` é 100% de saída. Recomendação já aprovada em PD-008, nunca implementada.
- Nenhuma fila de entrada existe.
- **Nenhum lookup `Patient` por telefone existe** (`PatientRepository` não tem `findByPhone`, `Patient.phone` não tem índice) — achado adicional desta fase de design detalhado, não estava nos 8 princípios originais da descoberta, ver §2.4 abaixo para a justificativa de por que é mínimo necessário, não uma expansão de escopo.

---

## Desenho técnico completo

### 1. Integração com a Meta Cloud API

- Continua Meta Cloud API (`graph.facebook.com`), sem troca de provedor.
- Uma única URL de webhook (`/webhooks/whatsapp`) compartilhada entre todos os Tenants — a Meta não permite URL por clínica dentro do mesmo App (confirmado em PD-007, Alternativa D).
- Payload da Meta pode conter múltiplas mensagens e/ou atualizações de status num único `POST` (`entry[].changes[].value.messages[]` e `.statuses[]`, independentes, podem coexistir) — o handler itera sobre a lista, nunca assume 1 mensagem por requisição.

### 2. Autenticação, identificação de Tenant e identificação de Paciente

**2.1 — Credencial de saída (inalterada):** `WhatsAppIntegration.accessToken`, por Tenant, já cifrado (AD-005). Esta ADR não toca nisso.

**2.2 — Autenticação de entrada (nova):** a Meta assina cada `POST` com HMAC-SHA256 sobre o corpo bruto, header `X-Hub-Signature-256`, usando o **App Secret** — um único segredo por App da Meta, nunca por Tenant (`WHATSAPP_APP_SECRET`, variável de ambiente única). Estruturalmente diferente do único precedente hoje (`AsaasWebhookGuard`, comparação de string simples, não HMAC). O novo `WhatsAppWebhookGuard` precisa calcular o HMAC sobre os bytes brutos exatos do corpo — requer capturar o corpo bruto **antes** do parser JSON do Express rodar, só para esta rota (mecanismo padrão do Express, `verify` callback de `express.json()` — requisito técnico confirmado, não uma decisão de arquitetura nova).

**Handshake de verificação (`GET /webhooks/whatsapp`):** a Meta chama uma única vez, ao configurar o webhook — `hub.mode=subscribe&hub.verify_token=X&hub.challenge=Y` como query string; responde `hub.challenge` em texto puro só se `hub.verify_token` bater com `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (variável única, configurada manualmente uma vez).

**2.3 — Identificação de Tenant (PD-007, implementado integralmente):**
- Migration: `@unique` em `WhatsAppIntegration.phoneNumberId`.
- Nova policy de RLS (3ª exceção, mesmo mecanismo de `auth_lookup_by_email`/`api_key_lookup_by_hash`): `whatsapp_lookup_by_phone_number_id ON whatsapp_integration FOR SELECT USING (current_setting('app.bypass_tenant_check', true) = 'true')`.
- **Sem repositório novo** — `WhatsAppWebhookGuard` chama `PrismaService.forAuthLookup()` diretamente, mesma estrutura de `TenantApiKeyGuard` (que também não usa uma camada de repositório para o lookup de API key, faz a query direto no Guard). Consistência com o precedente mais próximo, não introduz uma abstração nova.
- Depois de resolvido: `TenantContext.set(tenantId, null)` — mesmo padrão de `TenantApiKeyGuard`/`ProcessarWebhookAssinaturaUseCase`.
- **Nenhuma alteração no modelo de autenticação existente** (`JwtAuthGuard`/`TenantApiKeyGuard` inalterados) — este é um 3º ponto de entrada de `tenantId`, não uma modificação dos 2 existentes.

**2.4 — Identificação de Paciente (achado desta fase de design, sinalizado explicitamente para sua aprovação):** sem resolver `patientId`, **nenhum dos intents de ação** (`agendar_consulta`, `cancelar_consulta`, `confirmar_presenca`, `consultar_cobranca`, e os 2 novos de AD-010) jamais executaria uma ação real para uma mensagem recebida de verdade — `IntentActionRouter` receberia sempre `patientId: undefined`, e todo o trabalho de AD-010 (conectar `RemarcarConsultaUseCase`/`ConsultarDisponibilidadeUseCase`) ficaria funcionalmente morto. **Proposta mínima:** `PatientRepository` ganha `findByPhone(tenantId, phone): Promise<Patient | null>` — consulta simples, escopada por Tenant (já dentro de `PrismaService.forTenant()`, não precisa de bypass de RLS, porque neste ponto o `tenantId` já foi resolvido pela §2.3). Números que não correspondem a nenhum `Patient` cadastrado continuam com `patientId: null` — comportamento já antecipado por todo o pipeline de IA hoje (`patientId?: string` opcional), sem precisar do Aggregate `Contact` (Epic 9). Não há garantia de unicidade de `Patient.phone` hoje (achado de PD-007, não desta ADR); `findByPhone` retorna a primeira ocorrência — corrigir eventual duplicidade de dado é uma dívida pré-existente, fora do escopo desta ADR. **Esta é uma peça nova em relação aos 8 princípios originalmente aprovados — sinalizada aqui explicitamente porque, sem ela, a entrada "real" do WhatsApp não teria efeito prático nenhum além de conversar.**

### 3. Modelagem de `Conversation`/`Message` (PD-008, versão mínima aprovada)

**`Conversation`** (Aggregate Root, sem máquina de estados — ver restrição 3 acima):
- `id`, `tenantId`, `phoneNumber` (número do remetente — `wa_id` da Meta), `patientId: string | null` (resolvido via §2.4, nunca alterado por esta ADR depois da criação — reatribuição de conversa a um Patient diferente é fora de escopo), `createdAt`.
- Identidade natural: uma `Conversation` por par `(tenantId, phoneNumber)` — `findByTenantAndPhone()` busca a existente; se não houver, cria uma nova. Sem campo `channel` (restrição 2 — não há branching de canal, um único canal implícito).

**`Message`** (Entidade filha, nunca Aggregate Root própria — mesmo raciocínio já aplicado a `BillingSession` dentro de `Billing`):
- `id`, `conversationId`, `tenantId` (denormalizado, mesmo padrão de `BillingSession`), `direction: 'entrada' | 'saida'`, `content: string`, `externalId: string | null` (WAMID — `@unique`, só preenchido em mensagens de `direction: 'entrada'`, é a chave de idempotência de §4), `createdAt`.
- Mensagens de **saída** (resposta da IA) também são gravadas aqui — é a única forma de `conversationHistory` sobreviver entre chamadas (sem isso, a IA "esqueceria" a própria resposta anterior a cada novo turno, quebrando a conversa já no segundo turno). **Isto não cria um mecanismo novo de envio nem de idempotência de saída** (restrições 5/6): o envio continua 100% via `EnviarMensagemUseCase`/fila `messages` exatamente como hoje; `Message(direction: 'saida')` é só um registro de domínio, gravado depois que o envio já foi confirmado, sem nenhuma checagem de idempotência própria (reaproveita a idempotência de saída já existente).
- Mensagens automáticas não-conversacionais (lembrete de cobrança, resumo de agenda, régua de inadimplência) **continuam via `MessageLog`, sem tocar `Conversation`/`Message`** — restrição 5, e já era a separação implícita no código antes desta ADR.

**Persistência:** `ConversationRepository { findByTenantAndPhone, findById, save, appendMessages }` — `save()` grava só o cabeçalho da `Conversation`; `appendMessages()` grava novas `Message`s, mesmo padrão já usado por `BillingRepository.save()`/`BillingRepository.linkSessions()` (dois métodos, nunca um único `save()` cascateando).

**Eventos de domínio:** `ConversationMessageRecordedEvent` (ou nome equivalente a decidir na implementação) — um evento por `Message` nova, emitido pela própria `Conversation` via `pullDomainEvents()`, substituindo o atual `AiInteractionAuditEvent` fabricado dentro do Use Case. Sem `ConversaIniciada`/`ConversaEscalonadaParaHumano`/`ConversaEncerrada` (esses exigiriam a máquina de estados excluída pela restrição 3).

### 4. Fluxo de recebimento via Webhook

- `POST /webhooks/whatsapp` — sem `JwtAuthGuard`, protegido por `WhatsAppWebhookGuard` (§2.2). `GET /webhooks/whatsapp` — handshake, sem guard de autorização.
- Handler síncrono do `POST`: valida assinatura → itera `messages[]` → para cada mensagem, resolve `tenantId` (§2.3) → checa idempotência por `externalId`/WAMID (§5, antes de qualquer persistência) → se nova, resolve `patientId` (§2.4), garante a `Conversation` (find-or-create), grava a `Message` de entrada → enfileira o processamento de IA (fila nova) → devolve `200` imediatamente, sem esperar a IA responder.
- Mensagens de `statuses[]` (entregue/lida) atualizam o `status` de uma `Message` de saída já existente — não criam registro novo. (Campo `status` em `Message`, omitido da lista de §3 por brevidade — mesmo valor por padrão `'enviada'`, atualizável para `'entregue'`/`'lida'` quando a Meta informar.)

### 5. Idempotência

- WAMID (`messages[].id`) é a chave de idempotência de entrada — checado **antes** de enfileirar (não só dentro do worker), porque a própria Meta pode reentregar o mesmo webhook se não receber `200` a tempo. Mesmas 2-3 camadas já validadas na saída: checagem explícita + `@unique` no banco (`Message.externalId`) + `jobId` do BullMQ usando o mesmo valor.
- Nenhum mecanismo novo — é a mesma estratégia já em produção para a fila `messages`, aplicada ao sentido inverso.

### 6. Retries e falhas

- Saída: inalterado.
- Entrada (processamento de IA, fila nova): mesma política já validada (`attempts: 3, backoff: exponential 2000ms`) — sem mecanismo de retry paralelo.
- **DLQ: fora de escopo (restrição 4)** — nem a fila de saída, já em produção, tem DLQ hoje; esta ADR não introduz essa lacuna nem tenta fechá-la.
- Reentrega da Meta: inofensiva por construção, porque a idempotência (§5) já rejeita a duplicata antes de qualquer efeito colateral.

### 7. Auditoria e rastreabilidade

- `TenantContext.set(tenantId, null)` logo após §2.3, depois `auditService.recordAll(events, 'system')` para o evento de mensagem recebida — mesmo padrão de `ProcessarWebhookAssinaturaUseCase` (o único outro webhook não-autenticado do sistema).
- Resposta da IA continua auditada como `'ai_agent'` — sem mudança de convenção, só passa a ser emitida pela entidade (`Conversation`/`Message`) em vez de fabricada no Use Case.
- `correlationId`: já gerado/propagado pelo middleware existente em toda requisição (AD-016) — só precisa ser incluído explicitamente no payload do novo job de fila de entrada, mesmo campo já usado no job de saída.

### 8. Compatibilidade com Epics 10, 11 e 12

- **Epic 10:** sem dependência direta — webhook é server-to-server.
- **Epic 11:** sem dependência — indicadores continuam baseados em `Billing`/`Session` (AD-009).
- **Epic 12:** sem dependência de escopo — `ConversaEscalonadaParaHumano` mencionado na descoberta como gatilho futuro **foi removido do desenho** (restrição 3); Epic 12 continua dependendo de Epic 6 (eventos financeiros), como já registrado em `PLANO_DE_EXECUCAO.md`, sem relação com esta ADR.

---

## Plano de implementação

**Arquivos novos (produção):**
- `domain/communication/conversation.entity.ts` — `Conversation` + `ConversationMessageRecordedEvent`.
- `domain-services/communication/conversation.repository.ts` — interface (`findByTenantAndPhone`, `findById`, `save`, `appendMessages`).
- `infrastructure/database/repositories/prisma-conversation.repository.ts` — implementação.
- `domain-services/patient-ops/patient.repository.ts` — **modificado**, novo método `findByPhone(tenantId, phone)`.
- `infrastructure/database/repositories/prisma-patient.repository.ts` — **modificado**, implementação de `findByPhone`.
- `api/whatsapp-webhook/whatsapp-webhook.guard.ts` — `WhatsAppWebhookGuard` (HMAC-SHA256).
- `api/whatsapp-webhook/whatsapp-webhook.controller.ts` — `GET`/`POST /webhooks/whatsapp` (nome de diretório/rota a confirmar na implementação — pode reaproveitar `api/subscription/webhook.controller.ts` como um segundo Controller no mesmo diretório de "webhooks", ou um diretório próprio; decisão de organização, não de arquitetura).
- `infrastructure/messaging/whatsapp-inbound-queue.producer.ts` / `.worker.ts` — fila de entrada nova, delega a `ProcessarMensagemUseCase`.
- `use-cases/communication/receber-mensagem-whatsapp.use-case.ts` (nome ilustrativo) — orquestra §4: resolve Tenant/Patient/Conversation, idempotência, enfileiramento.
- Registro dos 2 novos `case`s em `intent-action-router.ts` (AD-010) + `RemarcarConsultaUseCase`/`ConsultarDisponibilidadeUseCase` como providers de `AIModule`.

**Arquivos modificados:**
- `prisma/schema.prisma` — `Conversation`, `Message`, `@unique` em `WhatsAppIntegration.phoneNumberId`.
- `prisma/rls/enable-rls.sql` — nova policy `whatsapp_lookup_by_phone_number_id`.
- `main.ts` — captura de corpo bruto (`verify` callback) escopada à rota do webhook do WhatsApp.
- `.env`, `.env.example`, `apps/backend/.env` — `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
- `docs/03-Database/09-Multi-Tenant.md` — documentar a 3ª exceção de RLS.

**Migration:** uma migration nova, cobrindo `Conversation`/`Message` (tabelas) + índice único em `WhatsAppIntegration.phoneNumberId` + a policy de RLS. Nenhuma migration é criada por esta ADR — só planejada aqui.

**Plano de testes:**
- Unitários: `Conversation`/`Message` (entidade — criação, `appendMessages`, eventos); `WhatsAppWebhookGuard` (assinatura válida aceita, inválida rejeitada, corpo adulterado rejeitado); `ReceberMensagemWhatsAppUseCase` (idempotência por WAMID, `patientId` resolvido/nulo); 2 novos `case`s de `IntentActionRouter`.
- Críticos (Postgres/Redis reais): handshake `GET` (verify_token correto/incorreto); `POST` com assinatura válida/inválida/ausente; resolução de Tenant por `phoneNumberId` (incluindo Tenant inexistente); ciclo completo mensagem→`Conversation`/`Message` criadas→IA processa→resposta enfileirada; reentrega do mesmo WAMID não duplica nada; payload com múltiplas mensagens numa só chamada; `remarcar_consulta`/consulta de horários roteados de ponta a ponta.

## Riscos

- AD-027 depende de credenciais reais da Meta — risco de ambiente, já registrado, não introduzido por esta ADR.
- Captura de corpo bruto para HMAC é um ponto de configuração sensível — exige teste crítico dedicado (assinatura inválida rejeitada), sem precedente no código atual.
- `PatientRepository.findByPhone()` (§2.4) assume que a maioria dos números que escrevem já são pacientes cadastrados — números de primeiro contato (nunca pacientes) sempre terão `patientId: null` e só recebem respostas conversacionais, nunca ações (`agendar_consulta` de alguém ainda não cadastrado não é resolvido por esta ADR — depende do Aggregate `Contact`, Epic 9, fora de escopo).
- `docs/09-Testes/01-Testes-Criticos.md` não tem nenhum item cobrindo este fluxo — suíte crítica desenhada do zero.

## Alternativas consideradas (histórico da decisão já aprovada)

| Opção | Escopo | Resultado |
|---|---|---|
| **A** | PD-007 + PD-008 mínimo, junto com o webhook | **Aprovada** |
| B | Webhook mínimo, só estender `MessageLog` | Rejeitada — deixaria idempotência/auditoria de entrada sem lugar coerente para viver |
| C | PD-007+PD-008 como AD separada, antes do webhook | Rejeitada — atrasaria a entrega sem valor de produto intermediário observável |

## Documentos Relacionados

- `docs/PLANO_DE_EXECUCAO.md` — Epic 8, AD-007/AD-010/AD-027.
- [`PD-007 — Identificação do Tenant via WhatsApp`](../../11-Product-Decisions/PD-007-Identificacao-do-Tenant-via-WhatsApp/01-Analise-Arquitetural.md) — implementado integralmente por esta ADR (§2.3).
- [`PD-008 — Domínio Conversacional`](../../11-Product-Decisions/PD-008-Dominio-Conversacional/01-Analise-Arquitetural.md) — implementado em versão mínima por esta ADR (§3), com escalonamento/máquina-de-estados/custo-por-conversa deliberadamente excluídos (restrições aprovadas).
- `docs/02-Arquitetura/ADRs/ADR-0041-whatsapp-interface-oficial-do-paciente.md`.
- `apps/backend/src/api/subscription/asaas-webhook.guard.ts`, `webhook.controller.ts`, `use-cases/subscription/processar-webhook-assinatura.use-case.ts`, `api/auth/tenant-api-key.guard.ts` — precedentes estruturais reaproveitados.

## Histórico

- **28/07/2026** — Documento criado como fase de descoberta (Status: PROPOSTO), 8 pontos técnicos + decisão-fork (Opção A/B/C).
- **28/07/2026** — Descoberta aprovada integralmente: Opção A confirmada, 8 princípios técnicos mantidos como vinculantes, 6 restrições arquiteturais explícitas impostas (sem multi-canal, sem escalonamento, sem DLQ, sem alterar saída, sem mecanismos paralelos, sem funcionalidade além do mínimo). Autorizada a produção desta versão definitiva (Status: ACEITA) com desenho técnico completo e plano de implementação — implementação de código bloqueada até aprovação final explícita deste documento.
- **28/07/2026** — Aprovação final concedida; implementação de AD-007/AD-010 autorizada e executada nos termos exatos desta ADR. Concluída com 3 achados reais corrigidos durante a validação (import de `express` quebrando o Vitest; RLS em `whatsapp_integration` quebrando `WhatsAppMessageProvider` — revertida via migration corretiva; bug de teste próprio com `??`) e 1 achado adicional sinalizado e implementado (`PatientRepository.findByPhone()`, fora dos 8 princípios originais, necessário para qualquer intent de ação funcionar de verdade). Validação completa: build/lint limpos, 499/499 testes unitários, 177/178 testes críticos (1 skip pré-existente). AD-027 permanece pendente (credenciais reais da Meta). Nenhum commit realizado — aguardando aprovação. Ver `docs/AD-007-AD-010-RELATORIO-HANDOFF.md` para o relatório completo.

## Considerações Finais

Esta ADR fecha o desenho técnico de Epic 8 dentro das restrições aprovadas: reaproveita integralmente PD-007 e a fatia mínima de PD-008, sem máquina de estados de conversa, sem escalonamento, sem DLQ, sem tocar o fluxo de saída existente. O único elemento novo em relação aos 8 princípios originalmente aprovados é `PatientRepository.findByPhone()` (§2.4), sinalizado explicitamente porque, sem ele, nenhum intent de ação teria efeito real sobre uma mensagem recebida de verdade — a "entrada real" do WhatsApp existiria em nome, não na prática. Nenhuma implementação de código deve começar até a aprovação final explícita deste documento.
