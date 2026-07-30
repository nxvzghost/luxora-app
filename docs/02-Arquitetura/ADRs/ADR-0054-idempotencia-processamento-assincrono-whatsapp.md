# ADR-0054 — Idempotência ponta-a-ponta do processamento assíncrono de WhatsApp (AD-036)

**Status:** ADOTADA E IMPLEMENTADA — v3 congelada e aprovada em 29/07/2026; implementação concluída, validada (build/lint/unit/critical) e sincronizada Windows↔WSL na mesma data.
**Origem:** revisão técnica do commit `37390df243ca532ca1426f60117ea60029c11f48` (AD-007/AD-010), risco Alto identificado.
**Relacionada a:** ADR-0053 (AD-007/AD-010).

## Problema

`ProcessarMensagemWhatsAppUseCase.execute()` (worker da fila `whatsapp-inbound`) executava 4 passos sequenciais sem proteção de reentrância: (1) chamar a IA e, internamente, `IntentActionRouter.route()` — que pode executar uma ação de negócio real (agendar/cancelar/confirmar/remarcar consulta); (2) persistir a resposta como `Message`; (3) auditar; (4) enfileirar o envio. Sob *at-least-once delivery* do BullMQ (`attempts: 3`), uma falha depois do passo 1 ter concluído — o caso mais provável, ex: falha transiente no passo 4 — fazia o retry reexecutar tudo do zero: segunda chamada real à Anthropic, possível ação de negócio duplicada, `Message` duplicada, auditoria duplicada. O envio ao paciente não duplicava (idempotência já existente na fila de saída), o que mascarava o problema.

## Contexto

Restrições herdadas da ADR-0053 e reafirmadas para esta AD: não alterar `ProcessarMensagemUseCase`, `IntentActionRouter`, nem o pipeline de saída além da mudança aprovada (despacho movido para o worker). Nenhum mecanismo local elimina 100% o caso patológico de crash durante a própria chamada HTTP à Anthropic — o objetivo é eliminar o cenário realista já observado, não perseguir exactly-once matemático.

## Opções avaliadas

Idempotency token isolado (insumo, não solução completa), `turnId` sintético (redundante ao WAMID, que já cumpre esse papel), Outbox Pattern (resolve um problema diferente — atomicidade entre persistir e enfileirar, não retry-duplicando-execução — candidato a AD própria), Optimistic Locking (ferramenta errada para um problema sem concorrência real de escritores), Compare-and-Swap (convergente com Unique Constraint, não é alternativa independente). Avaliado também um design embutindo o checkpoint em `Message` (v1) — descartado por acoplar uma preocupação de confiabilidade de infraestrutura ao agregado de domínio.

## Decisão

**Inbox Pattern**: uma tabela e um port de infraestrutura dedicados (`InboxRepository`/`PrismaInboxRepository`), genéricos por `channel`, garantindo que a chamada cara e não-idempotente (`ProcessarMensagemWhatsAppUseCase.execute()`) execute no máximo uma vez com sucesso por evento de entrada, independentemente de quantos retries o BullMQ fizer. `Conversation`/`Message` permanecem inalterados — nenhum campo novo, nenhuma responsabilidade de idempotência no agregado.

A orquestração de "claim → executa ou retoma → completa/falha" fica no **worker** (`WhatsAppInboundQueueWorker`), não no use case.

### Ciclo de estados (4 estados, não 2)

```
(ausente) ──tryClaim()──► processing ──markGenerated()──► generated ──markDispatched()──► dispatched
                 │                                              │
                 └──markFailed()──► failed                      └── falha no despacho: NADA muda de estado,
                        │                                            retry seguinte lê 'generated' de novo
                        └──tryClaim() (reclaim)──► processing
```

Um ciclo de 2 estados (`processing → completed`) foi avaliado e rejeitado: o checkpoint só existiria depois do enqueue também ter sucesso, então uma falha no despacho (o cenário central do problema) ainda cairia em `failed` e permitiria reclaim — reexecutando a IA. O ciclo de 4 estados insere o checkpoint (`generated`) estritamente entre a Fase 1 (IA + `IntentActionRouter` + persistência + auditoria) e a Fase 2 (despacho, idempotente por natureza via `idempotencyKey`), garantindo que **uma falha no despacho nunca transiciona de volta para `processing`**.

### Tabela `inbound_processing_inbox`

Campos: `id`, `tenantId` (FK, RLS padrão), `channel` (genérico — hoje só `'whatsapp'`), `externalId` (WAMID), `conversationId` (valor simples, sem FK — decisão deliberada para não acoplar ao agregado `Conversation`), `correlationId`, `status` (enum `processing`/`generated`/`dispatched`/`failed`), `resultPayload` (JSON, cache técnico e descartável — `{ responseMessage, toPhoneNumber }`), `attempts`, `lastError`, `claimedAt`, `processedAt`, `dispatchedAt`, `createdAt`. Índice único em `(channel, externalId)`; índice em `(tenantId, conversationId)` para consulta de suporte.

