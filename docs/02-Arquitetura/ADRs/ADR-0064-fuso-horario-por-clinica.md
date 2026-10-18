# ADR-0064 — Fuso horário por clínica e vencimento pelo dia civil da clínica

**Status:** APROVADA — decisão de produto de 8 de outubro de 2026. **IMPLEMENTADA em 12 de outubro de 2026 (AD-039) e publicada em 13 de outubro de 2026, com o CI remoto verde (execução 38479017674)** — ver "Implementação", abaixo. Os dois "Pontos a confirmar" que tinham ficado abertos — o que o painel mostra e quem pode alterar o fuso — foram decididos e implementados no mesmo dia e publicados com o restante: ver "Alteração do fuso pelo painel", abaixo.
**Origem:** complemento da Tarefa 06 da auditoria. O levantamento que motivou a decisão — o que o código faz hoje com data e hora, com a medição no contêiner — está na [ADR-0062](./ADR-0062-fechamento-dos-testes.md) ("Data e fuso horário") e não é repetido aqui.
**Antecedentes:** o modelo de domínio já lista "Fuso horário" como atributo da Clínica (`docs/01-Domain/01-Entidades.md.txt`); a estratégia de fuso consta como dívida nunca implementada desde o diagnóstico do Sprint 0 (`docs/10-Sprint-0/07-Diagnostico-Maturidade-MVP.md`). Não havia decisão aprovada nem item de backlog até aqui.

## Decisão

1. O fuso horário é **configurável por clínica**. O padrão inicial é `America/Sao_Paulo`.
2. Os **horários de agenda são interpretados no fuso da clínica**.
3. O **vencimento respeita o dia civil da clínica**: a cobrança continua em dia durante todo o dia do vencimento, e o atraso começa à **meia-noite do dia seguinte**, no fuso da clínica.
4. Nada disso pode **depender do fuso do contêiner** ou do processo.

## O que precisa mudar no código

| Hoje | Decidido |
|---|---|
| O motor de disponibilidade lê as janelas ("09:00–18:00") no fuso do processo. No contêiner, que roda em UTC, "09:00" é 06:00 de Brasília (medido). | As janelas valem no fuso da clínica, com o processo em qualquer fuso. |
| "Amanhã" nos resumos de agenda e os horários escritos ao paciente nas respostas do WhatsApp seguem o fuso do processo. | Seguem o fuso da clínica. |
| Em atraso quando `vencimento <= agora − 24h`, com o vencimento gravado em meia-noite UTC: a cobrança passa a constar em atraso às 21h de Brasília do próprio dia do vencimento. | Em atraso a partir de 00:00 do dia seguinte ao vencimento, no fuso da clínica (03:00 UTC para `America/Sao_Paulo`). |
| Nenhuma imagem ou compose de `infra/` define `TZ`; o comportamento certo na máquina de desenvolvimento vem do fuso da máquina. | Nenhuma dependência de `TZ`. |
| A clínica não tem campo de fuso (`clinic_settings` não tem a coluna). | Campo por clínica, com `America/Sao_Paulo` como padrão. |

A regra de atraso da Tarefa 05 (ADR-0061) **mantém o princípio** — o dia do vencimento ainda está em dia — e **troca o relógio**: do dia em UTC para o dia civil da clínica. A mudança alcança, juntas, `Billing.isOverdue()`, `Billing.daysOverdue()`, a contagem de `GET /dashboard/summary` e o campo `overdue` das cobranças; as duas telas têm de continuar concordando. A régua de inadimplência e a segmentação financeira, que leem só o estado `Atrasada`, são outra decisão e não entram aqui.

## Critérios de aceite (AD-039)

