# SPRINT_4_EXECUTION_PLAN.md — Plano de Execução da Sprint 4

**Status:** Plano aprovado para execução. Aprovado pelo CTO em 2026-07-20 (CTO Final Approval), a partir do `ARCHITECTURE_AUDIT_REPORT.md` (versão oficial, mesma data).
**Natureza deste documento:** planejamento apenas. Nenhuma implementação foi realizada para produzi-lo — nenhum código, teste, migration ou configuração foi alterado.
**Fonte única**: os 34 itens deste plano vêm exclusivamente da seção 22 ("Backlog Priorizado — Pronto para Sprint 4") do `ARCHITECTURE_AUDIT_REPORT.md`. Nenhum item novo foi introduzido — este documento organiza o backlog já aprovado em ordem de execução, não redefine seu conteúdo ou severidade.

---

## 1. Como usar este documento

Cada item referencia seu achado (`FXX`) e a seção do relatório de auditoria onde a evidência completa está documentada — este plano não repete a evidência, apenas a referencia. Antes de iniciar qualquer item, quem for executá-lo deve ler a seção correspondente do `ARCHITECTURE_AUDIT_REPORT.md` primeiro.

**Sobre as estimativas de esforço**: não há dados históricos de velocidade desta equipe para calibrar estimativas reais — os tamanhos abaixo (PP/P/M/G/GG) são ordens de grandeza para fins de sequenciamento e planejamento de capacidade, não compromissos. Devem ser recalibrados pelo time que efetivamente for executar cada item.

| Tamanho | Ordem de grandeza |
|---|---|
| PP | Poucas horas |
| P | Meio dia |
| M | 1-2 dias |
| G | 3-5 dias |
| GG | Mais de 1 semana — tipicamente porque depende de uma decisão de produto ainda não tomada, não porque a implementação em si seja grande |

---

## 2. Roadmap por Fase e Dependência Técnica

A ordem abaixo não é a ordem de severidade do backlog (Crítico→Alto→Médio→Baixo) — é a ordem de **dependência técnica real**, que é diferente. O motivo mais importante: **F26 (infraestrutura de migração quebrada) bloqueia tecnicamente a Fase 1 inteira** (aplicar a migration de RLS de F1/F3 exige a mesma infraestrutura de migração que F26 está tentando destravar) — por isso abre o roadmap, apesar de estar listado como item #11 no backlog por severidade.

```
Fase 0 (bloqueadora)     F26 ──┬──> Fase 1 (Crítico)      F3 ──> F1
                               │
                               ├──> Fase 3 (parcial)       F27, F29 (porção crítica)
                               │
                               └──> Fase 6 (parcial)       F13, F14, F33 (porção crítica)

Fase 2 (Alto)             F6 ──> F2 + F12 ──> F4 ──> F28   (sequencial dentro da fase)

Fase 3 (Alto, paralela à Fase 2 após Fase 0)    F27, F29

Fase 4 (Alto, sem dependência)    F5, F11   — pode rodar a qualquer momento após Fase 0

Fase 5 (Alto/Médio, gated por decisão de produto)    F7, F9   — não é bloqueio técnico, é bloqueio de decisão

Fase 6 (Médio, sem dependência técnica forte)    F10, F8, F13, F14, F30, F33, F31, F34

Fase 7 (Baixo, sem dependência)    F15, F16, F17(no-op), F18, F19, F20, F21, F22, F23, F24, F25, F32
```

**Paralelização real**: Fases 3, 4 e a porção não-crítica da Fase 6 podem rodar em paralelo à Fase 2, desde que a Fase 0 já tenha sido concluída. A Fase 7 pode ser distribuída ao longo de toda a Sprint como trabalho de preenchimento, inclusive por quem estiver com menor carga em determinado momento — não exige sequenciamento próprio.

---

## 3. Fase 0 — Desbloqueio de Infraestrutura (pré-requisito de tudo)

