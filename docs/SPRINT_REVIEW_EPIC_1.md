# Sprint Review Técnica — Epic 1 (Ambiente e Banco de Dados)

**Status:** Epic 1 formalmente encerrado.
**Data:** 23 de julho de 2026.
**Origem:** [`PLANO_DE_EXECUCAO.md`](./PLANO_DE_EXECUCAO.md), Epic 1. Backlog derivado de [`AUDITORIA_TECNICA_DEFINITIVA.md`](./AUDITORIA_TECNICA_DEFINITIVA.md).

---

## 1. Objetivos planejados × entregues

### AD-026 — Desbloquear ambiente Docker local

| | |
|---|---|
| **Objetivo** | Restaurar a capacidade de executar containers locais (Postgres/Redis), bloqueada por um defeito reprodutível do Docker Desktop 4.82.0. |
| **Resultado obtido** | Docker Engine nativo instalado diretamente na distro WSL2 (Ubuntu 26.04), contornando por completo o componente do Docker Desktop com defeito. Decisão formalizada em [`ADR-0047`](./02-Arquitetura/ADRs/ADR-0047-docker-engine-nativo-wsl2.md) — status **ADOTADO**. |
| **Evidências** | `docker version`/`info`/`compose ps` funcionais; containers `postgres`/`redis` com `health: healthy`; ambiente sustentado ao longo de toda a sessão sem novas quedas após os ajustes de `.wslconfig`. |
| **Status** | ✅ Concluído. Causa raiz do defeito do Docker Desktop permanece **inconclusiva** — contornada, não corrigida (registrado explicitamente, não omitido). |

### AD-002 — Formalizar RLS + índice de concorrência como migration versionada

| | |
|---|---|
| **Objetivo** | Transformar a RLS e o índice único de concorrência (até então scripts aplicados manualmente) em uma migration Prisma versionada, idempotente e reproduzível, sem alterar comportamento funcional. |
| **Resultado obtido** | Nova migration `apps/backend/prisma/migrations/20260723190000_enable_rls/migration.sql`, incorporando o conteúdo de `enable-rls.sql` e `unique-active-appointment.sql` (este último convertido para `CREATE UNIQUE INDEX IF NOT EXISTS`). Os dois scripts originais mantidos como referência histórica, com nota apontando para a migration real. |
| **Evidências** | Banco limpo (`luxora_clean_test`): 10/10 migrations aplicadas do zero, 17/17 policies confirmadas via `pg_policies`, RLS+FORCE ativas nas 15 tabelas via `pg_class.relrowsecurity`/`relforcerowsecurity`, índice confirmado via `pg_indexes`. Banco de dev já configurado manualmente: mesma migration aplicada sem erro (idempotência confirmada). Suíte crítica revalidada: 45/71, mesmos 2 testes falhando de antes (não relacionados a esta mudança) — zero regressão nova. |
| **Status** | ✅ Concluído. |

---

## 2. Dívida técnica remanescente

Exclusivamente os dois itens descobertos durante a validação do Epic 1 — nenhum outro item do backlog geral entra nesta seção.

### AD-033 — `prisma/seed.ts` incompatível com RLS real

