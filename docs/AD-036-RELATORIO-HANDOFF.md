# Relatório Final de Handoff — AD-036 (Idempotência ponta-a-ponta do processamento assíncrono de WhatsApp)

**Data:** 29 de julho de 2026
**ADR:** [`ADR-0054`](./02-Arquitetura/ADRs/ADR-0054-idempotencia-processamento-assincrono-whatsapp.md) — ADOTADA E IMPLEMENTADA
**Origem:** risco Alto identificado na revisão técnica do commit `37390df243ca532ca1426f60117ea60029c11f48` (AD-007/AD-010).
**Nota de numeração:** este trabalho foi conduzido durante a sessão sob o rótulo informal "AD-011"; ao formalizar o fechamento, foi identificada colisão real com o AD-011 já existente em `PLANO_DE_EXECUCAO.md` (Epic 13, "Decidir e formalizar `test/integration`"), item não relacionado. Renumerado para **AD-036** (próximo número livre, confirmado por varredura de `AD-0\d\d` em todo o repositório) em todos os documentos e comentários de código desta entrega, numa única operação atômica — nenhuma referência stale deixada.

## 1. Resumo técnico da implementação

`ProcessarMensagemWhatsAppUseCase.execute()` (worker da fila `whatsapp-inbound`) executava IA + `IntentActionRouter` + persistência + auditoria + despacho de saída em sequência, sem proteção de reentrância. Sob retry do BullMQ (`attempts: 3`), uma falha depois da IA já ter respondido com sucesso — o cenário mais provável, ex. falha transiente no enfileiramento de saída — reexecutava tudo do zero: custo de IA duplicado, possível ação de negócio duplicada, `Message` duplicada, auditoria duplicada.

Implementado o **Inbox Pattern**: uma tabela e um port de infraestrutura dedicados (`InboxRepository`/`PrismaInboxRepository`), com um ciclo de 4 estados (`processing → generated → dispatched`, com `failed` como desvio só a partir de `processing`). O checkpoint `generated` fica estritamente entre a Fase 1 (IA + `IntentActionRouter` + persistência + auditoria — cara, não-idempotente) e a Fase 2 (despacho — idempotente por natureza, via `idempotencyKey` já existente). Uma falha na Fase 2 nunca transiciona de volta para `processing`/`failed` — o retry seguinte só reexecuta o despacho.

`Conversation`/`Message`/`ProcessarMensagemUseCase`/`IntentActionRouter`/pipeline de saída permanecem 100% inalterados. A única mudança em `ProcessarMensagemWhatsAppUseCase` foi remover a chamada de enfileiramento de saída (movida para o worker) e passar a retornar `{ responseMessage, toPhoneNumber }` em vez de `void`.

A decisão passou por 3 rodadas de revisão arquitetural explícita antes de qualquer implementação (v1: checkpoint embutido em `Message`, revisada e rejeitada por acoplar idempotência ao domínio; v2: Inbox Pattern dedicado; v3: correção de uma falha real identificada na v2 — um ciclo de 2 estados não protegia contra o cenário central do problema).

## 2. Arquivos criados

- `apps/backend/src/domain-services/platform/inbox.repository.ts` — port `InboxRepository` (`tryClaim`/`markGenerated`/`markDispatched`/`markFailed`).
- `apps/backend/src/infrastructure/database/repositories/prisma-inbox.repository.ts` — implementação com a máquina de estados completa (claim, reclaim de `failed`, reclaim de staleness, `resume_dispatch` unificando `generated`/`dispatched`).
- `apps/backend/src/api/platform/inbox.module.ts` — módulo dedicado, exporta `INBOX_REPOSITORY`, importado por `AIModule` (evita a duplicação de providers já sinalizada na revisão do commit AD-007/AD-010).
- `apps/backend/test/critical/whatsapp-inbound-idempotency.test.ts` — 6 testes contra Postgres/Redis/BullMQ reais.
- `docs/02-Arquitetura/ADRs/ADR-0054-idempotencia-processamento-assincrono-whatsapp.md`.
- `docs/AD-036-RELATORIO-HANDOFF.md` (este arquivo).

## 3. Arquivos modificados

