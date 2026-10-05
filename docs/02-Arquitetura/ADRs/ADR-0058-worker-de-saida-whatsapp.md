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

- **Entrega AT-LEAST-ONCE — política registrada na Fase 3B.** `EnviarMensagemUseCase` envia e depois grava em `message_log`. Se a gravação falhar depois de a Meta aceitar a mensagem, a nova tentativa envia de novo: duplicação possível, perda silenciosa evitada dentro das garantias atuais. Ver "Análise: mensagem repetida × mensagem perdida" e "Complemento da Fase 3B" abaixo.
- **Job falhado bloqueia a mesma chave.** O job que falhou em definitivo continua no Redis com `jobId` igual à `idempotencyKey`; enfileirar a mesma chave de novo não o reexecuta. Reenvio exige remover o job falhado ou usar outra chave.
- **Retenção no Redis — resolvida na Fase 3B.** Ver "Complemento da Fase 3B". Os jobs antigos, anteriores à política, não foram apagados.
- **Sem alerta de falha definitiva.** A falha é registrada em log; nada notifica a clínica nem a operação.
- **Resíduo local.** O índice 0 do Redis de desenvolvimento tem 389 jobs antigos de teste na fila `messages`. Com o worker ativo, subir o backend contra esse Redis faz com que sejam consumidos; como nenhuma clínica local tem canal conectado, todos terminam como falha permanente, sem chamada externa. Dez deles são de clínicas que ainda existem no banco local: se uma delas for conectada a um canal real antes de a fila ser limpa, esses dez seriam enviados. A limpeza é destrutiva e depende de autorização.
- **Encerramento do processo — resolvido na Fase 3B para o SIGTERM.** Ver "Complemento da Fase 3B". Um encerramento forçado (SIGKILL, queda do processo) continua cortando o job em andamento, que o BullMQ reexecuta depois do tempo de bloqueio.

## Análise: mensagem repetida × mensagem perdida

Feita no fechamento da Fase 3. Nenhuma das alternativas foi implementada.

**Por que não existe "exatamente uma vez".** O envio envolve dois sistemas independentes — a Graph API e o nosso banco — sem transação comum, e `POST /{phone-number-id}/messages` não aceita chave de idempotência: a Meta não tem como reconhecer que a segunda chamada é a mesma mensagem. Entre "a Meta aceitou" e "nós gravamos" sempre existe um instante em que só um dos lados sabe do envio.

**A) Enviar e depois gravar (comportamento atual) — pode repetir.**

| Onde falha | O que acontece |
|---|---|
| Antes de a Meta receber | Nada foi enviado; a nova tentativa envia. Sem problema |
| A Meta aceita, mas a resposta não chega em 10 s | Tratado como falha repetível; a nova tentativa envia de novo — **repetida** |
| A Meta aceita, a resposta chega e a gravação em `message_log` falha (banco fora, processo morto) | A nova tentativa não encontra o registro e envia de novo — **repetida** |

A janela entre a resposta da Meta e a gravação é de milissegundos. O que a tornava relevante era o encerramento do processo: o SIGTERM não era tratado, então um deploy podia matar um job nesse intervalo, e o BullMQ o reexecutava depois do tempo de bloqueio. Desde a Fase 3B o SIGTERM espera o job terminar; a janela sobra para o encerramento forçado. Impacto: o paciente recebe a mesma mensagem duas vezes. Recuperação: nenhuma é necessária — a segunda execução grava o registro e o estado fica coerente.

**B) Gravar e depois enviar — pode perder.**

| Onde falha | O que acontece |
|---|---|
| A reserva em `message_log` falha | Nada foi enviado; a nova tentativa recomeça. Sem problema |
| A reserva é gravada e o processo morre antes de a Meta receber | A nova tentativa encontra a reserva e não envia — **perdida**, em silêncio |
| A reserva é gravada e a Meta devolve erro | Dá para distinguir: a reserva é desfeita e a nova tentativa envia |
| A reserva é gravada, a chamada expira sem resposta | Ambíguo: reenviar pode repetir, não reenviar pode perder |

Impacto: o paciente não recebe a resposta, a confirmação ou o lembrete, e nada avisa a clínica. Recuperação: exige um processo que revisite reservas antigas — e ele recai na mesma ambiguidade, porque não sabe se a Meta recebeu.

**Reduzir a ambiguidade, sem eliminá-la.** A Graph API devolve, nas notificações de status (`statuses[]`), o campo `biz_opaque_callback_data` enviado junto com a mensagem. Gravar ali a `idempotencyKey` permitiria confirmar, pelo webhook, que uma mensagem com aquela chave foi de fato enviada, e só então liberar ou descartar uma reserva pendente. Exige tratar `statuses[]`, que hoje são ignorados — mudança estrutural no fluxo de entrada.

