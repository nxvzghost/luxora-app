# 02 - Contratos de Integrações Externas

**Origem:** Fase 3 da auditoria técnica de 04/10/2026 (Integrações reais), 5 de outubro de 2026.

Contrato mínimo de cada serviço externo que o backend chama ou do qual recebe chamadas: Meta (WhatsApp), Anthropic e Asaas. Cada seção descreve o que o código faz hoje, conferido no próprio código e nos testes citados. O que ainda não foi exercitado contra o serviço real está dito como tal.

---

## Situação da validação

| Integração | Entrada | Saída | Provider | Credencial | Ambiente local | Estado | Efeito externo |
|---|---|---|---|---|---|---|---|
| Meta / WhatsApp | `POST /api/v1/webhooks/whatsapp` | Graph API `POST /{phone-number-id}/messages` | `WhatsAppMessageProvider` | Token por clínica, cifrado em `whatsapp_integration`; App Secret e Verify Token no ambiente | Nenhuma clínica conectada; App Secret local não é o de um App da Meta | **Bloqueada por credencial** — fluxo interno validado com `fetch` interceptado | Mensagem entregue a um telefone |
| Anthropic | — | `POST https://api.anthropic.com/v1/messages` (3 chamadas por turno) | `AnthropicAIProvider`, `AnthropicContactIntentClassifier` | `ANTHROPIC_API_KEY` | Variável vazia | **Bloqueada por credencial** — fluxo interno validado com `fetch` interceptado | Custo por token |
| Asaas | `POST /api/v1/webhooks/asaas` | `POST /customers`, `POST /subscriptions`, `PUT /subscriptions/{id}/creditCard`, `DELETE /subscriptions/{id}` | `AsaasPaymentProvider` | `ASAAS_API_KEY` (saída) e `ASAAS_WEBHOOK_TOKEN` (entrada) | `ASAAS_ENV=sandbox`, chave vazia | **Bloqueada por credencial** — webhook validado ponta a ponta no banco; chamadas de saída só com `fetch` interceptado | Cliente, assinatura e cobrança |

Nenhuma das três foi chamada de verdade até aqui. Os testes em `apps/backend/test/manual/` fazem essa chamada assim que a credencial de teste existir (ver "Smoke tests reais").

---

## Meta / WhatsApp

### Entrada (webhook)

Fluxo: Meta → `WhatsAppWebhookController` → `WhatsAppWebhookGuard` (HMAC) → `ReceberMensagemWhatsAppUseCase` (clínica, Contact, Conversation, Message) → fila `whatsapp-inbound` → `WhatsAppInboundQueueWorker` → `ProcessarMensagemWhatsAppUseCase` (IA) → fila `messages`.

- **Verificação (GET):** responde `hub.challenge` em texto puro quando `hub.mode=subscribe` e `hub.verify_token` é igual a `WHATSAPP_WEBHOOK_VERIFY_TOKEN`; caso contrário 403.
- **Autenticação (POST):** HMAC-SHA256 do corpo bruto com `WHATSAPP_APP_SECRET`, header `X-Hub-Signature-256`, comparação em tempo constante. Sem header ou com assinatura diferente: 401. O App Secret é um por App da Meta, não por clínica.
- **Clínica:** resolvida por `metadata.phone_number_id` (índice único global em `whatsapp_integration`), por mensagem — um mesmo POST pode trazer mensagens de clínicas diferentes. Número desconhecido ou integração inativa: ignorado, resposta 200.
- **Conteúdo aceito:** só mensagens `type: "text"`. Áudio, imagem, botões e os eventos `statuses[]` (entregue/lida) são ignorados em silêncio.
- **Resposta:** 200 assim que a mensagem está gravada e enfileirada; a IA nunca segura a resposta.

**Idempotência.** Três barreiras, todas pelo id da mensagem na Meta (WAMID): consulta a `message.external_id` antes de gravar (índice único global), `jobId` do BullMQ igual ao WAMID, e a tabela `inbound_processing_inbox` (ADR-0054), que impede a IA de ser chamada duas vezes para a mesma mensagem.

