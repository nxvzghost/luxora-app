# AUTOMACOES_AGENDADOR — Como as automações deverão ser executadas

**Status:** Revisão — Tarefa 04 da auditoria de 04/10/2026. Registra o que existe, o que o agendador precisa e o que impede a execução hoje. **Nenhuma funcionalidade foi criada nem alterada.**
**Decisão de arquitetura em vigor:** [ADR-0021](../02-Arquitetura/ADRs/ADR-0021.md) — o Motor Operacional decide, o n8n só executa.

## Conclusão

Nenhum agendador — n8n, cron ou qualquer outro — consegue executar as automações hoje. O bloqueio está na aplicação, não na infraestrutura: com a chave correta, as quatro rotas respondem **500**. Subir um n8n antes de resolver isso não entrega nada.

Há três decisões abertas, todas de produto ou de segurança, e por isso fora desta tarefa. Estão no fim do documento.

## O que existe

Quatro rotas em `/api/v1/automations`, protegidas por `AutomationApiKeyGuard` (cabeçalho `X-Automation-Api-Key`, comparado com `AUTOMATION_API_KEY`; obrigatória em produção):

| Rota | Corpo | O que faz |
|---|---|---|
| `POST agenda-summary/send` | `tenantId`, `therapistId`, `therapistPhone`, `correlationId?` | Enfileira o resumo da agenda do dia para o terapeuta |
| `POST agenda-summary/resend` | os mesmos | Reenvia a agenda depois de uma alteração |
| `POST inadimplencia/execute` | `tenantId`, `correlationId?` | Régua de inadimplência: lembretes de D+1 e D+7, sinalização em D+40 |
| `POST fechamento-mensal/generate` | nenhum | Gera o fechamento mensal |

## O que foi medido

Chamadas reais, pelo HTTP, contra a imagem de produção numa pilha descartável (banco vazio, sem canal de WhatsApp — nada é enviado):

| Chamada | Resposta |
|---|---|
| Sem a chave, ou com chave errada | 401 `UNAUTHORIZED` |
| Com a chave certa, em qualquer das quatro rotas | **500** — `TenantContext acessado antes de ser inicializado` |

**Causa.** O `tenantId` chega no corpo e é repassado ao Caso de Uso como argumento, mas quem define a clínica das consultas ao banco é o `TenantContext`, preenchido só pelo guard de autenticação de usuário. Nas rotas de automação esse guard não roda, e nada mais o preenche. A primeira consulta falha.

Isso nunca apareceu porque os únicos testes dessas rotas são unitários (o guard, e o teste de aceite da ADR-0021). O teste novo `test/critical/automations-scheduler-contract.test.ts` cobre a autenticação pelo HTTP real e deixa a execução registrada como pendência (`todo`).

É o mesmo ponto do achado **F2** de `docs/ARCHITECTURE_AUDIT_REPORT.md` (o `tenantId` vem de um corpo sem validação) e do item 2.2 de `docs/SPRINT_4_EXECUTION_PLAN.md`, ainda não executado.

## O que o agendador precisa, quando a execução funcionar

**Cadência**, segundo os documentos de produto:

| Rotina | Quando | Fonte |
|---|---|---|
| Resumo da agenda | Diário, em horário configurável por clínica (sugestão: fim do expediente, 20h) | `05-IA/02-Rotina-de-Controle-de-Agenda.md` |
| Reenvio da agenda | Por evento: quando a agenda muda depois do envio | idem |
| Régua de inadimplência | Diária, **sem falhar um dia** | `05-IA/03-Gestao-de-Inadimplencia.md` |
| Fechamento mensal | Último dia do mês ou primeiro dia útil, configurável por clínica | `06-UX/05-Fluxo-Fechamento-Mensal.md` |

**Chamada:** `POST` com `Content-Type: application/json` e `X-Automation-Api-Key`. Enviar um `correlationId` por execução, para ligar a chamada aos logs e às mensagens enfileiradas.

**Repetição em caso de falha:**

| Rotina | Repetir é seguro? | Por quê |
|---|---|---|
| Resumo da agenda | Sim | A chave da mensagem é por terapeuta e dia: a segunda chamada no mesmo dia não envia de novo |
| Régua de inadimplência | Sim | A chave é por cobrança e estágio (`-d1`, `-d7`) |
| Reenvio da agenda | **Não** | Cada chamada gera uma mensagem nova, de propósito. Repetir às cegas duplica o envio |
| Fechamento mensal | Não verificado | Não foi analisado nesta revisão |

**A régua não recupera dia perdido.** O gatilho é por igualdade (`daysOverdue === 1`, `7`, `40`). Se o agendador falhar num dia, quem completou D+1 nesse dia nunca recebe o lembrete. A limitação está documentada no próprio Caso de Uso. O agendador precisa, no mínimo, alertar quando uma execução diária falha.

## O que falta para o agendador existir

1. **A execução precisa funcionar** (o 500 acima).
2. **O agendador não tem como saber quem chamar.** As rotas pedem `tenantId`, `therapistId` e `therapistPhone`, e não existe rota, com a chave de automação, que liste clínicas e terapeutas. A ADR-0021 proíbe o n8n de ler o banco. Sem isso, cada clínica e cada terapeuta teriam de ser cadastrados à mão dentro do workflow.
3. **Não há horário por clínica.** Os documentos falam em horário "configurável por clínica", mas nenhuma configuração desse tipo existe no código.
4. **Nada está versionado nem provisionado.** Não há workflow de n8n no repositório nem serviço de agendador na pilha de homologação. O n8n é software livre e pode ser auto-hospedado sem licença paga, mas é mais um serviço para operar.

## Decisões necessárias

| # | Decisão | Opções | Observação |
|---|---|---|---|
| 1 | Como uma chamada de automação identifica a clínica | (a) o guard de automação inicializa o `TenantContext` a partir do `tenantId` validado; (b) uma chave por clínica, como previsto em PD-003 | (a) mantém uma chave única com poder sobre todas as clínicas — é o risco do achado F2. (b) é mais seguro e mais trabalho |
| 2 | Quem enumera clínicas e terapeutas | (a) uma rota de listagem para o agendador; (b) rotas "para todas as clínicas", em que o Motor Operacional faz a varredura; (c) cadastro manual no workflow | (b) é a que mais respeita a ADR-0021: o agendador só dispara, não decide para quem |
| 3 | Qual agendador | (a) n8n auto-hospedado, como previsto; (b) um cron simples chamando as rotas | Com a opção (b) da decisão 2, um cron de três linhas basta para o que existe hoje; o n8n se justifica quando houver fluxos com mais passos |

**Recomendação:** decidir 1 e 2 antes de provisionar qualquer agendador. São mudanças de código no backend, com teste crítico de isolamento entre clínicas, e pertencem a uma tarefa própria.

## Documentos relacionados

- [ADR-0021](../02-Arquitetura/ADRs/ADR-0021.md) — fronteira Motor Operacional ↔ n8n.
- `docs/ARCHITECTURE_AUDIT_REPORT.md` (F2) e `docs/SPRINT_4_EXECUTION_PLAN.md` (item 2.2).
- [DEPLOY_RUNBOOK.md](DEPLOY_RUNBOOK.md).
