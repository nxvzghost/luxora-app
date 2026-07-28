# Plano de Execução — Vertex/Luxora

**Status:** Documento oficial de execução. Única fonte de trabalho a partir deste ponto.
**Origem:** deriva exclusivamente do backlog `AD-001`–`AD-032` registrado em [`AUDITORIA_TECNICA_DEFINITIVA.md`](./AUDITORIA_TECNICA_DEFINITIVA.md), seção 5 (e seu anexo, seção 6). Nenhuma tarefa nova foi criada aqui — este documento apenas agrupa, sequencia e opera o que já foi aprovado.
**Papel a partir de agora:** Lead Engineer executando o backlog. Sem novas auditorias, sem novas arquiteturas, sem reorganizações — salvo se uma implementação revelar um problema real de código (nesse caso, o problema é registrado e tratado como uma nova entrada de backlog, não como pretexto para reabrir escopo).

---

## 1. Epics de Engenharia

### Epic 1 — Ambiente e Banco de Dados (Fundação)

**Objetivo:** ter um ambiente de desenvolvimento funcional e um histórico de migrations que reconstrua o banco por completo — schema, isolamento de tenant e proteção de concorrência — sem nenhuma intervenção manual fora do versionado.

**Dependências:** nenhuma. Ponto de partida de todo o resto.

**Tarefas:**
- ~~AD-026 — Desbloquear ambiente Docker local~~ **Concluída (23/07/2026)** — Docker Engine nativo no WSL2, ver `ADR-0047`.
- ~~AD-002 — Aplicar RLS real + trazer `unique-active-appointment.sql` para dentro do histórico de migrations~~ **Concluída (23/07/2026)** — migration `20260723190000_enable_rls`, validada em banco limpo e idempotente. Ver evidências no CHANGELOG.
- AD-033 (novo, descoberto em 23/07/2026, permanece em aberto) — `prisma/seed.ts` viola RLS ao criar o primeiro `ClinicSettings` de um Tenant novo: insere sem antes definir `app.tenant_id` na sessão, e falha com `new row violates row-level security policy for table "clinic_settings"` agora que RLS está genuinamente ativa por padrão. Nunca foi pego antes porque nenhum ambiente local anterior tinha RLS realmente aplicada (ver D1 da auditoria).

**Critério objetivo de conclusão — Epic 1 100% atingido (23/07/2026):**
- `docker compose up -d` (ou alternativa documentada) sobe Postgres+Redis sem intervenção manual — **atingido** via Docker Engine no WSL2
- `prisma migrate deploy` do zero aplica RLS nas 15 tabelas + o índice único parcial de concorrência, sem nenhum passo manual restante — **atingido**, validado em banco limpo (`luxora_clean_test`)
- `pnpm --filter @luxora/backend test:critical` roda localmente contra Postgres real — **validado**: 45/71 testes passando, 2 falhas (ambas AD-033, item de backlog independente, não bloqueia)

**Riscos (históricos, já materializados e superados):**
- A causa raiz do bloqueio do Docker foi investigada extensamente sem solução confirmada — contornada via Docker Engine no WSL2 (`ADR-0047`), não corrigida.
- Mover RLS/índice para dentro do histórico de migrations em um banco que já tinha configuração manual exigiu validação de idempotência — feita e confirmada sem erro.

**Resultado esperado — atingido:** qualquer engenheiro reconstrói o ambiente completo do zero só com `git clone` + comandos documentados (`README.md` § Setup local), com isolamento de tenant e proteção de concorrência reais desde a migration `enable_rls`.

---

### Epic 2 — Correção de Bugs de Persistência Confirmados

**Objetivo:** eliminar a perda silenciosa de dados já diagnosticada com evidência exata.

**Dependências:** nenhuma dura (o código pode ser corrigido e testado por unidade sem depender do Epic 1; verificação completa contra banco real se beneficia do Epic 1, mas não bloqueia o início).

**Tarefas:**
- AD-004 — Corrigir `PrismaAppointmentRepository.upsertAll()` para gravar `modality` no `create` e no `update`

**Critério objetivo de conclusão:**
- `modality` presente nos blocos `create` e `update` do `client.appointment.upsert()`
- Teste de regressão comprovando que um `Appointment` criado com `modality: 'online'` persiste e é lido de volta como `'online'`, não `'presencial'`

**Riscos:** nenhum relevante — bug isolado, causa já identificada linha a linha, sem decisão de produto pendente.

**Resultado esperado:** nenhum agendamento perde a modalidade escolhida pelo paciente/terapeuta.

---

### Epic 3 — Segurança Fundamental

**Objetivo:** eliminar as vulnerabilidades críticas de controle de acesso e proteção de credenciais confirmadas na auditoria.

**Dependências:** Epic 1 (precisa de banco estável para rodar a suíte completa de regressão em todas as rotas afetadas)

**Tarefas:**
- ~~AD-003 — Adicionar `RolesGuard`+`@Roles` às 21 rotas mutantes sem controle de papel~~ **CONCLUÍDA (2026-07-25)** — ver Kanban/CHANGELOG.
- ~~AD-005 — Criptografar `WhatsAppIntegration.accessToken` em repouso~~ **CONCLUÍDA (2026-07-25)** — ver Kanban/CHANGELOG/ADR-0049.
- ~~AD-006 — Instalar e configurar `@nestjs/throttler`, no mínimo em `/auth/login`~~ **CONCLUÍDA (2026-07-25)** — ver Kanban/CHANGELOG/ADR-0050.