| Item | Achado | Esforço | Depende de | Descrição |
|---|---|---|---|---|
| 0.1 | F26 | M | Acesso administrativo ao banco (fora do controle da engenharia — depende de quem administra a infraestrutura) | Aplicar as migrations pendentes de `ClinicSubscription` com um usuário administrativo, seguindo `docs/07-Infra/MIGRATION_RUNBOOK.md` (já aprovado, procedimento pronto) |

**Critério de Aceite**: `npx prisma migrate status` reporta "Database schema is up to date" contra o banco alvo; `pnpm test:critical` roda a suíte inteira (não só os arquivos de `ClinicSubscription`) sem nenhuma falha de `PrismaClientKnownRequestError` por coluna inexistente; `subscription-upgrade-downgrade.test.ts` e `tenant-api-key.test.ts` passam de ponta a ponta contra o banco real.

**Por que abre o roadmap**: sem isto, nenhuma nova migration (Fase 1) pode ser validada com confiança, e nenhum teste crítico novo (Fases 3 e 6) pode ser considerado verde de forma confiável — um teste que passa contra um banco com schema desincronizado não prova nada.

---

## 4. Fase 1 — Isolamento Multi-Tenant (Crítico)

| Item | Achado | Esforço | Depende de | Descrição |
|---|---|---|---|---|
| 1.1 | F3 | P | Fase 0 | Decidir a política de RLS para `clinic_subscription`, `message_log`, `whatsapp_integration` e adicioná-las ao array de `prisma/rls/enable-rls.sql` |
| 1.2 | F1 | M | 1.1 | Colar `enable-rls.sql` (já com as 3 tabelas de 1.1 incluídas) em uma migration real via `prisma migrate dev --name enable_rls --create-only`, aplicar, e escrever um teste crítico novo que confirme RLS `ENABLE`+`FORCE` ativa em cada uma das ~18 tabelas esperadas |

**Critérios de Aceite**:
- 1.1: as 3 tabelas aparecem no array de `enable-rls.sql` com a policy `tenant_isolation` padrão; nenhuma exceção de bypass adicional foi criada sem justificativa documentada equivalente às 2 já existentes (login por email, lookup de API key).
- 1.2: `grep -r "ROW LEVEL SECURITY" apps/backend/prisma/migrations/` retorna a nova migration além da já existente para `tenant_api_key`; o novo teste crítico consulta `pg_tables`/`pg_policies` (ou equivalente) e falha explicitamente se qualquer tabela da lista esperada não tiver RLS ativa — este teste deve ser adicionado à suíte permanente, não descartado após a validação manual.

**Risco de regressão** (o mais alto de todo este plano — ver seção 6): `FORCE ROW LEVEL SECURITY` pode quebrar silenciosamente qualquer query hoje dependente de acesso irrestrito que não passe pelos 2 mecanismos de bypass já existentes. Mitigação: rodar a suíte crítica inteira (não só os testes novos) após aplicar, e revisar manualmente qualquer `PrismaClientProvider` usado fora de `forTenant()`/`forAuthLookup()` (a mesma lista que o Anexo D da auditoria já levantou) antes de considerar a fase concluída.

---

## 5. Fase 2 — Autorização (Alto, sequencial internamente)

| Item | Achado | Esforço | Depende de | Descrição |
|---|---|---|---|---|
| 2.1 | F6 | S/P | — | Decidir o destino de `TenantApiKeyGuard`: reaproveitar como mecanismo de identidade por tenant para corrigir F2, ou registrar formalmente como descontinuado se não fizer mais parte do roadmap de PD-003 |
| 2.2 | F2 + F12 | M | 2.1 | Corrigir `/automations/*` para resolver `tenantId` a partir de uma identidade validada (não do corpo da requisição livre) — usando o resultado de 2.1; tipar os 3 `@Body()` hoje inline como classes DTO reais (F12, mesmos arquivos) |
| 2.3 | F4 | M | — (não depende de 2.1/2.2, pode rodar em paralelo) | Decidir e aplicar `@Roles` nos 6 controllers hoje sem checagem de role, começando por `PUT /clinic/payment-info` e `POST /payments/:id/refund` |
| 2.4 | F28 | S | 2.3 | Adicionar teste crítico de `403` (role incorreta) para cada rota corrigida em 2.3 — hoje zero em toda a suíte |

