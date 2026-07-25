# ADR-0051 — Observabilidade de Base: Correlation ID, OpenTelemetry, Prometheus

**Status:** ADOTADO
**Origem:** AD-016 (`docs/PLANO_DE_EXECUCAO.md`, Epic 4 — Observabilidade de Base), auditoria técnica aprovada em 25/07/2026 (com 3 ajustes arquiteturais), implementação aprovada na mesma data.
**Data:** 25 de julho de 2026

## Objetivo

Antes desta AD, o backend não tinha nenhum mecanismo de correlação de logs entre requisições, nenhuma instrumentação de tracing e nenhuma métrica exportada — confirmado por auditoria: 0 dependências de OpenTelemetry/Prometheus/logging estruturado, `Logger` do NestJS usado em apenas 5 arquivos, 0 interceptors, 1 filter, nenhum middleware registrado. `docs/02-Arquitetura/11-Monitoramento.md` já previa Correlation ID/OpenTelemetry/Prometheus como requisitos desde antes desta AD implementar qualquer um deles de fato.

## Auditoria prévia (resumo)

Mapeamento completo do pipeline HTTP (guards → filters, nenhum middleware), do ponto de entrada assíncrono (BullMQ) e do logging existente, feito antes de qualquer código. Achado arquitetural central, confirmado por leitura direta do código-fonte (não hipótese): `MessageQueueWorker`/`MessageQueueProducer` são providers singleton (`@Injectable()`, sem `scope`), mas a cadeia que eles disparam (`EnviarMensagemUseCase` → `PrismaMessageLogRepository` → `PrismaService.forTenant()` → `TenantContext.tenantId`) depende de `PrismaService`, que é `Scope.REQUEST` — um provider de escopo de requisição não pode ser resolvido corretamente fora de uma requisição HTTP ativa. Essa é uma limitação estrutural pré-existente (nunca corrigida por esta AD, apenas documentada), e foi o motivo determinante da decisão abaixo de nunca basear a propagação do Correlation ID em contexto ambiente/DI através da fronteira do BullMQ.

## Decisão

### 1. Correlation ID

**Contexto dedicado, não uma extensão de `TenantContext`.** `TenantContext` existe para autorização multi-tenant e só é populado depois de `JwtAuthGuard`/`TenantApiKeyGuard`; o Correlation ID precisa existir desde o primeiro middleware do processo, para qualquer requisição, autenticada ou não — dois ciclos de vida e dois propósitos diferentes. `CorrelationContext` (`shared/correlation-context.ts`, `Scope.REQUEST`) é injetado com o `REQUEST` cru (token do próprio Nest, `@Inject(REQUEST)`) e só lê um campo já preenchido no `req` — nunca chama `set()` a partir de um Guard, ao contrário de `TenantContext`.

**Geração:** `correlationIdMiddleware` (`shared/correlation-id.middleware.ts`), registrado via `app.use()` em `main.ts` — deliberadamente um middleware Express puro, não um Guard/Interceptor do Nest, porque precisa rodar antes de QUALQUER Guard (inclusive `JwtAuthGuard`/`ThrottlerGuard`), garantindo que até respostas 401/403/429 tenham um Correlation ID. Aceita `X-Correlation-Id` do cliente/proxy quando presente; gera um UUID v4 (`node:crypto randomUUID`) caso contrário. Sempre devolvido no header de resposta.

**No corpo de erro:** `LuxoraExceptionFilter` (instanciado manualmente em `main.ts`, fora da DI do Nest — não pode injetar `CorrelationContext`) lê o valor direto do `req` cru e inclui `correlationId` no JSON de erro e na linha de log de erros 5xx.

**Nas filas (BullMQ):** `MessageJobData` (`infrastructure/messaging/message-queue.producer.ts`) ganha um campo `correlationId?: string`, serializado explicitamente no payload do job — nunca via contexto ambiente/DI, pela mesma razão estrutural do achado da auditoria (`Scope.REQUEST` não sobrevive à fronteira do BullMQ). `MessageQueueWorker` lê `job.data.correlationId`; quando ausente, gera um novo (`randomUUID()`) só para aquele job e registra isso explicitamente no log — nunca finge que veio de uma requisição original.

**Em automações (n8n):** os 3 handlers de `AutomationsController` que efetivamente enfileiram mensagem (`agenda-summary/send`, `agenda-summary/resend`, `inadimplencia/execute`) ganham um campo `correlationId?: string` opcional no DTO, propagado até a chamada `messageQueue.enqueue()` através do use case correspondente. `fechamento-mensal/generate` não enfileira mensagem — não precisa do campo.

**Em chamadas externas:** `SendMessageInput`/`EnviarMensagemInput` ganham `correlationId?: string`; `WhatsAppMessageProvider` inclui o valor no header `X-Correlation-Id` da chamada à Graph API do WhatsApp, quando presente. Escopo desta AD **não** estendeu isso a `AnthropicAIProvider`/gateway de pagamento — ver "Limitações conhecidas".