**Critério objetivo de conclusão:**
- ✅ As 21 rotas listadas na auditoria (seção 3.5) com `@Roles` definido e testado (403 para papel indevido, 2xx para papel correto)
- ✅ `accessToken` armazenado cifrado, com teste de round-trip (grava cifrado, lê decifrado corretamente)
- ✅ Rate limit ativo em `/auth/login` com teste validando bloqueio após N tentativas

**Riscos:**
- A política de "qual papel pode fazer o quê" em cada uma das 21 rotas não está definida no backlog — é uma decisão de produto, não só técnica. Precisa de confirmação explícita antes de implementar (ex.: `PATCH /clinic/payment-info` deve ser `admin`-only? `POST /payments/:id/refund` também?) — ver seção 3 deste documento sobre como isso será resolvido.

**Resultado esperado:** nenhuma rota financeira ou administrativa sensível acessível por papel indevido; nenhuma credencial em texto plano; login protegido contra força bruta.

**Epic 3 — CONCLUÍDO INTEGRALMENTE (2026-07-25).** As 3 tarefas e os 3 critérios objetivos de conclusão estão marcados. Próximo Epic a considerar: ver Kanban.

---

### Epic 4 — Observabilidade de Base

**Objetivo:** instrumentar o sistema com rastreamento de requisições antes de construir mais funcionalidade em cima — para que todo epic seguinte já nasça depurável.

**Dependências:** Epic 1

**Tarefas:**
- AD-016 — `correlationId` de ponta a ponta + exportador de métricas (OpenTelemetry ou Prometheus)

**Critério objetivo de conclusão:**
- Todo request HTTP gera/propaga um `correlationId`, presente em todos os logs daquele request (entrada, use cases, saída)
- Endpoint de métricas exposto
- Teste de smoke confirmando presença do `correlationId` em pelo menos 3 fluxos (auth, appointment, billing)

**Riscos:** escolha de ferramenta de métricas é decisão de infraestrutura (Prometheus self-hosted vs. serviço gerenciado) — não bloqueia o `correlationId`, que é a parte funcionalmente mais urgente.

**Resultado esperado:** qualquer erro em produção, a partir daqui, é rastreável de ponta a ponta.

**Epic 4 — CONCLUÍDO INTEGRALMENTE (2026-07-25).** Os 3 critérios objetivos de conclusão estão marcados: correlationId gerado/propagado em todo request (middleware dedicado, antes de qualquer Guard), `GET /metrics` exposto e protegido, smoke test cobrindo os 3 fluxos (auth, appointment, billing). Próximo Epic a considerar: ver Kanban.

---

### Epic 5 — Gestão de Usuários (Onboarding)

**Objetivo:** permitir que uma clínica nova seja provisionada via API, sem depender do script de seed manual.

**Dependências:** Epic 1 (RLS deve cobrir a tabela `user`), Epic 3 (as novas rotas de `User` já nascem com `@Roles` correto, evitando reabrir o Epic 3 depois)

**Tarefas:**
- ~~AD-001 — Controller + Use Cases de criar/listar/atualizar/desativar `User`, incluindo provisionamento do primeiro admin de uma clínica nova~~ **CONCLUÍDA (2026-07-28)** — ver Kanban/CHANGELOG.

**Critério objetivo de conclusão:**
- [x] Rotas de `User` funcionais, protegidas por `@Roles('admin')` onde aplicável, cobrindo criar/listar/atualizar/desativar
- [x] Teste cobrindo happy path, e-mail duplicado (já `@unique` globalmente no schema) e 404
- [x] Fluxo de provisionamento do primeiro usuário de uma clínica nova documentado e testado (via API, não via seed)

**Riscos:** não reabrir o fluxo de assinatura/Asaas já existente — este epic é só sobre `User`, não sobre `ClinicSubscription`. **Confirmado sem reabertura** — nenhum arquivo de `subscription`/`billing`/`payment` foi tocado por esta AD.

**Resultado esperado:** `prisma/seed.ts` deixa de ser o único caminho para o sistema ter um primeiro usuário. **Alcançado** — `POST /users/bootstrap-admin` é agora esse caminho via API.

**Epic 5 — CONCLUÍDO INTEGRALMENTE (2026-07-28).** Os 3 critérios objetivos de conclusão estão marcados. Próximo Epic a considerar: ver Kanban.

---

### Epic 6 — Fechamento do Ciclo Financeiro (Sessão → Cobrança → Pagamento)

**Objetivo:** fazer o estado de `Session` refletir a realidade financeira, fechando os estados hoje mortos (`Faturada`/`Recebida`).

**Dependências:** Epic 1, Epic 2 (mesma área de domínio de `Appointment`/`Session` — evita conflito de merge fazendo os dois em sequência)

**Tarefas:**
- AD-009 — Transicionar `Session` para `Faturada` ao gerar cobrança e para `Recebida` ao confirmar pagamento

**Critério objetivo de conclusão:**
- `GerarCobrancaUseCase` transiciona toda `Session` vinculada para `Faturada`
- Confirmação de pagamento (via `RegistrarPagamentoUseCase`) transiciona a(s) `Session` correspondente(s) para `Recebida`
- Teste cobrindo o ciclo completo: `Realizada → Faturada → Recebida`