**Critérios de Aceite**:
- 2.1: decisão registrada por escrito (comentário no código ou nota curta no PD-003), com justificativa.
- 2.2: `POST /automations/*` rejeita uma requisição com `tenantId` não correspondente à identidade autenticada da chamada (teste crítico novo prova isso); os 3 DTOs viram classes com `class-validator`, confirmadas pelo `ValidationPipe` global rejeitando payload malformado (teste novo).
- 2.3: cada uma das 6 rotas identificadas no relatório tem uma decisão explícita de `@Roles` — "admin apenas", "admin ou therapist", etc. — documentada no PR, não deduzida implicitamente pelo código.
- 2.4: cada rota corrigida em 2.3 tem pelo menos um teste crítico que autentica com um usuário de role não autorizada e confirma `403` — é o primeiro `403` de toda a suíte crítica.

**Risco de regressão**: mudar `@Roles` pode quebrar um fluxo legítimo hoje executado por um usuário `therapist`, se a decisão de política (2.3) errar a mão. Mitigação: cada decisão de role em 2.3 deve ter sign-off explícito de produto antes do merge, não só julgamento de engenharia — o próprio relatório de auditoria já registra que não há evidência de que a ausência de `@Roles` hoje seja deliberada, então a correção também não deveria ser uma decisão unilateral de engenharia.

---

## 6. Fase 3 — Cobertura de Teste do Fluxo Financeiro Mais Crítico (Alto, paralela à Fase 2)

| Item | Achado | Esforço | Depende de | Descrição |
|---|---|---|---|---|
| 3.1 | F27 | M | Fase 0 | Suíte de testes unitários para `AnexarCartaoUseCase`: fluxo feliz, `NotFoundException`, `BadRequestException`, e um teste que confirme que nenhum dado de cartão é logado/persistido fora do necessário |
| 3.2 | F29 | M | Fase 0 | Teste crítico de integração HTTP cobrindo `POST /subscription` (criação) → `POST /subscription/credit-card`, com um stub de `PaymentProvider` em nível de aplicação (não mock unitário) |

**Critérios de Aceite**:
- 3.1: os 4 cenários do próprio backlog (feliz, 2 exceções, não-vazamento) têm teste correspondente; o teste de não-vazamento falha deliberadamente se um campo sensível (`number`, `ccv`) for adicionado a qualquer chamada de log/repositório observada pelo mock, para provar que o teste de fato detectaria uma regressão.
- 3.2: o teste roda contra Postgres real (padrão `test/critical/`, `bootstrapTestApp()`), exercita as duas rotas em sequência dentro do mesmo teste, e confirma que a assinatura criada tem os dados esperados persistidos — este é o primeiro teste E2E-de-fato do checkout completo (ver seção 8).

---

## 7. Fase 4 — Hardening Complementar (Alto, sem dependência)

| Item | Achado | Esforço | Depende de | Descrição |
|---|---|---|---|---|
| 4.1 | F5 | S | Fase 0 (só para rodar a suíte crítica depois) | Adicionar `@nestjs/throttler`, configurar limite em `POST /auth/login` no mínimo (avaliar `POST /webhooks/asaas` também) |
| 4.2 | F11 | PP | — | Trocar `!==` por comparação de tempo constante (`crypto.timingSafeEqual` ou equivalente) em `AsaasWebhookGuard` e `AutomationApiKeyGuard` |

**Critérios de Aceite**:
- 4.1: um teste (unitário ou crítico) prova que a N+1-ésima tentativa de login dentro da janela configurada retorna `429`, não `401`.
- 4.2: teste unitário do guard confirma que a nova comparação ainda aceita o segredo correto e rejeita um incorreto — comportamento funcional idêntico ao anterior, só o mecanismo de comparação muda.

---

## 8. Fase 5 — Itens Gated por Decisão de Produto (Alto/Médio)

Estes dois itens **não são bloqueios técnicos** — são bloqueios de decisão. Não devem ser estimados como "esforço de implementação" até a decisão ser tomada; o esforço abaixo é só o custo de registrar a decisão e, se aprovada, um spike de dimensionamento.

