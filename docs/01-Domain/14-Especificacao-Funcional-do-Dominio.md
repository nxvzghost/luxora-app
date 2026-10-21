# 14 — Especificação funcional do domínio (DOMAIN_SPEC)

> **PROPOSTA — NÃO APROVADA.** Escrita em 21/10/2026 a partir do levantamento `DOMAIN_DISCOVERY.md` (relato de cerca de três anos de operação de um consultório; arquivo entregue pelo responsável pelo produto, **fora do repositório**) e comparada com o código publicado em `2dd7934` (CI 39619145877 verde nos 7 jobs). Precisa de revisão antes de qualquer implementação. Não altera decisões já registradas (D-A, D-F revista, ADR-0063) e não é parecer jurídico. O backlog derivado está em [`docs/MVP_BACKLOG.md`](../MVP_BACKLOG.md).
>
> **Atualização de 21/10/2026 (continuação):** o responsável deu orientação para **DP-01 a DP-04** (ciclo da consulta). Ela está registrada na seção 4.1, separando o que a clínica relatou do que é proposta de produto e do que continua pendente. A especificação como um todo **continua não aprovada**.
>
> **Revisão de 21/10/2026:** o responsável deu orientação para **DP-26** (aviso recebido depois do início) e **DP-27** (sessões legadas), registradas também na seção 4.1. O desenho técnico correspondente está na [ADR-0069](../02-Arquitetura/ADRs/ADR-0069-ciclo-de-vida-da-consulta.md), que continua proposta. DP-22 a DP-25 continuam pendentes.
>
> **Revisão de 21/10/2026, rodada 5:** DP-22 a DP-25 e o K11 (IA antes do início) receberam decisão de produto (seção 4.1, "Decisões de 21/10/2026, rodada 5").
>
> **Revisão de 21/10/2026, rodada 2:** DP-26 detalhada (regras 26.6 a 26.12) e DP-27 reafirmada (regra 27.8). O rollback para versões sem a regra de elegibilidade para cobrança (K2) é **bloqueador** de qualquer liberação com dados de clínica (ADR-0069, seção 9.4).

## 0. Como ler

**Origem de cada requisito** (preservada do levantamento):

| Marca | Significado |
|---|---|
| **R** | Relatado/observado na operação real |
| **D** | Regra de produto desejada pelo responsável |
| **P** | Proposta operacional, registrada como recomendação a validar com a clínica (não é fato observado nem decisão tomada) |
| **H** | Hipótese de problema, ainda não validada |
| **C** | A confirmar: ausente ou contraditório no levantamento |
| **DR** | Decisão já registrada no repositório (com o documento) |

**Situação no código** (conferida em `2dd7934`):

| Situação | Critério |
|---|---|
| **Implementado** | Existe caminho real (rota ou fluxo do WhatsApp) e o comportamento foi lido no código |
| **Parcial** | Existe parte do caminho, ou a configuração existe sem efeito, ou só em teste |
| **Não implementado** | Nenhum caminho no código |
| **Não verificável** | Depende de processo externo, de credencial ou de informação que o levantamento não traz |

**Limite permanente:** o Vertex é administrativo. Não guarda prontuário, diagnóstico, anotação terapêutica ou relatório clínico; não interpreta crises; não decide alta, continuidade de tratamento ou conduta clínica.

---

## 1. Jornada administrativa do paciente

```
contato → identificação → agendamento → (lembrete) → atendimento
   │                                          │
   │                         realizado / falta / cancelado / remarcado
   │                                          │
   └──────────── cobrança (por sessão ou consolidada) → pagamento → conferência
                                              │
                         pendência → reiteração → escalonamento humano
                                              │
                    fechamento mensal · acompanhamento de quem não voltou
```

Cada seta é um registro separado. Nenhum estado único representa "agendado, atendido e pago" (levantamento, seção 5, regra 5).

---

## 2. Cadastro, identidade e histórico administrativo

| ID | Requisito | Origem | Situação | Evidência |
|---|---|---|---|---|
| CA-01 | Nome e telefone são o mínimo para cadastrar | R | Implementado | `patient` (name, phone); `POST /patients`; cadastro pelo WhatsApp com nome completo e confirmação (ADR-0063) |
| CA-02 | Status administrativo ativo / inativo / alta, alterado por pessoa autorizada | R, D | Implementado | `POST /patients/:id/deactivate`, `reactivate`, `discharge`; inativo e alta não agem pelo WhatsApp (A-11) |
| CA-03 | Dados de relacionamento: primeira consulta, último e próximo atendimento, frequência | D | Parcial | Deriváveis de `appointment` e `session`; nenhuma tela ou consulta mostra esses campos |
| CA-04 | Preferências: valor aplicável, forma e momento de pagamento, lembrete, modalidade | D | Parcial | Só `billingPolicyOverride` existe no paciente, e nenhum fluxo o usa |
| CA-05 | Observações restritas ao administrativo | D | Implementado (por ausência) | Não há campo de texto livre no cadastro; não há campo clínico no banco |
| CA-06 | Identidade ambígua nunca tratada como confirmada | D, DR | Implementado | `resolver-identidade-do-contato.use-case.ts` (`ambiguous`), ADR-0063 |
| CA-07 | Número novo só é vinculado com aprovação da clínica; desfazer vínculo | DR | Implementado | `POST /contacts/:id/link`, `unlink` (A-10) |
| CA-08 | Histórico das conversas preservado, sem exclusão automática por idade | D, DR | Implementado (por ausência) | Nenhum código apaga `message`, `conversation` ou `message_log`; decisão D-F revista (`5b67357`) |
| CA-09 | Consultar o histórico das conversas conforme as permissões da clínica | D, DR | **Não implementado** | O painel não mostra conversas; não há rota de leitura |
| CA-10 | Retenção do histórico separada do contexto enviado à IA | DR | Implementado | D-A (`6d307e0`): no máximo 20 mensagens, contando a atual, das últimas 72 h |
| CA-11 | Número compartilhado: manter as proteções, não apagar histórico, não criar fluxo manual para o cotidiano | D | Parcial | Proteção existe (CA-06). A regra de anonimização em número compartilhado (D-G) não está decidida formalmente; o levantamento descarta apagar a conversa |
| CA-12 | Alta / encerramento do tratamento por decisão humana | R, C | Implementado (registro) | `discharge`; o processo de alta não foi descrito (lacuna 10) |