- Com o processo em UTC e uma clínica em `America/Sao_Paulo`, a janela "09:00" oferece horários às 09:00 de Brasília.
- As suítes dão o mesmo resultado com o processo em UTC e em `America/Sao_Paulo` **sem** fixar o fuso do backend nos testes de ponta a ponta (hoje eles o fixam).
- Uma cobrança que vence no dia D não consta em atraso às 23:59 de D e consta às 00:00 de D+1, no fuso da clínica; o Dashboard e o Financeiro mostram a mesma contagem.
- Uma clínica configurada em outro fuso vê os próprios horários e o próprio dia, sem afetar as demais.
- Clínicas existentes recebem o padrão `America/Sao_Paulo` sem intervenção manual.

## Pontos a confirmar na implementação

A decisão não trata destes pontos, e nenhum foi resolvido aqui:

1. **Como o vencimento é representado.** Hoje é um instante (meia-noite UTC da data digitada); o que ele significa é uma data sem hora. Tratar como data civil evita reinterpretar as cobranças já gravadas.
2. **O que o painel mostra.** Os horários das consultas aparecem hoje no fuso do navegador de quem usa o painel. Falta definir se passam a aparecer sempre no fuso da clínica.
3. **Quem pode alterar o fuso** e o que acontece com as consultas já marcadas quando ele muda.
4. **Horário de verão.** `America/Sao_Paulo` não tem desde 2019; outros fusos têm. O cálculo precisa de uma biblioteca ou API que conheça as regras de cada fuso — escolha técnica a registrar na implementação.
5. **Terapeuta em fuso diferente do da clínica.** Não faz parte desta decisão.
6. **Data da primeira cobrança da assinatura** (hoje a data em UTC no momento da criação) — é da assinatura da clínica com a Luxora, não da agenda; avaliar se segue a mesma regra.

A implementação exige uma migration (a coluna do fuso). Ela não foi criada nem executada nesta etapa.

## O que não muda agora

> **Texto de 08/10/2026, mantido como registro. Superado em 12/10/2026 pela seção "Implementação".**

Nenhuma regra temporal de produção foi alterada: o corte do atraso continua em UTC e o motor de disponibilidade continua lendo o fuso do processo. Até a AD-039 ser executada, **subir o sistema em contêiner desloca a agenda em três horas** — por isso ela é pré-requisito do piloto. Os testes de ponta a ponta continuam fixando `America/Sao_Paulo` no backend de teste.

## Implementação (12/10/2026 — AD-039)

Executada na fase 1 da Tarefa 07 ([ADR-0065](./ADR-0065-preparacao-para-o-piloto-fase-1.md)). Publicada em 13/10/2026 (`b00fa17..1facf1f`); sem deploy.

### O que mudou

| Decidido | Como ficou |
|---|---|
| Fuso configurável por clínica, padrão `America/Sao_Paulo` | Coluna `clinic_settings.time_zone` (nome da base IANA), obrigatória, com esse padrão. **Antes de criar a coluna foi conferido que não existia campo de fuso** — nem no schema, nem em nenhuma das 19 migrations. Uma migration aditiva, gerada pelo próprio Prisma; as clínicas que já existiam receberam o padrão sem intervenção |
| Agenda no fuso da clínica | As janelas ("09:00–18:00"), o dia da semana e "o mesmo dia" são os da clínica. O calendário de disponibilidade carrega o fuso dela, lido junto com ele na mesma transação |
| Vencimento pelo dia civil da clínica | Em dia durante todo o dia do vencimento; em atraso a partir de 00:00 do dia seguinte, no fuso da clínica |
| Nada dependente do contêiner | Nenhum método local de `Date` (`getHours`, `setHours`, `getDay`, `toDateString`…) resta nas regras de agenda, de resumo e de cobrança de pacientes; o único que sobra no backend é o cálculo do próximo ciclo da assinatura da clínica (ponto 6, não alterado). Nenhuma imagem define `TZ`, e nenhuma precisa — o contêiner roda em UTC (medido) |
| "Amanhã" e os horários escritos ao paciente | "Amanhã" do resumo de agenda é o dia seguinte no calendário da clínica; os horários do resumo e os que a secretária escreve ao paciente (consulta marcada, remarcada, horários livres) saem na hora de lá |