| Item | Achado | Esforço (decisão) | Descrição |
|---|---|---|---|
| 5.1 | F7 | GG | Decidir se o entrypoint conversacional de IA (`ProcessarMensagemUseCase`/`IntentActionRouter`, já implementados e testados) entra nesta Sprint via webhook do WhatsApp, ou se permanece formalmente adiado — se aprovado, o esforço real de construir o Controller/webhook precisa ser dimensionado à parte, fora deste plano |
| 5.2 | F9 | G | Decidir o gatilho de produção para `MaterializarRecurringBlockUseCase` (cron interno, endpoint administrativo, ou acionado por outro evento) — se aprovado, dimensionar à parte |

**Critério de Aceite (para esta Sprint, independente do resultado)**: uma decisão explícita e registrada existe para cada item — "sim, entra nesta Sprint com escopo X" ou "não, permanece adiado até [condição]". **Não decidir não é uma opção aceitável de saída da Sprint** — mesmo "adiado" precisa ser uma decisão ativa, não silêncio.

---

## 9. Fase 6 — Consistência de Dados e Cobertura de Teste Médio

| Item | Achado | Esforço | Depende de | Descrição |
|---|---|---|---|---|
| 6.1 | F10 | S | — | Persistir `Appointment.modality` em `upsertAll()`; adicionar getter + persistência de `Therapist.phone` |
| 6.2 | F8 | M | — | Expor `CriarFeriadoUseCase`/`RemoverFeriadoUseCase`/`ListarFeriadosUseCase`/`ConsultarCalendarioUseCase` via um novo `ClinicHolidayController` (domínio e Use Cases já existem e já têm teste) |
| 6.3 | F13 | M | Fase 0 (porção crítica) | Fechar cobertura de teste dos Use Cases restantes listados no achado (excluindo `AnexarCartaoUseCase`, já coberto na Fase 3) |
| 6.4 | F14 + F33 | G | Fase 0 | Cobertura de teste crítico para `/clinic`, `/whatsapp`, `/webhooks/asaas`, `/automations` — os 4 grupos de rota hoje sem nenhum teste de integração |
| 6.5 | F30 | S | — | Teste de forma/tipo para as 14 subclasses concretas de `DomainEvent` |
| 6.6 | F31 | S | — | Reconciliar ADR-0001/0013/0014/0016 com o código real — atualizar o texto das ADRs para refletir o estado implementado, ou abrir itens de backlog de produto para as que devem ser construídas |
| 6.7 | F34 | PP | — | Adicionar ao `MIGRATION_RUNBOOK.md` uma nota explícita recomendando expand/contract mesmo dentro de uma única migration quando envolver `DROP COLUMN` — reforço de política, não correção de código |

**Critérios de Aceite**:
- 6.1: teste que cria um Appointment com `modality: 'online'`, recarrega do banco, confirma que o valor persiste (hoje falharia); mesmo padrão para `Therapist.phone`.
- 6.2: `POST/GET/DELETE /clinic-holidays` (ou rota equivalente) alcançável via HTTP real, com pelo menos um teste crítico; `@Roles`/guard aplicados de forma consistente com o resto da API (decisão explícita, não copiada sem pensar de outro controller).
- 6.3/6.4: cada Use Case/rota listado no achado correspondente tem pelo menos um teste (unit para 6.3 quando não houver endpoint, crítico para 6.4).
- 6.5: cada uma das 14 classes tem um teste que instancia a classe real (não uma fixture genérica) e confirma seus campos e imutabilidade.
- 6.6/6.7: revisão por um segundo engenheiro/CTO confirmando que o texto atualizado reflete a realidade — sem critério técnico automatizável, é revisão humana.

---

## 10. Fase 7 — Higiene Documental (Baixo)

Template de Critério de Aceite comum a todos os itens desta fase, salvo exceção indicada: **a referência corrigida é verificável por leitura direta (o arquivo/comentário/número citado existe e está correto), e um segundo revisor confirma antes do merge.**

