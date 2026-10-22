# ADR-0069 — Ciclo de vida da consulta: confirmação, desfecho, aviso tardio, remarcação com histórico, elegibilidade para cobrança e migração das sessões legadas (MVP-01)

**Status:** PROPOSTA — **EM REVISÃO**. É só desenho técnico, sem nenhuma alteração de código, schema, migration, banco, configuração ou workflow.
- **Não autoriza** implementar, migrar dados, fazer commit, push ou deploy.
- **Não está aprovada**, com uma única exceção: a exceção arquitetural da seção 9.4, aprovada em 21/10/2026 no escopo restrito.
- A especificação de domínio e o backlog que a originam também continuam não aprovados.

**Origem:** item MVP-01 de [`docs/MVP_BACKLOG.md`](../../MVP_BACKLOG.md) e orientação do responsável pelo produto para DP-01 a DP-04, registrada na [especificação funcional do domínio, seção 4.1](../../01-Domain/14-Especificacao-Funcional-do-Dominio.md).

**Rodadas de revisão (21/10/2026):**
1. Orientação para a DP-26 (aviso depois do início) e a DP-27 (sessões legadas).
2. DP-26 detalhada (limite temporal, atuação da IA, horário do aviso); DP-27 reafirmada; o responsável **recusou** a proposta de corrigir o K2 depois da publicação. Esta versão desenha a estratégia de lançamento e rollback (seção 9.4) e mantém o K2 como **bloqueador** até ela ser aprovada, implementada e provada.
3. **Decisão sobre o K2:** o responsável **aprovou a exceção à ADR-0060 somente no escopo restrito** da seção 9.4. Também escolheu guardar o desfecho da consulta numa **estrutura própria, sem ampliar o enum `AppointmentState`** (seção 2.4: tabela `appointment_outcome`). A aprovação cobre só a exceção arquitetural: o restante da ADR continua em revisão, e o **K2 continua bloqueador** até as provas da seção 9.4.

4. **Decisões funcionais (rodada 5):** DP-22 a DP-25 e K11 receberam decisão de produto (seção 10.1). A ADR continua em revisão, e o K2 continua bloqueador.

**Código de referência:** `2dd7934` (igual a `origin/master`), lido em 21/10/2026. Nenhum teste foi executado; os achados marcados "por leitura" não foram reproduzidos.

## Objetivo

Permitir implementar com segurança o ciclo de vida da consulta, sem quebrar a arquitetura existente e sem abrir caminho para cobrança indevida, inclusive depois de um rollback. O ciclo cobre:

- confirmação;
- realização;
- falta sem aviso e falta abonada;
- cancelamento no prazo e fora do prazo;
- comunicações do paciente e **aviso tardio**;
- remarcação com histórico;
- **elegibilidade das sessões para cobrança**;
- tratamento das sessões criadas pelo comportamento atual, que marca como "Realizada" o que só foi confirmado.

## Como ler

| Marca | Significado |
|---|---|
| **[EV]** | Evidência lida no código em `2dd7934`, com o arquivo |
| **[REG]** | Decisão ou orientação já registrada (especificação 4.1, seção 10.1 desta ADR, ADRs anteriores) |
| **[PROP]** | Proposta técnica desta ADR, para revisão |
| **[PEND]** | Questão não resolvida; o desenho não a assume |

Caminhos sem prefixo partem de `apps/backend/`.

---

## 1. Diagnóstico da arquitetura existente

### 1.1 Entidades, estados e mecanismos que já existem [EV]