### Semântica exata do atraso

- **O vencimento é uma data, sem hora.** A API a recebe como `AAAA-MM-DD` e a guarda como a meia-noite UTC desse dia; a data que vale é a do instante gravado lido em UTC. É a escolha sugerida no ponto 1 de "Pontos a confirmar": nenhuma cobrança já gravada precisou ser reinterpretada, e nenhuma coluna mudou de tipo. Um vencimento gravado com hora vale pela data.
- **Dias de atraso** (`Billing.daysOverdue`): dias do calendário da clínica entre o vencimento e hoje — 0 até o fim do dia do vencimento, 1 a partir da meia-noite seguinte na clínica. Antes: blocos de 24 h contados da meia-noite UTC.
- **Em atraso** (`Billing.isOverdue`, estados `Criada`, `Enviada`, `Visualizada`, `Pendente`): quando há 1 dia de atraso ou mais. `Atrasada` continua em atraso pelo estado; `Quitada`, `Cancelada`, `Negociada` e `Escalada`, como antes.
- **Contagem no banco** (`GET /dashboard/summary`): o vencimento gravado é anterior à meia-noite UTC do dia que é "hoje" na clínica. É a mesma regra da entidade escrita como filtro; as duas dão a mesma resposta instante a instante (conferido contra Postgres).
- **Exemplo**, clínica em São Paulo, cobrança que vence em 10/08: às 21:00 do dia 10 (o corte antigo, meia-noite UTC) **está em dia**; às 23:59:59 do dia 10 **está em dia**; às 00:00 do dia 11 (03:00 UTC) **está em atraso**. No mesmo instante, uma clínica em Manaus ainda está no dia 10.

**O que mudou junto, e só isso:** `Billing.isOverdue()`, `Billing.daysOverdue()`, a contagem de `GET /dashboard/summary`, o campo `overdue` das cobranças e — porque leem `daysOverdue()` — a segmentação financeira, a régua de inadimplência e o fechamento mensal, que passam a contar os dias pelo calendário da clínica. **O que não mudou:** quais cobranças a régua e a segmentação leem (só o estado `Atrasada`), os limiares (7 e 40 dias), os estados e as transições. Nenhum contrato financeiro ganhou ou perdeu campo.

### Escolhas técnicas

- **Sem biblioteca nova.** O cálculo usa o `Intl` do próprio Node, que carrega a base de fusos da IANA (`domain/shared/time-zone.ts`).
- **Horário de verão** (ponto 4): a hora de parede que não existe no dia da mudança vale o instante equivalente depois do salto; a que existe duas vezes vale a primeira — a mesma regra que a proposta Temporal do JavaScript chama de "compatible". `America/Sao_Paulo` não tem horário de verão desde 2019, e a regra de cada ano é a daquele ano.
- **Fuso inválido gravado no banco é erro**, com o valor na mensagem — nunca é trocado pelo padrão em silêncio. Clínica sem linha de configuração recebe o padrão.
- **Quem lê o fuso:** os repositórios que montam algo que depende dele (o calendário, a clínica) leem na mesma transação; os Casos de Uso que precisam dele dependem de uma porta (`ClinicTimeZoneReader`).

### Pontos a confirmar — situação

| # | Ponto | Situação |
|---|---|---|
| 1 | Como o vencimento é representado | **Resolvido** como a ADR sugeria: data civil, lida do valor já gravado |
| 2 | O que o painel mostra | **Resolvido em 12/10/2026:** os horários aparecem, e são lidos, no fuso da clínica — ver "Alteração do fuso pelo painel" |
| 3 | Quem pode alterar o fuso | **Resolvido em 12/10/2026:** o administrador da clínica, por `PUT /clinic/time-zone`, com registro na auditoria. As consultas já marcadas não são reescritas: continuam no mesmo instante e passam a ser lidas na hora do novo fuso — idem |
| 4 | Horário de verão | **Resolvido** (acima) |
| 5 | Terapeuta em fuso diferente do da clínica | Fora da decisão; não tratado |
| 6 | Data da primeira cobrança da assinatura | **Não alterada** — continua a data em UTC no momento da criação. É da assinatura da clínica com a Luxora, não da agenda |