### 2. OpenTelemetry

**Instrumentações registradas explicitamente — decisão do usuário, revertendo a proposta inicial da auditoria.** `apps/backend/src/tracing.ts` (primeiro import de `main.ts`, antes até de `reflect-metadata` — instrumentações do OTel funcionam por monkey-patch no `require()`, então precisam rodar antes de `http`/`express`/`ioredis` serem carregados) registra apenas `HttpInstrumentation`, `ExpressInstrumentation` e `IORedisInstrumentation` — nunca `@opentelemetry/auto-instrumentations-node`. BullMQ usa `ioredis` por baixo, então a instrumentação de ioredis também cobre a fila — não existe (nem foi necessário) um pacote de instrumentação dedicado a BullMQ.

**Exportação de traces:** `ConsoleSpanExporter` (`@opentelemetry/sdk-trace-base`) — não há hoje nenhum backend de tracing provisionado (`docker-compose.yml` só tem Postgres/Redis). Trocar por um exportador OTLP real é uma mudança de uma linha em `tracing.ts`, sem tocar nenhum outro arquivo desta AD, quando um backend for escolhido.

**Instrumentação de queries do Prisma foi deliberadamente ADIADA** — ver "Limitações conhecidas".

### 3. Prometheus

`PrometheusExporter` (`@opentelemetry/exporter-prometheus`, `preventServerStart: true`) registrado como `metricReaders` do `NodeSDK` em `tracing.ts`. `GET /metrics` (`api/metrics/metrics.controller.ts`) delega a `prometheusExporter.getMetricsRequestHandler()`, protegido por `MetricsAccessGuard` (token estático comparado ao header `X-Metrics-Token`, variável `METRICS_ACCESS_TOKEN` — mesmo padrão de `AutomationApiKeyGuard`). A rota fica **fora** do prefixo `api/v1` (`app.setGlobalPrefix('api/v1', { exclude: ['metrics'] })`), convenção padrão de scrapers Prometheus.

## Limitações conhecidas (documentadas, não corrigidas nesta AD)

- **Instrumentação de spans do Prisma foi deliberadamente adiada** porque a versão atualmente utilizada (Prisma 5.22.0) exige `previewFeatures = ["tracing"]`. A adoção será reavaliada quando a funcionalidade estiver disponível de forma estável (GA). Confirmado por leitura direta do runtime do client instalado (`@prisma/client/runtime/library.js`): o `TracingHelper` real só é ativado se `"tracing"` estiver no array `_previewFeatures` do client; sem o preview feature, o client usa um helper nulo que não emite spans.
- **`fetch()` global (usado por `WhatsAppMessageProvider`, `AnthropicAIProvider`, gateway de pagamento) não é coberto por `HttpInstrumentation`** — no Node 18+, `fetch()` é implementado via `undici`, não via o módulo `http` clássico que `@opentelemetry/instrumentation-http` instrumenta. Cobertura de tracing automático para essas chamadas exigiria `@opentelemetry/instrumentation-undici`, não instalado nesta AD. O Correlation ID manual (via header `X-Correlation-Id`) parcialmente compensa isso para o caminho do WhatsApp, mas não há tracing automático (span) nessas chamadas hoje.
- **Correlation ID nas chamadas externas foi implementado só para o caminho do WhatsApp** (o único que atravessa a fronteira do BullMQ, o caso concreto identificado na auditoria). `AnthropicAIProvider` e o gateway de pagamento (Asaas) não propagam `correlationId` no header ainda — ambos são chamados de forma síncrona dentro do mesmo request HTTP (não atravessam a fila), e essa extensão foi deliberadamente deixada de fora do escopo desta AD para não inflar a mudança com plumbing adicional de baixo valor imediato.
- **Exportação de traces via console** (`ConsoleSpanExporter`) não é adequada para produção — é um ponto de partida deliberado, já que não existe backend de tracing provisionado. Gera uma quantidade grande de output em `stdout` (visível, por exemplo, ao rodar a Suíte Crítica) — aceitável para esta fase, deve ser trocado por um exportador OTLP real antes de qualquer uso em produção com volume real de tráfego.
- **Overhead de performance das instrumentações não foi medido** nesta AD — a Suíte Crítica completa (20 arquivos, 145 testes) rodou normalmente após a mudança, sem timeouts novos, mas isso não é uma medição formal de overhead sob carga.
- **Cardinalidade de métricas Prometheus**: nenhuma métrica de negócio (por Tenant) foi adicionada nesta AD — só as métricas HTTP/Express/ioredis automáticas das instrumentações registradas. Adicionar `tenantId` como label de uma métrica Prometheus no futuro exigiria atenção à cardinalidade (dezenas/centenas de tenants), diferente de um trace/log (alta cardinalidade, cabe sem esse problema).

## Estratégia para a Suíte Crítica

