# Relatório Final de Handoff — AD-016 (Observabilidade de Base)

**Epic:** 4 — Observabilidade de Base
**Status:** Implementação tecnicamente validada. Pendência de governança: commit exclusivo ainda não existe (ver "Estado do Repositório").
**Data:** 25 de julho de 2026
**Decisão arquitetural de referência:** [`ADR-0051`](./02-Arquitetura/ADRs/ADR-0051-observabilidade-correlation-id-otel-prometheus.md)

---

## 1. Escopo implementado

- **Correlation ID ponta a ponta**: gerado/aceito em um middleware Express dedicado, registrado antes de qualquer Guard; disponibilizado em qualquer camada via um `CorrelationContext` próprio (`Scope.REQUEST`); incluído no header `X-Correlation-Id` de toda resposta e no corpo de erro (`LuxoraExceptionFilter`); propagado explicitamente no payload de job do BullMQ (`MessageJobData.correlationId`) e, a partir daí, até o header da chamada ao WhatsApp Business API.
- **OpenTelemetry**: SDK Node inicializado em `apps/backend/src/tracing.ts` (primeiro import de `main.ts`), com instrumentações registradas explicitamente para HTTP, Express e ioredis (esta última cobre BullMQ, que usa ioredis por baixo). Traces exportados via `ConsoleSpanExporter`.
- **Prometheus**: `GET /metrics`, fora do prefixo `api/v1`, protegido por token estático (`MetricsAccessGuard`, header `X-Metrics-Token`), delegando ao `PrometheusExporter` registrado como metric reader do NodeSDK.
- **Automações (n8n)**: os 3 handlers de `AutomationsController` que enfileiram mensagem ganharam um campo `correlationId?` opcional no DTO, propagado até o `enqueue()` correspondente.

## 2. Decisões arquiteturais

Decisão completa, com justificativa técnica de cada ponto, em **[ADR-0051](./02-Arquitetura/ADRs/ADR-0051-observabilidade-correlation-id-otel-prometheus.md)**. Resumo dos 3 ajustes que você determinou na aprovação da auditoria, e que prevaleceram sobre a proposta inicial:

1. **`CorrelationContext` dedicado, nunca uma extensão de `TenantContext`** — ciclos de vida e propósitos diferentes (autorização multi-tenant vs. correlação de logs, existente antes mesmo da autenticação).
2. **Instrumentações OpenTelemetry registradas uma a uma (HTTP, Express, ioredis)** — nunca `@opentelemetry/auto-instrumentations-node`, para não instrumentar módulos irrelevantes por padrão.
3. **Nenhuma alteração em `schema.prisma`, nenhum `previewFeatures` habilitado** — instrumentação de queries do Prisma deliberadamente adiada.

Achado arquitetural que fundamentou o design de propagação na fila: `MessageQueueWorker`/`MessageQueueProducer` são providers singleton, mas dependem transitivamente de `PrismaService` (`Scope.REQUEST`) — um provider de escopo de requisição não sobrevive à fronteira do BullMQ. Por isso o Correlation ID (como já acontecia com o `tenantId`) é serializado explicitamente no payload do job, nunca propagado via contexto ambiente/DI.

## 3. Evidências de validação

| Verificação | Resultado |
|---|---|
| `nest build` | Exit 0, limpo |
| `eslint src/**/*.ts --fix` | Exit 0, sem erros |
| Suíte unitária completa | 54 arquivos, 437 testes, 0 falhas (era 52/432 antes desta AD) |
| Suíte crítica completa (Postgres/Redis reais) | 20/21 arquivos (1 skip documentado, não relacionado), 146/147 testes, 0 falhas (era 19/20 arquivos, 138/139 antes desta AD) |
| Smoke test manual — Correlation ID | `X-Correlation-Id` ausente no request → gerado no response; presente no request → ecoado sem alteração |
| Smoke test manual — `GET /metrics` | Sem token → 401; token errado → 401; token correto → 200, corpo em formato de exposição do Prometheus real (`target_info`, `http_server_request_duration_*`, `service_name="luxora-backend"`) |
| Smoke test automatizado — 3 fluxos (auth/appointment/billing) | `observability-ad016.test.ts`: login real, `GET /appointments`, `GET /billings` — todos com `X-Correlation-Id` presente na resposta |
| Revalidação final | Build + suíte unitária + suíte crítica reexecutados do zero, containers Postgres/Redis recém-reiniciados, sem depender de estado residual de sessão anterior |

## 4. Limitações conhecidas

Todas documentadas em detalhe na seção "Limitações conhecidas" do ADR-0051:

- **Instrumentação de spans do Prisma foi deliberadamente adiada** — a versão instalada (Prisma 5.22.0) exige `previewFeatures = ["tracing"]` para ativar o `TracingHelper` real (confirmado lendo o runtime do client instalado); sem o preview feature, spans de query nunca são emitidos. Reavaliação fica para quando a funcionalidade for GA.
- `fetch()` global (usado por `WhatsAppMessageProvider`, `AnthropicAIProvider`, gateway de pagamento) não é coberto por `HttpInstrumentation` — Node usa `undici` para `fetch()`, não o módulo `http` clássico. Cobertura exigiria `@opentelemetry/instrumentation-undici`, não instalado nesta AD.
- Correlation ID nas chamadas externas foi implementado só para o caminho do WhatsApp (o único que atravessa a fila) — `AnthropicAIProvider` e o gateway de pagamento (Asaas) ainda não propagam o header.
- Exportação de traces via `ConsoleSpanExporter` — ponto de partida deliberado; não há backend de tracing provisionado; não adequado para produção com volume real.
- Overhead de performance das instrumentações não foi medido formalmente sob carga.
- Nenhuma métrica de negócio (por Tenant) foi adicionada — só as automáticas de HTTP/Express/ioredis; cardinalidade de labels por Tenant precisará de atenção quando isso for feito.

## 5. Arquivos criados (lista completa)

**Produção:**
- `apps/backend/src/shared/correlation-context.ts`
- `apps/backend/src/shared/correlation-context.module.ts`
- `apps/backend/src/shared/correlation-id.middleware.ts`
- `apps/backend/src/tracing.ts`
- `apps/backend/src/api/metrics/metrics-access.guard.ts`
- `apps/backend/src/api/metrics/metrics.controller.ts`

**Testes:**
- `apps/backend/test/unit/shared/correlation-id.middleware.test.ts`
- `apps/backend/test/unit/shared/correlation-context.test.ts`
- `apps/backend/test/critical/observability-ad016.test.ts`

**Documentação:**
- `docs/02-Arquitetura/ADRs/ADR-0051-observabilidade-correlation-id-otel-prometheus.md`
- `docs/AD-016-RELATORIO-HANDOFF.md` (este documento)

## 6. Arquivos modificados (lista completa)

**Produção:**
- `apps/backend/src/app.module.ts`
- `apps/backend/src/main.ts`
- `apps/backend/src/shared/luxora-exception.filter.ts`
- `apps/backend/src/infrastructure/messaging/message-queue.producer.ts`
- `apps/backend/src/infrastructure/messaging/message-queue.worker.ts`
- `apps/backend/src/infrastructure/messaging/whatsapp-message.provider.ts`
- `apps/backend/src/domain-services/communication/message-provider.ts`
- `apps/backend/src/use-cases/communication/enviar-mensagem.use-case.ts`
- `apps/backend/src/use-cases/scheduling/enviar-resumo-agenda-do-dia.use-case.ts`
- `apps/backend/src/use-cases/scheduling/reenviar-agenda-atualizada.use-case.ts`
- `apps/backend/src/use-cases/billing/executar-regua-inadimplencia.use-case.ts`
- `apps/backend/src/api/automations/automations.controller.ts`

**Testes / infraestrutura de teste:**
- `apps/backend/test/critical/support/bootstrap-app.ts`
- `apps/backend/test/critical/support/global-setup.ts`
- `apps/backend/test/critical/whatsapp-token-encryption.test.ts`
- `apps/backend/test/unit/shared/luxora-exception.filter.test.ts`

**Configuração / documentação:**
- `apps/backend/package.json`
- `pnpm-lock.yaml` (compartilha diffs de outras ADs já acumuladas no working tree — não é possível isolar só a contribuição do AD-016 neste arquivo)
- `.env.example`
- `apps/backend/.env` (gitignored — nunca aparece em `git status`)
- `.env` (raiz, gitignored — mesma observação)
- `CONFIGURACAO_AMBIENTE.md`
- `docs/02-Arquitetura/11-Monitoramento.md`
- `CHANGELOG.md` (arquivo inteiro ainda untracked no git — AD-016 é um dos vários acréscimos acumulados nele)
- `docs/PLANO_DE_EXECUCAO.md` (mesma observação)

## 7. Dependências adicionadas

| Pacote | Versão resolvida |
|---|---|
| `@opentelemetry/api` | 1.9.1 |
| `@opentelemetry/sdk-node` | 0.221.0 |
| `@opentelemetry/sdk-metrics` | 2.10.0 |
| `@opentelemetry/sdk-trace-base` | 2.10.0 |
| `@opentelemetry/sdk-trace-node` | 2.10.0 |
| `@opentelemetry/resources` | 2.10.0 |
| `@opentelemetry/semantic-conventions` | 1.43.0 |
| `@opentelemetry/instrumentation-http` | 0.221.0 |
| `@opentelemetry/instrumentation-express` | 0.69.0 |
| `@opentelemetry/instrumentation-ioredis` | 0.69.0 |
| `@opentelemetry/exporter-prometheus` | 0.221.0 |