### Limitações registradas

- **Agendamento recorrente e horário fixo** avançam em blocos de 24 h × intervalo. Em um fuso com horário de verão, a hora de parede se deslocaria uma hora na mudança. Nenhum fuso do Brasil tem horário de verão hoje; a correção fica para quando houver uma clínica fora dele.
- **A régua de inadimplência e a segmentação** continuam lendo só o estado `Atrasada` (decisão anterior, fora desta ADR).
- **O horário de execução das automações** terá de ser avaliado na hora de cada clínica — entra nas decisões do agendador (`docs/07-Infra/AUTOMACOES_AGENDADOR.md`).

### Critérios de aceite — onde cada um está provado

| Critério | Prova |
|---|---|
| Processo em UTC, clínica em São Paulo: a janela "09:00" oferece horários às 09:00 de lá | `test/critical/clinic-time-zone-ad039.test.ts`, pelas rotas reais; `test/unit/domain/availability/availability-calendar.time-zone.test.ts` |
| Mesmo resultado com o processo em UTC e em `America/Sao_Paulo`, **sem** fixar o fuso do backend nos testes de ponta a ponta | As três suítes do backend rodadas com o processo em UTC, `Asia/Tokyo` e `America/Sao_Paulo`, com o mesmo resultado; `apps/e2e/support/env.ts` deixou de definir `TZ` |
| Vence em D: não consta em atraso às 23:59 de D, consta às 00:00 de D+1, no fuso da clínica; Dashboard e Financeiro iguais | `test/unit/domain/billing/billing.entity.test.ts` (relógio controlado), `test/integration/database/prisma-clinic-time-zone.test.ts` (o filtro do banco, contra Postgres) e o teste crítico (as duas telas, pela API) |
| Clínica em outro fuso vê os próprios horários e o próprio dia, sem afetar as demais | Teste crítico, com clínicas em São Paulo, Manaus, Kiritimati e Pago Pago no mesmo banco |
| Clínicas existentes recebem o padrão sem intervenção | Teste de integração (coluna, padrão, nenhuma linha sem fuso) |

Seis mutações que recolocam uma regra antiga (hora lida no fuso do processo; corte em UTC; dias em blocos de 24 h; dias percorridos em UTC; janela convertida em UTC; repositório ignorando o fuso da clínica) foram aplicadas uma a uma: todas fazem os testes falhar.

## Alteração do fuso pelo painel (12/10/2026)

Fecha os pontos 2 e 3 de "Pontos a confirmar". Publicado em 13/10/2026, com o CI remoto verde; sem deploy.

### Decisão

Do responsável pelo produto, no fechamento da fase 1 da Tarefa 07:

1. O fuso em vigor aparece em Configurações, para todos os usuários da clínica.
2. Só um **administrador da própria clínica** o altera.
3. Só entra um identificador da base IANA.
4. A alteração fica registrada na auditoria que já existe.
5. Mudar o fuso muda a interpretação **futura** da agenda e das datas de vencimento. **Nenhum instante já gravado é reescrito**, e nenhum dado financeiro é alterado.
6. O painel mostra os horários no fuso da clínica, não no do navegador.

### Como ficou