`test/critical/support/bootstrap-app.ts` precisou ser atualizado para espelhar `main.ts` exatamente (`app.use(correlationIdMiddleware)` e `setGlobalPrefix` com `exclude: ['metrics']`) — o próprio arquivo já documentava esse princípio ("um teste que não passa pelos mesmos guards/pipes da produção não prova isolamento nenhum"), então ficou desatualizado no mesmo commit que atualizou `main.ts` seria um bug, não uma opção. `test/critical/support/global-setup.ts` ganhou um valor padrão para `METRICS_ACCESS_TOKEN` (mesmo padrão de `AUTH_THROTTLE_LIMIT`), evitando que cada teste precisasse configurar a variável no próprio `beforeAll`.

## Evidências quantitativas

**Dependências novas:** `@opentelemetry/api`, `sdk-node`, `sdk-metrics`, `sdk-trace-base`, `sdk-trace-node`, `resources`, `semantic-conventions`, `instrumentation-http`, `instrumentation-express`, `instrumentation-ioredis`, `exporter-prometheus` (11 pacotes).

**Arquivos novos:**
- `apps/backend/src/shared/correlation-context.ts`, `correlation-context.module.ts`, `correlation-id.middleware.ts`
- `apps/backend/src/tracing.ts`
- `apps/backend/src/api/metrics/metrics-access.guard.ts`, `metrics.controller.ts`
- `apps/backend/test/unit/shared/correlation-id.middleware.test.ts` (3 testes), `correlation-context.test.ts` (2 testes)
- `apps/backend/test/critical/observability-ad016.test.ts` (8 testes)

**Arquivos alterados:** `main.ts`, `app.module.ts`, `luxora-exception.filter.ts`, `message-queue.producer.ts`, `message-queue.worker.ts`, `enviar-resumo-agenda-do-dia.use-case.ts`, `reenviar-agenda-atualizada.use-case.ts`, `executar-regua-inadimplencia.use-case.ts`, `automations.controller.ts`, `message-provider.ts`, `enviar-mensagem.use-case.ts`, `whatsapp-message.provider.ts`, `test/critical/support/bootstrap-app.ts`, `test/critical/support/global-setup.ts`, `test/critical/whatsapp-token-encryption.test.ts` (nova asserção de `correlationId`), `test/unit/shared/luxora-exception.filter.test.ts` (+2 testes), `.env`, `.env.example`, `apps/backend/.env`, `CONFIGURACAO_AMBIENTE.md`.

**Resultado da suíte unitária completa:** 54 arquivos, 437 testes, 0 falhas (era 52/432 antes desta AD).

**Resultado da suíte crítica completa** (`/root/luxora-app`, Postgres/Redis reais): 20 arquivos passados, 1 pulado (documentado, não relacionado) — 146/147 testes, 0 falhas (era 19/20 arquivos, 138/139 testes antes desta AD).

**Build:** `nest build`, exit 0. **Lint:** `eslint src/**/*.ts --fix`, exit 0, sem erros.

**Critério de conclusão do Epic 4** ("teste de smoke confirmando presença do `correlationId` em pelo menos 3 fluxos: auth, appointment, billing") satisfeito literalmente por um teste dedicado em `observability-ad016.test.ts`: login real (`POST /auth/login`), listagem de agendamentos (`GET /appointments`) e listagem de cobranças (`GET /billings`), todos com o header `X-Correlation-Id` presente na resposta.

**Verificação manual end-to-end** (app real, Postgres/Redis reais): `GET /api/v1/health` sem `X-Correlation-Id` no request devolve um UUID gerado no header de resposta; com o header enviado, o mesmo valor é ecoado. `GET /metrics` sem token → 401; com token errado → 401; com o token correto → 200, corpo em formato de exposição do Prometheus real (`target_info`, `http_server_request_duration_*`, com `service_name="luxora-backend"`), confirmando que `HttpInstrumentation` + `PrometheusExporter` funcionam de ponta a ponta, não só em teste isolado.

## Confirmações

- **Nenhuma regra de negócio foi alterada** — os use cases que ganharam um parâmetro `correlationId?` opcional mantêm exatamente o mesmo comportamento quando ele está ausente.
- **Nenhum endpoint público mudou de contrato** — todos os campos novos em DTOs são opcionais; `GET /metrics` é uma rota inteiramente nova, não um contrato pré-existente alterado.
- **Nenhuma migration de banco foi necessária. Nenhuma alteração em `schema.prisma`. Nenhum `previewFeatures` habilitado** — decisão explícita do usuário, para não acoplar a arquitetura a uma dependência experimental do Prisma.

## Referências

- `docs/PLANO_DE_EXECUCAO.md` — AD-016, Epic 4.
- `docs/02-Arquitetura/11-Monitoramento.md` — princípios de Correlation ID/OpenTelemetry/Prometheus já previstos antes desta implementação.
- `CONFIGURACAO_AMBIENTE.md` — seção "Observabilidade — Correlation ID, OpenTelemetry, Prometheus (AD-016)".