**Ordem.** Não há reordenação: cada mensagem é processada na ordem em que seu job é consumido. Duas mensagens seguidas do mesmo paciente podem ser respondidas fora de ordem.

**Falhas.** Erro na parte síncrona → 500, e a Meta reenvia o POST inteiro; as mensagens já gravadas são reconhecidas pelo WAMID. Erro no processamento assíncrono → 3 tentativas com espera exponencial (2 s, 4 s); esgotadas, a mensagem fica sem resposta e o registro em `inbound_processing_inbox` fica como `failed`. Não há alerta para isso.

### Saída (envio)

Fluxo: Use Case → `MessageQueueProducer` → fila `messages` → `MessageQueueWorker` → `EnviarMensagemUseCase` → `WhatsAppMessageProvider` → Graph API v19.0. Decisão registrada na [ADR-0058](../02-Arquitetura/ADRs/ADR-0058-worker-de-saida-whatsapp.md).

- **Payload do job:** `tenantId`, `toPhoneNumber`, `body`, `idempotencyKey`, `correlationId` opcional. O `tenantId` é a única identidade do job e vem sempre do contexto já autenticado de quem enfileira.
- **Credencial:** a integração é buscada pelo `tenantId` do job; o token é decifrado só no momento da chamada. Clínica sem integração ativa não envia nada.
- **Chamada:** `Authorization: Bearer <token da clínica>`, corpo `{ messaging_product, to, type: "text", text.body }`, tempo limite de 10 s (`WHATSAPP_PROVIDER_TIMEOUT_MS`).
- **Sucesso:** qualquer 2xx. O id da mensagem (`messages[0].id`) é gravado em `message_log.provider_message_id`.

**Erros e repetição.**

| Situação | Classificação | O que acontece |
|---|---|---|
| Falha de rede, tempo limite | Repetível | Até 3 tentativas (2 s, 4 s) |
| HTTP 429, 5xx | Repetível | Até 3 tentativas |
| HTTP 400, 401, 403, 404 e demais 4xx | Permanente | Job encerrado na 1ª tentativa |
| Clínica sem canal conectado, token que não decifra | Permanente | Job encerrado, nenhuma chamada externa |
| Payload sem `tenantId` válido | Permanente | Job descartado, nenhuma chamada externa |

**Idempotência.** `jobId` do BullMQ igual à `idempotencyKey`; consulta a `message_log` antes de enviar; índice único em `message_log.idempotency_key`. A Graph API **não aceita chave de idempotência**: a garantia é toda do lado da Luxora.

**Limite conhecido — entrega "ao menos uma vez".** Se o envio é aceito pela Meta e a gravação em `message_log` falha logo depois (banco fora, processo morto), a nova tentativa não encontra o registro e envia de novo. A janela é de milissegundos, mas existe. Fechá-la exige escolher entre gravar antes de enviar (risco de mensagem perdida) e manter o comportamento atual (risco de mensagem repetida) — decisão registrada como pendente na ADR-0058.

**Outros limites.** Um job que falhou em definitivo continua no Redis com o mesmo id; reenfileirar a mesma `idempotencyKey` não o reexecuta. Jobs concluídos também ficam no Redis sem prazo de expiração, com telefone e texto no payload.

### Segurança

Token da clínica cifrado em repouso (AES-256-GCM, ADR-0049). A mensagem de erro do envio traz só `code`, `subcode`, `type` e `fbtrace_id` da Meta — nunca o texto livre devolvido, o token, o telefone ou o conteúdo da mensagem. O worker não registra `job.data`.

### Observabilidade

`correlationId` nasce no middleware HTTP, viaja no payload dos dois jobs e chega ao header `X-Correlation-Id` da chamada à Graph API e das três chamadas de IA. Id do provider: `fbtrace_id` (em erro) e WAMID (em sucesso, em `message_log`).

