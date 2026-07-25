# Encerramento do Ciclo de Estabilização da Infraestrutura

**Status:** Ciclo formalmente encerrado.
**Data:** 23 de julho de 2026.
**Origem:** iniciado pelo incidente AD-026 (bloqueio de ambiente Docker Desktop), passando por AD-002 (RLS versionada), AD-033 (seed compatível com RLS) e AD-034 (estabilidade da Suíte Crítica). Ver [`PLANO_DE_EXECUCAO.md`](./PLANO_DE_EXECUCAO.md) e [`ADR-0047`](./02-Arquitetura/ADRs/ADR-0047-docker-engine-nativo-wsl2.md).

Este documento contém a auditoria completa da Suíte Crítica (item 2 do fechamento da AD-034), a baseline oficial de infraestrutura (item 3) e o encerramento formal do ciclo (item 4). A arquitetura oficial de Dedicated Fixtures está documentada separadamente em [`09-Testes/02-Dedicated-Fixtures.md`](./09-Testes/02-Dedicated-Fixtures.md) (item 1).

---

## 1. Auditoria da Suíte Crítica

Varredura completa dos 17 arquivos de `apps/backend/test/critical/*.test.ts`, classificando cada um contra a arquitetura de Dedicated Fixtures. **Nenhuma alteração foi feita nesta etapa** — classificação apenas.

| Arquivo | Padrão usado | Veredito | Evidência |
|---|---|---|---|
| `appointment-modality-persistence.test.ts` | `createDedicatedFixture`/`cleanupDedicatedFixture` | **Conforme** | Corrigido nesta sessão (AD-004); usa o mecanismo oficial desde a criação. |
| `appointment-savemany-transactional.test.ts` | `createDedicatedFixture`/`cleanupDedicatedFixture` | **Conforme** | Um dos arquivos originais da Etapa 1 que introduziu o padrão. |
| `appointment-concurrency.test.ts` | `createDedicatedFixture`/`cleanupDedicatedFixture` | **Conforme** | Idem. |
| `billing-aggregation.test.ts` | `createDedicatedFixture`/`cleanupDedicatedFixture` | **Conforme** | Idem. |
| `payment-idempotency.test.ts` | `createDedicatedFixture`/`cleanupDedicatedFixture` | **Conforme** | Idem. |
| `inadimplencia.test.ts` | `createDedicatedFixture`/`cleanupDedicatedFixture` | **Conforme** | Idem. |
| `recurring-blocks-api.test.ts` | `createDedicatedFixture`/`cleanupDedicatedFixture` | **Conforme** | Migrado nesta sessão (AD-034) — antes tinha criação/limpeza manual duplicada. |
| `subscription-upgrade-downgrade.test.ts` | `createDedicatedFixture`/`cleanupDedicatedFixture`, `fixture.therapistIds` | **Conforme** | Corrigido nesta sessão (AD-034) — bug de FK por terapeuta não rastreado. |
| `tenant-api-key.test.ts` | `createDedicatedFixture`/`cleanupDedicatedFixture`, `sharedClient` | **Conforme** | Corrigido nesta sessão (AD-034) — consolidação de pools de conexão. |
| `multi-tenant-isolation.test.ts` | Seed global (Tenant A/B), sem criação de dado | **Conforme** | Exceção legítima por desenho — testa isolamento sobre o seed real, documentado em `02-Dedicated-Fixtures.md`. |
| `cache-tenant-isolation.test.ts` | `describe.skip` | **Conforme (N/A)** | Gap real e documentado (sem camada de cache), não uma questão de infraestrutura de teste. |
| `auth-rls-bypass-scope.test.ts` | Seed global (lookup), sem criação de dado | **Conforme** | Só leitura contra o seed — nada para limpar. |
| `audit-immutability.test.ts` | Cleanup manual, mas **contido em `finally` dentro do próprio teste** | **Melhorável** | Cria `Therapist`+`AvailabilityCalendar` via HTTP real e limpa no mesmo teste (comentário do próprio arquivo documenta um histórico de 70 registros órfãos antes deste `finally` existir). Funciona e é seguro, mas duplica lógica que `fixture.therapistIds` já cobriria — candidato a migração para o padrão oficial, não urgente. |
| `clinic-holiday-persistence.test.ts` | Seed global (lookup) + **criação de `ClinicHoliday` sem nenhuma limpeza** | **Divergente** | `repo.save(holiday)` roda em 3 testes, todos contra `tenantAId` (o Tenant A **seedado**, compartilhado). `afterAll` só desconecta — nenhum `ClinicHoliday` criado é apagado. Acumula indefinidamente a cada execução, mesma classe de problema que a Etapa 1 já corrigiu para `Appointment`. Não estava causando falha de teste observável nesta sessão (sem constraint de unicidade envolvida), mas é uma divergência real da arquitetura aprovada. |
| `recurring-block-persistence.test.ts` | Seed global (lookup) + **criação de `RecurringBlock` sem nenhuma limpeza** | **Divergente** | Mesmo padrão do item acima, para `RecurringBlock`. `afterAll` só desconecta. |
| `recurring-block-materialization.test.ts` | Tenant/Therapist/Patient dedicados, **criados e limpos manualmente** (não via `createDedicatedFixture`) | **Divergente** | Reimplementa por conta própria exatamente o que `createDedicatedFixture()`/`cleanupDedicatedFixture()` já fazem — `fixturePrisma.tenant.create()`/`.therapist.create()`/`.patient.create()` em `beforeAll`, `deleteMany`/`delete` manuais em `afterAll` (7 chamadas). Funciona hoje, mas é lógica duplicada — qualquer ajuste futuro no mecanismo oficial (como o desta própria AD-034) não se propaga aqui automaticamente. |
| `recurring-block-management.test.ts` | Tenant/Therapist/Patient dedicados, **criados e limpos manualmente**, variável `secondTherapistId` | **Divergente** | Mesmo padrão do item acima, com o agravante de usar exatamente `secondTherapistId` — a nomenclatura ad hoc que a AD-034 identificou como anti-padrão e eliminou no arquivo que a originou. Não foi corrigido aqui porque está fora do escopo dos 3 arquivos identificados na análise de causa raiz aprovada da AD-034. |