**Riscos:** exige decisão de produto sobre o exato gatilho de `Faturada` (na criação da `Billing` ou só no envio via `EnviarCobrancaUseCase`?) — confirmar antes de implementar, não assumir.

**Resultado esperado:** o estado de uma sessão no banco corresponde à realidade financeira, sem depender de inferência externa.

---

### Epic 7 — Motor de Disponibilidade — Persistência de Exceções

**Objetivo:** fechar a lacuna de infraestrutura já anunciada no próprio código-fonte — `AvailabilityException` não sobrevive a um restart.

**Dependências:** Epic 1

**Tarefas:**
- ~~AD-008 — Persistência de `AvailabilityException` (campo/tabela + repositório)~~ **CONCLUÍDA (2026-07-25)** — ver Kanban/CHANGELOG.

**Critério objetivo de conclusão:**
- ✅ Migration nova adicionando persistência de exceções (`exceptions Json @default("[]")` em `AvailabilityCalendar` — coluna, mesmo tratamento de `windows`, decisão registrada na descoberta desta AD)
- ✅ Repositório atualizado para reconstituir `exceptions` a partir do banco, não mais sempre `[]`
- ✅ Teste crítico de "restart-survival": exceção definida via API sobrevive a uma nova instância do repositório, e o Motor de Disponibilidade real para de oferecer o horário bloqueado

**Riscos:** baixo — domínio já modelado e testado (`availability-calendar.entity.test.ts`), era puramente a metade de infraestrutura que faltava. **Achado real durante a descoberta:** o gap também incluía a ausência total de um caminho de aplicação (use case/DTO/rota) para definir exceções — não só a persistência.

**Resultado esperado:** bloqueios de agenda configurados (feriado individual do terapeuta, etc.) não desaparecem silenciosamente.

**Epic 7 — CONCLUÍDO INTEGRALMENTE (2026-07-25).** Os 3 critérios objetivos de conclusão estão marcados. Próximo Epic a considerar: ver Kanban.

---

### Epic 8 — Canal WhatsApp (Entrada Real)

**Objetivo:** dar ao módulo de IA um ponto de entrada HTTP real, fechando o loop conversacional que hoje só existe em metade (`ProcessarMensagemUseCase` funciona, mas nada o aciona).

**Dependências:** Epic 1, Epic 3 (o webhook precisa nascer com validação de assinatura/segurança adequada, não depois), Epic 6 (para que reagendamento converse coerentemente com o ciclo financeiro já fechado)

**Tarefas:**
- AD-007 — Webhook de recepção de mensagens do WhatsApp + controller para `ai.module.ts`
- AD-010 — Rotear `remarcar_consulta` e consulta exploratória de horários no `IntentActionRouter`
- AD-027 — Testes do webhook e do `WhatsAppMessageProvider` contra a API real (hoje explicitamente não testados)

**Critério objetivo de conclusão:**
- `POST /whatsapp/webhook` (ou rota equivalente) recebe mensagem real, valida assinatura, aciona `ProcessarMensagemUseCase`
- `IntentActionRouter` cobre 6 intents (os 4 já roteados + `remarcar_consulta` + consulta de horários), com `SLOT_NOT_AVAILABLE` tratado corretamente em reagendamento
- Teste (sandbox real ou, na ausência de sandbox, teste de contrato documentado) validando envio/recebimento

**Riscos:** depende de credenciais reais da Meta/WhatsApp Business API e de rede — mesmo tipo de bloqueio de ambiente já visto no Epic 1; pode ficar parcialmente pendente até resolução externa (conta de teste da Meta).

**Resultado esperado:** um paciente real consegue interagir de ponta a ponta pelo WhatsApp, incluindo reagendar.

---

### Epic 9 — Domínio Contact (Marco 2)

**Objetivo:** implementar o Aggregate `Contact`, já modelado e congelado na fase de Arquitetura de Domínio, seguindo a ordem oficial definida em `docs/01-Domain/08-Contact-e-Identidade-de-Comunicacao.md` (banco → domínio → repositórios → casos de uso → API).

**Dependências:** Epic 1 (banco), Epic 8 (`Contact` nasce de mensagens recebidas pelo webhook), Epic 3 (RBAC cobre as novas rotas desde o início)

**Tarefas:**
- AD-018 — Implementação completa do Aggregate `Contact`
- AD-024 — Resolver a colisão de nome `Patient.Novo`/`Identificado` vs `Contact.Novo`/`Identificado`

**Critério objetivo de conclusão:**
- Banco, domínio, repositório, casos de uso e API implementados na ordem oficial documentada
- Os 3 cenários que quebraram a modelagem original (responsável/dependente, casal com telefone compartilhado, troca de número) com teste crítico dedicado contra Postgres real — não apenas aprovados no papel, conforme já exigido em `ARCHITECTURE_MILESTONE.md`
- Colisão de nome de estado resolvida ou formalmente descartada com justificativa registrada

**Riscos:** é o maior item de escopo funcional novo do backlog — já aprovado dentro da fase de arquitetura congelada, não é uma funcionalidade nova sendo proposta agora, apenas a implementação de uma decisão já tomada.