| Elemento | Arquivo | Estados / campos relevantes | Garantias |
|---|---|---|---|
| Consulta (`Appointment`) | `src/domain/appointment/appointment.entity.ts`, `prisma/schema.prisma` | `Criada → Reservada → Confirmada`, `ReagendamentoSolicitado → Reagendada`, `Cancelada` (terminal) | Máquina de estados (ADR-0017); índice único parcial `unique_active_appointment_slot … WHERE state != 'Cancelada'` (migration `20260723190000_enable_rls`); `@@unique([recurringBlockId, scheduledAt])` |
| Sessão (`Session`) | `src/domain/session/session.entity.ts` | `Realizada → Faturada → Recebida`. Criada só por `Session.createFromConfirmedAppointment` | `appointment_id` único |
| Cobrança e vínculo | `src/use-cases/billing/billing.use-cases.ts`, `prisma-billing.repository.ts` | Cobrança com `amount` digitado; vínculo N:N com sessões | `billing_session.session_id` único. **Não há** conferência de paciente nem de estado da sessão, e a cobrança é gravada antes do vínculo, em transações separadas (achado 5) |
| Pagamento | `src/use-cases/payment/payment.use-cases.ts` | `recebido`, `em_conferencia`, `confirmado`, `divergente`, `estornado` | `idempotency_key` único; quitação leva as sessões a `Recebida` (ADR-0052) |
| Configuração da clínica | `ClinicSettings`, `src/domain/clinic/clinic.entity.ts` | `cancellationHoursLimit`, `defaultBillingPolicy`, `timeZone` | Nenhum caso de uso lê `cancellationHoursLimit`. Mudança de política auditada como `politicas_alteradas`, **sem os valores** |
| Horário fixo | `materializar-recurring-block.use-case.ts` | Idempotência por `(recurringBlockId, scheduledAt)` | Sem chamador em produção |
| Mensagem de entrada | `src/use-cases/communication/receber-mensagem-whatsapp.use-case.ts`, `Message` | `content`, `externalId` (WAMID), `created_at` | Gravada na parte **síncrona** do webhook, antes da fila: `created_at` é o recebimento, não o processamento (por leitura). O payload tipado **não declara** o `timestamp` que a Meta envia, e ele não é guardado |
| Auditoria | `src/domain-services/platform/audit.service.ts` | `user_id`, `actor_type`, `action`, `payload`, `created_at` | Imutável pela API (Teste Crítico #11) |
| Usuário | `User` | `admin`, `therapist`, `super_admin`; `therapistId` opcional | `RolesGuard`; `16-Politica-RBAC.md` |
| Comprovantes | — | **Não existem no sistema** (ADR-0013 não implementada; imagem recebida vira aviso, A-15) | — |
| Deploy e rollback | `infra/scripts/deploy.sh`, `rollback.sh`, `lib.sh`, `build-images.sh` | A versão é a tag da imagem, por padrão o hash curto do commit (não ordenável). O rollback automático volta para a versão registrada em `previous-version`, num arquivo do host. `rollback.sh --to <tag>` aceita **qualquer** tag | **Nenhuma** conferência de compatibilidade entre a versão de destino e o banco. A ADR-0060 só exige que toda migration seja compatível com a versão anterior |

### 1.2 Como o ciclo funciona hoje [EV]

- **Agendar:** passa pelo motor de disponibilidade e grava em `Reservada`. Aceita horário no passado.
- **Confirmar:** muda para `Confirmada` e **cria a sessão em `Realizada`**, em gravações separadas. Painel e WhatsApp (`confirmar_presenca`) usam o mesmo caminho.
- **Cancelar:** muda para `Cancelada` em qualquer momento, **inclusive depois do início**, sem registrar quando o aviso chegou, quem pediu ou o motivo.
- **Remarcar:** sobrescreve `scheduledAt` no mesmo registro; o evento guarda só os estados.
- **Cobrar:** o administrador escolhe sessões e digita o valor; qualquer sessão da clínica é aceita.
- **Pagar:** pagamento confirmado quita a cobrança e as sessões vão a `Recebida`.

### 1.3 Achados desta leitura

Nenhum foi corrigido.

1. **`session.completed_at` nunca é gravado** [EV]: `PrismaSessionRepository.save()` não envia o campo.
2. **Reconfirmar depois de remarcar provavelmente falha com erro interno** (por leitura): segunda sessão com o mesmo `appointment_id`.
3. **Remarcar ocorrência de horário fixo quebra a idempotência da materialização** (por leitura; latente).
4. **O motor de disponibilidade não lê consultas que começaram antes e ainda estão em andamento** (por leitura).
5. **A cobrança não confere paciente nem estado das sessões e não é atômica** (por leitura). Uma falha no vínculo deixa uma cobrança sem sessão, que pode ser enviada.
6. **Ações do WhatsApp são auditadas como `system`**, e a auditoria é gravada fora da transação [EV].
7. **O papel `therapist` age sobre qualquer consulta da clínica** [EV].
8. **Não há relógio injetável** [EV].
9. **O agendamento aceita horário no passado** (por leitura).
10. **O rollback não confere se a versão de destino é compatível com os dados** [EV]. Qualquer versão antiga pode voltar ao ar contra um banco já migrado; é a causa estrutural do K2.

### 1.4 Restrições que o desenho respeita [REG]

- **ADR-0017** (máquina de estados), **ADR-0040** (motor de disponibilidade), **ADR-0052** (gatilhos de `Faturada` e `Recebida`), **ADR-0063** (identidade e `UnitOfWork`), **ADR-0064** (fuso).
- **ADR-0060:** o rollback troca só a aplicação; migrations compatíveis com a versão anterior. **Exceção aprovada em 21/10/2026, só no escopo restrito da seção 9.4:** versões sem `billing-eligibility-v1` continuam operando em modo degradado, mas não criam cobrança nem vínculo. Nenhuma outra incompatibilidade foi aprovada; por isso o enum `AppointmentState` não é ampliado.
- **`docs/03-Database/11-Funcoes-e-Triggers.md`:**
  - triggers são excepcionais;
  - elas não podem "gerar cobranças" nem "alterar estados do domínio";
  - "toda regra de negócio … deverá permanecer implementada no Backend".
  - A política lista "validação complementar da persistência" entre os usos permitidos, mas o responsável pediu considerar a restrição a triggers. Este desenho **não usa trigger**.
- **`docs/03-Database/05-Constraints.md`:** relacionamentos com chaves estrangeiras explícitas; "evitar triggers para validações simples".
- **Especificação 4.1**, **DP-26** e **DP-27** (seção 10.1).
- **Produto:** dívida não bloqueia nem libera agendamento; nada clínico é guardado; histórico das conversas preservado; contexto da IA segundo a D-A.

---

## 2. Modelo de estados, comunicações e elegibilidade

### 2.1 Conceitos separados

| Conceito | Pergunta | Onde fica |
|---|---|---|
| Horário reservado | O horário está ocupado para o paciente? | Consulta `Reservada` (ou `Reagendada`, legado) |
| Consulta confirmada | O paciente disse que vem? | Consulta `Confirmada`; nada no financeiro |
| **Comunicação do paciente** | O que o paciente disse, quando chegou e por qual canal? | **Registro de comunicação** (`appointment_notice`), somente acréscimo; não muda a consulta sozinho |
| Cancelamento | O paciente avisou, antes do início, que não vem? | Consulta `Cancelada` ou `Remarcada`, ligada à comunicação que a justificou |
| **Aviso tardio** | O paciente avisou, depois do início previsto, que não vem? | Comunicação classificada `depois_do_inicio`; a consulta só vai a `AvisoTardio` **por decisão de uma pessoa** |
| Falta sem aviso | O paciente não veio e não avisou? | Consulta `Falta`, registrada por pessoa |
| Atendimento realizado | O atendimento aconteceu? | Consulta `Realizada`, registrada por pessoa depois do início |
| **Item faturável** | Há algo a cobrar por esta ocorrência? | `Session` com `kind` e **elegibilidade** (seção 2.9) |

### 2.2 Comunicação do paciente e classificação do momento [REG DP-04, DP-26] → [PROP]

Toda comunicação sobre uma consulta (pelo WhatsApp ou registrada no painel) vira um registro próprio, **somente acréscimo**, com:
- intenção identificada: `nao_comparecera`, `atraso`, `pedido_cancelamento`, `pedido_remarcacao` ou `indefinida`;
- marca de ambiguidade;
- classificação do momento.

A classificação compara o **horário de referência** (seção 2.3) com o **início previsto** da consulta:

| `timing` | Quando |
|---|---|
| `no_prazo` | Antes do início, com antecedência maior ou igual ao limite da clínica |
| `fora_do_prazo` | Antes do início, com antecedência menor que o limite |
| `sem_limite_configurado` | Antes do início, sem limite configurado |
| `depois_do_inicio` | No instante do início ou depois, **sem limite final** (DP-26, rodada 2): uma mensagem que chega depois do fim do horário continua sendo comunicação, classificada pelo início previsto |

Classificar não é decidir: `depois_do_inicio` **não** é falta, cancelamento nem cobrança (DP-26).

### 2.3 Horário do aviso: recebido, registrado e alegado [REG DP-26] → [PROP]

| Campo | O que é | Fonte | Pode ser alterado? |
|---|---|---|---|
| `provider_sent_at` | Carimbo de tempo da mensagem enviado pela Meta no webhook | Integração (webhook com assinatura conferida, ADR-0053). **Hoje não é lido nem guardado** | Não |
| `received_at` | Momento em que o Vertex recebeu a mensagem | `message.created_at`, gravado na parte síncrona do webhook | Não |
| `recorded_at` | Momento em que o Vertex registrou a comunicação | Relógio do sistema | Não |
| `claimed_at` | Horário **alegado**: aviso por outro canal, ou o paciente afirma ter enviado em outro horário | Informado por pessoa no painel, com `claim_source` (`telefone`, `presencial`, `outro_canal`, `alegacao_do_paciente`) | Não; correção = novo registro |
| `recorded_by` | Quem registrou: usuário ou `ai_agent` | Sessão autenticada ou worker | Não |

**Horário de referência da classificação** (`reference_time`, com `reference_source`):
- **WhatsApp:** `provider_sent_at` quando presente e válido; senão `received_at`. Nunca o horário de processamento na fila. "Válido" significa: não está no futuro além de uma tolerância e não é anterior ao `received_at` em mais do que um limite. Os dois valores são parâmetros técnicos a fixar na implementação. A semântica exata do carimbo da Meta precisa ser confirmada na documentação oficial na implementação; não foi consultada nesta etapa. [PROP]
- **Painel:** `recorded_at`. Uma comunicação registrada no painel não tem horário de recebimento comprovado pelo sistema.
- **O horário alegado nunca é horário de referência.** Ele é guardado e mostrado como "alegado", com a classificação que teria (`claimed_timing`), separado da classificação oficial. Uma pessoa pode levá-lo em conta numa decisão (abono, consequência), e essa decisão fica registrada com autor e motivo.

**Imutabilidade:** os campos de horário e de origem nunca são reescritos.
- Corrigir = novo registro com `supersedes_notice_id`, motivo e autor.
- Só os campos de revisão (`review_status`, `reviewed_by`, `reviewed_at`) mudam.
- [PROP] No banco, a imutabilidade usa **privilégio por coluna**, sem trigger: o papel da aplicação recebe `UPDATE` apenas nas colunas de revisão.

### 2.4 Estado de agenda e desfecho da consulta [REG alternativa (b), 21/10/2026] → [PROP]

Cada linha de `appointment` é **uma ocorrência**: um horário e um desfecho. A remarcação encerra a ocorrência e cria outra (seção 5).

**Estado de agenda mais tabela de desfecho; o enum antigo não muda.** O responsável escolheu a alternativa (b): preservar a leitura pelas versões anteriores, sem ampliar o enum `AppointmentState`.
- **`appointment.state`** (enum `AppointmentState`, **sem valores novos**) é o estado de agenda que as versões anteriores conhecem.
- **`appointment_outcome`** (tabela nova, 1:1 com a consulta, chave `appointment_id`) guarda:
  - o desfecho (`AppointmentOutcome`: `Realizada`, `Falta`, `FaltaAbonada`, `AvisoTardio`, `Remarcada`, `Cancelada`);
  - tudo o que é gravado depois dele: comunicação que o encerrou, decisões, autoria;
  - um **retrato** de `state`, `scheduled_at` e `modality` no momento do registro.

Os nomes `Realizada`, `Falta`, `FaltaAbonada`, `AvisoTardio`, `Remarcada` e `Cancelada`, quando usados como desfecho nesta ADR, são **valores de `appointment_outcome.outcome`**.

| Desfecho | `appointment.state` (e no retrato) | O que a versão anterior vê | Ocupa horário? | Quem registra |
|---|---|---|---|---|
| — (sem linha de desfecho) | `Criada`, `Reservada`, `Confirmada`, `ReagendamentoSolicitado`, `Reagendada` (legado), ou `Cancelada` feita por versão anterior ou legado | O estado, como hoje | sim (`Cancelada`: não) | sistema, pessoa ou IA, como hoje |
| `Realizada`, `Falta`, `FaltaAbonada`, `AvisoTardio` | o estado de agenda no momento (`Reservada`, `Confirmada` ou `Reagendada`) | Uma consulta `Confirmada` (ou `Reservada`) no passado | sim | pessoa (`AvisoTardio`: com base em comunicação `depois_do_inicio`) |
| `Remarcada` | `Cancelada`, gravado antes do desfecho, na mesma transação | Uma consulta cancelada; a nova ocorrência aparece normalmente | **não** | pessoa; IA só com confirmação explícita do paciente (K11) |
| `Cancelada` | `Cancelada` | Uma consulta cancelada | **não** | pessoa; IA só com confirmação explícita do paciente (K11) |

**Correção (rodada 4): um `CHECK` não congela a linha.** A rodada 3 atribuía o congelamento a um `CHECK` que comparava `state` e `scheduled_at` com cópias guardadas na mesma linha. Um `CHECK` só avalia a linha **nova**; não compara com o valor anterior.
- Ele barraria uma versão antiga que não conhece as cópias.
- Não barraria a versão nova, nem qualquer escrita que atualizasse o estado e a cópia juntos.
- Por isso não serve como garantia de imutabilidade, e foi retirado.

**A garantia passa a ser feita por três mecanismos, sem trigger:**

1. **Chave estrangeira composta de congelamento (garantia principal) [PROP]:**
   - `appointment` ganha `UNIQUE (id, tenant_id, state, scheduled_at, modality)`.
   - `appointment_outcome` guarda o retrato (`state_at_outcome`, `scheduled_at_at_outcome`, `modality_at_outcome`) e tem `FOREIGN KEY (appointment_id, tenant_id, state_at_outcome, scheduled_at_at_outcome, modality_at_outcome) REFERENCES appointment (id, tenant_id, state, scheduled_at, modality)`, com `ON UPDATE NO ACTION` e `ON DELETE NO ACTION`, o padrão.
   - Se alguém alterar `state`, `scheduled_at` ou `modality` de uma consulta com desfecho, a chave **anterior** continua referenciada, e o PostgreSQL recusa a alteração com erro de chave estrangeira (23503). É justamente a comparação com o valor anterior que um `CHECK` não faz.
   - Vale para qualquer papel e qualquer versão da aplicação, inclusive o administrador, enquanto a restrição existir. Apagar a consulta também é recusado.
2. **Privilégios em `appointment_outcome` [PROP]:** o papel da aplicação recebe `INSERT` e `SELECT`, `UPDATE` só nas colunas de desfecho e de decisão (nunca no retrato, em `appointment_id` ou em `tenant_id`) e **nenhum `DELETE`**. A aplicação não consegue "descongelar" a consulta apagando ou reescrevendo o retrato.
3. **Política RLS restritiva de `UPDATE` em `appointment` (complemento) [PROP]:**
   - `CREATE POLICY appointment_frozen_after_outcome ON appointment AS RESTRICTIVE FOR UPDATE TO luxora_app USING (NOT EXISTS (SELECT 1 FROM appointment_outcome o WHERE o.appointment_id = appointment.id))`.
   - Em política de `UPDATE`, o `USING` é avaliado sobre a linha **existente**. Assim, ela bloqueia qualquer atualização em consulta com desfecho, inclusive de colunas fora da chave de congelamento.
   - **Precisa ser `RESTRICTIVE`.** Hoje `appointment` tem só a política permissiva `tenant_isolation`, para todos os comandos, com `USING (tenant_id = current_setting('app.tenant_id', true))` e RLS forçada [EV `20260723190000_enable_rls/migration.sql`]. Uma política permissiva nova seria combinada por OR com essa e não protegeria nada; restritivas se combinam por AND.
   - Nenhuma exceção de bypass (`app.bypass_tenant_check`) existe em `appointment`. As três exceções atuais são de outras tabelas [EV]. O papel `luxora_app` não é superusuário nem tem `BYPASSRLS` [EV `infra/docker/postgres-init/01-app-role.sql`].

| Mecanismo | Compara com o valor anterior? | Quem fica obrigado | Comportamento na recusa | Limites |
|---|---|---|---|---|
| `CHECK` com cópia na linha | Não | — | — | Descartado como garantia |
| FK composta | Sim (chave anterior referenciada) | Todos os papéis | Erro explícito (23503) | Cobre `state`, `scheduled_at`, `modality` e exclusão; o administrador pode remover a restrição |
| RLS restritiva de `UPDATE` | Sim (`USING` na linha existente) | Só `luxora_app`: superusuário e `BYPASSRLS` ignoram RLS | `UPDATE` comum: a linha fica fora do alcance e nada é atualizado, **sem erro**. `INSERT … ON CONFLICT DO UPDATE`: erro | Recusa silenciosa no `UPDATE` comum; depende do contexto de clínica (sem `app.tenant_id`, a política permissiva já esconde todas as linhas) |

**Recomendação:** FK composta mais privilégios como garantia; RLS restritiva como complemento, para as demais colunas no papel da aplicação.

**Efeito nas versões anteriores** [EV `prisma-appointment.repository.ts`]: a única escrita delas em `appointment` é o `upsert` de `upsertAll`, que cria a consulta ou atualiza `scheduledAt`, `modality` e `state`.

*Em consulta **com** desfecho:*
- confirmar muda o estado → recusado. Como a versão anterior grava a consulta antes da sessão, nenhuma sessão é criada;
- cancelar → recusado;
- remarcar no lugar (horário e estado mudam) → recusado;
- regravar sem mudar nada → sem efeito.

O erro exato depende de o Prisma executar o `upsert` como `INSERT … ON CONFLICT DO UPDATE` ou como atualização emulada; em ambos os casos nada é gravado. Isso precisa ser **confirmado no ensaio**.

*Em consulta **sem** desfecho, tudo continua como hoje.* O cancelamento e a remarcação no lugar, feitos pela versão anterior em modo degradado:
- perdem o histórico da ocorrência, como já acontece hoje;
- ficam sem linha de desfecho;
- a versão nova os trata como cancelamento ou remarcação sem registro de aviso.

**Remarcação na versão nova,** numa só transação:
1. grava `state = 'Cancelada'` na ocorrência anterior, que ainda não tem desfecho;
2. insere a linha de desfecho `Remarcada`, com o retrato já cancelado;
3. insere a nova ocorrência, com `rescheduled_from_id`.

A ordem é obrigatória: se invertida, a FK recusa o passo 1.

**Outra correção da rodada 3:** ela também punha na linha da consulta `CHECK`s (por exemplo, comunicação obrigatória em cancelamentos novos) que recusariam um cancelamento feito por versão anterior. Seria uma incompatibilidade não aprovada. Esses dados passam para `appointment_outcome`, e a linha da consulta não ganha `CHECK` novo.

**Invariantes:**
- Todo registro de desfecho grava o retrato com os valores lidos sob `FOR UPDATE`, na mesma transação.
- Nada atualiza `appointment` depois que existe a linha de desfecho; a versão nova grava decisões e correções só em `appointment_outcome`.
- O papel da aplicação nunca recebe `DELETE` em `appointment_outcome`, nem `UPDATE` no retrato.
- Nenhuma migration remove a FK de congelamento ou a política restritiva sem ADR própria (teste no CI).
- Nenhuma política permissiva nova em `appointment`.

**Limites (sem trigger):**
- O administrador pode remover a restrição ou a política. A FK continua valendo para ele enquanto existir; a política, não.
- Colunas fora da chave ficam protegidas só pela política RLS, que vale só para `luxora_app` e recusa em silêncio no `UPDATE` comum. Código futuro com `updateMany` poderia "funcionar" sem efeito; isso pede teste.
- Em modo degradado, a versão anterior continua cancelando e remarcando no lugar consultas sem desfecho.
- O comportamento exato do Prisma 5 na recusa ainda precisa ser confirmado no ensaio.

**Viabilidade:** a solução é sólida sem trigger. A FK cobre `state`, `scheduled_at`, `modality` e a exclusão; a RLS restritiva cobre as demais colunas no papel da aplicação. O ponto **não fica como bloqueador separado**: entra nas provas do K2 (seção 9.4).

### 2.5 Transições permitidas

Na coluna "Para", `Realizada`, `Falta`, `FaltaAbonada`, `AvisoTardio` e `Remarcada` são valores de `appointment_outcome.outcome`, e a consulta fica congelada como na seção 2.4. O cancelamento pela versão nova (T3) grava `state = 'Cancelada'` e o desfecho `Cancelada`. `Confirmada` é valor de `state`.

| # | De | Para | Quem | Quando | Efeito no item faturável | Evento auditado |
|---|---|---|---|---|---|---|
| N1 | — | registro de comunicação | IA (mensagem recebida) ou pessoa (painel) | qualquer momento, inclusive depois do fim do horário ou de um desfecho | nenhum; **não muda a consulta** | `ComunicacaoRegistrada` |
| N2 | comunicação | comunicação revista | pessoa | — | nenhum | `ComunicacaoRevista` |
| T1 | `Criada` | `Reservada` | sistema | — | nenhum | `AgendamentoEstadoAlterado` |
| T2 | `Reservada`, `Reagendada` | `Confirmada` | `admin`, `therapist` responsável [PROP]; IA | antes do início | **nenhum** | idem |
| T3 | `Reservada`, `Confirmada`, `Reagendada` | `Cancelada` (`no_prazo`, `fora_do_prazo`, `sem_limite_configurado`) | pessoa; IA só depois de confirmação explícita do paciente (K11) | referência antes do início | nenhum; fora do prazo: consequência pela política da clínica (DP-22); pedido da clínica ou do profissional: nunca cobra (DP-25) | `ConsultaCancelada`, ligada à comunicação |
| T4 | `Reservada`, `Confirmada`, `Reagendada` | `AvisoTardio` | **pessoa** (`admin` ou `therapist` responsável), indicando a(s) comunicação(ões) `depois_do_inicio` | depois do início | nenhum; decisão de consequência pendente | `AvisoTardioRegistrado` |
| T5 | `Reservada`, `Confirmada`, `Reagendada` | `Remarcada` + nova `Reservada` | mesmos de T3 | referência antes do início | nenhum | `ConsultaRemarcada` (nas duas) |
| T5b | `AvisoTardio` | nova `Reservada` ligada | pessoa | depois de T4 | nenhum | `ConsultaRemarcada` |
| T6 | `Reservada`, `Confirmada`, `Reagendada` | `Realizada` | **pessoa** autenticada | depois do início | cria ou reativa o item `atendimento` | `RealizacaoRegistrada` |
| T7 | idem | `Falta` (`aguardando_decisao`) | **pessoa** | depois do início | nenhum; aviso à equipe | `FaltaRegistrada` |
| T8 | `Falta` (`aguardando_decisao`) | `Falta` (`cobranca_confirmada`) | `admin` | — | cria ou reativa o item `falta` | `CobrancaDeFaltaConfirmada` |
| T9 | `Falta` (`aguardando_decisao`) | `FaltaAbonada` | conforme `abono_approvers` (DP-23: padrão `admin`; `super_admin` nunca; motivo obrigatório) | — | nenhum | `FaltaAbonada` |
| T9b | `FaltaAbonada` | `Falta` (`aguardando_decisao`) | `admin`, com motivo (DP-24a) | — | nenhum: volta para decisão humana | `AbonoRevertido` |
| T10 | `Realizada`, `Falta`, `AvisoTardio` | outro desses três | `admin`, com motivo | item ainda não cobrado | anula, ou troca o tipo e reativa | `DesfechoCorrigido` |
| T11 | `Cancelada`/`Remarcada` (`fora_do_prazo`), `AvisoTardio` | decisão `sem_cobranca` ou `cobranca_confirmada` (DP-22) | `admin` | — | com `cobranca_confirmada`, cria o item `aviso_fora_do_prazo` ou `aviso_tardio` pelo valor integral aplicável; nunca para pedido da clínica ou do profissional (DP-25) | `ConsequenciaDoAvisoDecidida` |

### 2.6 Transições e efeitos proibidos

Cada um vira teste (seção 8):

- **Comunicações:**
  - Uma comunicação nova sobrescrever um desfecho já registrado (DP-26). Ela vira evento adicional, e a equipe é sinalizada.
  - A IA levar a consulta a `Falta`, `AvisoTardio`, `Realizada` ou `FaltaAbonada`, decidir consequência ou gerar cobrança (DP-26).
  - A IA cancelar ou remarcar **depois do início** de referência, ou sem confirmação explícita do paciente (K11).
  - A IA transformar `atraso`, ou uma mensagem ambígua, em ausência (DP-26).
- **Horários:**
  - Usar `claimed_at` como horário de referência, ou reescrever `provider_sent_at`, `received_at` ou `recorded_at` (DP-26).
- **Inferências e conversões:**
  - Confirmar criar item faturável.
  - O horário passar mudar o estado; realização inferida pelo tempo, por confirmação ou por cobrança (DP-26, DP-27).
  - `AvisoTardio`, ou uma comunicação `depois_do_inicio`, virar `Falta`, `Cancelada` ou cobrança sem ação humana (DP-26).
  - Converter `Cancelada` (fora do prazo) em `Falta`.
- **Cobrança:**
  - Cobrança por aviso fora do prazo ou tardio sem confirmação humana, mesmo com a política `sugerir_cobranca` (DP-22).
  - Cobrança ao paciente por cancelamento pedido pela clínica ou pelo profissional (DP-25).
  - Abono aprovado por `super_admin` ou sem motivo (DP-23).
  - Cobrança que inclua sessão **inelegível**, de **outro paciente** ou de **outra clínica** (seção 2.9).
- **Desfechos:**
  - Desfecho de atendimento (T6, T7) antes do início.
  - Sair de `Cancelada` ou `Remarcada`; sair de `FaltaAbonada` só pela reversão do abono (T9b, DP-24a); `Realizada`, `Falta` ou `AvisoTardio` irem a `Cancelada`.
  - Correção com item já cobrado: segue a DP-06.
- **Dívida** mudar o resultado de agendar, confirmar, cancelar, comunicar ou remarcar (MVP-05).
- **Versão sem a capacidade** (rollback degradado) mudar `state` ou `scheduled_at` de consulta com desfecho, ou criar cobrança ou vínculo. O banco recusa (seções 2.4 e 3.7).

### 2.7 Consistência dentro da linha e entre tabelas [PROP]

- **Uma transição por vez:** todo caso de uso roda em `UnitOfWork.run()` com `SELECT … FOR UPDATE` na consulta. A gravação da comunicação (N1) não trava a consulta: comunicação e desfecho simultâneos não se perdem. A comunicação registra `arrived_after_outcome` conforme o estado lido na mesma transação.
- **Congelamento da consulta com desfecho:** FK composta, privilégios e RLS restritiva (seção 2.4). A linha de `appointment` **não ganha `CHECK` novo**, para não recusar operações das versões anteriores.
- **`CHECK` em `appointment_outcome`** (todos sobre a própria linha):
  - `no_show_decision` preenchido se e somente se `outcome = 'Falta'`;
  - `outcome` em `Remarcada` ou `Cancelada` exige `state_at_outcome = 'Cancelada'`; os demais exigem `state_at_outcome` em `Reservada`, `Confirmada` ou `Reagendada`;
  - `closing_notice_id` obrigatório para `AvisoTardio`, `Remarcada` e `Cancelada`;
  - `outcome_recorded_at` e `outcome_recorded_by_user_id` obrigatórios.
- **Coerência entre o desfecho e a comunicação que o encerra:** em `appointment_outcome`, chave estrangeira composta `(closing_notice_id, closing_notice_timing) → appointment_notice(id, timing)`, com `CHECK` ligando `outcome = 'AvisoTardio'` a `closing_notice_timing = 'depois_do_inicio'`, e `Remarcada` e cancelamento a uma classificação anterior ao início. Sem trigger.
- **Comunicação ligada à consulta da mesma clínica e do mesmo paciente:** chave composta `(appointment_id, tenant_id, patient_id) → appointment`.

### 2.8 Duplicidade [PROP]

- Uma comunicação por mensagem de entrada (`message_id` único em `appointment_notice`): reprocessamento da fila não duplica.
- Item faturável: `session.appointment_id` único; reaproveitado, nunca recriado (`voided_at`).
- `billing_session.session_id` único; `rescheduled_from_id` único.
- Repetir o mesmo desfecho devolve 200 sem novo evento; um desfecho diferente devolve 409.
- **Cobrança:** a elegibilidade da seção 2.9, na aplicação e no banco.

### 2.9 Elegibilidade das sessões para cobrança [PROP] (resposta ao K1 e ao K2)

**Regra (positiva, falha fechada):** uma sessão só pode entrar numa cobrança se, ao mesmo tempo:
1. tem `kind` preenchido (`atendimento`, `falta` com cobrança confirmada ou aviso com cobrança confirmada, DP-22);
2. não está anulada;
3. está no estado inicial (a faturar) e sem vínculo;
4. é do **mesmo paciente** e da **mesma clínica** da cobrança.

Sessão legada sem desfecho comprovado (sem `kind`) nunca é elegível (DP-27).

**Onde a regra vive:**
- **Na aplicação:** `GerarCobrancaUseCase` confere os quatro pontos e grava cobrança e vínculos numa única transação (`UnitOfWork`), sem cobrança órfã.
- **No banco, por restrições declarativas, sem trigger e sem função** (seção 3.7). Qualquer versão da aplicação, inclusive uma antiga num rollback, fica impedida de:
  - vincular sessão inelegível, de outro paciente ou de outra clínica;
  - **criar cobrança sem declarar que conferiu a elegibilidade**.

  A decisão de elegibilidade continua no backend (o banco não calcula regra de negócio). O banco só garante que o vínculo aponte para uma sessão marcada elegível, do mesmo paciente e da mesma clínica, e que a marca seja coerente com a própria linha da sessão.

### 2.10 Auditoria [PROP]

| Elemento | Origem |
|---|---|
| Autor | `audit_log.user_id`; ações da IA com `actor_type = 'ai_agent'` explícito (achado 6) |
| Momentos | `audit_log.created_at`; na comunicação, `provider_sent_at`, `received_at`, `recorded_at` e `claimed_at` separados (seção 2.3) |
| Estado anterior e novo | `AgendamentoEstadoAlterado` (`fromState`, `toState`) |
| Atomicidade | `recordAll` dentro do mesmo `UnitOfWork.run()` |
| Comunicação | A própria tabela é trilha somente de acréscimo; correções por novo registro (`supersedes_notice_id`); `ComunicacaoRegistrada` e `ComunicacaoRevista` na auditoria |
| Privacidade | O texto da mensagem continua só em `message` (D-F revista). A comunicação guarda a referência (`message_id`), a intenção e a classificação. Motivo livre de até 200 caracteres, fora da auditoria e da IA |

### 2.11 Permissões

**O que existe [EV]:**
- os papéis `admin`, `therapist` e `super_admin`;
- `User.therapistId`;
- rotas de consulta para `admin` e `therapist`;
- rotas financeiras só para `admin`.

**Lacunas:**
- sem secretaria nem financeiro (DP-14);
- sem permissão de abono (DP-23);
- sem restrição do terapeuta às próprias consultas (achado 7).

**Proposta, sem papel novo:**

| Ação | `admin` | `therapist` | IA |
|---|---|---|---|
| Registrar comunicação (N1) e revisar (N2) | sim | só nas próprias consultas [PROP] | N1 só da mensagem recebida |
| Confirmar | sim | próprias | paciente da conversa |
| Cancelar e remarcar antes do início | sim | próprias | só com confirmação explícita do paciente (K11) |
| Aviso tardio (T4), realização, falta | sim | próprias | **nunca** |
| Cobrança de falta, abono e reversão, correção, consequência | sim (DP-23; `super_admin` nunca abona) | abono só se a clínica habilitar, e só depois da restrição às próprias consultas (DP-23) | **nunca** |

---

## 3. Modelo de dados proposto

Tudo é aditivo: nenhuma coluna removida, nenhum valor de enum renomeado. As restrições que afetam versões antigas são **intencionais** (seção 9.4).

### 3.1 Enums novos ou ampliados

| Enum | Valores |
|---|---|
| `AppointmentState` | **Sem mudança** (alternativa (b), seção 2.4) |
| `AppointmentOutcome` (novo) | `Realizada`, `Falta`, `FaltaAbonada`, `AvisoTardio`, `Remarcada`, `Cancelada` |
| `NoticeTiming` | `no_prazo`, `fora_do_prazo`, `sem_limite_configurado`, `depois_do_inicio` |
| `NoticeIntent` | `nao_comparecera`, `atraso`, `pedido_cancelamento`, `pedido_remarcacao`, `indefinida` |
| `NoticeChannel` | `whatsapp`, `painel` |
| `NoticeReferenceSource` | `meta_timestamp`, `recebimento_webhook`, `registro_no_painel` |
| `NoticeClaimSource` | `telefone`, `presencial`, `outro_canal`, `alegacao_do_paciente` |
| `NoticeReviewStatus` | `pendente`, `revisada`, `sem_revisao_necessaria` |
| `NoticeConfirmationStatus` (novo, K11) | `aguardando_confirmacao`, `confirmada`, `expirada` |
| `NoticeRequestedBy` | `paciente`, `clinica`, `profissional` |
| `NoShowDecision` | `aguardando_decisao`, `cobranca_confirmada` |
| `LateNoticeDecision` | `aguardando_decisao`, `sem_cobranca`, `cobranca_confirmada` (DP-22: só por confirmação humana) |
| `SessionKind` | `atendimento`, `falta`, `aviso_fora_do_prazo`, `aviso_tardio` (DP-22) |
| `SessionVoidReason` | `desfecho_corrigido`, `legado_consulta_cancelada`, `legado_consulta_futura` |
| `BillingEligibility` | `elegivel`, `nao_elegivel` |
| `LegacyCategory` | `candidata_anulacao_consulta_cancelada`, `candidata_anulacao_consulta_futura`, `cobranca_de_consulta_cancelada`, `cobranca_antecipada`, `desfecho_nao_verificavel`, `desfecho_nao_verificavel_com_cobranca` |
| `NoShowPolicy` | `decisao_humana` (padrão), `cobrar_salvo_excecao` |
| `NoticeConsequencePolicy` | `nao_cobrar`, `decisao_humana` (padrão), `sugerir_cobranca` (DP-22); nenhum valor cobra sem confirmação humana |
| `AbonoApprovers` | `admin` (padrão, DP-23), `admin_e_profissional_responsavel` (só depois da restrição do terapeuta às próprias consultas, implementada e verificada) |

### 3.2 Tabela nova `appointment_notice` (comunicações) [PROP]

| Grupo | Campos |
|---|---|
| Identificação | `id`, `tenant_id`, `appointment_id`, `patient_id`, `channel`, `message_id` (único, WhatsApp) |
| Horários | `provider_sent_at`, `received_at`, `recorded_at`, `reference_time`, `reference_source`, `claimed_at`, `claim_source` |
| Classificação | `timing`, `minutes_from_start` (negativo depois do início), `limit_hours_applied`, `claimed_timing` |
| Interpretação | `intent`, `intent_source` (`ia`, `pessoa`), `ambiguous` |
| Contexto | `requested_by`, `arrived_after_outcome`, `outcome_at_arrival` |
| Autoria | `recorded_by_user_id`, `recorded_by_actor_type` |
| Confirmação (K11) | `confirmation_status`, `confirms_notice_id` (a comunicação de confirmação aponta para o pedido) |
| Correção | `supersedes_notice_id`, `reason` (até 200) |
| Revisão (únicas colunas atualizáveis) | `review_status`, `reviewed_by_user_id`, `reviewed_at` |

RLS como as demais tabelas.

### 3.2b Tabela nova `appointment_outcome` (desfecho) [PROP]

| Grupo | Campos |
|---|---|
| Identificação | `appointment_id` (chave primária e FK), `tenant_id` |
| Desfecho | `outcome`, `outcome_recorded_at`, `outcome_recorded_by_user_id` |
| Retrato (imutável) | `state_at_outcome`, `scheduled_at_at_outcome`, `modality_at_outcome`, referenciando `appointment (id, tenant_id, state, scheduled_at, modality)` |
| Encerramento | `closing_notice_id`, `closing_notice_timing` |
| Decisões | `no_show_decision` (+ `_at`, `_by`), `late_notice_decision` (+ `_at`, `_by`) |

Tem RLS como as demais tabelas. Os privilégios estão na seção 2.4: sem `DELETE`, e sem `UPDATE` no retrato.

### 3.3 Colunas novas [PROP]

| Tabela | Colunas |
|---|---|
| `appointment` | `rescheduled_from_id` (único); `legacy_flags`; `UNIQUE (id, tenant_id, state, scheduled_at, modality)`, referenciada pela FK de congelamento (seção 2.4). **Sem colunas de desfecho**: elas ficam em `appointment_outcome` |
| `session` | `kind` (opcional; vazio no legado); `voided_at`, `void_reason`, `voided_by_user_id`; **`billing_eligibility`** (`NOT NULL DEFAULT 'nao_elegivel'`); `legacy_category`, `legacy_run_id`; `completed_at` passa a ser gravado |
| `billing` | **`eligibility_protocol`** (texto, chave estrangeira para `billing_eligibility_protocol`; nulo nas cobranças existentes, `'nenhum'` como padrão das novas); **`legacy_billing`** (boolean) |
| `billing_session` | **`patient_id`**; **`required_eligibility`** (`DEFAULT 'elegivel'`); **`legacy_link`** (boolean) |
| `message` | `provider_sent_at` (carimbo da Meta, lido do webhook) |
| `clinic_settings` | `no_show_policy`, `late_notice_policy`, `after_start_notice_policy`, `abono_approvers` |

### 3.4 Por que `Session.Realizada` não é renomeado agora

Renomear quebraria versões anteriores sem necessidade. A troca para "a faturar" fica para uma contração futura. Até lá, o painel mostra o rótulo junto do `kind`.

### 3.5 Tabela nova `legacy_classification_run` [PROP]

Campos:
- `id`, `tenant_id`, `mode` (`dry_run`, `apply`), `approved_dry_run_id`;
- `rule_version`, `cutoff_at`;
- `started_at`, `finished_at`, `executed_by`;
- `counts`, `report` (sem nome, telefone ou valor por paciente);
- `financial_fingerprint_before`, `financial_fingerprint_simulated_after`, `financial_fingerprint_after`.

RLS.

### 3.6 Exigência mínima de versão no banco [PROP]

Tabela `deployment_requirement`, sem dados de clínica:
- `capability` (ex.: `billing-eligibility-v1`);
- `required_since`;
- `set_by_migration`.

A migration que cria as restrições da seção 3.7 grava a exigência. Os scripts de deploy e de rollback a leem antes de trocar a aplicação (seção 9.4).

### 3.7 Restrições declarativas (SQL bruto na migration, sem trigger e sem função) [PROP]

**Migration 1 (expandir):**
- enums **novos** (`CREATE TYPE`), tabelas e colunas. Nenhum enum existente ganha valor (alternativa (b));
- `ADD COLUMN … DEFAULT` em tabelas existentes. No PostgreSQL 16, um padrão constante é só metadado, sem reescrever linhas; isso precisa ser **provado no ensaio**.

**Linhas existentes, marcadas pelos padrões de `ADD COLUMN`** (nenhum valor existente é alterado):
- `session.billing_eligibility = 'nao_elegivel'`: **nenhuma sessão legada é elegível** (DP-27, item 5), sem depender da classificação;
- `billing.legacy_billing = true`, com `billing.eligibility_protocol` nulo;
- `billing_session.legacy_link = true`.

**Logo em seguida, o padrão para linhas novas muda:**
- `ALTER … SET DEFAULT false` em `legacy_billing` e `legacy_link`;
- `ALTER … SET DEFAULT 'nenhum'` em `billing.eligibility_protocol`, um valor que **não existe** na tabela de protocolos.

Uma versão antiga que insira sem conhecer essas colunas recebe esses padrões.

**Migration 2 (restrições), no mesmo deploy da migration 1:**
- **Sessão:** `UNIQUE (id, tenant_id, patient_id, billing_eligibility)` e `CHECK (billing_eligibility <> 'elegivel' OR (kind IS NOT NULL AND voided_at IS NULL))`.
- **Cobrança: chave estrangeira de protocolo** (rodada 6, 21/10/2026; substitui o campo `eligibility_checked` com `CHECK`):
  - tabela `billing_eligibility_protocol (name PRIMARY KEY)`, com uma única linha, `billing-eligibility-v1`;
  - `billing.eligibility_protocol` com chave estrangeira para ela;
  - `CHECK (legacy_billing OR eligibility_protocol IS NOT NULL)`;
  - `UNIQUE (id, tenant_id, patient_id)`.

  **Por que chave estrangeira e não `CHECK`** [EV, teste de 21/10/2026 num PostgreSQL 16 descartável]:
  - o Prisma 5.18 do projeto grava a cobrança com `INSERT … ON CONFLICT (id) DO UPDATE`, inclusive para só mudar o status;
  - o PostgreSQL avalia `CHECK` sobre a linha **proposta** mesmo quando o conflito vira atualização. O desenho anterior (`legacy_billing OR eligibility_checked IS TRUE`) impediria a versão antiga até de quitar, reenviar ou passar pela régua de uma cobrança existente, e o pagamento antigo, que grava o pagamento antes de atualizar a cobrança, deixaria pagamento confirmado com cobrança em aberto;
  - a chave estrangeira só é conferida quando a linha é de fato inserida ou quando o valor da chave muda.

  **Efeito** (os quatro casos foram verificados no mesmo teste):
  - versão antiga criando cobrança → recebe o padrão `'nenhum'` → **recusada** pela chave estrangeira, sem nada gravado;
  - versão antiga atualizando o status de cobrança existente, antiga ou nova → **aceita**;
  - linha nova com protocolo nulo → **recusada** pelo `CHECK`, porque o papel da aplicação não pode gravar `legacy_billing`;
  - versão nova → cria com `'billing-eligibility-v1'`, dentro da transação única, e muda status com `UPDATE` simples, sem `upsert`.
- **Vínculo:**
  - `CHECK (required_eligibility = 'elegivel')` e `CHECK (legacy_link OR patient_id IS NOT NULL)`;
  - FKs compostas `(session_id, tenant_id, patient_id, required_eligibility) → session (id, tenant_id, patient_id, billing_eligibility)` e `(billing_id, tenant_id, patient_id) → billing (id, tenant_id, patient_id)`. Os vínculos antigos têm `patient_id` nulo e, no modo padrão (`MATCH SIMPLE`), não são conferidos; os novos são. Por isso as chaves podem ser criadas já validadas, sem `NOT VALID`.
  - **K2-a** cria só a parte de paciente e clínica: `(session_id, tenant_id, patient_id) → session (id, tenant_id, patient_id)`. A elegibilidade da sessão (`required_eligibility`, `billing_eligibility`) entra na **K2-b**, junto do ciclo da consulta.
  - Um vínculo novo só existe se a sessão estiver elegível e for do mesmo paciente e da mesma clínica da cobrança.
  - Uma sessão já vinculada não pode deixar de ser elegível (a FK impede a mudança), o que também impede anular sessão cobrada.
- **Agenda e comunicação:**
  - o índice de horário ativo (`WHERE state != 'Cancelada'`) **não muda**: `Remarcada` grava `state = 'Cancelada'`, e os demais desfechos continuam ocupando o horário;
  - os `CHECK`s e chaves da seção 2.7;
  - a FK composta de congelamento, os privilégios de `appointment_outcome` e a política restritiva `appointment_frozen_after_outcome` (seção 2.4);
  - índice `(tenant_id, state, scheduled_at)`.
- **Privilégios:**
  - em `appointment_notice`, o papel da aplicação recebe `INSERT`, `SELECT` e `UPDATE` só nas colunas de revisão;
  - em `billing` e `billing_session`, a migration revoga o privilégio de tabela inteira (hoje `GRANT ALL`, `infra/docker/postgres-init/01-app-role.sql`) e concede por coluna, **sem** `legacy_billing` e `legacy_link`, que só a migration preenche. Em `billing`, o `UPDATE` fica limitado ao status e à data de atualização: a aplicação não muda o protocolo de uma cobrança existente. Em `billing_session`, não há `UPDATE`: a aplicação não muda vínculo existente;
  - em `billing_eligibility_protocol` e `deployment_requirement`, o papel da aplicação não tem privilégio de escrita, e em `deployment_requirement` nem de leitura;
  - [EV, K2-a] **onde o papel da aplicação é dono das tabelas** (CI e ambiente local, em que as migrations rodam com ele), a checagem de chave estrangeira trava a linha da outra tabela com `SELECT … FOR KEY SHARE`, executado com o dono dela, e isso exige `UPDATE` em pelo menos uma coluna. Só nesse caso a migration concede `UPDATE` em `billing_eligibility_protocol.description` e em `billing_session.created_at`, colunas sem papel na integridade. Em homologação e produção o dono é o administrador e as duas concessões não existem. Um dono pode devolver a si qualquer privilégio: ali os privilégios por coluna não são barreira, e a prova deles vale para produção.
  - [EV, K2-a] no Prisma, `legacy_billing` e `legacy_link` ficam com `@ignore`: o client manda no `INSERT` o padrão estático de toda coluna do modelo, e o papel da aplicação não pode gravá-las.
- **Exigência:** grava `deployment_requirement = billing-eligibility-v1`.

**Limites conhecidos das restrições:**
- não impedem uma cobrança com zero vínculos (exigiria trigger ou restrição adiada); isso fica com a transação única da aplicação e com testes;
- não impedem SQL direto com credencial de administrador;
- uma versão futura com defeito poderia gravar o protocolo sem conferir a elegibilidade, mas os vínculos continuariam barrados pelas FKs compostas (paciente e clínica e, depois da K2-b, elegibilidade da sessão);
- a chave estrangeira do protocolo não impede uma versão antiga de inserir cobrança se alguém acrescentar `'nenhum'` à tabela de protocolos; por isso a aplicação não tem privilégio de escrita nela.

---

## 4. Fluxos principais e alternativos [PROP]

**F1 — Agendar.** Sem mudança; dívida não é consultada; horário no passado continua aceito até a decisão da seção 10.3.

**F2 — Confirmar.** Antes do início; só muda o estado. Depois do início: 409; pelo WhatsApp, a IA não afirma presença.

**F3 — Realização** e **F4 — Falta** (F4a cobrança confirmada, F4b abono com motivo, F4c sem decisão, F4d reversão do abono pelo `admin`, que volta para decisão humana sem cobrar). Só pessoa, depois do início; detalhe na seção 2.5.

**F5 — Mensagem do paciente pelo WhatsApp (N1).**
1. A IA identifica a intenção e a ambiguidade e grava a comunicação. O horário de referência vem da integração (seção 2.3); o de processamento nunca é usado.
2. **Antes do início, com `pedido_cancelamento` ou `pedido_remarcacao` (K11):** a IA responde com a consulta exata (data, horário no fuso da clínica e profissional) e pede confirmação explícita. O pedido fica `aguardando_confirmacao`.
   - Só uma confirmação explícita, em mensagem seguinte e antes do início agendado, executa T3 ou T5.
   - Na remarcação, o horário novo também precisa ser confirmado.
   - A antecedência conta a partir da primeira mensagem do pedido.
   - Sem confirmação até o início, o pedido expira, nada é executado e a equipe é sinalizada.
3. **No início ou depois** (`depois_do_inicio`), ou com ambiguidade, ou com intenção `atraso`:
   - a consulta **não muda**;
   - a comunicação fica `pendente` de revisão;
   - a equipe recebe aviso (`appointment_notice_review`);
   - a resposta ao paciente é neutra: não confirma ausência, cancelamento nem cobrança.
   - `atraso` gera só aviso informativo, salvo ambiguidade.
4. **Com desfecho já registrado:** a comunicação fica com `arrived_after_outcome`, `pendente`, e aviso à equipe; o desfecho não muda (DP-26).

**F5b — Aviso tardio (T4).** Uma pessoa revê as comunicações `depois_do_inicio` e escolhe o desfecho: `AvisoTardio`, `Realizada` (o paciente veio mesmo atrasado) ou `Falta`. O `AvisoTardio` abre a decisão de consequência (sem política, decisão humana). Pode remarcar no mesmo ato (T5b).

**F5c — Comunicação por outro canal ou com horário alegado (painel).** A pessoa registra a comunicação (N1, canal `painel`):
- o horário de referência é `recorded_at`;
- se houver horário alegado, `claimed_at` e `claim_source` ficam separados, com a classificação alegada só para exibição;
- a decisão que levar a alegação em conta registra autor e motivo.

**F5d — Correção de comunicação.** Novo registro com `supersedes_notice_id`, motivo e autor. O anterior continua visível.

**F6 — Remarcar antes do início.** Nova ocorrência ligada, em uma transação (seção 5). O id muda.

**F7 — Correção de desfecho (T10).** `admin`, com motivo; recusada com item cobrado.

**F8 — Sem desfecho.** Lista de consultas cujo horário terminou sem desfecho, com comunicações pendentes e marca de legado. Não muda estado.

**F9 — Cobrança.** Só sessões elegíveis (seção 2.9), em uma transação, com `eligibility_protocol = 'billing-eligibility-v1'`. Cobranças legadas seguem o ciclo normal. A mensagem identifica cada falta sem aviso prévio com linguagem neutra, data e valor (DP-24b). Isso depende do MVP-03 e, fora da janela de 24 h, de modelo aprovado pela Meta (A-07).

**F10 — Dívida.** Não lida pelo MVP-01.

---

## 5. Preservação do histórico da remarcação

### 5.1 Alternativas

| Critério | A. Só auditoria | B. Log de alterações + linha que se move | **C. Nova ocorrência ligada** | D. Tabela de remarcações + linha que se move |
|---|---|---|---|---|
| Horário original preservado | só no `audit_log`, fora da transação | sim | sim | sim |
| Estado, motivo e comunicação por ocorrência | não | parcial | **sim** | parcial |
| Horários fixos (achado 3) | quebrado | exige trocar a chave | **corrigido sem mudar a chave** | igual a B |
| Item faturável 1:1, inclusive cobrança futura de aviso (DP-22) | não | exige item ligado ao log | **sim** | igual a B |
| Remarcação depois de aviso tardio | — | perde o aviso | **ocorrência fica `AvisoTardio`, nova ligada** | igual a B |
| Ids e WhatsApp | estável | estável | **muda** | estável |

### 5.2 Recomendação: C [PROP]

**Motivos:**
- é a única em que cada ocorrência tem um horário e um desfecho;
- mantém um item faturável por ocorrência;
- conserta os achados 2 e 3;
- não depende da auditoria como fonte de regra.

**Custo:** o id muda na remarcação. Uma ação sobre o id antigo é recusada sem efeito.

### 5.3 Impactos

| Componente | Mudança |
|---|---|
| Índice de horário ativo; `findActiveByTherapistAndRange`; `findByTenantAndRange` | Sem mudança de filtro: a ocorrência remarcada grava `state = 'Cancelada'` e já fica de fora, também na versão anterior. Parâmetro para incluir ocorrências encerradas. Recomendado junto: o achado 4 |
| Resumo da agenda do dia e reenvio | Herdam a exclusão de `Cancelada` |
| Materialização de horário fixo | Sem mudança: a ocorrência original mantém a chave; a nova nasce com `recurringBlockId = null`, ligada pela cadeia |
| WhatsApp (`intent-action-router.ts`) | Canal, ator `ai_agent`, comunicação (N1) antes de qualquer ação; ação só antes do início e sem ambiguidade. Não conferi de onde a IA tira o `appointmentId` |
| Painel (`app/agenda/page.tsx`, `appointments.hooks.ts`) | Troca de id; ações novas; comunicações e revisão; histórico |
| Legado | `Reagendada` antigas recebem `remarcada_sem_historico` |

### 5.4 Histórico consultável

`GET /appointments/:id/history` devolve, numa consulta recursiva limitada e dentro da RLS:
- a cadeia de ocorrências;
- os estados;
- as comunicações de cada uma, com os horários separados (recebido, registrado, alegado);
- as decisões.

---

## 6. Migração dos dados legados

### 6.1 Onde há dados

- Não há homologação nem produção (A-12).
- Há o banco de desenvolvimento local e as pilhas descartáveis de teste.
- Não há clínica real.

### 6.2 Orientação da DP-27 [REG] (reafirmada na rodada 2)

1. Não presumir realização porque a data passou, porque houve confirmação **ou porque existe cobrança**.
2. Cobranças, pagamentos e comprovantes existentes não podem ser perdidos, duplicados ou alterados pela reclassificação.
3. Desfecho não comprovável fica identificado para revisão, sem resultado inventado e sem cobrança nova automática.
4. Sessões futuras ou de consultas canceladas, não cobradas, são candidatas à anulação; a anulação depende de migração revisada e autorizada.
5. Nenhuma cobrança nova a partir de legado sem desfecho comprovado.
6. Primeira execução só em simulação (`dry-run`), por clínica, com relatório e comparação financeira antes e depois.
7. Inconsistência interrompe; a migração efetiva só com revisão do relatório e autorização específica.

**Nada é executado nesta etapa.**

### 6.3 Comparação com as opções anteriores

| Opção | Compatível? | Motivo |
|---|---|---|
| **O1. Sem desfecho (legado)** | **Sim, base adotada** | Itens 1, 3 e 5 |
| O2. Cobrado = realizado | **Não** | Contraria o item 1 |
| O3. Revisão em lote | Não adotada | Exigiria decisão própria |
| O4. Corte simples | **Não** | Contraria o item 5 |

### 6.4 Classificação

A migração **nunca** muda `appointment.state`, nunca grava desfecho nem comunicação e nunca escreve em `billing`, `billing_session` ou `payment`. O item 5 da DP-27 não depende dela: desde a migration 1, toda sessão legada é `nao_elegivel` (seção 3.7). O instante de corte (`cutoff_at`) é fixado no `dry-run` aprovado.

| Cat. | Situação | Classificação | Marca | `apply` autorizado | Revisão humana |
|---|---|---|---|---|---|
| L1 | Consulta `Cancelada`, sessão não cobrada | Segura | `candidata_anulacao_consulta_cancelada` | Anula | Não |
| L3 | Horário depois do corte, sessão não cobrada | Segura | `candidata_anulacao_consulta_futura` | Anula; o registro normal reativa o item quando a consulta acontecer | Não |
| L2 | Consulta `Cancelada`, sessão já cobrada | Revisão | `cobranca_de_consulta_cancelada` | Só marca | Sim (DP-06) |
| L4 | Consulta futura, sessão já cobrada | Revisão | `cobranca_antecipada` | Só marca | Sim |
| L5 | Horário antes do corte, sessão não cobrada | **Não verificável** | `desfecho_nao_verificavel` | Só marca; continua inelegível; aparece em F8 | Sim, um a um |
| L6 | Horário antes do corte, sessão já cobrada ou paga | **Não verificável**, cobrança preservada | `desfecho_nao_verificavel_com_cobranca` | Só marca; a cobrança segue o ciclo normal | Sim |
| marca | Sessão criada antes de uma remarcação | — | `remarcada_apos_confirmacao` | Tratada pela data atual | — |
| marca | Consulta em `Reagendada` | — | `remarcada_sem_historico` | Nenhum | — |
| L8 | Inconsistência (seção 6.8) | — | — | **Interrompe** | — |

### 6.5 O que o sistema atual não permite recuperar

| Informação | Recuperável? |
|---|---|
| Se o atendimento aconteceu | **Não** |
| Momento da realização | **Não** (`completed_at` nunca gravado) |
| Momento da confirmação | Aproximado (`session.created_at`, auditoria) |
| Quem confirmou | Parcial (`system` para WhatsApp e chave de API) |
| Horário original de remarcações antigas | **Não** |
| Momento do cancelamento | Aproximado (auditoria, se gravada) |
| Classificação do aviso antigo e limite da época | **Não com segurança** (`politicas_alteradas` sem valores) |
| Horário de recebimento de mensagens antigas segundo a Meta | **Não** (o carimbo nunca foi guardado) |
| Quem pediu o cancelamento e o motivo | **Não** |
| Comprovantes | **Não existem no sistema** |

As aproximações entram no relatório **só como informação para a revisão**. Nunca viram horário de referência nem campo gravado.

### 6.6 Procedimento [PROP]

- **Comando próprio**, fora das migrations de schema, por clínica, com a conexão da aplicação e dentro da RLS.
- **`--dry-run` (sempre primeiro):**
  1. impressão digital financeira (antes);
  2. transação com **o mesmo código** do `apply`, e a impressão digital simulada;
  3. **transação desfeita**;
  4. terceira impressão digital, igual à primeira;
  5. grava só o registro da execução.

  Alternativa sem escrita desfeita: projeção somente leitura (K5).
- **Impressão digital financeira:** contagem e hash ordenado das **colunas originais** de `billing (id, status, amount, due_date)`, `billing_session (id, billing_id, session_id)` e `payment (id, billing_id, status, amount)`. As colunas acrescentadas pela migration 1 (seção 3.7) ficam fora, e o relatório declara isso.
- **`--apply`:**
  - exige `dry-run` aprovado e **autorização específica** para aquela clínica e ambiente;
  - usa o mesmo corte;
  - compara item a item: itens resolvidos por pessoa depois do `dry-run` são pulados e listados; qualquer outra diferença interrompe;
  - roda numa transação por clínica, com `FOR UPDATE`;
  - grava marcas, anulações das candidatas e auditoria `LegadoClassificado`.
- **Idempotente.**

### 6.7 Verificações antes

1. Backup e ensaio de restauração.
2. Migrations 1 e 2 aplicadas; versão nova no ar; teste rápido:
   - confirmar não cria sessão;
   - sessão legada é recusada em cobrança, pela aplicação **e** pelo banco;
   - cobrança sem a marca de conferência é recusada pelo banco.
3. Zero inconsistências.
4. `completed_at` vazio no legado.
5. Impressão digital financeira.
6. `dry-run` revisado e aprovado.

### 6.8 Critérios de interrupção

- Sessão com paciente, profissional ou clínica diferente da consulta.
- Sessão `Faturada` ou `Recebida` sem vínculo; vínculo com cobrança de outro paciente.
- Sessão de consulta em `Criada` ou `ReagendamentoSolicitado`; `completed_at` preenchido.
- Sessão sem categoria.
- Diferença com o `dry-run` que não seja resolução humana.
- Escrita prevista em tabela financeira; impressão digital diferente.
- Qualquer exceção.

### 6.9 Verificações depois

1. Impressão digital idêntica.
2. Toda sessão anterior ao corte classificada ou resolvida por pessoa.
3. Nenhum item anulado vinculado.
4. Nenhuma consulta futura com item elegível.
5. Auditoria em número igual aos itens.
6. Nenhuma sessão legada `elegivel`.
7. Contagem por `appointment.state` igual à de antes.
8. Segundo `apply` sem efeito.

### 6.10 Reversão

Comando por `legacy_run_id`, com `dry-run`, que limpa marcas e desfaz anulações daquela execução. Não toca dados financeiros. O backup é o último recurso.

---

## 7. Contratos de API e permissões [PROP]

Estilo das rotas existentes (inglês, `/api/v1`); erros `{ code, message, category: 'business_rule' }`.

| Rota | Muda? | Corpo | Papéis | Resposta / erros |
|---|---|---|---|---|
| `POST /appointments/:id/confirm` | comportamento | — | `admin`, `therapist` responsável | Sem sessão. `APPOINTMENT_ALREADY_STARTED` |
| `POST /appointments/:id/notices` | nova | `intent`, `requestedBy`, `claimedAt?`, `claimSource?`, `reason?` | `admin`, `therapist` responsável | Comunicação com `recordedAt`, `referenceTime`, `timing` e `claimedTiming`. **Não aceita** horário de recebimento: só alegado |
| `GET /appointments/:id/notices` | nova | — | `admin`, `therapist` | Comunicações com todos os horários e a origem de cada um |
| `POST /notices/:id/review` | nova | `status` | `admin`, `therapist` responsável | `NOTICE_ALREADY_REVIEWED` |
| `POST /notices/:id/correct` | nova | campos corrigidos, `reason` | `admin` | Novo registro (`supersedesNoticeId`) |
| `POST /appointments/:id/cancel` | corpo | `noticeId` (comunicação antes do início) ou dados para criá-la; `requestedBy`; `reason?` | `admin`, `therapist` responsável | `noticeTiming`, `limitHoursApplied`. `APPOINTMENT_ALREADY_STARTED` |
| `PATCH /appointments/:id/reschedule` | corpo e resposta | `newScheduledAt`, `noticeId` ou dados, `requestedBy`, `reason?` | idem | `{ previous, current }`. `SESSION_CONFLICT`, `APPOINTMENT_ALREADY_RESCHEDULED`, `APPOINTMENT_ALREADY_STARTED` |
| `POST /appointments/:id/late-notice` | nova (T4) | `noticeIds[]` (todas `depois_do_inicio`), `reason?`, `reschedule?` | `admin`, `therapist` responsável; exige usuário | `AvisoTardio`, decisão pendente. `NOTICE_NOT_AFTER_START`, `HUMAN_ACTOR_REQUIRED` |
| `POST /appointments/:id/attended`, `/no-show` | novas | — | idem; exige usuário | `APPOINTMENT_NOT_STARTED`, `APPOINTMENT_OUTCOME_CONFLICT` |
| `POST /appointments/:id/no-show/charge`, `/notice/decision`, `/outcome/correct` | novas | ver seção 2.5; `/notice/decision` aceita `sem_cobranca` ou `cobranca_confirmada` (DP-22) | `admin` | `SESSION_ALREADY_BILLED`, `*_DECISION_CLOSED`; cobrança recusada para pedido da clínica ou do profissional (DP-25) |
| `POST /appointments/:id/no-show/excuse` | nova | `reason` (**obrigatório**) | conforme `abono_approvers` (DP-23); `super_admin` recusado | `NO_SHOW_DECISION_CLOSED`, `FORBIDDEN`, `REASON_REQUIRED` |
| `POST /appointments/:id/no-show/excuse/revert` | nova (DP-24a) | `reason` (obrigatório) | `admin` | Volta a `Falta` aguardando decisão |
| `GET /appointments/pending-outcome`, `/pending-decisions` | novas | — | `admin` (e `therapist` na primeira) | Incluem comunicações pendentes de revisão |
| `GET /appointments/:id/history` | nova | — | `admin`, `therapist` | Seção 5.4 |
| `GET /sessions` | resposta | — | igual hoje | `kind`, `billingEligibility`, `voidedAt`, `legacyCategory`; `state=Realizada` devolve só elegíveis |
| `POST /billings` | validação e atomicidade | — | `admin` | `SESSION_OF_ANOTHER_PATIENT`, `SESSION_ALREADY_BILLED` (sessão já cobrada, contrato mantido), `SESSION_NOT_BILLABLE`; restrições do banco como última barreira |
| `PUT /clinic/policies` | corpo | `noShowPolicy`, `lateNoticePolicy`, `afterStartNoticePolicy`, `abonoApprovers` | `admin` | — |

**Documentos a atualizar na implementação:**
- `04-API/01-Contratos-REST.md`;
- `16-Politica-RBAC.md`;
- `01-Domain/03-Maquina-de-Estados.md.txt`;
- `05-Linguagem-Ubiqua.md`;
- `07-Infra/MIGRATION_RUNBOOK.md` (exigência de versão e rollback).

---

## 8. Plano de testes [PROP]

Pré-requisito: porta `Clock` para as fronteiras exatas.

| Nível | O que cobre |
|---|---|
| Unitário (domínio) | Toda transição permitida e proibida (seções 2.5 e 2.6); classificação (limites de 2 h e 4 h, sem limite, no instante do início, 1 min antes e depois, **horas depois do fim do horário** = `depois_do_inicio`); escolha do horário de referência (Meta válido, Meta inválido → recebimento; nunca processamento; nunca alegado); elegibilidade |
| Casos de uso | IA só grava comunicação depois do início; `atraso` e ambiguidade não mudam estado; comunicação depois de desfecho não o altera e sinaliza; T4 só por pessoa e só com comunicação `depois_do_inicio`; política só sugere |
| Integração (Postgres 16 real) | **Cada restrição da seção 3.7**:<br>• vínculo de sessão inelegível, de outro paciente e de outra clínica recusado;<br>• cobrança nova sem o protocolo recusada (chave estrangeira); versão antiga continua atualizando o status de cobranças existentes (quitação, reenvio, régua);<br>• cobrança e vínculo antigos atualizáveis;<br>• sessão vinculada não pode ficar inelegível;<br>• `UPDATE` de horário em comunicação recusado por privilégio;<br>• `ADD COLUMN … DEFAULT` sem reescrita;<br>• `CHECK`s da seção 2.7;<br>• congelamento (seção 2.4): alterar estado, horário ou modalidade de consulta com desfecho é recusado pela FK; `UPDATE` do papel da aplicação nessa consulta não tem efeito (RLS); apagar o desfecho é recusado por privilégio; a remarcação na ordem certa passa, e na ordem invertida é recusada |
| Crítico (HTTP, RLS) | Critérios do MVP-01; comunicações pelo painel com horário alegado separado; correção por novo registro; concorrência (realização × falta, comunicação × desfecho, duas remarcações); isolamento entre clínicas; auditoria com autor, momentos, estado anterior e novo |
| Crítico (WhatsApp, fila e worker reais) | Comunicação com o carimbo da Meta (quando presente) e o recebimento, mesmo com a fila atrasada; antes do início sem ambiguidade cancela ou remarca; depois do início, `atraso`, ambiguidade ou desfecho existente → só comunicação e aviso; nenhuma intenção alcança desfecho, abono, decisão ou cobrança; identidade ambígua sem ação |
| Cobrança e pagamento | `POST /billings` com cada motivo de inelegibilidade; cobrança e vínculos atômicos (falha no vínculo não deixa cobrança); cobranças legadas pagáveis, reenviáveis e estornáveis; ADR-0052 verde |
| Migração | Fixture de cada categoria; `dry-run` sem efeito com as três impressões digitais; `apply` só aprovado; interrupções; reversão |
| **Compatibilidade de versões (K2)** | No ensaio de deploy, a **imagem da versão anterior** contra o banco migrado:<br>• consegue subir;<br>• **não consegue** criar cobrança;<br>• **não deixa** cobrança órfã;<br>• não vincula sessão legada.<br>Também:<br>• a versão anterior **não consegue** alterar consulta com desfecho (congelamento);<br>• o `rollback.sh` para imagem sem a capacidade é recusado, e com `--allow-degraded` só vai com motivo e registro;<br>• o rollback automático do `deploy.sh`, no deploy que introduz a exigência, volta em modo degradado e registrado;<br>• um banco restaurado sem as restrições não sobe aplicação antes de reaplicar as migrations |
| Painel e ponta a ponta | Ações por estado; revisão de comunicações; troca de id; aviso tardio por pessoa; cobrança só de elegíveis |

**Prova por mutação:**
- IA mudando estado depois do início;
- horário alegado usado como referência;
- horário de processamento usado;
- comunicação sobrescrevendo desfecho;
- aviso tardio virando falta;
- elegibilidade ignorando paciente;
- cobrança gravada antes do vínculo;
- script de rollback ignorando a exigência;
- além das mutações já listadas na versão anterior (confirmar cria item, tempo muda estado, etc.).

**Testes existentes a ajustar:** 50 ocorrências em 11 arquivos críticos, além de testes de unidade, do painel e de ponta a ponta. A lista está no backlog, MVP-01.

---

## 9. Implementação, lançamento, riscos e rollback

### 9.1 Sequência [PROP]

Cada fase exige autorização própria, gate pré-push e CI verde.

| Fase | Conteúdo | Depende de |
|---|---|---|
| 0 | Revisão e aprovação do restante desta ADR (a exceção à ADR-0060 já foi aprovada no escopo restrito da seção 9.4); respostas da seção 10.3 | Responsável |
| 1 | `Clock`; migrations 1 e 2 (inclusive restrições, privilégios e exigência de versão); Prisma | 0 |
| 2 | Domínio: estados, comunicação, classificação, elegibilidade | 1 |
| 3 | Casos de uso em `UnitOfWork`; auditoria na transação; `GerarCobrancaUseCase` atômico com a regra de elegibilidade | 2 |
| 4 | API, RBAC, contratos; testes críticos; ajuste dos existentes | 3 |
| 5 | WhatsApp: leitura e gravação do carimbo da Meta; comunicação antes de ação; confirmação explícita antes de cancelar ou remarcar (K11); intenções `atraso` e `indefinida` (precisam de validação com o modelo real, chamada paga a autorizar) | 3 |
| 6 | Painel | 4 |
| **K2** | Scripts `build-images.sh`, `deploy.sh`, `rollback.sh` e `restore-drill.sh`:<br>• rótulo de capacidade na imagem;<br>• leitura de `deployment_requirement` e das restrições;<br>• regras de retorno degradado, com registro;<br>• controle de restauração.<br>**Ensaios de deploy, rollback e restauração** (seção 9.4) | 1; antes de qualquer deploy fora do desenvolvimento |
| 7 | Comando de classificação do legado | 4 |
| 8 | Por ambiente: backup → deploy → teste rápido → `dry-run` → revisão → `apply` só com autorização específica | 7, K2 |
| depois | Abono pelo profissional responsável (DP-23), só depois da restrição do terapeuta às próprias consultas implementada e verificada | Restrição de acesso implementada e verificada |

**Dependência dura:** nenhuma versão com as fases 1 a 6 pode ir para um ambiente com dados de clínica sem a fase K2 concluída e provada.

### 9.2 Critérios para liberar a migração do legado

- ADR aprovada.
- Fases 1 a 7 e K2 publicadas com CI verde e ensaio de deploy com o teste de compatibilidade aprovado.
- Backup com restauração ensaiada.
- `dry-run` com as três impressões digitais iguais e zero inconsistências, revisado.
- **Autorização específica.**

### 9.3 Riscos

| Risco | Mitigação |
|---|---|
| Mudança de significado do legado | Seção 6; inelegível desde a migration 1 |
| Id muda na remarcação | `previous` e `current`; id antigo recusado |
| IA interpreta mal a mensagem | IA não decide depois do início; ambiguidade → revisão; correção por novo registro |
| Carimbo da Meta ausente ou fora do esperado | Validação e retorno ao recebimento; ambos guardados |
| Horário alegado usado para mudar decisão | Separado, rotulado, com autor e motivo |
| Rollback reabrindo cobrança do legado | **Seção 9.4 (K2), ainda bloqueador** |
| Versão antiga no ar sem conseguir criar cobrança | Efeito intencional da falha fechada; exceção à ADR-0060 aprovada no escopo restrito (seção 9.4) |
| `therapist` restrito às próprias consultas | Proposta a validar |
| Motivo livre com informação clínica | Limite, aviso, fora da IA e da auditoria |

### 9.4 Estratégia de lançamento e rollback (K2)

**Problema:**
- Hoje o rollback pode voltar a **qualquer** versão (achado 10).
- Uma versão sem a regra de elegibilidade, rodando contra o banco migrado:
  - volta a oferecer sessões legadas para cobrança;
  - vincula sessões de outro paciente (achado 5);
  - pode deixar cobrança órfã.
- O responsável **recusou** corrigir isso depois da publicação.

**Alternativas analisadas:**

| Alt. | Descrição | Pré-requisitos | Protege versões antigas? | Riscos e limitações |
|---|---|---|---|---|
| A | Correção para a frente depois da publicação | — | Não | **Recusada pelo responsável** |
| B | **Exigência mínima de versão** no deploy: a imagem carrega um rótulo de capacidade (`luxora.capabilities=billing-eligibility-v1`, junto do `APP_VERSION` que o `build-images.sh` já grava); a migration grava a exigência em `deployment_requirement`; `deploy.sh` e `rollback.sh` leem a exigência com a credencial de administrador e recusam destino sem a capacidade | Mudar os três scripts; versões identificadas por capacidade, não por ordem (as tags são hashes); ensaio | Só no caminho normal: bloqueia o rollback, não a versão antiga | Contornável por quem rode a imagem por fora dos scripts. Aplicada de forma estrita ao rollback automático, deixaria a aplicação parada no primeiro deploy com a exigência. A decisão de 21/10 permite esse retorno em modo degradado e registrado |
| C | **Lançamento em duas versões** (guarda antes da mudança de significado) | Uma versão intermediária com a guarda | Só para voltar até a intermediária | A versão intermediária precisa decidir elegibilidade sem o registro de desfecho: ou volta a tornar faturável o que a confirmação cria (o defeito original), ou congela a cobrança. Não protege abaixo dela sem B |
| D | **Restrições declarativas no banco** (seção 3.7): FKs compostas, `CHECK` por linha e protocolo de elegibilidade exigido na cobrança por chave estrangeira, sem trigger nem função | SQL bruto nas migrations; prova no PostgreSQL 16; exceção à ADR-0060 aprovada; `patient_id` e `tenant_id` repetidos no vínculo | **Sim, em qualquer versão**: a antiga não consegue criar cobrança nem vincular sessão inelegível ou de outro paciente | Não impede cobrança com zero vínculos (fica com a aplicação nova); não impede SQL de administrador; a versão antiga mostra erro ao tentar cobrar; complexidade |
| E | Trigger de validação | — | Sim | A política a admite como "validação complementar", mas exige regra de negócio no backend, e o responsável pediu considerar a restrição. **Não recomendada** |
| F | Papel do banco por geração de versão (tirar `INSERT` em cobrança do papel usado pelas versões antigas) | Papéis e RLS duplicados; credencial ligada à imagem no deploy | Sim | Operação complexa; um erro de configuração bloqueia a versão nova. Não recomendada agora |
| G | Apagar imagens antigas do host | — | Fraco | As imagens podem ser reconstruídas do Git |
| H | Chave de desligamento de cobrança por configuração | Só versões futuras | **Não** | Versões antigas não a conhecem |

#### Decisão de 21/10/2026 [REG]: exceção à ADR-0060 aprovada só no escopo restrito

**Escopo aprovado:**
1. **Cobrança.**
   - Depois da migration do K2, versões sem a capacidade `billing-eligibility-v1` podem continuar operando em **modo degradado**, mas não conseguem criar cobranças nem vínculos inválidos.
   - **D (restrições no banco) é obrigatória.**
   - B (exigência de versão no deploy e no rollback) é barreira operacional complementar.
2. **Agenda.**
   - Alternativa (b): o desfecho fica numa estrutura própria (tabela `appointment_outcome`), sem ampliar o enum `AppointmentState` (seção 2.4).
   - Nenhuma outra incompatibilidade com versões anteriores foi aprovada.
   - Se a implementação mostrar que (b) não é viável, a evidência volta para uma **segunda decisão explícita antes de implementar**.

**O que muda em relação à ADR-0060, exatamente:**

| Operação de uma versão sem a capacidade, depois da migration do K2 | Resultado |
|---|---|
| Criar cobrança (`billing`) | Recusada pelo banco (chave estrangeira do protocolo: o padrão `'nenhum'` não existe na tabela de protocolos); nada gravado |
| Criar vínculo (`billing_session`) | Recusado pelo banco (`CHECK` e FKs compostas) |
| Confirmar, cancelar ou remarcar consulta **com desfecho** | Recusado pelo banco (congelamento, seção 2.4); nada gravado |
| Confirmar consulta sem desfecho | Compatível; a sessão criada nasce `nao_elegivel`, sem efeito financeiro |
| Demais operações: agenda e cancelamento sem desfecho, pagamento, reenvio e estorno de cobranças existentes, leituras | Compatíveis, como exige a ADR-0060 |

**Controles obrigatórios (item 3 da decisão):**
- **Cobrança atômica:** cobrança e vínculos na mesma transação (`UnitOfWork`); uma falha no vínculo desfaz a cobrança.
- **Proteções no banco:** elegibilidade da sessão (`CHECK` e FK), identidade do paciente e isolamento entre clínicas, por FKs compostas com `patient_id` e `tenant_id` (seção 3.7). No PostgreSQL, a checagem de FK ignora a RLS; por isso a clínica precisa estar na própria chave.
- **Retornos degradados registrados:** todo retorno para versão sem a capacidade é gravado em `history.jsonl` com `mode=degraded`, motivo e responsável.
  - **Rollback automático (`deploy.sh`), no deploy que introduz a exigência:** permitido para a versão anterior, em modo degradado e registrado. A versão nova não chegou a atender, então não há desfechos gravados, e parar a aplicação seria pior.
  - **`rollback.sh --to` para destino sem a capacidade,** depois que uma versão com a capacidade ficou no ar naquele ambiente: recusado, salvo `--allow-degraded` com `--notes`, registrado.
- **Restauração de backup sem reintroduzir o estado vulnerável:**
  - o host registra no seu estado (`requirement-active`) que a exigência está ativa naquele ambiente;
  - `deploy.sh`, `rollback.sh` e o procedimento de restauração (`restore-drill.sh` e runbook) conferem `deployment_requirement` e a presença das restrições (`pg_constraint`) antes de subir qualquer versão;
  - se o banco restaurado não as tiver, aplicam as migrations (`prisma migrate deploy`) e conferem de novo; sem isso, nenhuma aplicação sobe.
- **Privilégios por coluna** em `billing` e `billing_session` (seção 3.7), sem reaplicar `GRANT ALL` nessas tabelas. Isso vale também para o provisionamento do papel em homologação.
- **Teste no CI** que falha se alguma restrição da seção 3.7, ou o congelamento da seção 2.4, sumir.

**Condição para encerrar o K2 (item 4 da decisão):**
1. Testes de integração no **PostgreSQL 16** para cada restrição da seção 3.7 e para o congelamento da seção 2.4.
2. **Ensaio de deploy e rollback** demonstrando que a versão anterior, contra o banco migrado:
   - sobe;
   - **não cria cobrança inválida**;
   - **não deixa cobrança sem vínculo nem vínculo órfão**;
   - não altera consulta com desfecho;
   - fica com o retorno degradado registrado.
3. Ensaio de restauração demonstrando que um banco restaurado sem as restrições não sobe aplicação antes de reaplicar as migrations.

Até lá, **o K2 continua BLOQUEADOR** para qualquer ambiente com dados de clínica. A aprovação da exceção **não autoriza** código, schema, migrations, testes executáveis, commit, push ou deploy.

**Limitações que o banco não impede sem triggers** (registradas à parte, item 4 da decisão):

| Limitação | Por quê | Controle que resta |
|---|---|---|
| Cobrança sem nenhum vínculo criada pela versão nova | "Ao menos um vínculo" exigiria trigger ou restrição adiada entre tabelas | Transação única; teste; mutação |
| Versão nova com defeito preenchendo `kind` ou a elegibilidade sem desfecho registrado | O banco confere a coerência da linha, não quem decidiu | Só os casos de uso de desfecho gravam `kind`; testes e mutação |
| Valor da cobrança diferente da soma das sessões | Fora do K2: o valor ainda é digitado | MVP-02 |
| SQL direto com credencial de administrador | O administrador ignora privilégios e pode remover restrições | Acesso restrito; runbook |
| Restauração ou subida da aplicação por fora dos scripts | Os scripts são o ponto de controle | Runbook; acesso ao host |
| Reaplicar `GRANT ALL`, ou rodar `VALIDATE CONSTRAINT` nas FKs `NOT VALID` | Desfaz os privilégios por coluna, ou falha nos vínculos legados | Runbook; teste no CI |

### 9.5 Rollback por momento (com a alternativa (b))

| Momento | Versão anterior contra o banco novo |
|---|---|
| Durante o deploy (migrations aplicadas, versão nova não ficou pronta) | Rollback automático em modo degradado, registrado. Sobe; agenda, confirmação, pagamento e reenvio funcionam; **não cria cobrança** (D) |
| Depois de a versão nova atender | `rollback.sh` recusa, salvo `--allow-degraded`. Se usado:<br>• lê todas as consultas, porque nenhum enum antigo mudou;<br>• consultas com desfecho aparecem com o estado de agenda congelado, e o banco recusa alterá-las;<br>• remarcadas aparecem como canceladas;<br>• a confirmação cria sessão inelegível;<br>• **não cria cobrança** |
| Depois do `apply` do legado | Igual; marcas e anulações não dão elegibilidade a nada |
| Banco restaurado de backup anterior à migration | Nenhuma versão sobe antes de reaplicar as migrations (controle de restauração) |

Sem rollback de schema: migrations aditivas; a remoção seria uma contração futura, com ADR própria.

---

## 10. Decisões, pendências e critérios de aceite

### 10.1 Decisões registradas [REG]

**DP-26 — Aviso depois do início** (orientação do responsável, 21/10/2026, duas rodadas):

*Rodada 1:*
1. É **aviso tardio**, distinto de falta sem aviso.
2. Registrado com o horário real, preservando a informação original.
3. Nunca convertido automaticamente em falta.
4. Sem cobrança automática; sem política da clínica, decisão humana.
5. Realização nunca inferida só pela passagem do tempo ou por confirmação anterior.

*Rodada 2:*

6. O aviso não deixa de existir por chegar depois do fim do horário. Registra-se o momento real de recebimento, e a classificação considera o início previsto.
7. Aviso tardio não é automaticamente falta, cancelamento ou cobrança.
8. Com desfecho já registrado: não sobrescrever; registrar a comunicação como evento adicional, preservar o histórico e sinalizar a equipe quando exigir revisão.
9. A IA pode registrar a mensagem e identificar a possível intenção administrativa, mas não decide sozinha que o paciente faltou, que o atendimento foi cancelado ou que uma cobrança deve ser gerada.
10. Ambiguidade (por exemplo, "vou me atrasar") → registrar e encaminhar para análise humana quando necessário; atraso nunca vira ausência automaticamente.
11. O horário real de recebimento vem da informação confiável da integração, é preservado e não pode ser sobrescrito silenciosamente no painel.
12. Aviso por outro canal, ou horário afirmado pelo paciente: guardar separadamente o horário de registro no sistema, o horário alegado (se houver), a origem e o responsável, e a trilha de correções. **Horário alegado nunca é usado como horário de recebimento comprovado.**

**Propostas da rodada 1 substituídas pela rodada 2:**
- o limite "até o fim do horário" deu lugar à classificação sem limite final;
- a IA não registra mais o aviso tardio como desfecho: registra só a comunicação, e o desfecho é sempre de pessoa;
- o horário informado à mão deu lugar ao modelo recebido / registrado / alegado.

**Como o desenho atende:** seções 2.2, 2.3, 2.4 a 2.6, 3.2 e F5 a F5d.

**DP-27 — Sessões legadas** (rodada 1, reafirmada na rodada 2): os sete itens da seção 6.2, acrescidos de "nem porque existe cobrança" no item 1. **Como o desenho atende:** O1; seções 6.4 a 6.10; inelegibilidade de todo o legado desde a migration 1.

**K2:** o responsável recusou a correção depois da publicação.

**Decisão de 21/10/2026:** exceção à ADR-0060 **aprovada só no escopo restrito** da seção 9.4:
- versões sem `billing-eligibility-v1` operam em modo degradado, sem criar cobrança nem vínculo;
- D obrigatória e B complementar;
- agenda pela alternativa (b), sem ampliar `AppointmentState`;
- controles obrigatórios e condição de encerramento definidos.

**K2 continua bloqueador** até as provas. A decisão não autoriza implementação.

#### Decisões funcionais de 21/10/2026 (rodada 5) [REG]

Decisões de produto do responsável. Elas não aprovam a ADR, que continua em revisão; o K2 continua bloqueador.

| ID | Decisão | Proposta técnica correspondente [PROP] | Dependência para implementar |
|---|---|---|---|
| **DP-22** | Opção C: política por clínica com `nao_cobrar`, `decisao_humana` (padrão) e `sugerir_cobranca`. Cancelamento ou remarcação fora do prazo e aviso tardio usam as mesmas opções, com **configurações independentes**. A cobrança só nasce depois de confirmação humana e usa o **valor integral aplicável da sessão**, sem taxa adicional | `late_notice_policy` e `after_start_notice_policy` com os três valores; T11 com `cobranca_confirmada`; itens `aviso_fora_do_prazo` e `aviso_tardio`. `sugerir_cobranca` só destaca a ação de cobrar no painel; `nao_cobrar` registra `sem_cobranca` sem pendência | Valor aplicável depende do MVP-02; até lá, a confirmação não inventa valor (fica pendente de valor) |
| **DP-23** | Opção B: padrão `admin`. `super_admin` **nunca** aprova abono. Motivo obrigatório. O profissional responsável só pode ser habilitado para as próprias consultas **depois** de a restrição de acesso estar implementada e verificada | `abono_approvers` com padrão `admin`; conferência no caso de uso, porque o `RolesGuard` deixa o `super_admin` passar em qualquer rota [EV `roles.guard.ts`] | Permissão de abono e restrição do terapeuta às próprias consultas **não existem** no código (achado 7). `admin_e_profissional_responsavel` fica bloqueado até essa restrição |
| **DP-24a** | Opção B: o `admin` pode reverter um abono, com motivo. O caso volta para decisão humana, sem cobrança automática | T9b: `FaltaAbonada → Falta (aguardando_decisao)` em `appointment_outcome` | — |
| **DP-24b** | Opção A: a cobrança identifica a falta sem aviso prévio com linguagem neutra, com a data e o valor | Texto do item de falta na mensagem de cobrança | Datas na mensagem dependem do MVP-03 (CB-07). Fora da janela de 24 h do WhatsApp, depende de **modelo aprovado pela Meta** (A-07), possivelmente um modelo próprio para falta |
| **DP-25** | Opção A: cancelamento por iniciativa da clínica ou do profissional **não gera cobrança ao paciente**. Registrar separadamente quem solicitou, quem registrou e o horário; o motivo é opcional | `requested_by` (`clinica` ou `profissional`) sem decisão de consequência; `recorded_by` e `recorded_at` na comunicação; `notice_reason` opcional | — |
| **K11** | Opção B: a IA pede **confirmação explícita** antes de cancelar ou remarcar, identificando a consulta por data, horário e profissional. A antecedência é calculada a partir da **primeira mensagem** do pedido. A confirmação precisa chegar **antes do início agendado**; senão, nada é executado automaticamente e o caso vai para a equipe. A nova data também exige confirmação explícita | O pedido vira comunicação `aguardando_confirmacao`; a confirmação é uma segunda comunicação ligada (`confirms_notice_id`); sem confirmação até o início, o pedido fica `expirada` e vai para revisão. Precedente: confirmação em duas etapas do cadastro (ADR-0063) | Comportamento com o modelo real **não validado** (chamada paga, a autorizar). Fase 5 |

Resolve o K11 (seção 11.2): a IA não decide sozinha, porque o cancelamento só acontece com a confirmação do paciente, o que é compatível com a regra 26.9.


### 10.2 Situação das partes depois das decisões de produto

| Parte | Situação |
|---|---|
| Estados, comunicações, classificação, horários, elegibilidade, restrições, estratégia K2 | Sim |
| Realização, falta, aviso tardio por pessoa, cobrança de falta (T8), abono padrão `admin` | Sim |
| Decisão `sem_cobranca` para aviso fora do prazo ou tardio | Sim |
| Migração do legado | Sim (DP-27 orientada) |
| Cobrar aviso fora do prazo ou tardio | Decidido (DP-22); depende do MVP-02 para o valor aplicável |
| Abono pelo profissional | Decidido (DP-23); depende da restrição do terapeuta às próprias consultas, implementada e verificada |
| Reverter abono; falta na mensagem de cobrança | Decidido (DP-24); a mensagem depende do MVP-03 e, fora da janela de 24 h, de modelo aprovado pela Meta (A-07) |
| Cancelamento da clínica | Decidido (DP-25) |

### 10.3 Questões em aberto

| ID / tema | Pergunta | Situação |
|---|---|---|
| DP-22 | Consequência do aviso fora do prazo e do aviso tardio | **Decidido** (rodada 5, seção 10.1) |
| DP-23 | Quem aprova o abono | **Decidido** (rodada 5) |
| DP-24 | Abono reversível? Falta identificada na mensagem? | **Decidido** (rodada 5) |
| DP-25 | Cancelamento da clínica | **Decidido** (rodada 5) |
| IA antes do início (K11) | Confirmação explícita do paciente antes de cancelar ou remarcar | **Decidido** (rodada 5); comportamento com o modelo real não validado |
| K2 | Exceção à ADR-0060 aprovada em 21/10 no escopo restrito (seção 9.4); faltam as provas | **Bloqueador até as provas** |
| Carimbo da Meta | Semântica exata e tolerâncias de validade | A confirmar na implementação (documentação da Meta) |
| Terapeuta | Restrição às próprias consultas | Proposta, a validar |
| Agendamento no passado (achado 9) | Registro retroativo permitido ou recusado? | Não decidido |
| Origem do `appointmentId` na IA | — | Não conferido |
| Intenções `atraso` e `indefinida` | Comportamento com o modelo real | Não validado (chamada paga) |

### 10.4 Critérios de aceite deste desenho (para a revisão)

- [ ] Agendamento, confirmação, comunicação, aviso tardio, falta, realização e cobrança são distintos, sem conversão automática.
- [ ] A IA nunca decide falta, cancelamento depois do início, desfecho, consequência ou cobrança.
- [ ] Horários recebido, registrado e alegado separados; o alegado nunca vale como recebido; nada é sobrescrito.
- [ ] Comunicação depois de desfecho não o altera e sinaliza a equipe.
- [ ] Histórico de remarcação preservado por ocorrência.
- [ ] Elegibilidade para cobrança definida positivamente e garantida na aplicação e no banco, sem trigger.
- [ ] Nenhuma versão para a qual se possa voltar consegue cobrar sessão inelegível ou de outro paciente; o K2 continua bloqueador até prova.
- [ ] A migração não presume desfecho, não toca dados financeiros, começa por `dry-run`, interrompe em inconsistência e só aplica com autorização específica.
- [ ] DP-22 a DP-25 e K11 registradas como decisões de produto, com as dependências de implementação explícitas.
- [ ] Limitações e conflitos declarados (seções 1.3 e 11).

### 10.5 Critérios de aceite da implementação futura

Os critérios do MVP-01 no backlog, mais os da seção 8, em especial:
- [ ] As restrições da seção 3.7 provadas no PostgreSQL 16.
- [ ] O teste de compatibilidade da versão anterior aprovado no ensaio de deploy.
- [ ] Os scripts de deploy e de rollback aplicando as regras de retorno degradado e registrando cada retorno.
- [ ] O ensaio de restauração recusando subir aplicação sobre banco sem as restrições.
- [ ] A versão anterior sem conseguir alterar consulta com desfecho.

---

## 11. Validação técnica

### 11.1 Coerência (rodada 2)

| Ponto | Resultado |
|---|---|
| Separação dos conceitos | Coerente. A comunicação virou registro próprio; o aviso tardio como desfecho é só de pessoa |
| Histórico de remarcações | Coerente; alternativa C mantida; T5b só por pessoa |
| Integridade de cobranças e pagamentos | Coerente. Elegibilidade na aplicação e no banco; cobranças e pagamentos legados intactos e operáveis; impressão digital sobre colunas originais |
| Duplicidade | Coerente. Comunicação única por mensagem; item reaproveitado; vínculo único; transação única na cobrança |
| Auditoria | Coerente. Comunicação somente de acréscimo; horários separados; ator `ai_agent` |
| Isolamento entre clínicas | Coerente e reforçado: `tenant_id` nas chaves compostas do vínculo e da comunicação |
| Migração do legado | Coerente. A inelegibilidade não depende mais do `apply` |
| Rollback | Estratégia definida; **K2 continua bloqueador** até prova |
| Fases e critérios | Fase K2 obrigatória antes de qualquer ambiente com dados de clínica |

### 11.2 Conflitos, limitações e alternativas

- **K1 — Guarda de `POST /billings`:** resolvida no desenho (seção 2.9) por aplicação e banco. Antes era só recomendada.
- **K2 — Rollback:** seção 9.4. **Bloqueador.**
- **K3 — Comprovantes:** não existem no sistema; nada a preservar no banco hoje. Se o MVP-13 vier antes, entra na impressão digital.
- **K4 — Exceção do legado:** L2, L4 e L6 têm sessão cobrada sem desfecho registrado. A verificação e o fechamento (MVP-06) tratam `legacy_category` à parte.
- **K5 — `dry-run`:** transação desfeita (recomendada) ou projeção somente leitura. A transação desfeita trava as sessões da clínica durante a simulação.
- **K6 — Representação do aviso tardio:** estado `AvisoTardio` só por pessoa, mais comunicação registrada pela IA.
- **K7 — Limite temporal:** resolvido pela DP-26 rodada 2 (sem limite final).
- **K8 — Comunicação depois de desfecho:** resolvido pela DP-26 rodada 2 (evento adicional, sem sobrescrever).
- **K9 — Horário à mão:** substituído pelo modelo recebido / registrado / alegado.
- **K10 — Agendamento no passado:** aberto (seção 10.3).
- **K11 — IA antes do início:** resolvido pela decisão da rodada 5: confirmação explícita do paciente antes de cancelar ou remarcar (seção 10.1). Fica pendente validar o comportamento com o modelo real.
- **K12 — Exceção à ADR-0060:** **aprovada em 21/10/2026 no escopo restrito** (seção 9.4): versões antigas sem criar cobrança nem vínculo, e sem alterar consulta com desfecho, depois da migration do K2. A agenda segue a alternativa (b); nenhuma outra incompatibilidade foi aprovada.
- **K13 — Carimbo da Meta:** hoje não é lido. Até a fase 5, o horário de referência pelo WhatsApp é o recebimento no webhook.
- **K14 — Limites das restrições:** cobrança com zero vínculos e SQL de administrador não são barrados pelo banco (seção 3.7).

---

## Documentos relacionados

- [`docs/01-Domain/14-Especificacao-Funcional-do-Dominio.md`](../../01-Domain/14-Especificacao-Funcional-do-Dominio.md), seção 4.1.
- [`docs/MVP_BACKLOG.md`](../../MVP_BACKLOG.md), MVP-01 e DP-22 a DP-27.
- ADR-0017, ADR-0040, [ADR-0052](./ADR-0052-fechamento-ciclo-financeiro-sessao-faturada-recebida.md), [ADR-0060](./ADR-0060-deploy-e-operacao.md), [ADR-0063](./ADR-0063-identidade-confirmada-no-whatsapp.md), [ADR-0064](./ADR-0064-fuso-horario-por-clinica.md), [ADR-0068](./ADR-0068-governanca-dos-dados-a-14.md).
- `docs/02-Arquitetura/16-Politica-RBAC.md`, `docs/04-API/01-Contratos-REST.md`, `docs/07-Infra/MIGRATION_RUNBOOK.md`, `docs/03-Database/05-Constraints.md`, `docs/03-Database/11-Funcoes-e-Triggers.md`, `infra/scripts/deploy.sh`, `infra/scripts/rollback.sh`.

## Histórico

- **21/10/2026 — versão inicial.** Proposta a partir da leitura de `2dd7934`. Abriu DP-26 e DP-27; oito achados.
- **21/10/2026 — rodada 1.** Orientação para DP-26 e DP-27; estado `AvisoTardio`; classificação do aviso; migração com O1 e `dry-run` em transação desfeita; guarda de `POST /billings` obrigatória; achado 9; seção 11.
- **21/10/2026 — rodada 2.**
  - DP-26 detalhada: sem limite final; a IA só registra a comunicação; horários recebido, registrado e alegado separados; comunicação depois de desfecho como evento adicional.
  - Tabela de comunicações; DP-27 reafirmada.
  - K2: o responsável recusou a correção depois da publicação. Desenhadas a regra de elegibilidade com restrições declarativas, a exigência de capacidade no deploy e a exceção à ADR-0060. K2 mantido bloqueador.
  - Achado 10.
  - A ADR continua **PROPOSTA, EM REVISÃO**.
- **21/10/2026 — rodada 3 (decisão do K2).**
  - O responsável aprovou a exceção à ADR-0060 **só no escopo restrito** da seção 9.4.
  - Desfecho em coluna própria (`outcome`), com congelamento de `state` e `scheduled_at`, sem ampliar o enum `AppointmentState` (alternativa (b)); a seção 9.5 foi corrigida, porque a versão anterior provavelmente quebraria ao ler valores novos de enum.
  - Controles obrigatórios, condição de encerramento e limitações sem triggers registrados.
  - K2 continua bloqueador. Nada implementado.
- **21/10/2026 — rodada 4 (correção técnica).**
  - O congelamento atribuído a um `CHECK` foi retirado: `CHECK` não compara com o valor anterior da linha.
  - O desfecho passou para a tabela `appointment_outcome`.
  - A imutabilidade agora vem de FK composta de congelamento, privilégios e política RLS restritiva de `UPDATE`, sem trigger (seção 2.4).
  - Também foram retirados os `CHECK`s na linha da consulta que recusariam cancelamentos de versões anteriores.
- **21/10/2026 — rodada 5 (decisões funcionais).**
  - DP-22 a DP-25 e K11 decididos pelo responsável (seção 10.1).
  - Dependências registradas: MVP-02, MVP-03, A-07, restrição do terapeuta às próprias consultas e validação com o modelo real.
  - A ADR continua em revisão, e o K2 continua bloqueador.
- **21/10/2026 — rodada 6 (mecanismo da cobrança).**
  - [EV] O `CHECK` sobre `eligibility_checked` recusaria até a quitação feita pela versão antiga: o Prisma grava a cobrança com `INSERT … ON CONFLICT DO UPDATE`, e o PostgreSQL confere `CHECK` na linha proposta.
  - O responsável aprovou a troca pela chave estrangeira de protocolo (`eligibility_protocol` → `billing_eligibility_protocol`, padrão inválido `'nenhum'` para versões antigas, cobranças legadas com protocolo nulo), mantendo os privilégios por coluna (seção 3.7).
- **21/10/2026 — K2-a implementada (fase autorizada; commit local, sem push nem deploy).**
  - Migration `20261022120000_k2a_billing_eligibility`: tabela de protocolos e `deployment_requirement`; `legacy_billing`, `eligibility_protocol`, `legacy_link` e `patient_id` do vínculo; chave do protocolo; FKs compostas de paciente e clínica no vínculo (cobrança e sessão), já validadas; os dois `CHECK`s; privilégios por coluna. Sem trigger e sem função.
  - Aplicação: `POST /billings` confere paciente, clínica e estado de cada sessão (`SESSION_OF_ANOTHER_PATIENT`, `SESSION_ALREADY_BILLED` para sessão já `Faturada` ou `Recebida`, como no contrato publicado, e `SESSION_NOT_BILLABLE`, reservado para os estados da K2-b) e grava cobrança e vínculos numa única transação; `BillingRepository.save()` só atualiza o status.
  - Achados da implementação [EV], registrados na seção 3.7: `@ignore` no Prisma para as colunas que a aplicação não grava; `UPDATE` numa coluna sem papel na integridade, só onde o papel da aplicação é dono das tabelas, para a checagem de chave estrangeira.
  - Scripts: rótulo `luxora.capabilities` na imagem; `deploy.sh` e `rollback.sh` conferem exigência, restrições e privilégios; retorno degradado registrado (`mode`); estado `requirement-active` gravado assim que as migrations passam; `restore-drill.sh` confere o banco restaurado.
  - Restauração: em vez de aplicar migrations por conta própria, `rollback.sh` recusa e indica `deploy.sh`, que as aplica e confere de novo antes de trocar a aplicação. Backup de schema anterior vai para banco vazio: `pg_restore --clean` sobre o banco atual deixaria as tabelas novas e impediria reaplicar a migration (MIGRATION_RUNBOOK).
  - Fora da K2-a, e por isso o K2 **continua bloqueador**: K2-b (elegibilidade da sessão, `required_eligibility` e `billing_eligibility`, congelamento da consulta com desfecho, seção 2.4) e as provas que dependem dela.

## Considerações finais

O desenho separa reservar, confirmar, comunicar, realizar e cobrar:
- a comunicação do paciente é registrada como fato, com horários de origem comprovada, e nunca decide nada sozinha;
- nada que só uma pessoa pode afirmar fica a cargo da IA, do tempo ou de uma versão antiga da aplicação;
- a elegibilidade para cobrança passa a ser garantida também pelo banco, de forma declarativa, para que um rollback não reabra cobrança indevida.

Enquanto essa garantia não for implementada e provada, o K2 bloqueia qualquer liberação em ambiente com dados de clínica. Esta proposta não autoriza programar.