| Decidido | Como ficou |
|---|---|
| Só o administrador altera | `PUT /clinic/time-zone`, corpo `{ "timeZone": "America/Manaus" }`, com `@Roles('admin')`. Terapeuta: 403; sem sessão: 401. É uma rota própria, e não um campo de `PATCH /clinic`: trocar o fuso desloca a hora de parede de tudo o que já está marcado e não deve acontecer de carona em outra edição. `PATCH /clinic` e `PUT /clinic/policies` continuam recusando o campo |
| Só identificador IANA | Entra só o **nome exato** de uma zona, como o `Intl` a lista (`Intl.supportedValuesOf('timeZone')`). O `Intl` aceita, para calcular, formas que não são o nome de um lugar — maiúsculas trocadas (`america/sao_paulo`), apelidos (`UTC`, `GMT`) e, em versões novas do Node, deslocamentos fixos (`-03:00`). Nenhuma é gravada: 400. A leitura continua com a conferência de antes (fuso inválido no banco é erro, nunca é trocado pelo padrão) |
| Registro na auditoria | Evento `ClinicaAtualizada`, com `action: "fuso_alterado"`, `fromTimeZone` e `toTimeZone`, o usuário que trocou e a clínica. **A troca e o registro são gravados na mesma transação** (`UnitOfWork`): ou os dois, ou nenhum. Pedir o fuso que já está em vigor responde 200 e não grava nem registra nada |
| Duas trocas ao mesmo tempo | A configuração da clínica é travada durante a troca (`SELECT … FOR UPDATE`): acontecem uma depois da outra, e o "fuso anterior" de cada registro é o que a troca anterior gravou. O fuso é gravado por um método próprio do repositório; a gravação geral da clínica (nome, políticas, PIX) não o grava — uma edição feita a partir de uma leitura anterior não tem como recolocar o fuso antigo |
| Nenhuma migration | A coluna já existia. Nenhuma tabela mudou |
| O painel no fuso da clínica | `apps/frontend/lib/clinic-time.ts` — as mesmas regras de `domain/shared/time-zone.ts`, com o `Intl` do navegador; nenhum método local de `Date`. Agenda ("hoje", os sete dias pedidos à API, cada horário), escolha de dia e horário para marcar e remarcar, exceções e horários fixos (o que se digita é hora de parede da clínica), prévia de horários livres, data da sessão no Financeiro e hora das notificações. As janelas de atendimento já eram horas de parede; o vencimento é uma data sem hora e não mudou |
| Quando o fuso da clínica não é o do computador | A Agenda e a Disponibilidade dizem em que fuso os horários estão. Se o painel não consegue ler o fuso (ou o navegador não o conhece), usa o do computador **e avisa** — não mostra em silêncio uma hora que pode não ser a da clínica |

### O que acontece com o que já está gravado

| Dado | O que ele é | Depois da troca |
|---|---|---|
| Consulta marcada | Um instante | O mesmo instante. Passa a ser lida na hora do novo fuso: a das 09:00 de São Paulo aparece às 08:00 de Manaus. Não é remarcada |
| Exceção de disponibilidade (folga, férias) | Dois instantes | Os mesmos instantes, lidos na hora do novo fuso |
| Horário fixo de paciente | Um instante de partida, repetido em blocos de 24 h | O mesmo instante de partida |
| Janela de atendimento ("09:00–18:00") | Hora de parede, sem fuso | A mesma hora de parede, agora no novo fuso: a agenda passa a abrir às 09:00 de lá |
| Vencimento de cobrança | Uma data, sem hora | A mesma data. O dia passa a virar em outro momento: a cobrança pode constar em atraso algumas horas antes ou depois |
| Valor, estado, pagamento | — | Nada é regravado (conferido: valor, estado, vencimento e data de alteração da cobrança iguais antes e depois) |

A tela diz isso ao administrador antes de confirmar, e pede que a agenda seja conferida depois.

### Limitações registradas

- **A troca não remarca nada e não avisa ninguém.** Uma clínica com agenda cheia que mude de fuso fica com as consultas antigas em outra hora do relógio; conferir é da clínica. A mudança é para corrigir o cadastro ou acompanhar uma mudança real de lugar.
- **`UTC` e deslocamentos fixos não são aceitos** como fuso de clínica.
- **A lista de Configurações vem do navegador** (os fusos do Brasil, e depois os demais que ele conhece). Quem valida é a API: um nome que o navegador ofereça e o servidor não conheça é recusado com 400.
- **`GET /audit-log` não devolve a data de cada registro** (já era assim): a hora da troca está gravada, mas a trilha lida pelo painel mostra quem, de qual fuso e para qual — não quando.
- **Os testes de ponta a ponta rodam em um navegador** (Chromium), com ele em Brasília.

