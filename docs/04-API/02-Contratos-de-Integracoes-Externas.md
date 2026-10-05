# 02 - Contratos de Integrações Externas

**Origem:** Fase 3 da auditoria técnica de 04/10/2026 (Integrações reais). Escrito em 5 de outubro de 2026 e revisado no mesmo dia, no fechamento da fase e na Fase 3B (preparação para os testes externos).

Contrato mínimo de cada serviço externo que o backend chama ou do qual recebe chamadas: Meta (WhatsApp), Anthropic e Asaas. Cada seção descreve o que o código faz hoje, conferido no próprio código, nos testes citados e na documentação oficial de cada provider.

---

## Situação da validação

Os termos abaixo têm sentido fixo neste documento:

| Termo | Significa |
|---|---|
| **VALIDADO LOCALMENTE** | Código real contra Postgres, Redis e BullMQ reais na máquina; o serviço externo não participa (webhook com corpo controlado) |
| **VALIDADO COM MOCK** | O serviço externo é simulado (`fetch` interceptado) |
| **VALIDADO EM SANDBOX** | Chamada real ao ambiente de testes do provider |
| **VALIDADO CONTRA API REAL** | Chamada real ao serviço do provider |
| **BLOQUEADO POR CREDENCIAL** | Falta credencial de teste no ambiente local |
| **BLOQUEADO POR DECISÃO** | Depende de uma decisão registrada em "Decisões pendentes" |

| Integração | O quê | Estado |
|---|---|---|
| Meta | Webhook: verificação, HMAC, clínica, deduplicação, corpo no formato documentado pela Meta | VALIDADO LOCALMENTE |
| Meta | Webhook: evento enviado pela própria Meta | BLOQUEADO POR CREDENCIAL (App Secret e número de teste) e POR DECISÃO (exige endereço público — D9) |
| Meta | Envio: produtor → Redis → worker → Use Case → provider, com as respostas 200, 401, 429, 500 e 503 | VALIDADO LOCALMENTE e COM MOCK |
| Meta | Envio: token inválido recusado, pela cadeia completa da fila | **VALIDADO CONTRA API REAL** (401, código 190) |
| Meta | Envio: mensagem aceita e entregue | BLOQUEADO POR CREDENCIAL |
| Anthropic | As 3 chamadas do turno; tempo limite, nova tentativa, 5xx, resposta inválida, indisponibilidade | VALIDADO COM MOCK |
| Anthropic | Chave inválida recusada, sem nova tentativa | **VALIDADO CONTRA API REAL** (401, `authentication_error`) |
| Anthropic | Chamada bem-sucedida (formato real da resposta do modelo, tokens, custo) | BLOQUEADO POR CREDENCIAL |
| Asaas | Webhook: token, mudança de estado, idempotência, isolamento, corpo inválido, evento que não cabe no estado | VALIDADO LOCALMENTE |
| Asaas | Webhook: evento enviado pela própria Asaas | BLOQUEADO POR CREDENCIAL (conta sandbox) e POR DECISÃO (endereço público — D9) |
| Asaas | Saída: cliente, assinatura, cartão, cancelamento | VALIDADO COM MOCK |
| Asaas | Saída: chave inválida recusada | **VALIDADO EM SANDBOX** (401, `invalid_access_token`) |
| Asaas | Saída: cliente, assinatura e cobrança de teste | BLOQUEADO POR CREDENCIAL e POR DECISÃO (política de sandbox — D4) |

**Nenhum caminho feliz foi exercitado contra um serviço real.** As únicas chamadas reais feitas até aqui usam uma credencial inválida de propósito: provam que o endereço responde, que o corpo de erro verdadeiro é lido pelo nosso código e que a falha é classificada como permanente. O ambiente local não tem credencial de teste de nenhum dos três providers.

---

## Meta / WhatsApp

### Entrada (webhook)

Fluxo: Meta → `WhatsAppWebhookController` → `WhatsAppWebhookGuard` (HMAC) → `ReceberMensagemWhatsAppUseCase` (clínica, Contact, Conversation, Message) → fila `whatsapp-inbound` → `WhatsAppInboundQueueWorker` → `ProcessarMensagemWhatsAppUseCase` (IA) → fila `messages`.

- **Verificação (GET):** responde `hub.challenge` em texto puro quando `hub.mode=subscribe` e `hub.verify_token` é igual a `WHATSAPP_WEBHOOK_VERIFY_TOKEN`; caso contrário 403.
- **Autenticação (POST):** HMAC-SHA256 do corpo bruto com `WHATSAPP_APP_SECRET`, header `X-Hub-Signature-256`, comparação em tempo constante. Sem header ou com assinatura diferente: 401. O App Secret é um por App da Meta, não por clínica.
- **Clínica:** resolvida por `metadata.phone_number_id` (índice único global em `whatsapp_integration`), por mensagem — um mesmo POST pode trazer mensagens de clínicas diferentes. Número desconhecido ou integração inativa: ignorado, resposta 200.
- **Corpo:** o envelope completo da Meta (`object`, `entry[].id`, `contacts`, `timestamp`, `field`) é aceito; campos que o backend não usa são ignorados.
- **Conteúdo tratado:** só mensagens `type: "text"`. Áudio, imagem, botões e as notificações `statuses[]` (enviada, entregue, lida) são confirmados com 200 e ignorados.
- **Resposta:** 200 assim que a mensagem está gravada e enfileirada; a IA nunca segura a resposta.

