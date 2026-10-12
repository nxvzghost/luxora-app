# ADR-0064 — Fuso horário por clínica e vencimento pelo dia civil da clínica

**Status:** APROVADA — decisão de produto de 8 de outubro de 2026. **IMPLEMENTADA em 12 de outubro de 2026 (AD-039), localmente: sem push e sem execução no CI remoto** — ver "Implementação", abaixo. Dois dos "Pontos a confirmar" continuam pedindo decisão (o que o painel mostra; quem pode alterar o fuso).
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

Executada na fase 1 da Tarefa 07 ([ADR-0065](./ADR-0065-preparacao-para-o-piloto-fase-1.md)). Local: sem push, sem deploy.

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
| 2 | O que o painel mostra | **Aberto.** O painel continua mostrando os horários no fuso do navegador de quem o usa. Para uma clínica cujos usuários estão no fuso dela, é o mesmo; para quem acessa de outro fuso, não |
| 3 | Quem pode alterar o fuso | **Aberto.** `GET /clinic` devolve `timeZone` (só leitura); nenhuma rota o altera — as de edição da clínica recusam o campo. Até a decisão, o fuso só muda direto no banco. Falta definir também o que acontece com as consultas já marcadas quando ele muda (elas são instantes: a hora de parede se deslocaria) |
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

## Documentos relacionados

- [ADR-0062](./ADR-0062-fechamento-dos-testes.md) — levantamento e medição; [ADR-0061](./ADR-0061-painel-operavel.md) — regra de atraso vigente; ADR-0040 — motor de disponibilidade; ADR-0060 — imagens e deploy
- `docs/PLANO_DE_EXECUCAO.md` — AD-039 (Epic 14)
- `docs/04-API/01-Contratos-REST.md` — campo `overdue`