### Provas

| O que | Onde |
|---|---|
| Quem pode alterar (sem sessão, terapeuta, administrador); catorze corpos inválidos; isolamento entre duas clínicas, inclusive com o id de outra no corpo | `test/critical/clinic-time-zone-change.test.ts`; `test/critical/rbac-mutating-routes.test.ts` |
| Registro na auditoria, lido também por `GET /audit-log`; mesma transação (o `xmin` da configuração e o do registro são iguais); o mesmo fuso não grava nem registra | idem |
| Oito trocas simultâneas: a trilha é uma corrente sem buraco, e o fuso gravado é o da última | idem |
| Agenda antes e depois da troca; a consulta já marcada continua no mesmo instante | idem |
| Cobrança em dia em Pago Pago e em atraso em Kiritimati, sem que um campo dela seja regravado; fronteira "vence hoje / venceu ontem" no fuso em vigor | idem. As fronteiras de meia-noite com o relógio controlado continuam em `test/unit/domain/billing/billing.entity.test.ts` e `test/integration/database/prisma-clinic-time-zone.test.ts` |
| Regras de data e hora do painel, com todo instante em UTC e o fuso dito no teste | `apps/frontend/test/lib/clinic-time.test.ts` |
| Telas com a clínica em Kiritimati (UTC+14), um fuso em que nenhuma máquina que roda a suíte está; aviso; falha na leitura do fuso | `apps/frontend/test/app/fuso-da-clinica.test.tsx` |
| Seção de Configurações, para administrador e terapeuta | `apps/frontend/test/app/configuracoes.test.tsx` |
| Pela tela, com o navegador em Brasília: troca para Manaus, agenda na hora de Manaus, consulta antiga às 07:00 | `apps/e2e/tests/fuso.spec.ts` |

Quinze mutações, uma regra desligada por vez e o arquivo restaurado em seguida — todas fazem os testes falhar: rota sem a exigência de administrador; validação que aceita o que o `Intl` aceita; troca sem a trava; troca sem registro; registro sem o fuso anterior e o novo; fuso que não é gravado; o mesmo fuso gravando de novo; e, no painel, formatação que ignora o fuso, cálculo no fuso do computador, telas que não leem o fuso da clínica, terapeuta com o formulário de troca, dia escolhido lido no fuso do computador, exceção digitada lida no fuso do computador, troca sem confirmação e falha de leitura sem aviso.

Regressão no commit `9e5bdce`, com o processo em UTC, em `Asia/Tokyo` e em `America/Sao_Paulo`, com o mesmo resultado nos três: 1190 testes unitários do backend, 56 de integração, 567 críticos (1 pulado e 1 `todo`, os mesmos de antes) e 274 do painel; 32 de 32 de ponta a ponta, com o backend em UTC e o navegador em Brasília. **As imagens Docker e o ensaio de deploy não foram refeitos** — ver a [ADR-0065](./ADR-0065-preparacao-para-o-piloto-fase-1.md), "Fechamento do escopo local".

## Documentos relacionados

- [ADR-0062](./ADR-0062-fechamento-dos-testes.md) — levantamento e medição; [ADR-0061](./ADR-0061-painel-operavel.md) — regra de atraso vigente; ADR-0040 — motor de disponibilidade; ADR-0060 — imagens e deploy
- `docs/PLANO_DE_EXECUCAO.md` — AD-039 (Epic 14)
- `docs/04-API/01-Contratos-REST.md` — campo `overdue` e `PUT /clinic/time-zone`; `docs/02-Arquitetura/16-Politica-RBAC.md` — papel exigido