**Telefone do remetente** ([ADR-0059](../02-Arquitetura/ADRs/ADR-0059-normalizacao-unica-de-telefone.md)). A Meta envia `messages[].from` só em dígitos, com o código do país e sem "+" (`5541…`). `Conversation.phoneNumber` guarda esse valor como veio; `Contact` guarda a forma normalizada (`+5541…`). O paciente já cadastrado e a conversa já aberta são encontrados pela forma normalizada do número, qualquer que seja a grafia gravada (`+55…`, só dígitos, com máscara, com ou sem o código do país); nada gravado é reescrito. Remetente que não é um telefone do Brasil é confirmado com 200 e ignorado, sem interromper as outras mensagens do mesmo POST.

**Idempotência.** Três barreiras, todas pelo id da mensagem na Meta (WAMID): consulta a `message.external_id` antes de gravar (índice único global), `jobId` do BullMQ igual ao WAMID, e a tabela `inbound_processing_inbox` (ADR-0054), que impede a IA de ser chamada duas vezes para a mesma mensagem.

**Ordem.** Não há reordenação: cada mensagem é processada na ordem em que seu job é consumido. Duas mensagens seguidas do mesmo paciente podem ser respondidas fora de ordem.

**Falhas.** Erro na parte síncrona → 500, e a Meta reenvia o POST inteiro; as mensagens já gravadas são reconhecidas pelo WAMID. Erro no processamento assíncrono → 3 tentativas com espera exponencial (2 s, 4 s); esgotadas, a mensagem fica sem resposta e o registro em `inbound_processing_inbox` fica como `failed`. Não há alerta para isso.

### Saída (envio)

Fluxo: Use Case → `MessageQueueProducer` → fila `messages` → `MessageQueueWorker` → `EnviarMensagemUseCase` → `WhatsAppMessageProvider` → Graph API. Decisão registrada na [ADR-0058](../02-Arquitetura/ADRs/ADR-0058-worker-de-saida-whatsapp.md).

- **Payload do job:** `tenantId`, `toPhoneNumber`, `body`, `idempotencyKey`, `correlationId` opcional. O `tenantId` é a única identidade do job e vem sempre do contexto já autenticado de quem enfileira.
- **Credencial:** a integração é buscada pelo `tenantId` do job; o token é decifrado só no momento da chamada. Clínica sem integração ativa não envia nada.
- **Chamada:** `POST /{phone-number-id}/messages`, `Authorization: Bearer <token da clínica>`, corpo `{ messaging_product, to, type: "text", text.body }`, tempo limite de 10 s (`WHATSAPP_PROVIDER_TIMEOUT_MS`).
- **Sucesso:** qualquer 2xx. O id da mensagem (`messages[0].id`) é gravado em `message_log.provider_message_id`.

**Versão da Graph API.** Fixada em `v21.0`, num único ponto (`src/infrastructure/messaging/whatsapp-graph-api.ts`). Até a Fase 3B o código pedia `v19.0`, expirada em 21/05/2026; a Meta não devolve erro para versão expirada, atende com a mais antiga ainda disponível — que era a `v21.0` (medido em 05/10/2026). Fixar a `v21.0` tornou explícito o que já acontecia, sem mudar o comportamento. **Ela expira em 21/01/2027.** Um teste unitário falha quando essa data chega e quando outro arquivo escreve uma versão por conta própria; o smoke externo falha se a Meta servir uma versão diferente da pedida.

**Erros e repetição.**

| Situação | Classificação | O que acontece | Validado |
|---|---|---|---|
| Falha de rede, tempo limite | Repetível | Até 3 tentativas (2 s, 4 s) | Com mock |
| HTTP 429 | Repetível | Até 3 tentativas | Com mock |
| HTTP 5xx | Repetível | Até 3 tentativas; a 3ª falha encerra o job | Com mock |
| HTTP 401 (token inválido ou expirado) | Permanente | Job encerrado na 1ª tentativa | Contra a API real |
| HTTP 400, 403, 404 e demais 4xx | Permanente | Job encerrado na 1ª tentativa | Com mock |
| Clínica sem canal conectado, token que não decifra | Permanente | Job encerrado, nenhuma chamada externa | Localmente |
| Payload sem `tenantId` válido | Permanente | Job descartado, nenhuma chamada externa | Localmente |

A espera entre tentativas é de 2 s e 4 s. Se a resposta repetível (429 ou 5xx) trouxer o cabeçalho `Retry-After`, a espera passa a ser a que o provider pediu, nunca menor que a padrão daquela tentativa e nunca maior que 60 s; o número de tentativas não muda. A Meta não documenta `Retry-After` para os limites da Cloud API — o suporte é defensivo, usa o cabeçalho se ele vier.

**Idempotência.** `jobId` do BullMQ igual à `idempotencyKey`; consulta a `message_log` antes de enviar; índice único em `message_log.idempotency_key`. A Graph API **não aceita chave de idempotência**: a garantia é toda do lado da Luxora.