**Resultado esperado:** o WhatsApp passa a reconhecer identidade de comunicação corretamente, cumprindo a visão de produto já congelada no Marco 1.

---

### Epic 10 — Frontend: Confiabilidade e Paridade de Ações

**Objetivo:** eliminar falhas silenciosas na UI e dar à equipe da clínica as ações que o backend já suporta, mas a interface ainda não expõe.

**Dependências:** Epic 3 (RBAC precisa existir antes de expor ações sensíveis na UI), Epic 6 (ciclo financeiro fechado antes de expor "marcar como pago" de forma coerente)

**Tarefas:**
- AD-013 — Persistir token de autenticação (hoje memory-only)
- AD-014 — Tratamento de `isError` nas 8 páginas que não têm
- AD-015 — Ações de mutação de estado (confirmar/cancelar consulta, marcar cobrança como paga, enviar cobrança)
- AD-020 — Ações de mutação na tela Financeiro (criar cobrança, registrar pagamento, estorno)
- AD-028 — `middleware.ts` para proteção de rota no Next.js
- AD-029 — Páginas de Terapeutas e Auditoria (endpoints já existem no backend)

**Critério objetivo de conclusão:**
- Token sobrevive a reload de página
- `isError` tratado em 100% das páginas que fazem `useQuery`
- Cada ação de mutação nova cobre o RBAC do Epic 3 (não reinventa controle de acesso na UI)
- `middleware.ts` bloqueia acesso a rota protegida sem token válido
- Páginas de Terapeutas e Auditoria funcionais, consumindo endpoints reais

**Riscos:** cada ação nova aumenta a superfície de mutação exposta — checklist obrigatório: toda ação nova precisa ter a rota correspondente já coberta pelo Epic 3 antes de ser exposta na UI.

**Resultado esperado:** o painel deixa de ser majoritariamente somente-leitura.

---

### Epic 11 — Dashboard e Indicadores Reais

**Objetivo:** substituir a agregação client-side (hoje reempacotamento de `/patients`+`/billings` no navegador) por uma feature real de backend.

**Dependências:** Epic 6 (indicadores dependem de estados corretos de `Billing`/`Session`, já fechados)

**Tarefas:**
- AD-019 — Endpoint de agregação dedicado (`GET /dashboard/summary` ou equivalente) + frontend consumindo-o

**Critério objetivo de conclusão:**
- Endpoint dedicado de agregação no backend, com teste cobrindo os números retornados
- `app/dashboard/page.tsx` consumindo o novo endpoint, sem mais `.reduce`/`.filter` client-side sobre listas cruas

**Riscos:** baixo.

**Resultado esperado:** indicadores confiáveis, sem recálculo no cliente, prontos para crescer sem penalizar performance do navegador.

---

### Epic 12 — Notificações Internas

**Objetivo:** implementar notificação staff-facing, hoje completamente inexistente.

**Dependências:** Epic 4 (observabilidade ajuda a decidir/depurar quando disparar notificações), Epic 6 (eventos financeiros são o gatilho mais óbvio)

**Tarefas:**
- AD-021 — Mecanismo de notificação interna (e-mail, push ou in-app) disparando em pelo menos 1 evento crítico (ex.: pagamento divergente)

**Critério objetivo de conclusão:**
- Canal escolhido e implementado, com teste cobrindo o disparo em pelo menos 1 evento
- Nenhum evento "notifica só no papel" — string genérica de erro anterior (`luxora-exception.filter.ts`) não conta como notificação real

**Riscos:** decisão de canal (e-mail vs. push vs. in-app) não está definida no backlog — decisão de produto pendente, a ser resolvida antes de iniciar este epic.

**Resultado esperado:** a equipe da clínica é avisada de eventos relevantes sem precisar checar o painel manualmente.

---

### Epic 13 — Testes Automatizados (Fechamento de Cobertura)

**Objetivo:** cobrir os gaps de teste identificados na auditoria, consolidando a suíte antes do deploy real.

**Dependências:** todos os epics funcionais anteriores (Epics 2–12) — escrever teste de algo que ainda vai mudar é retrabalho; este epic fecha a cobertura depois que a superfície estabiliza.

**Tarefas:**
- AD-011 — Decidir e formalizar `test/integration` (torná-lo real ou consolidar oficialmente em `test/critical`, ajustando o job de CI para não ser mais um no-op silencioso)
- AD-012 — Introduzir Playwright ou Cypress, cobrindo Login→Agenda→Pacientes→Financeiro
- AD-022 — Teste do caminho de leitura de Auditoria (`ConsultarAuditLogUseCase`, `GET /audit-log`)
- AD-031 — Testes unitários/componente no frontend (hoje zero)
- AD-032 — Testes dedicados para `PatientsController`/`AppointmentsController`
- ~~AD-034~~ **Concluída (23/07/2026)** — 3 causas raízes corrigidas (bug determinístico de FK + 2 causas de pressão de conexão). Arquitetura oficial documentada em [`09-Testes/02-Dedicated-Fixtures.md`](../09-Testes/02-Dedicated-Fixtures.md). Ver evidências no CHANGELOG e fechamento do ciclo em [`CICLO_ESTABILIZACAO_INFRAESTRUTURA.md`](../CICLO_ESTABILIZACAO_INFRAESTRUTURA.md).
- AD-035 (novo, descoberto em 23/07/2026, durante a auditoria de fechamento da AD-034) — 4 arquivos de `test/critical` divergem da arquitetura oficial de Dedicated Fixtures (`clinic-holiday-persistence.test.ts` e `recurring-block-persistence.test.ts` acumulam dado real no Tenant seedado sem nenhuma limpeza; `recurring-block-materialization.test.ts` e `recurring-block-management.test.ts` reimplementam manualmente a criação/limpeza de Tenant dedicado, duplicando lógica). Não corrigido — fora do escopo dos 3 arquivos com causa raiz confirmada na AD-034. Ver auditoria completa em `CICLO_ESTABILIZACAO_INFRAESTRUTURA.md`.

