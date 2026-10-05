# ADR-0058 — Worker da fila de saída do WhatsApp: instanciação, clínica do job e classificação de falhas

**Status:** ADOTADO
**Origem:** Fase 3 da auditoria técnica de 04/10/2026 (Integrações reais).
**Data:** 5 de outubro de 2026

## Objetivo

Fazer a fila de saída (`messages`) ter um consumidor de verdade e definir o que ele faz quando o envio falha.

## Auditoria prévia (achados confirmados)

- **A fila não tinha consumidor.** `MessageQueueWorker` injetava `EnviarMensagemUseCase` no construtor. A cadeia `EnviarMensagemUseCase` → `PrismaMessageLogRepository` → `PrismaService` é `Scope.REQUEST`, e no NestJS o escopo de requisição sobe para quem depende dele: o worker virava de escopo de requisição e nunca era instanciado no boot. A ADR-0051 já descrevia a limitação, sem corrigir. Medido: 366 jobs em espera na fila `messages` do Redis local, nenhum concluído; e os 9 testes de `whatsapp-outbound-worker.test.ts` falham com o worker anterior.
- **Toda falha de envio era tratada igual.** `WhatsAppMessageProvider` lançava `Error` genérico para qualquer resposta fora de 2xx; com um consumidor ativo, uma credencial recusada seria repetida 3 vezes.
- **Sem tempo limite** na chamada à Graph API.
- **O corpo de erro da Meta entrava inteiro na mensagem da exceção**, que vai para o log e para o Redis (`failedReason`). Esse corpo pode repetir o telefone do destinatário.

## Decisão

**Instanciação.** O worker depende só de `ModuleRef`. A cada job cria um `contextId` (`ContextIdFactory.create()`), resolve o `TenantContext` desse contexto, preenche com o `tenantId` do payload e só então resolve `EnviarMensagemUseCase` no mesmo contexto. É o mecanismo já adotado em `WhatsAppInboundQueueWorker` (ADR-0053, ADR-0054); nenhuma requisição HTTP participa e um job não enxerga o contexto de outro.

**Clínica do job.** O `tenantId` do payload é a única fonte de identidade. Quem enfileira o preenche a partir do contexto já autenticado, nunca de entrada do cliente. A credencial de envio é buscada por esse id e `message_log` é gravado sob a RLS dessa clínica. Payload sem `tenantId` em formato de UUID é descartado sem tentar enviar.

**Classificação de falhas.** O provider lança `MessageProviderError` (definido junto da porta `MessageProvider`), com `retryable`:

| Situação | `retryable` |
|---|---|
| Falha de rede, tempo limite, HTTP 429, HTTP 5xx | `true` |
| Demais 4xx, clínica sem canal conectado, token que não decifra | `false` |

O worker converte `retryable: false` em `UnrecoverableError` do BullMQ: o job é encerrado na primeira tentativa. O restante segue a política do `MessageQueueProducer` (3 tentativas, espera exponencial a partir de 2 s).

**Tempo limite** de 10 s na chamada (`WHATSAPP_PROVIDER_TIMEOUT_MS`, opcional, validada no boot quando definida).

**Mensagem de erro** só com `code`, `error_subcode`, `type` e `fbtrace_id` da Meta. Texto livre do provider, token, telefone e conteúdo da mensagem ficam de fora. O worker registra a falha sem `job.data`.

**Resposta 2xx sem id de mensagem é sucesso.** A Meta já aceitou o envio; tratar como erro faria a fila reenviar.

**Suíte crítica.** O app de teste passa a substituir `MessageQueueWorker` por um objeto inerte, como já fazia com o worker de entrada. Só `whatsapp-outbound-worker.test.ts` pede o worker real, em um banco lógico próprio do Redis (índice 14) e com `fetch` interceptado.

## Limitações conhecidas (documentadas, não corrigidas)

- **Entrega "ao menos uma vez".** `EnviarMensagemUseCase` envia e depois grava em `message_log`. Se a gravação falhar depois de a Meta aceitar a mensagem, a nova tentativa envia de novo. A Graph API não aceita chave de idempotência, então não há como delegar isso ao provider. Inverter a ordem (gravar antes, enviar depois) troca o risco de mensagem repetida pelo de mensagem perdida. **Decisão pendente** — o comportamento atual foi mantido.
- **Job falhado bloqueia a mesma chave.** O job que falhou em definitivo continua no Redis com `jobId` igual à `idempotencyKey`; enfileirar a mesma chave de novo não o reexecuta. Reenvio exige remover o job falhado ou usar outra chave.
- **Retenção no Redis.** Jobs concluídos e falhados não têm prazo de expiração e guardam telefone e texto da mensagem.
- **Sem alerta de falha definitiva.** A falha é registrada em log; nada notifica a clínica nem a operação.
- **Resíduo local.** O Redis de desenvolvimento tem jobs antigos de teste na fila `messages`. Com o worker ativo, subir o backend contra esse Redis faz com que sejam consumidos; como nenhuma clínica local tem canal conectado, todos terminam como falha permanente, sem chamada externa.
- **Encerramento do processo.** O SIGTERM continua sem tratamento adequado (achado da Fase 2); um job em execução no momento do encerramento é reprocessado pelo BullMQ depois do tempo de bloqueio.

## Evidências

- `test/critical/whatsapp-outbound-worker.test.ts` — 9 testes contra Postgres, Redis e BullMQ reais: instanciação, envio com a credencial da clínica do job, isolamento entre duas clínicas, idempotência em duas camadas, repetição em falha transitória, teto de 3 tentativas, falha permanente sem repetição, clínica sem canal, payload sem `tenantId`. Com o worker anterior: 9 falhas.
- `test/unit/infrastructure/messaging/whatsapp-message.provider.test.ts` — 16 testes da classificação e do conteúdo da mensagem de erro.
- Backend real (`node dist/main.js`) em Redis isolado: 1 consumidor registrado na fila; job para clínica sem canal encerrado na primeira tentativa.
- Envio real pela Graph API: **não executado** — nenhuma credencial de teste da Meta disponível. `test/manual/whatsapp-smoke.test.ts` faz essa chamada quando houver.