**Política de entrega: AT-LEAST-ONCE.** O envio acontece antes da gravação em `message_log`. Se a gravação falhar depois de a Meta aceitar a mensagem, a nova tentativa envia de novo: a mensagem pode chegar repetida, mas não se perde em silêncio dentro das garantias atuais. Não existe "exatamente uma vez" com a Graph API. Análise das alternativas na ADR-0058 (D1).

**Outros limites.** Um job que falhou em definitivo continua no Redis com o mesmo id; reenfileirar a mesma `idempotencyKey` não o reexecuta. Ver também "Redis".

### Segurança

Token da clínica cifrado em repouso (AES-256-GCM, ADR-0049). A mensagem de erro do envio traz só `code`, `subcode`, `type` e `fbtrace_id` da Meta — nunca o texto livre devolvido, o token, o telefone ou o conteúdo da mensagem. O worker não registra `job.data`.

### Observabilidade

`correlationId` nasce no middleware HTTP, viaja no payload dos dois jobs e chega ao header `X-Correlation-Id` da chamada à Graph API e das três chamadas de IA. Id do provider: `fbtrace_id` (em erro) e WAMID (em sucesso, em `message_log`).

### Testes

`test/critical/whatsapp-webhook.test.ts` (inclui o corpo no formato da Meta), `whatsapp-inbound-idempotency.test.ts`, `whatsapp-outbound-worker.test.ts`, `whatsapp-token-encryption.test.ts`; `test/unit/infrastructure/messaging/whatsapp-message.provider.test.ts`; `test/manual/whatsapp-worker-smoke.test.ts` e `providers-rejection-smoke.test.ts` (API real).

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

Conferido no código (`anthropic-ai.provider.ts`, `anthropic-contact-intent-classifier.ts`, `system-prompt.builder.ts`, `contact-intent-prompt-builder.ts`, `intent-action-router.ts`, `contact-intent-action-router.ts`):

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

O texto do paciente é livre. O sistema não envia dado clínico, mas não tem como impedir que o próprio paciente escreva algo sensível, e esse texto segue para o provider como está — e volta a ser enviado em todos os turnos seguintes, porque o histórico não tem limite (D2).

### Resposta e erros

| Situação | Classificação | O que acontece | Validado |
|---|---|---|---|
| Falha de rede, tempo limite, 5xx | Repetível | 2 tentativas dentro da chamada | Com mock |
| 401 (chave inválida) | Não repetida dentro da chamada | Erro sobe para o job | Contra a API real |
| Demais 4xx (inclui 429) | Não repetida dentro da chamada | Erro sobe para o job | Com mock |
| 2xx com corpo ilegível | Não repetida | Erro sobe para o job | Com mock |
| `interpretIntent` devolve texto que não é JSON | — | Tratado como `intent: "outro"`, com escalonamento | Com mock |
| `classify` falha por qualquer motivo | — | Decisão `HUMANO` | Com mock |

Erro que sobe para o job entra na política da fila `whatsapp-inbound`: 3 tentativas com espera exponencial. Um 429 ou um 401 portanto geram até 3 execuções do job; nenhuma delas produz efeito externo.

O que só uma chamada bem-sucedida revela, e continua sem verificação: se o modelo real devolve o JSON de intenção puro ou embrulhado (cerca de código, texto em volta). Embrulhado, o parser cai no ramo de segurança e escala toda mensagem para atendimento humano.

**A IA não decide.** O modelo devolve um rótulo e um texto. Quem executa (agendar, cancelar, cadastrar, associar) é `IntentActionRouter` / `ContactIntentActionRouter`, através dos Use Cases, e só quando o próprio modelo não pediu escalonamento. Resposta inválida do modelo nunca chega ao domínio.

### Idempotência

A API da Anthropic não tem efeito colateral além do custo. A repetição é contida pela `inbound_processing_inbox`: depois que a resposta foi gerada e gravada, um novo processamento do mesmo job só reenvia, sem chamar a IA de novo (ADR-0054).

### Custo e observabilidade

`MetricsService` registra por tipo de chamada: total, duração, novas tentativas, tempos limite e custo estimado em reais (US$ 1,00 e US$ 5,00 por milhão de tokens de entrada e saída, câmbio fixo de R$ 5,50). O custo do turno é somado e gera aviso em log a partir de 70 % de R$ 0,25. Nenhum prompt ou resposta é registrado em log. `correlationId` vai no header `X-Correlation-Id`; em erro, o `request_id` da Anthropic aparece na mensagem.

Dois detalhes do teto, encontrados nesta fase e não alterados: o valor é fixo no código (a variável `AI_COST_CEILING_PER_CONVERSATION` do `.env.example` não é lida), e o "teto por conversa" é comparado com o custo de **um turno**, não da conversa.

### Testes

`test/unit/infrastructure/ai/*.test.ts`, `test/unit/use-cases/ai/*.test.ts`, `test/critical/whatsapp-inbound-idempotency.test.ts` (as 3 chamadas, com `fetch` interceptado, e o isolamento entre clínicas); `test/manual/anthropic-smoke.test.ts` e `providers-rejection-smoke.test.ts` (API real).

---

## Asaas

### Saída