**Critério objetivo de conclusão:**
- `test/integration` deixa de ser um no-op documentado — ou some formalmente, com o CI atualizado
- Pelo menos 1 fluxo E2E real passando em CI
- Todos os itens acima com teste correspondente, listado nominalmente

**Riscos:** introduzir Playwright do zero é o maior item de tooling novo do plano — estimar à parte, não subestimar.

**Resultado esperado:** nenhum módulo crítico do sistema sem teste automatizado de regressão.

---

### Epic 14 — Deploy e CI/CD

**Objetivo:** ter um caminho real e repetível de produção.

**Dependências:** todos os epics anteriores — automatizar deploy de um sistema ainda inseguro, sem RLS completo ou sem cobertura de teste, apenas antecipa incidentes em produção.

**Tarefas:**
- AD-017 — Dockerfile de frontend, configuração Railway, pipeline de CD

**Critério objetivo de conclusão:**
- Dockerfile de frontend existe e builda
- Pipeline de CD real (mesmo que simples) deploya em ambiente de staging
- Rollback documentado e testado pelo menos uma vez

**Riscos:** decisão de provedor (Railway já é a intenção declarada nos docs, nunca configurada de fato) pode revelar custo/operacional não previsto.

**Resultado esperado:** deploy deixa de ser manual/inexistente.

---

### Epic 15 — Dívidas Técnicas Menores e Polimento

**Objetivo:** fechar itens de baixo risco/esforço que não bloqueiam nenhum epic anterior, e atualizar a documentação para refletir o estado final real.

**Dependências:** nenhuma dura — mas roda por último para não competir por atenção com itens críticos.

**Tarefas:**
- AD-023 — Decidir: adotar `react-hook-form`/`zod` de fato, ou remover as dependências mortas
- AD-025 — Decidir destino de `AiSettings` (schema morto): implementar teto de custo dinâmico, ou remover o modelo
- AD-030 — Corrigir `README.md` (números de teste finais, e confirmar que o princípio de RLS agora é verdadeiro, não mais aspiracional)

**Critério objetivo de conclusão:**
- Cada decisão registrada e implementada
- `README.md` reflete o estado real do sistema ao final do roadmap, sem nenhuma afirmação não verificável

**Riscos:** nenhum.

**Resultado esperado:** sem dependências mortas, sem schema não utilizado, documentação confiável.

---

## 2. Ordem de Engenharia (sequência técnica, não prioridade)

```
Epic 1  → Epic 2  → Epic 3  → Epic 4
                                  ↓
                     Epic 5  → Epic 6  → Epic 7
                                  ↓
                     Epic 8  → Epic 9
                                  ↓
              Epic 10 → Epic 11 → Epic 12
                                  ↓
                     Epic 13 → Epic 14 → Epic 15
```

A ordem segue dependência real, não facilidade nem urgência de negócio: fundação de ambiente e banco primeiro (Epic 1), depois um bug isolado que não custa nada corrigir cedo (Epic 2), depois segurança e observabilidade como infraestrutura transversal que todo o resto usa (Epics 3–4), só então o núcleo de domínio (usuários, financeiro, agenda — Epics 5–7), o canal do paciente por cima disso (Epics 8–9, que dependem do financeiro já fechado), a experiência da equipe por cima do canal e da segurança (Epics 10–12), e por último o fechamento formal (testes, deploy, polimento — Epics 13–15), que não faz sentido rodar antes do resto existir.

---

## 3. Roadmap por Fases

### Fase 1 — Fundação
**Epics:** 1, 2, 3, 4
**Resultado esperado:** ambiente reproduzível, seguro e rastreável — a base sobre a qual todo o resto é construído.
**Critério para iniciar a Fase 2:**
- Testes Críticos passam localmente contra Postgres real com RLS completo (15/15 tabelas)
- Zero rota mutante sem `@Roles`
- `correlationId` presente em 100% dos logs de request
- Bug de `modality` corrigido e testado

### Fase 2 — Núcleo de Domínio
**Epics:** 5, 6, 7
**Resultado esperado:** os três fluxos centrais de negócio — onboarding, ciclo financeiro, agenda — corretos e completos de ponta a ponta.
**Critério para iniciar a Fase 3:**
- Onboarding de clínica nova funcional via API, sem seed manual
- Ciclo `Session → Billing → Payment` fechado e testado
- `AvailabilityException` sobrevive a restart

### Fase 3 — Canal do Paciente
**Epics:** 8, 9
**Resultado esperado:** jornada do paciente pelo WhatsApp funcional de ponta a ponta, incluindo identidade de comunicação (`Contact`).
**Critério para iniciar a Fase 4:**
- Webhook real recebendo e processando mensagens
- `Contact` implementado e testado contra os 3 cenários que quebraram a modelagem original