### Testes

`test/critical/whatsapp-webhook.test.ts`, `whatsapp-inbound-idempotency.test.ts`, `whatsapp-outbound-worker.test.ts`, `whatsapp-token-encryption.test.ts`; `test/unit/infrastructure/messaging/whatsapp-message.provider.test.ts`.

---

## Anthropic

### Saída

Um turno de conversa faz até 3 chamadas a `POST /v1/messages`, sempre de dentro do `WhatsAppInboundQueueWorker`:

| Chamada | Provider | `max_tokens` | Para quê |
|---|---|---|---|
| `interpretIntent` | `AnthropicAIProvider` | 300 | Classificar a intenção da mensagem (JSON) |
| `classify` | `AnthropicContactIntentClassifier` | 200 | Decidir o vínculo de identidade do Contact (JSON) |
| `generateResponse` | `AnthropicAIProvider` | 500 | Redigir a resposta ao paciente |

Modelo: `AI_MODEL` (padrão `claude-haiku-4-5-20251001`). Autenticação: header `x-api-key` com `ANTHROPIC_API_KEY`. Tempo limite de 8 s por chamada (`AI_PROVIDER_TIMEOUT_MS`, `CONTACT_CLASSIFIER_TIMEOUT_MS`).

### Dados enviados ao provider

Conferido no código (`anthropic-ai.provider.ts`, `anthropic-contact-intent-classifier.ts`, `system-prompt.builder.ts`, `contact-intent-prompt-builder.ts`, `intent-action-router.ts`):

| Dado | Vai? | Onde |
|---|---|---|
| Texto das mensagens do paciente — **toda** a conversa, sem limite de tamanho | Sim | `messages`, nas 3 chamadas |
| Respostas anteriores do agente | Sim | `messages` |
| Nome da clínica e nomes dos terapeutas | Sim | Prompt de sistema de `generateResponse` |
| Resultado de ação executada: data e hora da consulta, horários livres, valor e estado da cobrança, nome do paciente recém-cadastrado | Sim | `messages` de `generateResponse` |
| Estado do Contact e número de pacientes vinculados | Sim | Prompt de sistema de `classify` |
| Telefone, CPF, e-mail, endereço | Não | — |
| `tenantId`, `patientId`, `contactId` | Não | — |
| Prontuário ou qualquer registro clínico do sistema | Não | — |
| Tokens e chaves | Não | — |

Dois pontos de atenção:

- O texto do paciente é livre. O sistema não envia dado clínico, mas não tem como impedir que o próprio paciente escreva algo sensível, e esse texto segue para o provider como está.
- O histórico enviado cresce sem limite: cada turno reenvia a conversa inteira nas 3 chamadas. O custo por turno cresce com a idade da conversa.

### Resposta e erros

| Situação | Classificação | O que acontece |
|---|---|---|
| Falha de rede, tempo limite, 5xx | Repetível | 2 tentativas dentro da chamada |
| 4xx (inclui 401 e 429) | Não repetida dentro da chamada | Erro sobe para o job |
| 2xx com corpo ilegível | Não repetida | Erro sobe para o job |
| `interpretIntent` devolve texto que não é JSON | — | Tratado como `intent: "outro"`, com escalonamento |
| `classify` falha por qualquer motivo | — | Decisão `HUMANO` |

Erro que sobe para o job entra na política da fila `whatsapp-inbound`: 3 tentativas com espera exponencial. Um 429 ou um 401 portanto geram até 3 execuções do job; nenhuma delas produz efeito externo.

**A IA não decide.** O modelo devolve um rótulo e um texto. Quem executa (agendar, cancelar, cadastrar, associar) é `IntentActionRouter` / `ContactIntentActionRouter`, através dos Use Cases, e só quando o próprio modelo não pediu escalonamento. Resposta inválida do modelo nunca chega ao domínio.

### Idempotência