Reclaim de staleness: um registro em `processing` cujo `claimedAt` ultrapassa `INBOX_STALE_CLAIM_MINUTES` (default 5) é tratado como órfão (worker morreu no meio) e pode ser reclamado.

### Único ajuste fora da infraestrutura nova

`ProcessarMensagemWhatsAppUseCase.execute()` perdeu a chamada a `outboundQueue.enqueue()` (que passou para o worker, Fase 2) e passou a **retornar** `{ responseMessage, toPhoneNumber }` em vez de `void`, para o worker poder cachear o resultado em `markGenerated()`. Nenhuma outra mudança em sua lógica de IA/`Conversation`/`Message`/auditoria.

## Impactos

Custo de IA duplicado, ação de negócio duplicada, `Message` duplicada e auditoria duplicada — todos eliminados: o worker só chama a Fase 1 quando `tryClaim()` retorna `'claimed'`; uma vez em `generated`, só resta reexecutar a Fase 2 (idempotente).

**Risco residual aceito e documentado:** se `execute()` tiver sucesso mas a própria escrita de `markGenerated()` falhar (janela muito estreita — exige falha isolada de escrita na tabela nova, no instante logo após as escritas em `message`/`audit_log` já terem tido sucesso no mesmo Postgres), o registro cai em `failed` e um retry reexecutaria a Fase 1, podendo persistir uma segunda `Message` de saída. Resolver isso por completo exigiria uma transação atômica cruzando `Conversation`/`Message` e o Inbox — reintroduzindo o acoplamento que esta ADR foi desenhada para eliminar. Risco aceito como residual, dada a raridade extrema.

## Migração

Migration `20260729004639_inbox_entry_and_rls`: `CREATE TYPE "InboxEntryStatus"`, `CREATE TABLE "inbound_processing_inbox"`, índice único `(channel, external_id)`, índice `(tenant_id, conversation_id)`, RLS (`ENABLE`/`FORCE ROW LEVEL SECURITY`, policy `tenant_isolation`). Nenhuma alteração em `message`/`conversation`.

## Estratégia de testes

Unitário: `ProcessarMensagemWhatsAppUseCase` (novo retorno, sem `outboundQueue`). Crítico (Postgres/Redis/BullMQ reais): cenário de retry ponta-a-ponta (falha forçada no despacho, retry real do BullMQ, prova de que a IA nunca é rechamada); constraint de unicidade; reclaim de staleness; reclaim de `failed`; `resume_dispatch` a partir de `generated`/`dispatched`.

## Rollback

Reverter código (worker, retorno do use case, `InboxModule`) — sem inconsistência de schema, já que `Conversation`/`Message` nunca foram tocados. Rollback de schema (se necessário): nova migration corretiva (`DROP TABLE`/`DROP TYPE`), nunca editar a já aplicada.

## Documentos Relacionados

- `docs/PLANO_DE_EXECUCAO.md` — Epic 8, AD-036.
- ADR-0053 — Canal WhatsApp: Entrada Real (contexto original do worker assíncrono que esta ADR corrige).
- `docs/AD-036-RELATORIO-HANDOFF.md` — relatório de implementação.

## Histórico

- **29/07/2026** — v1 proposta (checkpoint embutido em `Message` via `replyToExternalId`) — não implementada, revisada antes de qualquer código.
- **29/07/2026** — v2: revisão arquitetural pediu Inbox Pattern dedicado, mantendo `Conversation`/`Message` livres de qualquer responsabilidade de idempotência.
- **29/07/2026** — v3: refinamento final corrigiu uma falha real identificada na v2 (ciclo de 2 estados não protegia contra falha no despacho após a IA já ter tido sucesso) — ciclo de 4 estados adotado, despacho movido para o worker.
- **29/07/2026** — v3 aprovada e congelada. Implementação de AD-036 autorizada e executada nos termos exatos desta ADR.
- **29/07/2026** — Implementação concluída. Um achado real adicional, fora do desenho original mas necessário para a suíte crítica: a fila `whatsapp-inbound` é real e compartilhada entre arquivos de teste — corrigido via opt-in explícito (`bootstrapTestApp({ realWhatsAppInboundWorker: true })`) para que só um worker real exista por execução da suíte, eliminando competição entre workers de arquivos diferentes (ver `docs/AD-036-RELATORIO-HANDOFF.md`). Validação completa: build/lint limpos, 60/60 arquivos e 499/499 testes unitários, 26/26 arquivos e 183/184 testes críticos (1 skip pré-existente), confirmado em duas execuções consecutivas da suíte completa. Nenhum commit realizado — aguardando aprovação.

## Considerações Finais

O ciclo de refinamento desta ADR (v1 → v2 → v3) é, em si, um caso de estudo de por que revisão arquitetural antes de implementar vale o tempo: a v2 já parecia correta e só foi corrigida porque a v3 exigiu simular explicitamente o cenário exato do problema original (falha no despacho após a IA ter sucesso) contra o desenho proposto. A implementação seguiu a v3 sem nenhum desvio de arquitetura — o único achado adicional (competição de workers na suíte de testes) é uma questão de infraestrutura de teste, não de design da solução em si.