**Máquina de estados do paciente.** O código tem 12 estados (`Novo`, `Identificado`, `Cadastrado`, `Ativo`, `Agendado`, `Confirmado`, `EmSessao`, `PagamentoPendente`, `Pago`, `EmFollowUp`, `Inativo`, `Alta`), mas só ativo/inativo/alta são usados por algum fluxo. Proposta: o status administrativo do paciente fica em **ativo, inativo e alta**; agenda, atendimento e financeiro ficam nos próprios registros (consulta, sessão, cobrança, pagamento). Decisão pendente DP-20.

---

## 3. Agenda, horários, disponibilidade, férias e bloqueios

| ID | Requisito | Origem | Situação | Evidência |
|---|---|---|---|---|
| AG-01 | Não oferecer horário em conflito com sessão marcada, bloqueio, férias ou feriado | R, D | Implementado | `verificar-disponibilidade.use-case.ts`: feriado da clínica > exceção do terapeuta > janela, e consultas existentes; Teste Crítico #10 (concorrência) |
| AG-02 | Horários fixos (semanais, quinzenais) coexistindo com mudanças | R, D | Implementado | `recurring_block` (`intervalDays`, `renewalMode`), `POST /recurring-blocks`, materialização |
| AG-03 | Presencial e on-line | R | Implementado | `modality` na consulta e no horário fixo |
| AG-04 | Duração de 30 min ou 1 h, conforme clínica, terapeuta ou paciente | R, D | Parcial | Duração vem do calendário do terapeuta (`durationMinutesFor`) e do padrão da clínica; a consulta não guarda a própria duração; não há duração por paciente |
| AG-05 | Feriados sem atendimento | R | Parcial | `clinic_holiday` é respeitado na disponibilidade, mas **não há rota nem tela para cadastrar feriado** |
| AG-06 | Férias com intervalo, data de retorno e reabertura | R, D | Parcial | Exceções de disponibilidade por terapeuta (`PUT /therapists/:id/availability/exceptions`); intervalo de férias e reabertura não verificados como fluxo; aviso aos pacientes não existe |
| AG-07 | Bloqueios pessoais | R | Parcial | Mesmo mecanismo de exceção (AG-06) |
| AG-08 | Encaixe em emergência com autorização configurável | R, C | Não implementado | Nenhum caminho para sobrepor a disponibilidade; quem aprova não está definido (lacuna 6) |
| AG-09 | Revisão semanal da agenda com a terapeuta | R | Não verificável | Processo humano; o sistema só precisa permitir alterar a semana |
| AG-10 | Grade horária fixa da clínica do relato | C | — | **Não codificar.** As anotações se contradizem sobre sexta-feira e o último horário (lacuna 3) |

---

## 4. Agendamento, confirmação, cancelamento, remarcação e faltas

| ID | Requisito | Origem | Situação | Evidência |
|---|---|---|---|---|
| AT-01 | Agendar pelo painel e pelo WhatsApp | R, D | Implementado | `POST /appointments`; intenção `agendar_consulta` |
| AT-02 | O paciente confirma data e hora no ato do agendamento | R | Parcial | Estados `Criada` → `Reservada` → `Confirmada`; a confirmação é uma ação à parte (`POST /appointments/:id/confirm`, intenção `confirmar_presenca`) |
| AT-03 | **Confirmação é diferente de realização** | R, D | **Divergente** | `ConfirmarConsultaUseCase` cria a sessão com estado `Realizada` no momento da confirmação, que pode ser dias antes do atendimento (`gerenciar-consulta.use-case.ts`, `session.entity.ts`). O `completedAt` da entidade não chega ao banco: `session.completed_at` fica vazio, e o momento da confirmação fica só em `session.created_at` (`prisma-session.repository.ts`; ADR-0069, achado 1). A intenção `confirmar_presenca` do WhatsApp usa o mesmo caso de uso (`intent-action-router.ts`) |
| AT-04 | Cancelar e remarcar conforme disponibilidade | R | Implementado | `cancel`, `reschedule`; intenções `cancelar_consulta` e `remarcar_consulta` |
| AT-05 | Antecedência mínima de 2 h para cancelar ou remarcar | R | Parcial | `clinic_settings.cancellation_hours_limit` é gravado e validado, mas **nenhum caso de uso o aplica** |
| AT-06 | Registrar a antecedência do cancelamento | H, D | Não implementado | Orientação DP-04 (seção 4.1) |
| AT-07 | Falta sem aviso cobrada pelo valor aplicável, salvo exceção decidida pela pessoa responsável | R | **Não implementado** | Não existe estado de falta na consulta nem na sessão. Regra geral confirmada no levantamento; processo em DP-03 (seção 4.1) |
| AT-08 | Distinguir confirmada, realizada, falta sem aviso, falta abonada, cancelada (no prazo / fora do prazo), aviso tardio (depois do início) e reagendada | R, D | Não implementado | Orientação DP-01 e DP-26 (seção 4.1) |
| AT-13 | Remarcação preserva o horário original | D | **Não implementado** | `Appointment.reschedule` sobrescreve `scheduledAt` no próprio registro (`appointment.entity.ts`); o evento auditado guarda só os estados (`fromState`, `toState`), não a data anterior |
| AT-14 | Realização e falta registradas por pessoa autorizada; a passagem do horário não comprova nada | D, P | Não implementado | Orientação DP-01 e DP-02 (seção 4.1) |
| AT-15 | Comunicação do paciente registrada com horário de recebimento confiável (e alegado à parte); aviso depois do início tratado como aviso tardio, sem virar falta, cancelamento nem cobrança automática, e sem sobrescrever desfecho | D | **Não implementado** | Hoje `CancelarConsultaUseCase` aceita cancelar em qualquer momento, inclusive depois do início, sem registrar o horário do aviso. O carimbo de tempo da Meta não é lido. Orientação DP-26 (seção 4.1) |
| AT-09 | Limite de remarcações e perda de vaga | C | Não implementado | Não especificado (lacuna 4) |
| AT-10 | Lista de espera | C | Não implementado | Não especificado (lacuna 5) |
| AT-11 | Resistência ao tratamento ou risco de desistência vai à terapeuta, sem decisão do sistema | R, D | Parcial | A IA encaminha à equipe o que foge do administrativo (aviso `whatsapp_human_review`); não há encaminhamento dirigido à terapeuta |
| AT-12 | Quem alterou um agendamento | H | Parcial | Pelo painel, o `audit_log` grava o usuário (`audit.service.ts`). Pelo WhatsApp, a ação fica como `system`, sem usuário e sem marca de `ai_agent`, e a auditoria é gravada depois da mudança, fora da mesma transação (ADR-0069, achado 6) |