| Item | Achado | Esforço | Alvo específico |
|---|---|---|---|
| 7.1 | F15 | PP | `@HttpCode` explícito nos endpoints de ação hoje retornando 201 por default |
| 7.2 | F16 | S | `@ApiResponse`/`@ApiProperty` na superfície de API |
| 7.3 | F17 | — | Nenhuma ação — já registrado como deliberado; item existe só para fechar o rastreamento do backlog |
| 7.4 | F18 | PP | Corrigir referência a `00000000000000_init_rls` em `schema.prisma`; atualizar `prisma/migrations/README.md` |
| 7.5 | F19 + F32 | S | Trazer os 7 arquivos de ADR faltantes (0024, 0026, 0027, 0028, 0033, 0037, 0039), ou renumerar as citações no código para os números que de fato existem |
| 7.6 | F20 | PP | Marcar ADR-0013/0016 como não implementadas (se 6.6 não as tiver coberto) |
| 7.7 | F21 | PP | Atualizar `docs/11-Product-Decisions/PD-001-.../README.md` |
| 7.8 | F22 | PP | Corrigir comentário de `main.ts` sobre `OperationalEngineModule` |
| 7.9 | F23 | PP | Remover registro duplicado de `ExecutarReguaInadimplenciaUseCase` em `billing.module.ts` |
| 7.10 | F24 | PP | Resolver o TODO de paginação em `gerar-fechamento-mensal.use-case.ts` |
| 7.11 | F25 | S | Consolidar `JwtModule.register()` via export único de `AuthModule` |

Esta fase pode ser distribuída ao longo de toda a Sprint, inclusive por quem estiver com capacidade ociosa entre as fases anteriores — não precisa de um dono único nem de sequenciamento.

---

## 11. Riscos de Regressão (consolidado por natureza)

| Categoria | Risco | Fases afetadas | Mitigação |
|---|---|---|---|
| **RLS/`FORCE ROW LEVEL SECURITY`** | Maior risco deste plano — pode quebrar silenciosamente qualquer query que hoje dependa de acesso irrestrito fora dos 2 mecanismos de bypass já existentes | Fase 1 | Suíte crítica completa (não só os testes novos) obrigatória antes do merge; revisão manual de todo uso de `PrismaClientProvider` fora de `forTenant()`/`forAuthLookup()` |
| **Mudança de autorização (`@Roles`)** | Pode bloquear um fluxo hoje executado por um usuário `therapist`, se a política escolhida errar | Fase 2 | Sign-off de produto por rota antes do merge — não é decisão só de engenharia |
| **Mudança de contrato de `/automations/*`** | Se o mecanismo de identidade mudar de forma, qualquer chamador externo (n8n/cron) hoje integrado quebra | Fase 2 | Coordenar com quem opera o agendador externo antes do deploy; versionar ou dar aviso de depreciação se o contrato mudar |
| **Persistir campos hoje descartados (`modality`, `phone`)** | Qualquer código que dependa implicitamente do valor sempre ser o default pode se comportar diferente | Fase 6 | Auditar call sites de `Appointment.modality`/`Therapist.phone` antes do deploy, não só adicionar a persistência |
| **Testes novos mal desenhados** | Um teste mal escrito pode enshrinar comportamento errado como "correto" — já aconteceu uma vez neste projeto (bug de renovação de assinatura) | Fases 3, 6 | Revisão exige que o revisor confirme independentemente que o comportamento testado é o comportamento *correto*, não só que o teste passa |
| **Itens de higiene documental** | Praticamente nulo — mudanças de comentário/doc não afetam runtime | Fase 7 | Revisão de leitura padrão |

---

## 12. Estratégia de Validação

### Testes unitários (`test/unit/`, `pnpm test:unit`)
Usar para: lógica de domínio/Use Case isolada (Fases 3.1, 6.1 parcial, 6.5), guards testados com dependências mockadas (Fase 4.2). Convenção já estabelecida no projeto: mocks via `vi.fn()`, nunca infraestrutura real — confirmado pela própria auditoria (Anexo F) como já 100% respeitado hoje; qualquer teste novo deve manter esse padrão.