- `apps/backend/prisma/schema.prisma` — modelo `InboxEntry` + enum `InboxEntryStatus`; relação reversa em `Tenant`.
- `apps/backend/prisma/rls/enable-rls.sql` — `inbound_processing_inbox` no array padrão de `tenant_isolation`.
- `apps/backend/src/use-cases/communication/processar-mensagem-whatsapp.use-case.ts` — remove `MessageQueueProducer`/`outboundQueue.enqueue()`; retorna `{ responseMessage, toPhoneNumber }`.
- `apps/backend/src/infrastructure/messaging/whatsapp-inbound-queue.worker.ts` — orquestração completa de Fase 1/Fase 2, `tryClaim`/`markGenerated`/`markDispatched`/`markFailed`, regra de nunca chamar `markFailed()` depois de `markGenerated()` ter sido gravado.
- `apps/backend/src/api/ai/ai.module.ts` — importa `InboxModule` em vez de redeclarar providers; comentário atualizado.
- `apps/backend/test/unit/use-cases/communication/processar-mensagem-whatsapp.use-case.test.ts` — atualizado para o novo retorno, sem `outboundQueue`.
- `apps/backend/test/critical/support/bootstrap-app.ts` — nova opção `realWhatsAppInboundWorker` (default `false`, desliga o worker real; ver achado real #2 abaixo).
- `apps/backend/test/critical/whatsapp-webhook.test.ts` — cleanup de `inboxEntry` com retry (ver achado real #2), opt-in do worker real não solicitado (mantém o padrão desligado, correto para esta suíte).

## 4. Migrations criadas

- `20260729004639_inbox_entry_and_rls` — `CREATE TYPE "InboxEntryStatus"`; `CREATE TABLE "inbound_processing_inbox"`; índice único `(channel, external_id)`; índice `(tenant_id, conversation_id)`; RLS (`ENABLE`/`FORCE ROW LEVEL SECURITY`, policy `tenant_isolation`). Nenhuma alteração em `message`/`conversation`. Aplicada via `prisma migrate deploy` (procedimento manual já estabelecido — `prisma migrate dev` é bloqueado neste ambiente não-interativo).

## 5. Decisões tomadas durante a implementação

- **Renumeração AD-011 → AD-036** (ver nota no topo) — a única decisão que alterou um rótulo já usado ao longo de toda a sessão; aplicada atomicamente (código + docs) para nunca deixar uma referência stale.
- **Suprimir o worker real por padrão em `bootstrapTestApp()`**, com opt-in explícito — decisão arquitetural de teste tomada em conjunto com o usuário durante a depuração (ver achado real #2), não estava na ADR original porque o problema só se manifestou ao rodar a suíte crítica completa.
- **Marcador único (WAMID embutido na mensagem) para filtrar chamadas de `fetch` mockadas no teste crítico** — necessário porque, mesmo com um único worker real na suíte, ele processa legitimamente jobs concorrentes de outros arquivos (`whatsapp-webhook.test.ts` continua enfileirando de verdade); sem o filtro, a asserção de "nenhuma chamada nova entre `generated` e `dispatched`" ficaria sujeita a tráfego alheio.
- **`Queue.obliterate({ force: true })` no `beforeAll`** do teste crítico — limpa jobs órfãos de execuções anteriores da mesma fila real, persistente entre execuções.

## 6. Desvios da ADR-0054, com justificativa

Nenhum desvio de arquitetura. Dois desvios pontuais, ambos do **plano de testes** da ADR (seção "Estratégia de testes"), justificados:

1. A ADR previa cobertura "Unitário" para a máquina de estados do `PrismaInboxRepository`. Implementado como **crítico** (Postgres real) em vez de unitário — este codebase não tem precedente de unit-testar classes `Prisma*Repository` com `PrismaService` mockado; toda verificação de comportamento real de repositório (incluindo captura de `P2002`) já é feita via suíte crítica em todo o projeto. Manter esse padrão evita introduzir um estilo de teste novo e inconsistente só para esta AD.
2. Nenhum teste unitário foi escrito para `WhatsAppInboundQueueWorker` diretamente — o worker constrói uma instância real de `Worker`/`IORedis` no construtor; não há precedente no codebase de unit-testar essa classe (nem mesmo `MessageQueueWorker`, pré-existente). A cobertura da sua orquestração fica inteiramente na suíte crítica, que exercita o worker de ponta a ponta contra infraestrutura real — mais rigoroso, não mais fraco, que o unitário previsto.

## 7. Resultado de build, lint e testes

- `nest build` (`tsc --noEmit`): limpo.
- `eslint` (projeto inteiro): limpo.
- Suíte unitária: **60/60 arquivos, 499/499 testes, 0 falhas.**
- Suíte crítica (Postgres/Redis/BullMQ reais): **26/26 arquivos, 183/184 testes, 0 falhas** (1 skip documentado pré-existente, `cache-tenant-isolation.test.ts`) — **confirmado em duas execuções consecutivas completas**, sem flakiness residual.
- Sincronização Windows↔WSL: 13 arquivos de código/schema/migration + 4 arquivos de documentação, todos verificados byte-idênticos (`diff`) entre a cópia de referência Windows e o repositório canônico WSL.

## 8. Riscos remanescentes

- **Residual aceito e documentado na própria ADR:** se `execute()` tiver sucesso mas a escrita de `markGenerated()` falhar isoladamente (janela muito estreita, exige falha de escrita especificamente na tabela nova no instante logo após `message`/`audit_log` já terem sido escritos com sucesso no mesmo Postgres), o registro cai em `failed` e um retry poderia gerar uma segunda `Message` de saída. Resolver isso por completo exigiria uma transação atômica cruzando `Conversation`/`Message` e o Inbox, reintroduzindo o acoplamento que esta ADR foi desenhada para eliminar — aceito como residual, dada a raridade extrema.
- **Achado real de infraestrutura de teste (não de produção):** a fila `whatsapp-inbound` é real e compartilhada no Redis entre arquivos da suíte crítica. Corrigido estruturalmente (worker real desligado por padrão, só um arquivo o liga) — mas qualquer arquivo crítico *futuro* que precise de um worker assíncrono real deve seguir o mesmo padrão de opt-in explícito em `bootstrap-app.ts`, nunca assumir que o worker padrão está ativo.
- **AD-027** (testes contra a API real da Meta/Anthropic) segue pendente, bloqueada por credenciais externas — inalterada por esta AD, apenas reconfirmada como o único item ainda não coberto no fluxo assíncrono real.

## 9. ADR / registro correspondente

`ADR-0054` — Status: ADOTADA E IMPLEMENTADA. `docs/PLANO_DE_EXECUCAO.md` (Epic 8, AD-036) e `CHANGELOG.md` atualizados. `docs/02-Arquitetura/ADRs/README.md` — nova linha de índice.

## 10. Estado do repositório

Nenhuma ação de git foi realizada. Todos os arquivos criados/modificados estão sincronizados e idênticos entre a cópia de referência Windows e o repositório canônico WSL. **Aguardando aprovação explícita para o commit.**