A API da Anthropic não tem efeito colateral além do custo. A repetição é contida pela `inbound_processing_inbox`: depois que a resposta foi gerada e gravada, um novo processamento do mesmo job só reenvia, sem chamar a IA de novo (ADR-0054).

### Custo e observabilidade

`MetricsService` registra por tipo de chamada: total, duração, novas tentativas, tempos limite e custo estimado em reais (US$ 1,00 e US$ 5,00 por milhão de tokens de entrada e saída, câmbio fixo de R$ 5,50). O custo do turno é somado e gera aviso em log a partir de 70 % do teto de R$ 0,25. Nenhum prompt ou resposta é registrado em log. `correlationId` vai no header `X-Correlation-Id`.

### Testes

`test/unit/infrastructure/ai/*.test.ts`, `test/unit/use-cases/ai/*.test.ts`, `test/critical/whatsapp-inbound-idempotency.test.ts` (as 3 chamadas, com `fetch` interceptado).

---

## Asaas

### Saída

| Operação | Chamada | Quando |
|---|---|---|
| Criar cliente | `POST /customers` | `CriarAssinaturaUseCase` |
| Criar assinatura | `POST /subscriptions` | `CriarAssinaturaUseCase`, logo depois |
| Anexar cartão | `PUT /subscriptions/{id}/creditCard` | `AnexarCartaoUseCase` |
| Cancelar | `DELETE /subscriptions/{id}` | Implementado no provider; nenhum Use Case chama hoje |

Autenticação: header `access_token` com `ASAAS_API_KEY`. Endereço: `ASAAS_BASE_URL` (padrão do código: sandbox). Sem tempo limite configurado. Qualquer resposta fora de 2xx vira erro; o corpo devolvido entra na mensagem só depois de mascarado (dados de cartão) e cortado em 500 caracteres. Não há repetição automática: as chamadas acontecem dentro da requisição do usuário.

**Idempotência.** A Luxora recusa criar uma segunda assinatura para a clínica que já tem uma ativa ou em trial. A API da Asaas não recebe chave de idempotência nestas chamadas. Se `POST /subscriptions` falhar depois de `POST /customers` ter dado certo, o cliente fica criado na Asaas sem assinatura, e uma nova tentativa cria outro cliente.

### Entrada (webhook)

Fluxo: Asaas → `WebhookController` → `AsaasWebhookGuard` → `ProcessarWebhookAssinaturaUseCase` → assinatura localizada por `asaas_subscription_id` → mudança de estado → auditoria → `asaas_webhook_event`.

- **Autenticação:** header `asaas-access-token` igual a `ASAAS_WEBHOOK_TOKEN` (valor próprio, nunca a chave da API). É o mecanismo que a Asaas oferece; não há assinatura HMAC do corpo. Token ausente ou diferente: 401.
- **Clínica:** vem da assinatura encontrada pelo id da Asaas (índice único). `clinic_subscription` não tem RLS por desenho — o webhook precisa achar a assinatura antes de conhecer a clínica.
- **Eventos tratados:** `PAYMENT_CONFIRMED` e `PAYMENT_RECEIVED` (ativa ou renova), `PAYMENT_OVERDUE` (em atraso), `SUBSCRIPTION_DELETED` (cancelada).
- **Resposta 200 sem efeito:** evento de tipo desconhecido, assinatura que não existe na Luxora, evento já processado, corpo sem `id` ou sem `event`.

**Idempotência.** Pelo `id` do evento, em `asaas_webhook_event` (índice único). Reentrega não altera a assinatura nem gera nova auditoria.

**Limites conhecidos.**

- A verificação e o registro do evento não são atômicos. Duas entregas **simultâneas** do mesmo evento podem ser processadas duas vezes (auditoria duplicada; a segunda responde 500). A Asaas entrega os eventos em fila, um de cada vez, então o caso depende de comportamento anormal do lado dela.
- Não há tratamento de ordem. Um `PAYMENT_OVERDUE` antigo que chegue depois de um `PAYMENT_CONFIRMED` coloca a assinatura em atraso.
- O token é comparado com `!==`, não em tempo constante.