### Fase 4 — Experiência da Equipe
**Epics:** 10, 11, 12
**Resultado esperado:** painel deixa de ser majoritariamente leitura; indicadores reais; equipe é notificada de eventos relevantes.
**Critério para iniciar a Fase 5:**
- Nenhuma página do frontend sem tratamento de erro
- Ações de mutação cobrindo o que o backend já suporta
- Dashboard consumindo endpoint dedicado, não mais cálculo client-side

### Fase 5 — Fechamento e Produção
**Epics:** 13, 14, 15
**Resultado esperado:** Vertex pronto para produção, com cobertura de teste completa e pipeline de deploy real.
**Critério de encerramento do roadmap:**
- Nenhum epic anterior com pendência aberta
- Suíte E2E cobrindo o fluxo principal
- Deploy automatizado funcionando em staging
- Documentação (`README.md`) refletindo o estado real do sistema

---

## 4. Kanban

**BACKLOG**
AD-007, AD-009, AD-010, AD-011, AD-012, AD-013, AD-014, AD-015, AD-017, AD-018, AD-019, AD-020, AD-021, AD-022, AD-023, AD-024, AD-025, AD-027, AD-028, AD-029, AD-030, AD-031, AD-032, AD-035

**PRÓXIMO**
Epic 5 (Gestão de Usuários) concluído com a AD-001; Epic 7 concluído com a AD-008. Próximo item do backlog a definir (auditoria de priorização indicou AD-009/Epic 6 como maior alavancagem, pendente de decisão de produto sobre o gatilho de `Faturada`).

**EM EXECUÇÃO**
_(vazio)_

**EM REVISÃO**
_(vazio)_

**CONCLUÍDO**
- AD-001 — CRUD de `User` (criar/listar/atualizar/desativar/reativar) + `POST /users/bootstrap-admin` para provisionar o primeiro admin de um Tenant recém-criado, sem `JwtAuthGuard` (não pode haver JWT ainda), protegido por garantia atômica de "Tenant com 0 usuários" (`SELECT ... FOR UPDATE`, validada sob concorrência real) em vez de checagem de aplicação. `super_admin` bloqueado em 3 camadas independentes. 3 achados reais corrigidos durante a implementação: (1) `AuditService` incompatível com o fluxo de bootstrap por depender de `TenantContext`, corrigido gravando o evento de auditoria dentro da própria transação do repositório; (2) regressão real no rate limit de `/auth/login` (AD-006) por dois registros independentes de `ThrottlerModule.forRootAsync()` — causa raiz confirmada lendo o pacote instalado (`ThrottlerModule` já é `@Global()` internamente, `isGlobal` nunca foi uma opção válida), corrigido consolidando em um único registro com throttlers nomeados; (3) gap de fixture de teste (Tenant dedicado sem assinatura ativa), não de produção. 35 testes novos (25 unitários + 10 críticos, Postgres real, incluindo concorrência real do bootstrap), suíte unitária 466/466, suíte crítica 162/163 (1 skip documentado pré-existente), 0 falhas — inclui a suíte de AD-006 passando, confirmando a regressão corrigida sem reintrodução. Nenhuma migration criada. Epic 5 (Gestão de Usuários) **concluído integralmente** com este item. Evidência completa no CHANGELOG.
- AD-008 — Persistência de `AvailabilityException` em `AvailabilityCalendar` (coluna JSON `exceptions`, mesmo padrão de `windows` — nunca uma tabela dedicada). Novo `DefinirExcecoesDisponibilidadeUseCase` + `PUT /therapists/:id/availability/exceptions` (`admin`, mesma política RBAC da rota de janelas). Achado corrigido durante a implementação: conversão de string ISO para `Date` na reconstituição, sem a qual a exceção persistiria mas nunca teria efeito real no Motor. 10 testes novos (4 unitários + 6 críticos, Postgres real), suíte unitária 441/441, suíte crítica 152/153 (1 skip documentado), 0 falhas. Epic 7 (Motor de Disponibilidade — Persistência de Exceções) **concluído integralmente** com este item. Evidência completa no CHANGELOG.
- AD-016 — Observabilidade de Base: Correlation ID ponta a ponta (middleware dedicado + `CorrelationContext` próprio, nunca uma extensão de `TenantContext`), OpenTelemetry com instrumentações registradas explicitamente (HTTP, Express, ioredis — nunca `auto-instrumentations-node`), `GET /metrics` protegido por token (Prometheus). Instrumentação de queries do Prisma deliberadamente adiada (exigiria `previewFeatures = ["tracing"]`, recurso experimental). 13 testes novos (5 unitários + 8 críticos, Postgres/Redis reais, incluindo o smoke de 3 fluxos exigido pelo critério de conclusão), suíte unitária 437/437, suíte crítica 146/147 (1 skip documentado), 0 falhas. Epic 4 (Observabilidade de Base) **concluído integralmente** com este item. Ver `ADR-0051` e evidência completa no CHANGELOG.
- AD-006 — `POST /auth/login` protegido por rate limit (`@nestjs/throttler`, 5 tentativas/60s, por IP, `trust proxy` configurado para produção atrás do Railway). Chave por IP puro, deliberadamente sem compor com email (decisão registrada). 4 testes novos (3 críticos, Postgres real + 1 unitário), suíte unitária 430/430, suíte crítica 138/139 (1 skip documentado), 0 falhas. Epic 3 (Segurança Fundamental) **concluído integralmente** com este item. Ver `ADR-0050` e evidência completa no CHANGELOG.
- AD-005 — `WhatsAppIntegration.accessToken` cifrado em repouso (AES-256-GCM, `TokenCipherService`, formato versionado `v1:iv:tag:ciphertext`, sem migration de schema, compatibilidade retroativa com tokens legados em texto puro). 8 testes novos (6 unitários + 2 críticos, Postgres real), suíte unitária 429/429, suíte crítica 135/136 (1 skip documentado), 0 falhas. Ver `ADR-0049` e evidência completa no CHANGELOG.
- AD-003 — `RolesGuard`+`@Roles` aplicado às 21/21 rotas mutantes sem controle de papel, em 5 etapas incrementais (`ClinicController` 3 · `TherapistsController` 3 · `Billing`+`PaymentController` 4 · `PatientsController` 5 · `Appointments`+`RecurringBlocksController` 6). Matriz centralizada em `docs/02-Arquitetura/16-Politica-RBAC.md`. 63 novos testes de RBAC, suíte crítica completa validada 2x consecutivas ao final (17/18 arquivos, 133/134 testes, 0 falhas), rodando a partir do novo ambiente oficial `/root/luxora-app` (ver ADR-0048, adotada durante esta mesma AD). Ver evidência completa no CHANGELOG.
- AD-004 — Corrigir `PrismaAppointmentRepository.upsertAll()` para gravar `modality`. **Validada por completo**: 3/3 testes críticos de regressão passando contra Postgres real (não mais pendente).
- AD-026 — Ambiente de desenvolvimento restaurado. Docker Engine nativo instalado dentro do WSL2 (Ubuntu 26.04), substituindo o Docker Desktop. Ver nota de resolução abaixo.
- AD-002 — RLS + índice de concorrência formalizados como migration versionada (`prisma/migrations/20260723190000_enable_rls/`). Validado em banco limpo e no banco de dev já configurado, idempotente, sem regressão. Ver evidências no CHANGELOG.
- AD-033 — `prisma/seed.ts` corrigido para operar sob RLS real, via `withTenantContext()` centralizado, `set_config()` parametrizado (sem interpolação SQL), uma transação por Tenant. Suíte crítica: 70 passando / 1 pulado / zero falhas reais. Ver evidências no CHANGELOG.
- AD-034 — 3 causas raízes independentes corrigidas (bug determinístico de FK + 2 causas de pressão de conexão sob paralelismo). 5 execuções consecutivas da suíte crítica, resultado idêntico em todas (70/71, zero timeout, zero erro de FK, zero erro de cleanup) — antes variava entre 39/71 e 45/71. Paralelização e timeouts da suíte inalterados. Ver evidências completas no CHANGELOG.