**Recomendação.** Manter A. Neste produto uma mensagem repetida é um incômodo visível e sem consequência; uma resposta ou confirmação de consulta que nunca chega, sem ninguém saber, é pior. Avaliar a conciliação por `statuses[]` quando houver volume real.

**Decisão registrada na Fase 3B: AT-LEAST-ONCE.** A política vigente é a alternativa A, a que o código já seguia. Ela não foi alterada e não deve ser alterada sem decisão explícita do responsável pelo produto; `EnviarMensagemUseCase` traz esse aviso no próprio código.

## Complemento da Fase 3B

Quatro pontos desta ADR foram fechados na preparação para os testes externos. Nenhum muda o desenho do worker.

**Retenção de jobs** (`queue-retention.ts`). Concluídos: 24 horas, nas duas filas. Falhados: 14 dias na fila de saída, 7 na de entrada. Na saída o job falhado é o único rastro de um envio que não aconteceu, e não há alerta — 14 dias cobre duas revisões semanais. Na entrada o rastro durável já está em `inbound_processing_inbox`, e a cópia no Redis carrega o texto do paciente. A idempotência não depende dessa retenção: as barreiras duráveis estão no Postgres. O BullMQ faz a limpeza quando outro job da mesma fila termina; jobs em espera não são afetados, e nada que já estava no Redis foi apagado.

**Espera orientada pelo provider** (`outbound-retry.ts`). Sem indicação, a espera continua 2 s e 4 s. Com `Retry-After` numa resposta repetível, vale o que o provider pediu, com piso (a espera padrão daquela tentativa) e teto (60 s). As 3 tentativas continuam sendo o limite. Para isso os jobs da fila de saída passaram a ser enfileirados com um tipo de espera próprio (`provider-aware`), resolvido por uma função do worker; jobs antigos, com o tipo exponencial nativo, continuam funcionando. A Meta não documenta `Retry-After` para os limites da Cloud API — o suporte é defensivo.

**Encerramento gracioso** (`main.ts`, `tracing.ts`). Dois defeitos somados faziam o SIGTERM não encerrar nada: os hooks de encerramento do Nest nunca eram ligados, então nenhum `onModuleDestroy()` rodava; e a telemetria registrava um listener permanente de SIGTERM, que tira do Node o comportamento padrão de terminar. Agora `main.ts` liga os hooks para SIGTERM e SIGINT e a telemetria usa um listener de uso único. No sinal, cada worker para de pegar jobs e espera o job em andamento; filas, banco e servidor HTTP são fechados; o processo termina. Medido no processo real, sem job em andamento: antes, vivo 10 s depois do sinal (encerrado com `kill -9`); depois, terminado em 215 ms, com as conexões dos workers fechadas.

*Requisito para a Fase 4:* o tempo que a plataforma dá entre o SIGTERM e o SIGKILL precisa cobrir o job mais longo. O de saída leva até 10 s (tempo limite da chamada à Meta); o de entrada faz até 3 chamadas de IA, com 8 s de limite e 2 tentativas cada — até cerca de 50 s. Recomendação: 60 s. Se o SIGKILL chegar antes, vale a política AT-LEAST-ONCE.

**Versão da Graph API** (`whatsapp-graph-api.ts`). Fixada em `v21.0`, num único ponto, com data de expiração registrada (21/01/2027) e teste contra regressão.

## Evidências

- `test/critical/whatsapp-outbound-worker.test.ts` — 14 testes contra Postgres, Redis e BullMQ reais: instanciação, envio com a credencial da clínica do job, isolamento entre duas clínicas, idempotência em duas camadas, repetição em falha transitória (500 e 429), teto de 3 tentativas, falha permanente sem repetição, clínica sem canal, payload sem `tenantId` e, da Fase 3B, retenção gravada no job, `Retry-After` respeitado, `Retry-After` absurdo limitado a 60 s e fechamento da aplicação esperando o envio em andamento. Com o worker original, os 9 testes que existiam falhavam.
- `test/unit/infrastructure/messaging/whatsapp-message.provider.test.ts` — 16 testes da classificação e do conteúdo da mensagem de erro.
- Backend real (`node dist/main.js`) em Redis isolado: 1 consumidor registrado na fila; job para clínica sem canal encerrado na primeira tentativa.
- Cadeia completa contra a Meta real, em 05/10/2026 (`test/manual/whatsapp-worker-smoke.test.ts`, `EXTERNAL_SMOKE=1`): produtor → Redis → worker → Use Case → provider → Graph API, com um token inválido de propósito. A Meta respondeu 401, `code=190`, `OAuthException`; o job foi encerrado na primeira tentativa, com o `fbtrace_id` no motivo da falha e nada em `message_log`.
- Envio aceito pela Meta (caminho feliz): **não executado** — nenhuma credencial de teste da Meta disponível. O mesmo arquivo faz esse envio quando as variáveis `WHATSAPP_SMOKE_*` existirem.
