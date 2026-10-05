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

**Suíte crítica.** O app de teste passa a substituir `MessageQueueWorker` por um objeto inerte, como já fazia com o worker de entrada. Só `whatsapp-outbound-worker.test.ts` pede o worker real, em um banco lógico próprio do Redis (índice 14) e com `fetch` interceptado. No fechamento da fase, a suíte inteira passou a usar um banco lógico próprio (índice 13): antes, cada execução deixava jobs de saída no índice 0, o mesmo de `pnpm dev`, e o worker — agora ativo — tentaria enviá-los na subida seguinte do backend.

## Limitações conhecidas (documentadas, não corrigidas)

- **Entrega "ao menos uma vez".** `EnviarMensagemUseCase` envia e depois grava em `message_log`. Se a gravação falhar depois de a Meta aceitar a mensagem, a nova tentativa envia de novo. **Decisão pendente** — o comportamento atual foi mantido; ver "Análise: mensagem repetida × mensagem perdida" abaixo.
- **Job falhado bloqueia a mesma chave.** O job que falhou em definitivo continua no Redis com `jobId` igual à `idempotencyKey`; enfileirar a mesma chave de novo não o reexecuta. Reenvio exige remover o job falhado ou usar outra chave.
- **Retenção no Redis.** Jobs concluídos e falhados não têm prazo de expiração e guardam telefone e texto da mensagem.
- **Sem alerta de falha definitiva.** A falha é registrada em log; nada notifica a clínica nem a operação.
- **Resíduo local.** O índice 0 do Redis de desenvolvimento tem 389 jobs antigos de teste na fila `messages`. Com o worker ativo, subir o backend contra esse Redis faz com que sejam consumidos; como nenhuma clínica local tem canal conectado, todos terminam como falha permanente, sem chamada externa. Dez deles são de clínicas que ainda existem no banco local: se uma delas for conectada a um canal real antes de a fila ser limpa, esses dez seriam enviados. A limpeza é destrutiva e depende de autorização.
- **Encerramento do processo.** O SIGTERM continua sem tratamento adequado (achado da Fase 2); um job em execução no momento do encerramento é reprocessado pelo BullMQ depois do tempo de bloqueio.

## Análise: mensagem repetida × mensagem perdida

Feita no fechamento da Fase 3. Nenhuma das alternativas foi implementada.

**Por que não existe "exatamente uma vez".** O envio envolve dois sistemas independentes — a Graph API e o nosso banco — sem transação comum, e `POST /{phone-number-id}/messages` não aceita chave de idempotência: a Meta não tem como reconhecer que a segunda chamada é a mesma mensagem. Entre "a Meta aceitou" e "nós gravamos" sempre existe um instante em que só um dos lados sabe do envio.

**A) Enviar e depois gravar (comportamento atual) — pode repetir.**

| Onde falha | O que acontece |
|---|---|
| Antes de a Meta receber | Nada foi enviado; a nova tentativa envia. Sem problema |
| A Meta aceita, mas a resposta não chega em 10 s | Tratado como falha repetível; a nova tentativa envia de novo — **repetida** |
| A Meta aceita, a resposta chega e a gravação em `message_log` falha (banco fora, processo morto) | A nova tentativa não encontra o registro e envia de novo — **repetida** |

A janela entre a resposta da Meta e a gravação é de milissegundos. O que a torna relevante é o encerramento do processo: o SIGTERM não é tratado (achado da Fase 2), então um deploy pode matar um job nesse intervalo, e o BullMQ o reexecuta depois do tempo de bloqueio. Impacto: o paciente recebe a mesma mensagem duas vezes. Recuperação: nenhuma é necessária — a segunda execução grava o registro e o estado fica coerente.

**B) Gravar e depois enviar — pode perder.**

| Onde falha | O que acontece |
|---|---|
| A reserva em `message_log` falha | Nada foi enviado; a nova tentativa recomeça. Sem problema |
| A reserva é gravada e o processo morre antes de a Meta receber | A nova tentativa encontra a reserva e não envia — **perdida**, em silêncio |
| A reserva é gravada e a Meta devolve erro | Dá para distinguir: a reserva é desfeita e a nova tentativa envia |
| A reserva é gravada, a chamada expira sem resposta | Ambíguo: reenviar pode repetir, não reenviar pode perder |

Impacto: o paciente não recebe a resposta, a confirmação ou o lembrete, e nada avisa a clínica. Recuperação: exige um processo que revisite reservas antigas — e ele recai na mesma ambiguidade, porque não sabe se a Meta recebeu.

**Reduzir a ambiguidade, sem eliminá-la.** A Graph API devolve, nas notificações de status (`statuses[]`), o campo `biz_opaque_callback_data` enviado junto com a mensagem. Gravar ali a `idempotencyKey` permitiria confirmar, pelo webhook, que uma mensagem com aquela chave foi de fato enviada, e só então liberar ou descartar uma reserva pendente. Exige tratar `statuses[]`, que hoje são ignorados — mudança estrutural no fluxo de entrada.

**Recomendação.** Manter A. Neste produto uma mensagem repetida é um incômodo visível e sem consequência; uma resposta ou confirmação de consulta que nunca chega, sem ninguém saber, é pior. Reduzir a janela com encerramento gracioso do processo (Fase 4). Avaliar a conciliação por `statuses[]` quando houver volume real. **Decisão necessária** — fica com o responsável pelo produto.

## Evidências

- `test/critical/whatsapp-outbound-worker.test.ts` — 10 testes contra Postgres, Redis e BullMQ reais: instanciação, envio com a credencial da clínica do job, isolamento entre duas clínicas, idempotência em duas camadas, repetição em falha transitória (500 e 429), teto de 3 tentativas, falha permanente sem repetição, clínica sem canal, payload sem `tenantId`. Com o worker anterior, os 9 testes que existiam falhavam.
- `test/unit/infrastructure/messaging/whatsapp-message.provider.test.ts` — 16 testes da classificação e do conteúdo da mensagem de erro.
- Backend real (`node dist/main.js`) em Redis isolado: 1 consumidor registrado na fila; job para clínica sem canal encerrado na primeira tentativa.
- Cadeia completa contra a Meta real, em 05/10/2026 (`test/manual/whatsapp-worker-smoke.test.ts`, `EXTERNAL_SMOKE=1`): produtor → Redis → worker → Use Case → provider → Graph API, com um token inválido de propósito. A Meta respondeu 401, `code=190`, `OAuthException`; o job foi encerrado na primeira tentativa, com o `fbtrace_id` no motivo da falha e nada em `message_log`.
- Envio aceito pela Meta (caminho feliz): **não executado** — nenhuma credencial de teste da Meta disponível. O mesmo arquivo faz esse envio quando as variáveis `WHATSAPP_SMOKE_*` existirem.