### 4.1 Ciclo da consulta — orientação para DP-01 a DP-04, DP-26 e DP-27 (21/10/2026)

Orientação dada pelo responsável pelo produto em 21/10/2026. Cada regra traz a origem (seção 0). **Não é aprovação da especificação**; os pontos marcados como pendentes continuam abertos.

**Desenho técnico (proposta, não aprovada):** [ADR-0069](../02-Arquitetura/ADRs/ADR-0069-ciclo-de-vida-da-consulta.md). Cobre estados, aviso tardio, remarcação como nova ocorrência ligada, migração das sessões legadas, contratos, testes e rollback. A ADR abriu a DP-26 e a DP-27, que receberam orientação no mesmo dia (abaixo).

**Divergência com a versão anterior desta seção.** A proposta anterior dizia que a sessão nasce quando "uma falta é considerada cobrável pela política", o que permitia ler que a política sozinha decidiria a cobrança. A orientação muda isso: nenhuma cobrança de falta nasce sem que uma pessoa autorizada registre ou confirme a ocorrência, mesmo com política configurada. A proposta anterior também listava o cancelamento entre os desfechos registrados **depois** do início; o cancelamento acontece em qualquer momento antes do atendimento, e a antecedência é o que o distingue.

#### DP-01 — Confirmada, realizada, falta e falta abonada

| # | Regra | Origem |
|---|---|---|
| 1.1 | Reservar ou confirmar o horário não significa que a consulta foi realizada | R, D |
| 1.2 | O ciclo distingue, no mínimo: **reservada/agendada**, **confirmada**, **realizada**, **falta sem aviso**, **falta abonada**, **cancelada no prazo**, **cancelada fora do prazo** e **reagendada** | D |
| 1.3 | Realizada só depois de o atendimento ter ocorrido e de uma pessoa autorizada registrar o resultado. A passagem do horário, sozinha, não comprova a realização e não muda o estado | D |
| 1.4 | Falta abonada é sempre decisão humana de pessoa autorizada; o sistema nunca deduz o abono | D |
| 1.5 | A consequência financeira de uma exceção segue a decisão autorizada e as regras configuradas pela clínica | D |
| 1.6 | Reagendar preserva o histórico da ocorrência anterior (horário original, quem pediu, quando) | D |
| 1.7 | Confirmação pelo WhatsApp é só confirmação: nunca comprova atendimento e nunca cria sessão | D |

Consequências para o modelo (proposta técnica, a detalhar no desenho do MVP-01):
- A **consulta** guarda o ciclo de agenda e o **desfecho**: realizada, falta sem aviso, falta abonada, cancelada no prazo, cancelada fora do prazo e, desde a DP-26, aviso tardio.
- A **sessão** representa o que pode ser faturado: nasce do registro de realização, ou do registro de falta sem aviso **com a cobrança confirmada** (DP-03). Falta abonada e cancelamento no prazo não geram sessão faturável.
- Consulta cujo horário passou sem desfecho fica **"sem desfecho registrado"**: aparece para a equipe como pendência operacional, não é tratada como realizada nem como falta e não entra em cobrança nem no fechamento como valor devido.
- **Remarcação:** o código atual sobrescreve a data (AT-13). Preservar o histórico exige guardar o horário anterior. A ADR-0069 compara as formas possíveis e propõe uma nova ocorrência ligada à original (proposta técnica, não aprovada).

#### DP-02 — Quem registra realização e falta