| Operação | Chamada | Quando |
|---|---|---|
| Criar cliente | `POST /customers` | `CriarAssinaturaUseCase` |
| Criar assinatura | `POST /subscriptions` | `CriarAssinaturaUseCase`, logo depois |
| Anexar cartão | `PUT /subscriptions/{id}/creditCard` | `AnexarCartaoUseCase` |
| Cancelar | `DELETE /subscriptions/{id}` | Implementado no provider; nenhum Use Case chama hoje |

Headers: `access_token` com `ASAAS_API_KEY` (a Asaas não usa `Authorization: Bearer`) e `User-Agent: Luxora-Backend (Node.js; <ASAAS_ENV>)` — a Asaas exige um `User-Agent` que identifique a aplicação em contas criadas a partir de 13/06/2024. Endereço: `ASAAS_BASE_URL` (padrão do código: sandbox). Chaves de sandbox começam com `$aact_hmlg_`; as de produção, com `$aact_prod_`.

Sem tempo limite configurado. Qualquer resposta fora de 2xx vira erro; o corpo devolvido entra na mensagem só depois de mascarado (dados de cartão) e cortado em 500 caracteres. Não há repetição automática: as chamadas acontecem dentro da requisição do usuário.

**Idempotência.** A Luxora recusa criar uma segunda assinatura para a clínica que já tem uma ativa ou em trial. A API da Asaas não recebe chave de idempotência nestas chamadas. Se `POST /subscriptions` falhar depois de `POST /customers` ter dado certo, o cliente fica criado na Asaas sem assinatura, e uma nova tentativa cria outro cliente.

### Entrada (webhook)

Fluxo: Asaas → `WebhookController` → `AsaasWebhookGuard` → `ProcessarWebhookAssinaturaUseCase` → assinatura localizada por `asaas_subscription_id` → mudança de estado → auditoria → `asaas_webhook_event`.

- **Autenticação:** header `asaas-access-token` igual a `ASAAS_WEBHOOK_TOKEN` (valor próprio, nunca a chave da API), comparado em tempo constante. É o mecanismo que a Asaas oferece; não há assinatura HMAC do corpo. Token ausente ou diferente: 401.
- **Clínica:** vem da assinatura encontrada pelo id da Asaas (índice único). `clinic_subscription` não tem RLS por desenho — o webhook precisa achar a assinatura antes de conhecer a clínica.
- **Eventos tratados:** `PAYMENT_CONFIRMED` e `PAYMENT_RECEIVED` (ativa ou renova), `PAYMENT_OVERDUE` (em atraso), `SUBSCRIPTION_DELETED` (cancelada).
- **Resposta 200 sem efeito:** evento de tipo desconhecido, assinatura que não existe na Luxora, evento já processado, corpo sem `id` ou sem `event`, e evento que não cabe no estado atual da assinatura (por exemplo, um pagamento confirmado para uma assinatura já cancelada).

**O que a Asaas garante (documentação oficial).** Entrega "ao menos uma vez": o mesmo evento pode chegar mais de uma vez, e o campo `id` é a chave para não reprocessar. Depois de 15 falhas seguidas a fila do webhook pode ser interrompida — e o webhook é um só, da conta da Luxora, para as assinaturas de todas as clínicas — e eventos parados há mais de 14 dias são apagados. Por isso o webhook nunca responde erro para um evento que ele entendeu mas não tem o que fazer com ele.

**Modo de envio — requisito de configuração.** Ao cadastrar o webhook na Asaas escolhe-se o modo: **sequencial** (a ordem é preservada, um evento por vez) ou **não sequencial** (eventos podem chegar ao mesmo tempo e fora de ordem). Este backend pressupõe o modo **sequencial**; no outro modo os dois limites abaixo deixam de ser teóricos.

**Idempotência.** Pelo `id` do evento, em `asaas_webhook_event` (índice único). Reentrega não altera a assinatura nem gera nova auditoria.

**Limites conhecidos.**

- A verificação e o registro do evento não são atômicos. Duas entregas **simultâneas** do mesmo evento podem ser processadas duas vezes (auditoria duplicada; a segunda responde 500). No modo sequencial isso exige que o processamento demore mais que o tempo de espera da Asaas. Avaliado na Fase 3B como suficiente para o estágio atual — ver D8.
- Não há tratamento de ordem. Um `PAYMENT_OVERDUE` antigo que chegue depois de um `PAYMENT_CONFIRMED` coloca a assinatura em atraso. No modo sequencial a Asaas preserva a ordem.
- `PAYMENT_CONFIRMED` e `PAYMENT_RECEIVED` têm o mesmo efeito (ativar ou renovar). Pela documentação da Asaas, uma mesma cobrança por cartão gera `PAYMENT_CONFIRMED` e, 32 dias depois, `PAYMENT_RECEIVED`; por boleto, os dois em sequência; por PIX, só `PAYMENT_RECEIVED`. Uma única cobrança por cartão conta, portanto, como duas confirmações — com consequência real, analisada em D8. Decisão pendente.
- Estorno, remoção de cobrança e chargeback (`PAYMENT_REFUNDED`, `PAYMENT_DELETED`, `PAYMENT_CHARGEBACK_REQUESTED`) são registrados e ignorados: a assinatura continua ativa.