### Cartão

Número e código de segurança passam pelo backend a caminho da Asaas (`AnexarCartaoUseCase`). Não são gravados, não entram em auditoria nem em log, e a resposta de erro da Asaas é mascarada — coberto por `test/critical/card-data-exposure.test.ts`. O modelo em si (cartão trafegando pelo backend) continua aguardando decisão arquitetural; nada foi alterado nesta fase.

### Testes

`test/critical/asaas-webhook.test.ts`, `card-data-exposure.test.ts`; `test/unit/infrastructure/payment/asaas-payment.provider.test.ts`; `test/unit/use-cases/subscription/*.test.ts`.

---

## Isolamento entre clínicas

| Caminho | O que garante | Teste |
|---|---|---|
| Webhook do WhatsApp | Clínica resolvida por `phone_number_id` único; gravação sob RLS | `whatsapp-webhook.test.ts` |
| Job de saída | Credencial buscada pelo `tenantId` do job; `message_log` sob RLS | `whatsapp-outbound-worker.test.ts` |
| Contact e Conversation | RLS por clínica; o mesmo telefone gera Contact e Conversation separados em cada clínica | `whatsapp-inbound-idempotency.test.ts` (teste de isolamento), `test/integration/database/prisma-contact.repository.test.ts` |
| Contexto enviado à IA | Histórico, nome da clínica e terapeutas lidos sob a RLS da clínica do job | `whatsapp-inbound-idempotency.test.ts` (teste de isolamento) |
| Webhook da Asaas | Assinatura localizada por id único da Asaas | `asaas-webhook.test.ts` |

O payload dos jobs é confiável por construção: só o backend escreve no Redis. Quem conseguir escrever no Redis consegue enviar mensagens em nome de qualquer clínica conectada — o Redis precisa ficar em rede privada, com senha.

---

## Smoke tests reais

Ficam em `apps/backend/test/manual/`, rodam só com `pnpm --filter @luxora/backend test:manual` e pulam sozinhos quando a credencial não existe. Passo a passo em [`test/manual/README.md`](../../apps/backend/test/manual/README.md).

| Arquivo | Chama | Exige |
|---|---|---|
| `whatsapp-smoke.test.ts` | Graph API, 1 mensagem | Número de teste, token temporário e destinatário autorizado do App da Meta |
| `anthropic-smoke.test.ts` | Anthropic, 3 chamadas com conteúdo sintético | `ANTHROPIC_SMOKE=1` e `ANTHROPIC_API_KEY` |
| `asaas-sandbox-smoke.test.ts` | Asaas sandbox: cliente, assinatura PIX, cancelamento | `ASAAS_ENV=sandbox`, endereço de sandbox e chave de sandbox |
| `asaas-production-smoke.test.ts` | Asaas **produção** (anterior a esta fase) | `ASAAS_ENV=production` e chave de produção |

A entrada real (Meta → webhook → Luxora, Asaas → webhook → Luxora) exige um endereço público apontando para o backend. Isso depende de infraestrutura e fica para a Fase 4.

## Testes e CI

| Tipo | Onde | Rede externa | Credencial | No CI |
|---|---|---|---|---|
| Unitário | `test/unit` | Não | Não | Sim |
| Integração | `test/integration` | Não (Postgres local) | Não | Sim |
| Crítico / contrato | `test/critical` | Não (`fetch` interceptado; Postgres e Redis locais) | Não | Sim |
| Smoke real | `test/manual` | Sim | Sim | **Não** |

Nenhuma credencial de provider foi cadastrada no CI. Levar um smoke real para lá exige decidir antes qual conta paga a chamada, com que frequência roda e o que acontece quando o provider está fora do ar — a suíte obrigatória não pode depender disso.