| # | Regra | Origem |
|---|---|---|
| 2.1 | A equipe administrativa (secretaria) registra o resultado da consulta no painel | **P** |
| 2.2 | O profissional responsável registra ou corrige o resultado, conforme as permissões | **P** |
| 2.3 | Exceções (falta abonada) dependem de aprovação de pessoa autorizada, respeitando a responsabilidade do profissional e as permissões configuradas | **P** |
| 2.4 | Nenhuma marcação automática de realização, nem pela passagem do horário nem pela confirmação do WhatsApp | D |
| 2.5 | Todo registro, correção e abono vai para a auditoria com o autor | D |

**Lacunas do modelo de permissões atual** (registradas, sem alteração nesta etapa):
- Só existem os papéis `admin`, `therapist` e `super_admin` (`16-Politica-RBAC.md`). Não há papel de secretaria nem de financeiro (PE-01, DP-14, MVP-14). No MVP, "equipe administrativa" teria de ser o `admin`.
- Não há permissão separada para **aprovar abono** no código. Decisão DP-23 (regras 23.1 e 23.2): padrão `admin`, `super_admin` nunca, motivo obrigatório; o profissional só depois da restrição às próprias consultas. A permissão ainda precisa ser implementada.
- As ações de consulta (`confirm`, `cancel`, `reschedule`) aceitam `admin` e `therapist`, e o terapeuta **não** fica restrito às próprias consultas: a rota exige só o papel (ADR-0069, achado 7). `User.therapistId` existe e permitiria essa restrição, proposta na ADR-0069 a validar.
- A auditoria já grava o autor quando a ação vem de usuário (`audit.service.ts`: `userId`, `actorType`); o registro de desfecho pode usar o mesmo mecanismo.

#### DP-03 — Falta sem aviso

| # | Regra | Origem |
|---|---|---|
| 3.1 | Paciente que não comparece e não avisa tem a sessão cobrada pelo valor aplicável, salvo exceção decidida pela pessoa responsável | **R** (levantamento) |
| 3.2 | A ocorrência é registrada como falta, nunca como consulta realizada | D |
| 3.3 | A cobrança usa o preço aplicável àquele paciente e àquela data (MVP-02); nenhum valor fixo no código | D |
| 3.4 | A cobrança da falta só nasce depois que pessoa autorizada registra ou confirma a ocorrência; o horário passar não basta | D |
| 3.5 | Emergências e casos excepcionais vão para decisão humana; o Vertex não decide questão clínica nem concede exceção | D |
| 3.6 | A política de falta é configuração da clínica (e do profissional, quando aplicável); a regra 3.1 é a política relatada pela clínica do levantamento, não um padrão universal | D |
| 3.7 | Processo proposto: registrar a falta → sistema indica a consequência da política → pessoa autorizada confirma a cobrança ou abona | **P** |

Decidido em 21/10 (DP-24, regras 24.1 e 24.2): o `admin` pode reverter o abono, com motivo, e o caso volta para decisão humana; a cobrança identifica a falta com linguagem neutra, data e valor.

#### DP-04 — Cancelamento com menos de duas horas

| # | Regra | Origem |
|---|---|---|
| 4.1 | Cancelar ou reagendar exige aviso com pelo menos duas horas de antecedência | **R** |
| 4.2 | O levantamento **não confirma** que todo cancelamento com menos de duas horas gera cobrança | C |
| 4.3 | Cancelamento fora do prazo é uma ocorrência distinta de falta sem aviso e nunca é convertido nela automaticamente | D |
| 4.4 | A consequência do cancelamento fora do prazo é configurável por clínica | D |
| 4.5 | Sem política configurada, nada é cobrado: o caso vai para decisão humana | D |
| 4.6 | O limite (2 h no relato) é configuração da clínica (`cancellation_hours_limit` já existe, sem efeito); nada fixo no código | D |
| 4.7 | O histórico do horário original e de cada reagendamento é preservado | D |
| 4.8 | A antecedência é calculada entre o momento do aviso e o horário marcado, no fuso da clínica | D |

Decididos em 21/10 (rodada 5, regras 22.x, 25.x e K11.x abaixo):
- **Consequência do aviso fora do prazo:** política por clínica, padrão `decisao_humana`. Cancelamento e remarcação seguem a mesma configuração, e a cobrança só ocorre com confirmação humana (DP-22).
- **Cancelamento pedido pela clínica ou pelo profissional:** não gera cobrança ao paciente (DP-25).
- **Pelo WhatsApp,** a IA **hoje** cancela direto (`cancelar_consulta`). Pela decisão K11, passará a pedir confirmação explícita antes de cancelar ou remarcar. Isso ainda não está implementado.

#### DP-26 — Aviso recebido depois do horário de início

| # | Regra | Origem |
|---|---|---|
| 26.1 | Aviso recebido depois do horário previsto é identificado como **aviso tardio**, distinto da falta sem aviso | D |
| 26.2 | Se o paciente comunicar que não comparecerá depois do início previsto, a ocorrência é registrada com o **horário real** do aviso, e a informação original é preservada | D |
| 26.3 | O sistema não converte automaticamente aviso tardio em falta sem aviso | D |
| 26.4 | Não há cobrança automática só porque o aviso chegou depois do início. Se a política da clínica não determinar a consequência, o caso vai para decisão humana | D |
| 26.5 | A realização nunca é inferida só pela passagem do tempo ou por uma confirmação anterior | D |
| 26.6 | O aviso não deixa de existir por chegar depois do fim do horário agendado: registra-se o momento real em que a mensagem foi recebida, e a classificação considera o início previsto da consulta | D (rodada 2) |
| 26.7 | Aviso tardio não é automaticamente falta, cancelamento ou cobrança | D (rodada 2) |
| 26.8 | Se já houver desfecho registrado, ele não é sobrescrito: a nova comunicação vira evento adicional, o histórico é preservado e a equipe é sinalizada quando houver algo a revisar | D (rodada 2) |
| 26.9 | A IA pode registrar a mensagem recebida e identificar uma possível intenção administrativa, mas não decide sozinha que o paciente faltou, que o atendimento foi cancelado ou que uma cobrança deve ser gerada | D (rodada 2) |
| 26.10 | Mensagem ambígua (por exemplo, só que o paciente vai se atrasar): registrar a comunicação e encaminhar para análise humana quando necessário; atraso nunca vira ausência automaticamente | D (rodada 2) |
| 26.11 | O horário real de recebimento vem da informação confiável disponível na integração, é preservado e não pode ser sobrescrito silenciosamente no painel | D (rodada 2) |
| 26.12 | Aviso por outro canal, ou horário que o paciente afirma ter enviado: guardar separadamente o horário em que o sistema registrou, o horário alegado ou informado (se houver), a origem e o responsável pelo registro, e a trilha de correções. Horário alegado nunca é usado como horário de recebimento comprovado | D (rodada 2) |