### Cartão

Número e código de segurança passam pelo backend a caminho da Asaas (`AnexarCartaoUseCase`). Não são gravados, não entram em auditoria nem em log, e a resposta de erro da Asaas é mascarada — coberto por `test/critical/card-data-exposure.test.ts`. O modelo em si (cartão trafegando pelo backend) continua aguardando decisão arquitetural (D3); nada foi alterado.

### Testes

`test/critical/asaas-webhook.test.ts`, `card-data-exposure.test.ts`; `test/unit/api/subscription/asaas-webhook.guard.test.ts`; `test/unit/infrastructure/payment/asaas-payment.provider.test.ts`; `test/unit/use-cases/subscription/*.test.ts`; `test/manual/asaas-sandbox-smoke.test.ts` e `providers-rejection-smoke.test.ts` (sandbox real).

---

## Isolamento entre clínicas

| Caminho | O que garante | Teste |
|---|---|---|
| Webhook do WhatsApp | Clínica resolvida por `phone_number_id` único; gravação sob RLS | `whatsapp-webhook.test.ts` |
| Job de saída | Credencial buscada pelo `tenantId` do job; `message_log` sob RLS | `whatsapp-outbound-worker.test.ts`; com a Meta real, `whatsapp-worker-smoke.test.ts` |
| Contact e Conversation | RLS por clínica; o mesmo telefone gera Contact e Conversation separados em cada clínica | `whatsapp-inbound-idempotency.test.ts` (teste de isolamento), `test/integration/database/prisma-contact.repository.test.ts` |
| Contexto enviado à IA | Histórico, nome da clínica e terapeutas lidos sob a RLS da clínica do job | `whatsapp-inbound-idempotency.test.ts` (teste de isolamento) |
| Webhook da Asaas | Assinatura localizada por id único da Asaas | `asaas-webhook.test.ts` |

O payload dos jobs é confiável por construção: só o backend escreve no Redis. Quem conseguir escrever no Redis consegue enviar mensagens em nome de qualquer clínica conectada — o Redis precisa ficar em rede privada, com senha.

---

## Redis

Auditado em 05/10/2026 (BullMQ 5.80, Redis 7 do `docker-compose`).

- **Retenção (definida na Fase 3B).** Jobs concluídos: 24 horas, nas duas filas. Falhados da fila de saída: 14 dias. Falhados da fila de entrada: 7 dias. Antes não havia retenção nenhuma — o padrão do BullMQ é guardar para sempre, e havia no Redis local jobs de 23/07/2026 sem prazo de expiração. A política vale para jobs enfileirados a partir de agora; a limpeza acontece quando outro job da mesma fila termina, e jobs em espera (nunca processados) não são afetados.
- **O que fica guardado.** Fila de saída: `tenantId`, `toPhoneNumber`, `body`, `idempotencyKey`, `correlationId` — cerca de 1 KB por job. Fila de entrada: `tenantId`, `conversationId`, `patientId`, `externalId`, `message` (o texto do paciente), `correlationId` — cerca de 1,5 KB por job.
- **Crescimento.** O Redis guarda tudo em memória. Para uma clínica com cerca de 250 conversas por mês, a estimativa é da ordem de 1.300 jobs e 1,6 MB por mês, nunca liberados; com 100 clínicas, perto de 2 GB por ano. Estimativa, não medição de produção.
- **A idempotência não depende dessa retenção.** As barreiras duráveis estão no Postgres (`message_log`, `message.external_id`, `inbound_processing_inbox`). O `jobId` no Redis é só a primeira camada.
- **O job falhado é hoje o único rastro de uma falha definitiva** — não há alerta. Apagar cedo demais os falhados tira esse rastro.
- **Configuração local.** Sem limite de memória, política `noeviction` (a que o BullMQ exige), sem senha, porta publicada, cópia periódica em disco dentro do contêiner. Adequado só para desenvolvimento.

Os 14 dias da fila de saída existem porque o job falhado é o único rastro de um envio que não aconteceu; na de entrada o rastro durável já está no Postgres e a cópia no Redis carrega o texto do paciente, por isso 7. Os valores estão em `src/infrastructure/messaging/queue-retention.ts`.

**Bancos lógicos usados em teste.** A Suíte Crítica usa o índice 13 (`test/critical/support/global-setup.ts`), `whatsapp-outbound-worker.test.ts` usa o 14 e os smoke tests manuais usam o 15. Nenhum teste toca o índice 0, onde `pnpm dev` trabalha. Antes desta separação a suíte deixava jobs de saída no índice 0 a cada execução — ver D10.

---

## Decisões pendentes

Nenhuma destas foi tomada pelo código. Cada item traz a recomendação técnica; a escolha é do responsável pelo produto.

**D1 — Mensagem repetida × mensagem perdida. Registrada: AT-LEAST-ONCE.** Não existe "exatamente uma vez" com a Graph API. A política vigente é a que o código já seguia: envia e depois grava — duplicação possível, perda silenciosa evitada dentro das garantias atuais. A janela de duplicação foi reduzida na Fase 3B com o encerramento gracioso (o SIGTERM agora espera o job em andamento). Mudar a política exige decisão explícita; análise na ADR-0058.