| | |
|---|---|
| **Impacto** | Real e atual, não hipotético: o banco de dev hoje está com **zero dados seedados** (a tentativa de seed nesta sessão falhou e nunca completou). Bloqueia onboarding de qualquer novo desenvolvedor que siga o `README.md` do zero, e é a causa direta dos 2 únicos testes ainda falhando na suíte crítica (`multi-tenant-isolation.test.ts`, Teste Crítico #1 documentado). |
| **Prioridade** | Alta. |
| **Risco** | Técnico baixo (a correção é local ao script — envolver os inserts em `SET LOCAL app.tenant_id` por Tenant, ou reutilizar o padrão de bypass já existente em `PrismaService.forAuthLookup()`/fixtures de teste crítico). Risco de produto/processo alto enquanto não corrigido, por bloquear onboarding e um Teste Crítico. |
| **Dependências** | Nenhuma — corrigível de forma isolada, não depende de nenhum outro item do backlog. |
| **Recomendação** | Tratar cedo, fora da ordem estrita de Epics se necessário — o custo de correção é pequeno frente ao impacto de bloquear onboarding e deixar um Teste Crítico documentado permanentemente vermelho. |

### AD-034 — Fragilidade de hooks de limpeza (`afterAll`) sob execução paralela

| | |
|---|---|
| **Impacto** | Resultados inconsistentes entre execuções idênticas da suíte crítica — observado nesta própria sessão (39/71 em uma execução, 45/71 em outra, mesmo código). Corrói a confiabilidade do sinal verde/vermelho da suíte como gate de qualidade (o próprio `README.md` declara "Nenhum PR é aprovado sem os Testes Críticos passando" — um sinal instável enfraquece essa garantia). |
| **Prioridade** | Média. |
| **Risco** | Médio — já foi parcialmente atacado antes ("Critical Suite stability — Etapa 1/2", histórico do projeto) sem resolução completa; pode ter causa mais profunda (pressão de connection pool, já cogitada nas etapas anteriores) do que um ajuste pontual resolveria. |
| **Dependências** | Nenhuma direta, mas tematicamente pertence ao Epic 13 (Testes Automatizados) — faz mais sentido resolvido junto da consolidação de testes do que isoladamente. |
| **Recomendação** | Não é urgente isoladamente, mas **deve ser resolvido antes de expandir a suíte crítica com novos testes** — construir cobertura nova sobre uma fundação instável só amplia o problema. |

---

## 3. Lições aprendidas

**O incidente do Docker Desktop.** O Docker Desktop 4.82.0 apresentou um defeito reprodutível em dois componentes internos distintos (`Secrets Engine`, depois `Inference Manager`) — em ambos os casos, um socket AF_UNIX implementado como reparse point NTFS ficava órfão após qualquer encerramento abrupto do backend, e nenhuma API testada (rename via MSYS, PowerShell, `Get-Acl`, `fsutil reparsepoint query`) conseguia tocá-lo. Um reboot completo do Windows foi realizado e o erro se reproduziu de forma idêntica depois — evidência decisiva de que não era um estado de kernel temporário. A causa raiz nunca foi confirmada.

**Por que Docker Engine nativo no WSL2.** A decisão não foi por eliminação de alternativas ad-hoc — foi baseada em uma matriz de decisão explícita (probabilidade de sucesso, tempo, complexidade, risco, dependências, impacto, rollback) comparando 7 alternativas reais (reparar Docker Desktop, trocar de versão, Rancher Desktop, Podman, Docker Engine no WSL2, Postgres/Redis nativos no WSL2, banco remoto de dev). O fator decisivo: o próprio Docker Desktop já executava seus containers dentro de uma VM WSL2 por baixo dos panos — a mudança removeu apenas a camada de orquestração Windows problemática, sem introduzir um ambiente de execução genuinamente novo. Uma validação arquitetural própria, feita **antes** de instalar qualquer coisa, confirmou que o projeto não tinha nenhuma dependência real do Docker Desktop especificamente (só de um daemon compatível com a API Docker).

**Práticas que evitaram retrabalho:**
- Nenhuma correção foi aplicada sem diagnóstico direto (logs, `Get-Acl`, `fsutil`, timestamps) confirmando a causa antes.
- Toda mudança priorizou reversibilidade: renomear em vez de apagar; Docker Desktop nunca desinstalado; Factory Reset explicitamente descartado do escopo em toda a investigação.
- Validação em banco limpo **e** em banco já configurado, antes de considerar a AD-002 encerrada — expôs a necessidade real de idempotência antes que isso virasse um problema em CI ou em outra máquina.
- Achados novos (AD-033, AD-034) foram registrados como itens de backlog separados em vez de corrigidos "de brinde" durante a AD-002 — manteve o escopo de cada entrega limpo e rastreável, sem misturar preocupações.

**Melhorias de processo para os próximos Epics:**
- O pipeline de CI (`ci.yml`) nunca aplicou `enable-rls.sql` — só o script de criação da role de aplicação. Isso significa que os Testes Críticos em CI provavelmente rodam sem RLS real hoje, a mesma lacuna que existia localmente antes desta sessão. Vale confirmar explicitamente, no início do Epic 3 (Segurança), que a nova migration fecha esse gap também em CI, não só localmente — não deve ser assumido.
- A suíte crítica mostrou variação de resultado entre execuções idênticas nesta própria sessão (AD-034). Antes de expandir cobertura de testes (Epic 13), vale estabilizar a base existente — do contrário, "quantidade de testes passando" deixa de ser um sinal confiável de progresso.
- Documentação de setup (`README.md`, `COMECE_AQUI.md`) tinha informações desatualizadas em mais de um ponto (contagens de teste, processo de RLS manual) antes desta sessão. Um passe de sincronização geral (já previsto como AD-030) deveria acontecer com prioridade, antes que mais dessincronia se acumule.

---

## 4. Métricas do Epic 1

| Métrica | Valor |
|---|---|
| ADs concluídas | 2 (AD-026, AD-002) |
| Migrations adicionadas | 1 (`20260723190000_enable_rls`) |
| Testes executados (suíte crítica) | 71 (17 arquivos) |
| Testes executados (suíte unitária, não afetada) | 423 (51 arquivos) — sempre verde, sem relação com este Epic |
| Regressões introduzidas | 0 |
| Bugs encontrados durante o Epic 1 | 2 (AD-033, AD-034) |
| Bugs corrigidos durante o Epic 1 | 0 (ambos deliberadamente registrados como backlog independente, não corrigidos — fora do escopo funcional da AD-002) |
| Cobertura de RLS atingida | 15/15 tabelas multi-tenant (100% — antes desta sessão, 1/15 em migração real) |
| Suíte crítica — resultado final | 45/71 passando, 2 falhando (AD-033), 24 puladas (documentadas, pré-existentes) |
| Pendências remanescentes | AD-033, AD-034 (backlog, independentes, não bloqueiam) |

---

## 5. Critérios de aceite

- [x] **Ambiente reproduzível do zero** — procedimento completo documentado em `README.md` § Setup local e `ADR-0047`.
- [x] **Banco reproduzível apenas por migrations** — validado em banco limpo, 10/10 migrations, sem passo manual.
- [x] **RLS versionada** — migration `enable_rls`, idempotente, validada.
- [x] **Documentação sincronizada** — `CHANGELOG.md`, `PLANO_DE_EXECUCAO.md`, `README.md` e `ADR-0047` consistentes entre si.
- [x] **ADRs atualizados** — `ADR-0047` criada, indexada em `ADRs/README.md`.
- [x] **Epic 1 concluído.**

---

## 6. Priorização do backlog restante

Reordenação de todos os 32 itens restantes (AD-001, AD-003, AD-005 a AD-025, AD-027 a AD-034), por impacto no produto, risco técnico, dependências e esforço estimado. Substitui a ordem puramente "sequência de engenharia" do `PLANO_DE_EXECUCAO.md` por uma ordem de execução recomendada — a estrutura de Epics permanece válida como agrupamento, não como sequência rígida.

### Tier 1 — Fazer primeiro (crítico, esforço baixo, sem dependência)

1. **AD-033** — corrigir `prisma/seed.ts` incompatível com RLS. Onboarding e um Teste Crítico documentado dependem disso; esforço pequeno.
2. **AD-003** — RBAC nas 21 rotas mutantes sem controle de papel. Risco de segurança mais concreto do backlog inteiro (estorno de pagamento, alta de paciente, dados financeiros da clínica sem proteção de papel).
3. **AD-005** — criptografar `WhatsAppIntegration.accessToken` (hoje texto plano).
4. **AD-006** — rate limiting (`@nestjs/throttler`), especialmente em `/auth/login`.
5. **AD-016** — `correlationId` + métricas. Esforço baixo, alto retorno: instrumentar agora beneficia a depuração de todo o resto do backlog.

### Tier 2 — Núcleo de produto (alto impacto, dependem só do Tier 1)

6. **AD-001** — Gestão de Usuários. Bloqueia onboarding real de clínica nova hoje (só existe via seed manual — que também está quebrado, ver AD-033). Depende de AD-003 já existir, para nascer com RBAC correto.
7. **AD-009** — fechar o ciclo `Session → Billing → Payment`. Gap direto no core financeiro do produto.
8. **AD-034** — estabilizar hooks de limpeza da suíte crítica. Fazer antes de continuar expandindo testes.

### Tier 3 — Funcionalidade core pendente

9. **AD-008** — persistência de `AvailabilityException` (domínio já pronto, falta só a infraestrutura).
10. **AD-007** — webhook de recepção do WhatsApp (ponto de entrada real da IA, hoje inexistente).
11. **AD-010** — rotear `remarcar_consulta` e consulta de horários no `IntentActionRouter`.
12. **AD-027** — testes de WhatsApp/provider de mensageria contra API real.
13. **AD-018** — implementação do Aggregate `Contact` (Marco 2). Depende do webhook (AD-007) existir.
14. **AD-024** — resolver a colisão de nome de estado `Patient`/`Contact`, junto com AD-018.

### Tier 4 — Experiência da equipe (frontend)

15. **AD-013** — persistir token de autenticação (hoje memory-only).
16. **AD-014** — tratamento de erro em todas as páginas.
17. **AD-015** — ações de mutação de estado (confirmar/cancelar consulta, marcar pago).
18. **AD-020** — ações de mutação em Financeiro.
19. **AD-028** — `middleware.ts` de proteção de rota.
20. **AD-029** — páginas de Terapeutas e Auditoria.
21. **AD-019** — Dashboard como feature real de backend.
22. **AD-021** — notificações internas.

### Tier 5 — Fechamento de testes e deploy

23. **AD-011** — formalizar `test/integration`.
24. **AD-012** — introduzir E2E (Playwright/Cypress).
25. **AD-022** — teste do caminho de leitura de Auditoria.
26. **AD-031** — testes de frontend.
27. **AD-032** — testes dedicados de `PatientsController`/`AppointmentsController`.
28. **AD-017** — Dockerfile de frontend + pipeline de CD real.

### Tier 6 — Polimento (baixo risco, sem urgência)

29. **AD-023** — decidir destino de `react-hook-form`/`zod` (adotar ou remover).
30. **AD-025** — decidir destino de `AiSettings` (schema morto).
31. **AD-030** — sincronizar `README.md` (contagens de teste, princípios não-negociáveis).

---

**Epic 1 formalmente encerrado. Backlog reordenado. Aguardando decisão sobre o próximo item de execução — recomendação: AD-033.**