Proposta técnica na ADR-0069 (não aprovada):
- **Comunicação como registro próprio**, somente de acréscimo, com:
  - intenção identificada;
  - marca de ambiguidade;
  - classificação pelo início previsto, sem limite final;
  - horários separados: carimbo da Meta, recebimento no webhook, registro no sistema e alegado.

  Correções são novos registros.
- **Estado `AvisoTardio`** separado de `Cancelada`, `Falta` e `Realizada`, levado **só por pessoa**, com base nas comunicações `depois_do_inicio`. A IA nunca muda a consulta depois do início.
- **Sem item faturável** e com decisão de consequência pendente por padrão.

Substituído pela rodada 2: a proposta da rodada 1 de limitar o aviso tardio ao fim do horário, de deixar a IA registrá-lo como desfecho e de aceitar o horário do aviso informado à mão.

Decidido em 21/10 (K11): antes do início, a IA só cancela ou remarca depois de confirmação explícita do paciente (regras K11.1 a K11.4).

A consequência financeira do aviso tardio segue a DP-22 (regras 22.1 a 22.3), com configuração própria.

Limitação atual: o carimbo de tempo que a Meta envia no webhook não é lido nem guardado. Até a implementação, o horário confiável pelo WhatsApp é o recebimento no webhook (`message.created_at`).

#### DP-27 — Sessões legadas criadas na confirmação

| # | Regra | Origem |
|---|---|---|
| 27.1 | Não presumir que sessões antigas foram realizadas só porque a data passou | D |
| 27.2 | Preservar integralmente cobranças, pagamentos e comprovantes durante a reclassificação | D |
| 27.3 | Identificar separadamente os registros com desfecho histórico não verificável, sem inventar resultado | D |
| 27.4 | Sessões futuras ou de consultas canceladas, ainda não cobradas, podem ser classificadas como candidatas à anulação; a anulação efetiva depende de migração revisada e autorizada | D |
| 27.5 | Não gerar novas cobranças a partir de sessões legadas sem desfecho comprovado | D |
| 27.6 | A primeira execução é só simulação (`dry-run`), por clínica, com relatório dos registros afetados e comparação dos dados financeiros antes e depois | D |
| 27.7 | Qualquer inconsistência interrompe; a migração efetiva só ocorre depois da revisão do relatório e de autorização específica | D |
| 27.8 | Também não presumir realização porque houve confirmação ou porque existe cobrança; cobranças e pagamentos existentes não podem ser perdidos, duplicados ou alterados pela reclassificação | D (rodada 2) |

Proposta técnica na ADR-0069 (não aprovada):
- Toda sessão legada fica inelegível para cobrança nova desde a primeira migration, sem depender da classificação.
- A classificação só marca; anula as candidatas apenas no `apply` autorizado.
- Nunca muda o estado das consultas nem escreve em cobrança ou pagamento.

Limitações do sistema atual que afetam a DP-27 (ADR-0069, seção 6.5):
- Não há registro de presença.
- `session.completed_at` nunca foi gravado.
- O horário original das remarcações antigas foi sobrescrito.
- Quem pediu e o motivo dos cancelamentos nunca foram registrados.
- O limite de antecedência vigente na época não é recuperável.
- **O sistema não guarda comprovantes:** a regra 27.2 vale para o que existir fora dele e para uma tabela futura (MVP-13).

#### Decisões de 21/10/2026, rodada 5: DP-22 a DP-25 e K11

Decisões de produto do responsável (origem **D**). A especificação continua não aprovada. As propostas técnicas e as dependências estão na ADR-0069, seção 10.1.

| # | Regra | Origem |
|---|---|---|
| 22.1 | A consequência do aviso fora do prazo (cancelamento ou remarcação com menos que o limite) e do aviso tardio é uma **política por clínica**, com as opções `nao_cobrar`, `decisao_humana` (padrão) e `sugerir_cobranca` | D |
| 22.2 | Aviso fora do prazo e aviso tardio usam as mesmas opções, com **configurações independentes** | D |
| 22.3 | A cobrança só é gerada depois de confirmação humana, mesmo com `sugerir_cobranca`, e usa o **valor integral aplicável da sessão**, sem taxa adicional | D |
| 23.1 | O abono é aprovado por `admin` por padrão; `super_admin` nunca aprova abono; o motivo é obrigatório | D |
| 23.2 | O profissional responsável só pode ser habilitado a abonar, nas próprias consultas, **depois** de a restrição de acesso às próprias consultas estar implementada e verificada | D |
| 24.1 | O `admin` pode reverter um abono, com motivo; o caso volta para decisão humana, sem cobrança automática | D |
| 24.2 | A cobrança identifica a falta sem aviso prévio com linguagem neutra, incluindo a data e o valor | D |
| 25.1 | Cancelamento por iniciativa da clínica ou do profissional **não gera cobrança ao paciente** | D |
| 25.2 | Registrar separadamente quem solicitou, quem registrou e o horário; o motivo é opcional | D |
| K11.1 | A IA pede **confirmação explícita** antes de cancelar ou remarcar, identificando a consulta por data, horário e profissional | D |
| K11.2 | A antecedência é calculada a partir da **primeira mensagem** do pedido | D |
| K11.3 | A confirmação precisa chegar antes do início agendado; senão, nada é executado automaticamente e o caso vai para a equipe | D |
| K11.4 | A nova data, na remarcação, também exige confirmação explícita | D |