**D2 — Histórico enviado à IA.** A `Conversation` é uma só por clínica e telefone, para sempre, e é reenviada inteira nas 3 chamadas de cada turno. Estimativa (cerca de 3 caracteres por token; prompts de sistema somando 4.038 caracteres; cada turno acrescenta por volta de 135 tokens ao histórico; preços do código):

| Turnos anteriores na conversa | Custo estimado do turno |
|---|---|
| 0 | R$ 0,014 |
| 10 | R$ 0,036 |
| 50 | R$ 0,125 |
| 73 | R$ 0,175 — dispara o aviso de 70 % |
| 107 | R$ 0,25 |

Com a premissa de `05-IA/00-Provedor-e-Interface.md` (3 interações por paciente por mês, 2 a 3 turnos cada — cerca de 8 turnos por mês), o custo mensal por paciente sobe cerca de R$ 0,14 a cada mês de relacionamento: R$ 0,17 no primeiro mês, R$ 0,89 no sexto, R$ 1,74 no décimo segundo. O orçamento de IA do plano Professional (R$ 59,70 para cerca de 70 pacientes, ou R$ 0,85 por paciente) é ultrapassado a partir do sexto mês; com 70 pacientes no décimo segundo mês, o custo chega a cerca de R$ 120 por mês, 20 % da mensalidade. São estimativas — não houve chamada real para medir tokens.

Comparação das alternativas pedidas na Fase 3B (mesmas premissas da estimativa acima):

| Opção | Custo por turno | Contexto que o agente mantém | Risco de perder informação | Efeito no comportamento do agente |
|---|---|---|---|---|
| Hoje: histórico inteiro | Cresce sem limite (tabela acima) | Tudo, para sempre | Nenhum | Nenhum; o texto antigo do paciente é reenviado ao provider em todo turno |
| Últimas 20 mensagens | Até R$ 0,036, estável (R$ 0,29 por paciente por mês) | Os últimos 10 turnos | Baixo: uma interação típica tem 2 a 3 turnos. Perde o que foi dito há mais de 10 turnos — por exemplo, uma preferência de horário mencionada semanas antes | Pode perguntar de novo algo já respondido há muito tempo. Consultas e cobranças não se perdem: vêm do sistema, não do histórico |
| Janela de tempo (por exemplo 24 horas) | Cerca de R$ 0,02 numa interação típica; sem teto numa conversa longa no mesmo dia | Só a sessão em curso | Médio: "como combinamos ontem" chega sem o contexto de ontem; uma conversa que atravessa o limite da janela perde o começo | Cada dia começa do zero; mais repetição de perguntas entre um dia e outro |
| Resumo da conversa | Cerca de R$ 0,02 a R$ 0,03, mais uma chamada de IA a cada atualização do resumo | Fatos de longo prazo, na forma resumida | Médio: o resumo pode omitir ou distorcer; o erro se propaga para os turnos seguintes | Mantém a memória, mas passa a depender de um texto gerado pela própria IA. Cria um dado novo, derivado do que o paciente escreveu, que precisa ser guardado (LGPD) |
| Janela de tempo + resumo | Cerca de R$ 0,03 | Sessão em curso literal e o restante resumido | O menor entre as opções com teto | O mais próximo do comportamento atual; é a opção mais complexa e a com mais pontos de falha |

**Não há regra escrita que defina o tamanho do histórico.** `05-IA/00-Provedor-e-Interface.md` calcula o orçamento supondo "histórico curto", sem dizer o que é curto. Por isso nada foi escolhido nem alterado: **decisão pendente**.

Recomendação técnica: começar pelo limite de mensagens combinado com uma janela de tempo — é a mudança pequena, com teto de custo e que reduz o dado enviado ao provider. Resumo só se o produto precisar de memória longa. A retenção das mensagens em si (apagar ou anonimizar) é outra decisão, de LGPD.

**D3 — Checkout do cartão.** Checkout hospedado pela Asaas ou tokenização no navegador. Pendente desde a Fase 2; sem alteração.

**D4 — Sandbox da Asaas.** `CONFIGURACAO_AMBIENTE.md` registra a produção como único ambiente Asaas da Luxora. A Fase 3 exige sandbox primeiro. Sem uma conta de sandbox (gratuita, separada da de produção), a saída para a Asaas continua sem validação real. Recomendação: criar a conta de sandbox e revisar aquele documento.

**D5 — Formato do telefone do paciente. Resolvida na Fase 3B, sem migration ([ADR-0059](../02-Arquitetura/ADRs/ADR-0059-normalizacao-unica-de-telefone.md)).** A busca de paciente e a de conversa passaram a comparar a forma normalizada do telefone, pela mesma regra do `Contact`. Nenhum dado gravado foi alterado e a API de pacientes não mudou. Uma migration (coluna normalizada com índice) é opcional e está descrita na ADR; não foi executada. Restam três pontos, cada um uma decisão própria:

- **D5a — Nono dígito.** O WhatsApp pode entregar o remetente de contas antigas sem o nono dígito; o paciente cadastrado com 9 dígitos não seria reconhecido. A confirmar na primeira entrada real. Comparar também essa variante revê um limite aceito na ADR-0055.
- **D5b — Cadastro duplicado pelo fluxo de identificação.** Mesmo reconhecido pelo telefone, o paciente pode ser cadastrado de novo se a IA classificar a mensagem como primeira identificação: a promoção do Contact não considera o paciente já conhecido. É a lacuna do "Cenário 13" da ADR-0055.
- **D5c — Telefone do destinatário no envio.** Lembretes e resumos usam o telefone do paciente e do terapeuta como estão gravados. Sem o código do país, a Meta pode recusar o envio ou ler os primeiros dígitos como código de outro país. Recomendação: normalizar o destinatário pela mesma regra no momento do envio.

**D6 — Versão da Graph API. Resolvida na Fase 3B; resta uma escolha com prazo.** A versão está fixada em `v21.0`, a que a Meta já vinha servindo, num único ponto e com teste contra regressão. Ela **expira em 21/01/2027**: a partir dessa data o teste unitário falha, de propósito. Trocar por uma versão de vida mais longa é uma alteração de duas linhas, a fazer logo depois do primeiro envio real — quando o smoke externo puder confirmar a versão nova contra a Meta.

**D7 — Retenção de jobs no Redis. Resolvida na Fase 3B.** Concluídos: 24 horas. Falhados: 14 dias na fila de saída, 7 na de entrada. Ver "Redis". Os jobs antigos não foram apagados (D10).

**D8 — Webhook da Asaas.**

*(a) Modo de envio — requisito de configuração.* O webhook precisa ser cadastrado no modo **sequencial**. Registrado em `CONFIGURACAO_AMBIENTE.md`; o smoke do sandbox confere o modo dos webhooks cadastrados.

*(b) Atomicidade — avaliada na Fase 3B: o modo sequencial é suficiente para o estágio atual.* Há uma conta e um webhook; o processamento é síncrono e faz poucas consultas ao banco, na casa dos milissegundos; no modo sequencial a Asaas envia um evento por vez. Uma segunda entrega do mesmo evento ao mesmo tempo só aconteceria se ela desistisse de esperar a resposta da primeira — ou seja, se esse processamento demorasse mais que o tempo de espera dela. Se acontecer, o efeito é uma auditoria duplicada e um 500 na segunda entrega — o estado da assinatura continua correto, porque as transições são as mesmas. Nenhuma migration foi feita. A mudança, se um dia for necessária (por exemplo, ao adotar o modo não sequencial): uma coluna de estado em `asaas_webhook_event` (`processing`, `processed`), reserva do evento por inserção com conflito ignorado, e a mudança de estado da assinatura, a auditoria e a conclusão do evento na mesma transação — o que obriga os repositórios de assinatura e de evento a receberem a transação de fora.

*(c) Qual evento confirma o pagamento — decisão pendente, de negócio.* Estados da assinatura: `Trialing`, `Active`, `PastDue`, `Cancelled`. `PAYMENT_CONFIRMED` e `PAYMENT_RECEIVED` chamam o mesmo método, que ativa a assinatura, recalcula o fim do ciclo para hoje mais um ciclo e, numa renovação, aplica o downgrade agendado.

| Alternativa | Avaliação |
|---|---|
| A — os dois eventos confirmam (hoje) | Correta só para PIX, que gera apenas `PAYMENT_RECEIVED`. Para cartão, a mesma cobrança confirma duas vezes, com 32 dias de intervalo |
| B — só um dos dois confirma | `PAYMENT_CONFIRMED` sozinho deixa o PIX sem confirmação; `PAYMENT_RECEIVED` sozinho atrasa o cartão em 32 dias |
| C — cada cobrança confirma uma única vez, no primeiro dos dois eventos | É a regra coerente com a documentação da Asaas |

O que a alternativa A causa com cartão: (1) uma assinatura em atraso pela mensalidade atual é reativada quando chega a liquidação da mensalidade anterior — fixado em teste de caracterização; (2) num plano anual, o downgrade agendado é aplicado 32 dias depois do pagamento, não no fim do ano; (3) o fim do ciclo é empurrado 32 dias. A alternativa C exige lembrar qual cobrança já foi contabilizada: ou gravar o id da cobrança (coluna nova, com migration), ou decidir pelo meio de pagamento que vem no evento — campo que ainda não foi observado num evento real. Envolve regra de acesso e de cobrança da clínica; **nada foi alterado**. Estorno, remoção de cobrança e chargeback continuam sem efeito sobre a assinatura, também à espera dessa decisão.

**D9 — Entrada real dos webhooks.** A Meta e a Asaas só chamam um endereço público com HTTPS. Expor o backend é atividade da Fase 4. Ou a entrada real é validada lá, em ambiente de homologação, ou se autoriza um túnel temporário para esta fase.

**D10 — Resíduo de testes no Redis local.** O índice 0 guarda 389 jobs de saída e 10 de entrada deixados por execuções de teste desde julho: respostas a mensagens de teste, cobranças de teste e chaves `resend-test-…`. Pertencem a 128 clínicas de teste, das quais 124 já não existem; nenhuma tem canal conectado. Não se identificou valor em nenhum deles, mas apagar é destrutivo e não foi feito. Enquanto estiverem lá, subir o backend contra o índice 0 faz o worker consumi-los (todos falham sem chamada externa). **Antes de conectar um canal real a uma clínica do banco local, a fila precisa ser limpa**: 10 desses jobs são de clínicas que ainda existem e seriam enviados de verdade, para os números de teste.