### Testes de integração (`test/critical/`, `pnpm test:critical`, Postgres real via `bootstrapTestApp()`)
Usar para: qualquer item que toque banco real, RLS, ou o ciclo HTTP completo (Fases 1.2, 2.2, 2.4, 3.2, 6.2, 6.4). Padrão de fixture já estabelecido: `createDedicatedFixture()`/`cleanupDedicatedFixture()`, nunca dado compartilhado entre arquivos — seguir o mesmo padrão para todo teste novo desta Sprint, incluindo o exemplo de referência do próprio backlog (`recurring-blocks-api.test.ts`, citado no relatório como "modelo do repositório").

### E2E
**Nota de escopo, verificada nesta etapa de planejamento**: não existe nenhum framework de E2E de navegador (Playwright/Cypress) configurado em `apps/frontend` neste repositório — confirmado por busca direta, sem arquivo de configuração nem teste `.e2e.`/`.spec.` encontrado. Para os fins deste plano, "E2E" é tratado como a suíte `test/critical/` (HTTP real ponta a ponta contra Postgres real, via `supertest`), que é o mais próximo que o repositório tem hoje de um teste de ponta a ponta. **Construir uma suíte de E2E de navegador de verdade está fora do escopo deste plano** — se for uma prioridade, deveria ser um item de backlog próprio, não implícito neste Sprint.

### Gate de CI
Todo item deste plano deve passar pelos 4 jobs já existentes em `.github/workflows/ci.yml` (`lint`, `test-unit`, `test-integration`, `test-critical`) antes do merge — nenhum novo mecanismo de CI precisa ser criado, o pipeline já existente e obrigatório é suficiente. O job `lint` em particular já teria pego, automaticamente, qualquer violação de camada introduzida por engano em qualquer item deste plano (`eslint-plugin-boundaries`, já documentado no Anexo H da auditoria).

---

## 13. Definição de "Done" da Sprint 4

A Sprint 4 pode ser considerada encerrada quando, **no mínimo**:

1. **Fase 0 concluída** — suíte crítica inteira passando contra um banco real com schema sincronizado.
2. **Fase 1 concluída** — RLS aplicada e verificada por teste automatizado nas ~18 tabelas esperadas; nenhuma regressão na suíte crítica completa.
3. **Fase 2 concluída** — bypass de tenant em `/automations/*` corrigido e testado; `@Roles` decidido e aplicado nos 6 controllers, com pelo menos um teste de `403` por rota corrigida.
4. **Fase 3 concluída** — `AnexarCartaoUseCase` e o checkout completo (`POST /subscription` → `credit-card`) com cobertura de teste real.
5. **Fase 4 concluída** — rate limiting ativo em `/auth/login`; comparações de segredo constantes-time nos 2 guards.
6. **Fase 5 resolvida como decisão** — não necessariamente implementada, mas com decisão explícita registrada para F7 e F9.
7. **Todos os 4 jobs de CI verdes** para cada PR mergeado desta Sprint, sem exceção.
8. **Nenhum item das Fases 1-4 (Crítico/Alto) deixado para a Sprint seguinte** sem uma decisão explícita do CTO registrando o adiamento e o motivo — igual ao critério já aplicado a F7/F9 na Fase 5.
9. **Fases 6 e 7**: não são bloqueadoras para encerrar a Sprint — podem transbordar para a Sprint seguinte, desde que o que transbordar seja explicitamente listado no encerramento (não apenas silenciosamente incompleto).
10. **Um novo relatório de status**, no mesmo formato de rastreabilidade usado nesta auditoria (achado → evidência → ação → resultado), deve ser produzido ao final da Sprint 4, atualizando o `ARCHITECTURE_AUDIT_REPORT.md` ou um documento de fechamento próprio — para que o próximo ciclo de auditoria (se houver) comece de um estado conhecido, e não precise redescobrir o que já foi corrigido.

**O que "Done" explicitamente não exige**: os itens de decisão-gated da Fase 5, se adiados por decisão explícita, não impedem o encerramento da Sprint. Os itens Baixo da Fase 7 não implementados não impedem o encerramento, desde que listados como transbordo.