Dependências que impedem implementar já (nada disso existe no código):
- **Permissão de abono e restrição do terapeuta às próprias consultas:** a opção "admin e profissional responsável" fica bloqueada até a restrição ser implementada e verificada (ADR-0069, achado 7).
- **Valor aplicável:** depende do MVP-02.
- **Datas e tipo na mensagem de cobrança:** dependem do MVP-03 (CB-07). Fora da janela de 24 h do WhatsApp, dependem de modelo aprovado pela Meta (A-07), possivelmente um modelo próprio para falta.
- **Confirmação em duas etapas pela IA:** não foi validada com o modelo real (chamada paga, a autorizar).
- **K2:** continua bloqueador de qualquer liberação com dados de clínica.

#### O que continua dependendo de configuração ou decisão

| Ponto | Situação |
|---|---|
| Política de falta sem aviso por clínica / profissional | Configuração (regra relatada para a clínica do levantamento: cobrar) |
| Limite de antecedência | Configuração (relato: 2 h) |
| Consequência do cancelamento fora do prazo | Configuração por clínica (DP-22): `nao_cobrar`, `decisao_humana` (padrão), `sugerir_cobranca`; cobrança só com confirmação humana, pelo valor integral aplicável |
| Quem aprova abono | Decidido (DP-23): `admin` por padrão, `super_admin` nunca, motivo obrigatório. Profissional só depois da restrição às próprias consultas |
| Reversão de abono; falta identificada na mensagem de cobrança | Decidido (DP-24); a mensagem depende do MVP-03 e, fora da janela de 24 h, de modelo aprovado pela Meta (A-07) |
| Cancelamento por iniciativa da clínica | Decidido (DP-25): sem cobrança ao paciente; quem solicitou, quem registrou e horário registrados à parte |
| Consequência do aviso tardio | Configuração por clínica; sem política, decisão humana (DP-26). Opções definidas pela DP-22, com configuração independente |
| Limite do aviso tardio, papel da IA, horário do aviso | Orientação DP-26 (rodada 2): sem limite final; a IA só registra a comunicação; horário recebido, registrado e alegado separados |
| IA cancelar ou remarcar antes do início | Decidido (K11): só com confirmação explícita do paciente, antes do início |
| Sessões legadas sem desfecho comprovável | Orientação DP-27; migração só com `dry-run` revisado e autorização específica |
| Rollback para versões sem a regra de elegibilidade para cobrança (K2) | **Bloqueador** até as provas (testes das restrições no PostgreSQL 16 e ensaios de deploy, rollback e restauração). A exceção à ADR-0060 foi aprovada em 21/10 só no escopo restrito (ADR-0069, seção 9.4) |
| Prazo para registrar o desfecho e aviso de consultas sem desfecho | Proposta técnica do MVP-01 (sem regra relatada) |

---

## 5. Sessões realizadas, valores e regras de cobrança

| ID | Requisito | Origem | Situação | Evidência |
|---|---|---|---|---|
| CB-01 | Sessão é a unidade que liga agenda e financeiro | D | Parcial | `session` existe e é ligada à cobrança por `billing_session`; mas nasce na confirmação (AT-03) |
| CB-02 | Cobrança nasce por atendimento realizado, conforme as regras da clínica | R, D | Parcial | Cobrança é criada **à mão** pelo administrador, escolhendo sessões (`POST /billings`, tela Financeiro); não há criação conforme política |
| CB-03 | Valor aplicável por clínica, terapeuta, paciente e período, sem valor fixo | D | **Não implementado** | O valor é digitado na criação (`CreateBillingDto.amount`); não há tabela de preço nem vigência |
| CB-04 | Cobrança individual ou consolidada, mantendo a origem por sessão | R, D | Implementado | Uma cobrança liga várias sessões; `UNIQUE(session_id)` impede cobrar a mesma sessão duas vezes |
| CB-05 | Política por sessão, semanal ou mensal, por clínica e por paciente | D | Parcial | `default_billing_policy` e `billing_policy_override` são gravados; **nenhum fluxo os usa** |
| CB-06 | Separar sessão realizada, cobrança criada, enviada, pagamento confirmado e pendência | D | Implementado | Estados próprios: sessão (`Realizada`, `Faturada`, `Recebida`), cobrança (`criada` … `quitada`, `cancelada`), pagamento (`recebido` … `estornado`) |
| CB-07 | Mensagem de cobrança com datas, quantidade, valor unitário, total, Pix, recebedor e pedido de comprovante | R | Parcial | `buildBillingMessage` tem quantidade, unitário, total, Pix e recebedor; **não lista as datas das sessões** |
| CB-08 | Cobrança de atendimento realizado pode ser a primeira mensagem | D | Implementado (envio) | O envio não depende de conversa; fora da janela de 24 h a Meta só entrega modelo aprovado (A-07, não implementado) |
| CB-09 | Pagamento antes ou depois da sessão | R | Parcial | O pagamento pode quitar a cobrança a partir de `criada`; não há pagamento antecipado sem sessão |
| CB-10 | Cobrança não some por falta de resposta | D | Implementado | Estado persiste; atraso calculado pelo vencimento (`Billing.isOverdue`) |
| CB-11 | Correção rastreável; "não editar" a confirmar | C | Parcial | Estorno de pagamento existe; cancelar cobrança existe no domínio, sem rota; edição não existe (lacuna 8, DP-06) |
| CB-12 | Dívida em aberto + pedido de nova sessão: alertar o financeiro; **não bloquear nem liberar automaticamente** | D | **Não implementado** | O agendamento não consulta cobranças. Hoje não bloqueia (correto) e não alerta (falta); pelo WhatsApp a IA reserva o horário sozinha (`agendar-consulta.use-case.ts`, estado `Reservada`) |

