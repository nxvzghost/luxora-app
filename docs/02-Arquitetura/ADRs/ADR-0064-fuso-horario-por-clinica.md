# ADR-0064 — Fuso horário por clínica e vencimento pelo dia civil da clínica

**Status:** APROVADA — decisão de produto de 8 de outubro de 2026. **Implementação pendente** (AD-039), **necessária antes do piloto de produção**; nenhuma regra temporal foi alterada.
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

Nenhuma regra temporal de produção foi alterada: o corte do atraso continua em UTC e o motor de disponibilidade continua lendo o fuso do processo. Até a AD-039 ser executada, **subir o sistema em contêiner desloca a agenda em três horas** — por isso ela é pré-requisito do piloto. Os testes de ponta a ponta continuam fixando `America/Sao_Paulo` no backend de teste.

## Documentos relacionados

- [ADR-0062](./ADR-0062-fechamento-dos-testes.md) — levantamento e medição; [ADR-0061](./ADR-0061-painel-operavel.md) — regra de atraso vigente; ADR-0040 — motor de disponibilidade; ADR-0060 — imagens e deploy
- `docs/PLANO_DE_EXECUCAO.md` — AD-039 (Epic 14)
- `docs/04-API/01-Contratos-REST.md` — campo `overdue`