---

**CHECKPOINT FINAL — Incidente AD-026 formalmente encerrado (23/07/2026).**

1. **O Docker Desktop NÃO foi corrigido.**
2. **A causa raiz permanece inconclusiva** — investigação do defeito específico do Docker Desktop 4.82.0 (`run/dockerInference` e `docker-secrets-engine/engine.sock` como reparse points NTFS órfãos, sobrevivendo a reboot completo) foi encerrada sem confirmação.
3. **O ambiente oficial de desenvolvimento no Windows passa a ser Docker Engine nativo no WSL2**, substituindo o Docker Desktop para esse fim.
4. **A decisão foi motivada por continuidade do projeto** (destravar a Sprint 4), **não pela identificação da causa raiz.**
5. Procedimento completo de instalação/reprodução do zero: [`README.md` § Setup local](../../README.md#setup-local) e [`ADR-0047`](./02-Arquitetura/ADRs/ADR-0047-docker-engine-nativo-wsl2.md).

Decisão arquitetural formalizada em **[`ADR-0047`](./02-Arquitetura/ADRs/ADR-0047-docker-engine-nativo-wsl2.md) — status ADOTADO.**

**Solução aplicada:** Docker Engine nativo instalado diretamente na distro WSL2 Ubuntu 26.04 (via repositório oficial apt da Docker, pacotes `docker-ce`/`docker-ce-cli`/`containerd.io`/`docker-compose-plugin`), contornando por completo o componente do Docker Desktop com defeito. Docker Desktop permanece instalado, porém inativo — nenhuma remoção foi feita, a mudança é 100% reversível.

**Dois ajustes de configuração necessários, além da instalação do engine, descobertos durante a validação:**
- `C:\Users\pichau\.wslconfig` criado com `vmIdleTimeout=-1` e `localhostForwarding=true` — sem isso, a VM do WSL2 se desliga por ociosidade entre sessões, derrubando o `dockerd` e os containers junto. Para uso real de desenvolvimento, isso é resolvido naturalmente por manter um terminal WSL2 aberto durante o trabalho (padrão comum de uso, ex. terminal integrado do VS Code via extensão WSL).
- Migração `20260716171111_init` precisou ser marcada como `--rolled-back` (via `prisma migrate resolve`) antes de reaplicar — resultado de uma tentativa anterior interrompida por uma instabilidade de rede pontual durante a própria validação, não um problema recorrente.

**Validação completa realizada nesta sessão, com evidência:**
- `docker version`/`docker info`/`docker compose ps` funcionais, containers `postgres`/`redis` com `health: healthy`.
- 9/9 migrations aplicadas com sucesso.
- RLS aplicada nas 15 tabelas + índice único parcial de concorrência aplicados manualmente (mesmo conteúdo de `enable-rls.sql`/`unique-active-appointment.sql`) — primeira vez que este ambiente local tem a cobertura completa que a auditoria identificou como ausente (ver AD-002, ainda pendente de formalizar isso como migration versionada).
- Suíte crítica: 39/71 testes passando, incluindo os 3 testes da AD-004. 2 falhas reais (não relacionadas ao ambiente nem à AD-004) e algumas falhas de hook de limpeza — ambas registradas como novos itens de backlog abaixo (AD-033, AD-034).

**AD-033 e AD-034 são itens de backlog independentes, não bloqueiam a Sprint 4.** Ambos foram descobertos como efeito colateral da validação (RLS genuinamente ativa pela primeira vez expôs AD-033; execução completa e repetida da suíte expôs AD-034) — nenhum dos dois impede o uso normal do ambiente restaurado, da AD-004 validada, ou do início da AD-002. Seguem no Kanban em BACKLOG, sem prioridade sobre o restante da fila.

A hipótese de que a causa é uma limitação conhecida do Go/Windows na manipulação de reparse points de sockets AF_UNIX é **plausível, com evidência pública de apoio, mas não confirmada** — permanece registrada apenas como hipótese em `ADR-0047`, não como fato.

---

## 5. Primeira Tarefa — AD-004

### Por que ela é a primeira

O Epic 1 (Ambiente e Banco de Dados) é o dependency root de todo o roadmap, mas seu primeiro item (AD-026, desbloquear Docker) é um problema de ambiente externo já investigado exaustivamente em sessão anterior desta mesma engenharia, sem causa raiz resolvida (reparse point AF_UNIX do Windows, issue conhecida e sem fix confirmado do lado do Docker Desktop). Travar a primeira tarefa executável nesse item arrisca repetir o mesmo ciclo de tentativa-e-erro sem entrega, o que não serve ao ritmo executar→revisar→testar→concluir que este plano estabelece.

AD-004 é o item executável mais próximo de "pronto para começar agora" em todo o backlog:
- **Causa raiz já provada, com arquivo e linha exatos** — não exige investigação adicional, só execução.
- **Não depende de nenhuma decisão de produto em aberto** (diferente de AD-003, que precisa de política de papéis por rota, ou AD-009, que precisa de decisão sobre o gatilho exato de `Faturada`).
- **Não depende de Postgres/Docker para ser implementado e testado no nível de unidade** — o bug está na construção dos argumentos passados a `client.appointment.upsert()`; um teste de unidade com um `PrismaClient` mockado/spy é suficiente para provar a correção sem precisar do ambiente do Epic 1 resolvido. A verificação completa contra banco real (teste crítico) fica disponível assim que o Epic 1 avançar, mas não bloqueia o início.
- É estritamente uma correção de bug em código já existente — não introduz funcionalidade nova, consistente com a instrução de não expandir escopo.

O Epic 1 continua sendo trabalhado em paralelo/logo em seguida (AD-026 permanece uma tarefa aberta e rastreada) — escolher AD-004 primeiro não abandona a fundação, apenas evita bloquear o primeiro ciclo de entrega nela.

### Arquivos que serão alterados

- `apps/backend/src/infrastructure/database/repositories/prisma-appointment.repository.ts` — método `upsertAll` (linhas 92-112): adicionar `modality: appointment.modality` aos blocos `create` e `update` da chamada `client.appointment.upsert()`.

### Testes que precisarão ser criados ou ajustados

- **Novo arquivo:** `apps/backend/test/unit/infrastructure/database/repositories/prisma-appointment.repository.test.ts` (não existe hoje — confirmado por busca no repositório). Deve cobrir:
  - `upsertAll` chama `client.appointment.upsert` com `modality` presente no `create` quando o `Appointment` tem `modality: 'online'`
  - `upsertAll` chama `client.appointment.upsert` com `modality` presente no `update` quando o `Appointment` é atualizado com `modality: 'online'`
  - Regressão: sem a correção, o teste deve falhar (validar isso manualmente antes de commitar, revertendo a mudança uma vez)
- **Quando o Epic 1 (Postgres real) estiver disponível:** estender ou criar um teste em `test/critical/` confirmando que um `Appointment` criado via API com `modality: 'online'` é lido de volta com o mesmo valor após um `GET` — fechando o gap ponta a ponta, não só no nível de unidade.

### Critérios para marcar como concluída

- [ ] `modality` presente em ambos os blocos (`create` e `update`) de `upsertAll`
- [ ] Teste de unidade novo passando, e comprovadamente falhando sem a correção (checagem manual de regressão)
- [ ] `pnpm lint` e `pnpm build` limpos
- [ ] Nenhuma alteração fora do escopo deste arquivo (sem refatoração adicional do repositório)
- [ ] Movida para CONCLUÍDO no Kanban; próxima tarefa do Epic 2 (não há mais nenhuma — Epic 2 fecha aqui) libera o início do Epic 1 (AD-026) ou do Epic 3, conforme disponibilidade de ambiente