---

## 6. Pagamentos, comprovantes, pendências e conciliação

| ID | Requisito | Origem | Situação | Evidência |
|---|---|---|---|---|
| PG-01 | Registrar pagamento (Pix como meio relatado) | R | Implementado | `POST /payments` (listagem em `GET /billings/:id/payments`); `payment.method` |
| PG-02 | Estado "incerto" que exige conferência | R | Parcial | `em_conferencia` existe na máquina de estados, **sem nenhum chamador**; a conciliação é automática por valor (`recebido` → `confirmado` ou `divergente`) |
| PG-03 | Pagamento incerto nunca tratado como confirmado | D | Parcial | Divergência gera aviso `payment_divergent`; o estado incerto manual não existe (PG-02) |
| PG-04 | Comprovante recebido e vinculado ao pagamento | R | **Não implementado** | Não há armazenamento de arquivos (ADR-0013 não implementada); imagem recebida no WhatsApp vira aviso de mídia não lida (A-15) |
| PG-05 | Saldo em aberto por paciente | H | Parcial | Fechamento calcula pendência por paciente, mas só atrás das automações (FM-01) |
| PG-06 | Distinguir data da sessão e data do pagamento | H | Parcial | `payment.created_at` existe; `session.completed_at` nunca é gravado (ADR-0069, achado 1). A data da sessão só pode vir de `appointment.scheduled_at` |
| PG-07 | Quem marcou como pago | H | Parcial | Eventos do pagamento vão para `audit_log`; autor não conferido em todos os caminhos |
| PG-08 | Cartão, dinheiro, boleto, parcelamento | — | Fora do escopo | Não relatados |
| PG-09 | Recibos formais ou fiscais | C | Não verificável | Processo atual não descrito (lacuna 7, DP-13) |

---

## 7. Mensagens e lembretes pelo WhatsApp

| ID | Requisito | Origem | Situação | Evidência |
|---|---|---|---|---|
| MS-01 | Lembrete de consulta no dia, com horário configurável | R, D | **Não implementado** | Não há caso de uso de lembrete de consulta; depende de agendador (A-19) e de modelo aprovado pela Meta (A-07) |
| MS-02 | Reiteração da cobrança (ex.: toda sexta) e mensagem de pendências após ~30 dias, com cadência configurável e limite | R, C | Parcial | Régua D+1/D+7 existe (`executar-regua-inadimplencia`), mas as rotas de automação respondem 500 e a régua lê o estado `atrasada`, que nenhum fluxo alcança; cadência não é configurável |
| MS-03 | Não enviar repetidamente sem limite | D | Implementado (por ausência) | Nenhum envio repetido roda hoje; precisa virar regra explícita quando MS-02 existir |
| MS-04 | Contestação ou caso delicado vai à terapeuta ou à equipe | R | Parcial | Encaminhamento genérico à equipe; sem fluxo de contestação |
| MS-05 | Tom calmo, educado, personalizável por clínica | R, D | Parcial | Texto fixo da IA (`system-prompt.builder.ts`, doc `05-IA/01`); sem configuração por clínica |
| MS-06 | Não enviar só "não há horário": oferecer alternativa ou encaminhar | D | Não verificável | Depende da resposta da IA com o modelo real (chamada paga) |
| MS-07 | Aviso de atendimento automatizado na primeira resposta, com link da página da clínica | DR, D | Não implementado | D-H (diretriz); plano no documento 07 de `12-Privacidade-e-Dados`, etapa 2 |
| MS-08 | Mensagem duplicada após reprocessamento | H | Implementado (proteção) | Chave de idempotência em todo envio; caixa de entrada idempotente (AD-036) |
| MS-09 | Registro de que a mensagem foi enviada e entregue | H | Parcial | `message_log` registra envio e falha; falha de entrega vira aviso (A-08); entrega positiva não é exibida |

---

## 8. Acompanhamento de pacientes sem retorno

| ID | Requisito | Origem | Situação | Evidência |
|---|---|---|---|---|
| FU-01 | Lista de pacientes sem sessão há mais de 30, 60 ou 90 dias | D | **Não implementado** | Estado `EmFollowUp` existe na entidade, sem nenhum uso |
| FU-02 | Follow-up iniciado por orientação da terapeuta, executado em até uma semana | R | Não implementado | — |
| FU-03 | A lista não autoriza envio automático | D | — | Regra a respeitar quando FU-01 existir |

---

## 9. Fechamento financeiro mensal