### Resumo da auditoria

- **Conforme:** 12 de 17 arquivos (incluindo os 3 corrigidos + 1 migrado nesta sessão).
- **Melhorável:** 1 arquivo (`audit-immutability.test.ts`) — funciona, cleanup contido, mas duplica lógica.
- **Divergente:** 4 arquivos (`clinic-holiday-persistence.test.ts`, `recurring-block-persistence.test.ts`, `recurring-block-materialization.test.ts`, `recurring-block-management.test.ts`) — não usam o mecanismo oficial; dois deles (`clinic-holiday-persistence.test.ts`, `recurring-block-persistence.test.ts`) acumulam dado real no Tenant seedado sem nenhuma limpeza.

**Nenhuma destas divergências foi corrigida nesta etapa** — o escopo aprovado da AD-034 foi especificamente os 3 arquivos com causa raiz confirmada (`subscription-upgrade-downgrade.test.ts`, `tenant-api-key.test.ts`, `recurring-blocks-api.test.ts`). As 5 divergências/melhorias acima são um achado novo desta auditoria, registrado como item de backlog abaixo, não corrigido por decisão de escopo — consistente com a regra de nunca misturar escopo entre tarefas.

**Novo item de backlog:** **AD-035 — Migrar `clinic-holiday-persistence.test.ts`, `recurring-block-persistence.test.ts`, `recurring-block-materialization.test.ts` e `recurring-block-management.test.ts` para o mecanismo oficial de Dedicated Fixtures**, e avaliar migrar `audit-immutability.test.ts`. Prioridade sugerida: baixa-média — nenhuma das divergências está causando falha de teste hoje (diferente do que a AD-034 corrigiu), mas duas delas acumulam dado real indefinidamente no Tenant seedado, mesma classe de risco que já causou instabilidade real antes (Etapa 1).

---

## 2. Baseline oficial da infraestrutura de testes

Referência para detectar regressões futuras.

| Métrica | Valor |
|---|---|
| Total de arquivos de teste em `test/critical/` | 17 (`*.test.ts`) |
| Arquivos de suporte compartilhado (`support/`) | 5 (`bootstrap-app.ts`, `dedicated-fixture.ts`, `global-setup.ts`, `login-helper.ts`, `unique-slot.ts`) |
| Chamadas a `createDedicatedFixture()` | 11, em 9 arquivos |
| `PrismaClient`/`PrismaClientProvider` instanciados (contagem estática, código-fonte) | 27 instâncias, em 16 arquivos |
| Pools de conexão abertos por execução completa da suíte (estimativa, 1 pool por instância acima) | ≤ 27 pools, nunca simultâneos em sua totalidade — distribuídos entre até 6 workers paralelos |
| `connection_limit` por pool / `maxWorkers` | 4 / 6 (inalterados pela AD-034) |
| Tempo médio da suíte completa (5 execuções, pós-AD-034) | **16,1s** (16,89 / 16,14 / 13,68 / 17,31 / 16,61) |
| Taxa de sucesso (5 execuções consecutivas, sem alteração entre elas) | **5/5** — 70/71 testes, 16/17 arquivos, em todas |

---

## 3. Encerramento formal

A auditoria da seção 1 encontrou **achados novos** (4 arquivos Divergentes, 1 Melhorável) — por isso, seguindo o critério definido, este não é um encerramento "sem nenhum problema estrutural novo": é um encerramento **com os achados registrados explicitamente como backlog (AD-035), não escondidos**.

Considerando que:
- as 3 causas raízes que efetivamente causavam instabilidade observável (variação de resultado entre execuções) foram corrigidas e validadas com 5/5 execuções idênticas;
- as divergências remanescentes (AD-035) não causam falha de teste hoje, apenas se afastam do padrão arquitetural oficial;
- a arquitetura oficial está agora documentada (`09-Testes/02-Dedicated-Fixtures.md`) como referência para todo código novo, prevenindo que a mesma divergência se repita em arquivos futuros;

**O ciclo de estabilização iniciado pelo incidente do Docker Desktop (AD-026) está formalmente encerrado.**

Sequência completa do ciclo:
1. **AD-026** — ambiente de desenvolvimento restaurado (Docker Engine nativo no WSL2), `ADR-0047` adotada.
2. **AD-002** — RLS e índice de concorrência formalizados como migration versionada, idempotente, validada em banco limpo.
3. **AD-033** — `prisma/seed.ts` corrigido para operar sob RLS real, padrão `withTenantContext()` documentado como oficial.
4. **AD-034** — 3 causas raízes de instabilidade da Suíte Crítica corrigidas, arquitetura de Dedicated Fixtures documentada, auditoria completa realizada, baseline registrada.

**Backlog novo resultante deste ciclo:** AD-035 (esta auditoria). Não bloqueia início de nenhuma outra tarefa.