---

## Pronto para credenciais

Situação em 05/10/2026, ao fim da Fase 3B: o código e os smoke tests estão prontos; nenhuma credencial de teste existe no ambiente local e nenhuma chamada externa foi feita nesta etapa.

| Para validar | Variáveis no `.env` local (nunca no repositório, nunca em conversa) | Arquivo |
|---|---|---|
| Alcance e rejeição nos três providers; versão da Graph API | `EXTERNAL_SMOKE=1` | `providers-rejection-smoke.test.ts` |
| Envio real pela fila até a Meta | `EXTERNAL_SMOKE=1`, `WHATSAPP_SMOKE_PHONE_NUMBER_ID`, `WHATSAPP_SMOKE_ACCESS_TOKEN`, `WHATSAPP_SMOKE_TO` | `whatsapp-worker-smoke.test.ts` |
| Envio real, só o provider | `WHATSAPP_SMOKE_PHONE_NUMBER_ID`, `WHATSAPP_SMOKE_ACCESS_TOKEN`, `WHATSAPP_SMOKE_TO` | `whatsapp-smoke.test.ts` |
| As 3 chamadas de IA, com conteúdo sintético | `ANTHROPIC_SMOKE=1`, `ANTHROPIC_API_KEY` | `anthropic-smoke.test.ts` |
| Cliente, assinatura e cobrança no sandbox | `ASAAS_ENV=sandbox`, `ASAAS_BASE_URL` de sandbox, `ASAAS_API_KEY` de sandbox (prefixo `$aact_hmlg_`) | `asaas-sandbox-smoke.test.ts` |

Antes de conectar um canal real a uma clínica do banco local, limpar a fila antiga do Redis (D10). A entrada real dos webhooks continua dependendo de endereço público (D9).

## Smoke tests reais

Ficam em `apps/backend/test/manual/`, identificados como `[MANUAL / EXTERNAL]`, rodam só com `pnpm --filter @luxora/backend test:manual` e pulam sozinhos quando a condição de cada um não é atendida. Passo a passo em [`test/manual/README.md`](../../apps/backend/test/manual/README.md).

| Arquivo | Chama | Exige | Executado |
|---|---|---|---|
| `providers-rejection-smoke.test.ts` | Meta, Anthropic e Asaas sandbox, com credencial inválida de propósito; confere que a Meta serve a versão da Graph API fixada | `EXTERNAL_SMOKE=1` | Sim, 05/10/2026 (antes de a versão ser fixada) |
| `whatsapp-worker-smoke.test.ts` | A fila de saída inteira até a Meta | `EXTERNAL_SMOKE=1`, Postgres e Redis locais; o envio real exige também as credenciais de teste da Meta | Só a rejeição de token inválido |
| `whatsapp-smoke.test.ts` | Graph API, 1 mensagem, só o provider | Número de teste, token temporário e destinatário autorizado do App da Meta | Não |
| `anthropic-smoke.test.ts` | Anthropic, 3 chamadas com conteúdo sintético | `ANTHROPIC_SMOKE=1` e `ANTHROPIC_API_KEY` | Não |
| `asaas-sandbox-smoke.test.ts` | Asaas sandbox: cliente, assinatura PIX, consulta das cobranças, modo de envio dos webhooks, cancelamento | `ASAAS_ENV=sandbox`, endereço de sandbox e chave de sandbox | Não |
| `asaas-production-smoke.test.ts` | Asaas **produção** (anterior a esta fase) | `ASAAS_ENV=production` e chave de produção | Não |

Resultado das chamadas reais de 05/10/2026 (credencial inválida de propósito):

| Chamada | Resposta | Classificação pelo código |
|---|---|---|
| Meta `POST /{phone-number-id}/messages`, só o provider | 401, `code=190`, `OAuthException`, com `fbtrace_id` | Permanente |
| Meta, pela fila (produtor → Redis → worker → Use Case → provider) | 401, `code=190`; job encerrado na 1ª tentativa; nada em `message_log` | Permanente |
| Meta `GET /v19.0/` | `facebook-api-version: v21.0` | — |
| Anthropic `POST /v1/messages` | 401, `authentication_error`, com `request_id`; 1 chamada | Sem nova tentativa |
| Asaas sandbox `DELETE /subscriptions/{id}` | 401, `invalid_access_token` | Erro, sem expor a chave |

## Testes e CI

| Tipo | Onde | Rede externa | Credencial | No CI |
|---|---|---|---|---|
| Unitário | `test/unit` | Não | Não | Sim |
| Integração | `test/integration` | Não (Postgres local) | Não | Sim |
| Crítico / contrato | `test/critical` | Não (`fetch` interceptado; Postgres e Redis locais) | Não | Sim |
| Smoke real | `test/manual` | Sim | Depende do arquivo | **Não** |

Nenhuma credencial de provider foi cadastrada no CI. Levar um smoke real para lá exige decidir antes qual conta paga a chamada, com que frequência roda e o que acontece quando o provider está fora do ar — a suíte obrigatória não pode depender disso.