| ID | Requisito | Origem | Situação | Evidência |
|---|---|---|---|---|
| FM-01 | Resumo do mês: atendimentos realizados, valor aplicado, devido, recebido, pendente e em atraso, sem dupla contagem | R, D | Parcial | `gerar-fechamento-mensal.use-case.ts` calcula total, recebido, pendente e pendência por paciente, mas **não filtra o mês**, só é chamado por `POST /automations/fechamento-mensal/generate` (500) e não tem tela |
| FM-02 | Preços diferentes por período ou paciente no cálculo | D | Não implementado | Depende de CB-03 |
| FM-03 | Indicadores do painel | — | Parcial | `GET /dashboard/summary`: pacientes ativos, cobranças em atraso, total pendente |

---

## 10. Regras configuráveis por clínica e profissional

| Configuração | Situação |
|---|---|
| Fuso da clínica | Implementado (AD-039) |
| Chave Pix e nome do recebedor | Implementado (`PUT /clinic/payment-info`) |
| Política de cobrança padrão, limite de cancelamento, duração padrão | Gravados (`PUT /clinic/policies`); **política e limite sem efeito** |
| Janelas, exceções e duração por terapeuta | Implementado (`/therapists/:id/availability`) |
| Horários fixos por paciente | Implementado (`/recurring-blocks`) |
| Feriados | Respeitados; **sem cadastro** |
| Preços e vigência | Não implementado |
| Cadência de lembretes e cobranças | Não implementado |
| Tom das mensagens | Não implementado |
| URL da página de privacidade da clínica | Não implementado (D-H) |
| Política de falta sem aviso e de cancelamento fora do prazo (seção 4.1) | Não implementado |
| Política de encaixe | Não implementado |

---

## 11. Permissões, privacidade e rastreabilidade

| ID | Requisito | Origem | Situação | Evidência |
|---|---|---|---|---|
| PE-01 | Papéis distintos para secretaria, financeiro e terapeuta | H, C | Parcial | Papéis existentes: `admin`, `therapist`, `super_admin` (`16-Politica-RBAC.md`); financeiro só `admin`; a matriz real da clínica não foi descrita (lacuna 2) |
| PE-02 | Acesso financeiro só a quem precisa | H | Parcial | Rotas de cobrança e pagamento só `admin` |
| PE-03 | Terapeuta vê todos os pacientes da clínica | DR | Implementado (aceito) | D-E pode esperar (A-14) |
| PE-04 | Trilha de quem fez o quê | H | Implementado (ações) | `audit_log`, tela Auditoria; leituras não são registradas (L13) |
| PE-05 | Nada clínico no sistema | D | Implementado (por desenho) | Escopo oficial; nenhum campo clínico |
| PE-06 | A IA não decide nada clínico | D | Implementado (instrução) | Texto fixo da IA encaminha à equipe o que foge do administrativo; não validado com o modelo real |

---

## 12. Contradições e regras ambíguas

1. **Confirmação ≠ realização (código × levantamento).** O código trata a confirmação como realização (AT-03). Consequência: uma consulta confirmada e depois desmarcada já gerou sessão "realizada" e pode ser cobrada. Orientação registrada na seção 4.1 (DP-01).
11. **Remarcação apaga o horário anterior (código × orientação).** `reschedule` sobrescreve a data; a orientação DP-01/DP-04 pede o histórico preservado (AT-13).
2. **Grade horária fixa** contraditória dentro do próprio levantamento (sexta-feira, último horário). Não codificar (AG-10).
3. **Cadência de cobrança:** o levantamento cita "toda sexta" e "após ~30 dias"; a documentação existente (`05-IA/03-Gestao-de-Inadimplencia.md`) e o código usam D+1, D+7, 7 e 40 dias. Qual é política e qual é exemplo? (lacuna 12, DP-08)
4. **Follow-up:** "janela de até uma semana" (prazo para executar o pedido da terapeuta) × "30/60/90 dias" (critério da lista). São coisas diferentes; ambas precisam de definição (DP-10).
5. **"Edição: não" na cobrança** pode se referir à mensagem enviada ou ao registro financeiro (lacuna 8, DP-06).
6. **Política de cobrança gravada sem efeito** (CB-05) e **limite de cancelamento gravado sem efeito** (AT-05): a tela sugere uma regra que o sistema não aplica.
7. **Régua de inadimplência** depende do estado `atrasada`, que nenhum fluxo alcança, enquanto o atraso real é calculado pelo vencimento.
8. **D-G (número compartilhado):** a análise de 21/10 propôs apagar a conversa com confirmação explícita; o levantamento registra a direção contrária do responsável (preservar a conversa, não usar apagamento). A decisão formal continua pendente (DP-17).
9. **D-H:** o levantamento registra a página por clínica como "opção escolhida", mas a decisão formal e o caso da primeira cobrança continuam pendentes (DP-18).
10. **Estados do paciente:** a entidade mistura status administrativo com agenda e financeiro (seção 2).

## 13. Lacunas que não foram inventadas

As lacunas 1 a 15 da seção 13 do levantamento continuam abertas; esta especificação não as preenche. As decisões que elas exigem estão em [`docs/MVP_BACKLOG.md`](../MVP_BACKLOG.md), seção 4.

## 14. O que esta especificação preserva

- D-A (`6d307e0`): a IA recebe no máximo 20 mensagens, contando a atual, das últimas 72 horas.
- D-F revista (`5b67357`): histórico das conversas preservado, sem exclusão automática; 90 dias só para contatos que não viraram pacientes; J-2 e J-4 pendentes.
- ADR-0063: identidade ambígua nunca é resolvida por suposição.
- Correção do teste R5 (`2dd7934`).
- A-14 aberto; nenhum documento declara conformidade com a LGPD.