Nenhuma dependência experimental/preview do Prisma foi adicionada (decisão explícita).

## 8. Riscos remanescentes

- **Governança de commit** (ver seção 10) — risco de processo, não técnico: o AD-016 não tem um commit que o isole, o que dificulta reverter ou auditar esta AD isoladamente até que o working tree seja organizado.
- **Lacuna de tracing em chamadas externas via `fetch()`** — enquanto `@opentelemetry/instrumentation-undici` não for adotado, chamadas ao WhatsApp/Anthropic/Asaas não geram spans automáticos, só o Correlation ID manual (e só para WhatsApp).
- **`ConsoleSpanExporter` em produção seria inadequado** — gera volume alto de output; precisa ser substituído por um exportador OTLP real antes de qualquer deploy com tráfego de produção.
- **Overhead não medido sob carga** — a suíte crítica não expôs problema, mas não é uma medição formal de throughput/latência sob volume real.
- **Cardinalidade de métricas** — se métricas de negócio por Tenant forem adicionadas no futuro sem essa disciplina, risco de explosão de séries temporais no Prometheus.

## 9. Critérios de aceite atendidos (checklist)

**Critérios de conclusão do Epic 4 (`docs/PLANO_DE_EXECUCAO.md`):**
- [x] Todo request HTTP gera/propaga um `correlationId`, presente em todos os logs daquele request
- [x] Endpoint de métricas exposto
- [x] Teste de smoke confirmando presença do `correlationId` em pelo menos 3 fluxos (auth, appointment, billing)

**Ajustes arquiteturais determinados na aprovação da auditoria:**
- [x] `CorrelationContext` dedicado, não uma extensão de `TenantContext`
- [x] Instrumentações OpenTelemetry registradas explicitamente, sem `auto-instrumentations-node`
- [x] Instrumentação do Prisma verificada e conscientemente adiada, sem habilitar `previewFeatures`

**Padrão de qualidade já estabelecido nas ADs anteriores desta sessão:**
- [x] Nenhuma regra de negócio alterada
- [x] Nenhum endpoint público mudou de contrato (campos novos são opcionais; `/metrics` é rota nova)
- [x] Nenhuma migration de banco necessária
- [x] Testes contra Postgres/Redis reais, não mocks, para os caminhos críticos
- [x] Build e lint limpos

## 10. Estado do Repositório

- O *working tree* contém alterações acumuladas de **múltiplas ADs** desde o commit `9550869` (16/07/2026) — não apenas do AD-016. Isso inclui, entre outros, AD-002, AD-026, AD-033, AD-034, o Épico de Disponibilidade (domínio + persistência + casos de uso), AD-003 (RBAC), AD-005 e AD-006.
- O **AD-016 foi validado tecnicamente de forma isolada** (build, lint, suíte unitária e suíte crítica completas, revalidados do zero nesta sessão) — mas **ainda não existe um commit exclusivo que o represente** no histórico do Git.
- **Nenhuma ação de `git add`, `git commit` ou `git push` foi realizada** em nenhum momento desta AD ou desta validação.

## 11. Próximos passos recomendados

1. **Decidir a estratégia de commit** para o working tree acumulado — um único commit abrangente, ou uma tentativa de separação retroativa por AD (mais trabalhosa, nem sempre limpa dado que arquivos se sobrepõem entre ADs). Esta é uma decisão de governança do usuário, não técnica.
2. **Escolher um backend de tracing real** (Grafana Cloud, Honeycomb, ou outro compatível com OTLP) antes de qualquer uso em produção — troca de uma linha em `tracing.ts`.
3. **Avaliar `@opentelemetry/instrumentation-undici`** se tracing automático de chamadas `fetch()` externas (WhatsApp/Anthropic/Asaas) se tornar prioridade.
4. **Estender Correlation ID a `AnthropicAIProvider`/gateway de pagamento**, se o valor de correlacionar essas chamadas específicas justificar o esforço.
5. **Medir overhead de instrumentação sob carga real**, não só sob a suíte crítica.
6. **Reavaliar instrumentação do Prisma** quando `previewFeatures = ["tracing"]` for promovido a GA.
7. **Definir o próximo item do backlog** (Epic 5 em diante, ou algum item do BACKLOG do Kanban) — decisão em aberto, conforme já registrado em `docs/PLANO_DE_EXECUCAO.md`.
