# AUTOMACOES_AGENDADOR — Como as automações deverão ser executadas

**Status:** Revisão — Tarefa 04 da auditoria de 04/10/2026. Registra o que existe, o que o agendador precisa e o que impede a execução hoje. **Nenhuma funcionalidade foi criada nem alterada.** Em 12/10/2026 (Tarefa 07, fase 1) o diagnóstico foi refeito com medições novas e ganhou opções e uma recomendação — seção "Diagnóstico de 12/10/2026", no fim. **Continua sem implementação: aguarda a decisão do responsável pelo produto.**
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

## Diagnóstico de 12/10/2026 (Tarefa 07, fase 1)

Refeito no código atual, já com o fuso por clínica (AD-039). **Nada neste fluxo foi alterado**: as medições usaram uma sonda temporária, apagada em seguida, com a fila substituída por uma lista em memória. Nenhuma chamada externa.

### 1. O motivo técnico exato

Medido pelo HTTP real, com a chave certa, nas quatro rotas — com o corpo completo e válido e com o corpo vazio, o resultado é o mesmo:

| Rota | Resposta | Onde o erro nasce |
|---|---|---|
| `agenda-summary/send` | 500 | `TenantContext.tenantId` (`src/shared/tenant-context.ts:37`) |
| `agenda-summary/resend` | 500 | idem |
| `inadimplencia/execute` | 500 | idem |
| `fechamento-mensal/generate` | 500 | idem |

Nas quatro, o caminho é `PrismaService.forTenant()` → `validatedTenantId()` → `TenantContext.tenantId`, que lança `TenantContext acessado antes de ser inicializado`. O `TenantContext` é de escopo de requisição e só é preenchido em dois lugares do código HTTP: `JwtAuthGuard` e `TenantApiKeyGuard`. `AutomationApiKeyGuard` só compara a chave — não sabe de clínica. O `tenantId` do corpo é entregue ao Caso de Uso como argumento, mas os repositórios não o leem: perguntam ao `TenantContext`, e é ele que define `app.tenant_id` para a RLS. A primeira leitura de qualquer repositório falha, antes de qualquer regra de negócio.

Dois detalhes que a medição acrescentou:

- o corpo dessas rotas é um tipo inline, não uma classe de DTO: o `ValidationPipe` global não valida nada nelas;
- `fechamento-mensal/generate` **não pede clínica nenhuma** no contrato. Não é só o contexto que falta: a rota nunca soube para quem gerar.

### 2. O que acontece se a clínica for preenchida a partir do `tenantId` do corpo (medido)

Sonda com um guard de teste que copia o `tenantId` do corpo para o `TenantContext` — a opção 1(a) da tabela acima, sem tocar o código de produção:

| Chamada | Resposta | Leitura |
|---|---|---|
| `agenda-summary/send`, `resend` | 201 `enqueued` | A rotina roda de ponta a ponta; a mensagem é enfileirada para a clínica certa, com a data de amanhã no calendário dela |
| `inadimplencia/execute` | 201 `{ d1: 1, d7: 0, d40Signaled: 0 }` | Idem; o lembrete de D+1 é enfileirado para o telefone do paciente |
| `fechamento-mensal/generate` **com** `tenantId` | 201, com o fechamento | Funciona, mas o contrato de hoje não tem esse campo |
| `fechamento-mensal/generate` como o contrato é hoje | 500 | Continua quebrada: precisa passar a identificar a clínica |
| A mesma chave, só trocando o `tenantId` para o de outra clínica | 201 — executa a rotina da outra clínica | **Uma única chave comanda todas as clínicas.** É o risco do achado F2, agora medido |
| `tenantId` da clínica B com o terapeuta da clínica A | 404 | A RLS segura: o dado de uma clínica não vaza para a rotina de outra |
| `tenantId` malformado | 500 (`tenantId em formato inválido, recusando executar query`) | Recusado antes de chegar ao banco, mas como erro interno; deveria ser 400 |
| `tenantId` de clínica que não existe | 201, com zeros | "Sucesso" para ninguém — um erro de digitação no agendador passaria despercebido |

Conclusão da medição: a opção 1(a) faz três das quatro rotas funcionarem com uma mudança pequena, e mantém intacto o problema de segurança.

### 3. De onde deve vir a identidade da clínica

| Opção | Como | A favor | Contra |
|---|---|---|---|
| **A. Do corpo, validada** | O guard de automação valida o `tenantId` (formato e existência) e preenche o `TenantContext` | Menor mudança; medida acima | Uma chave vale para todas as clínicas; quem a tiver executa a rotina de qualquer uma. Contraria a regra escrita no próprio `TenantContext` ("o tenantId nunca vem de body"). O agendador precisa conhecer os ids |
| **B. De uma chave por clínica** | As rotas passam a usar o `TenantApiKeyGuard` (PD-003), que já deriva a clínica da chave | A clínica deixa de ser dado de entrada; uma chave vazada alcança uma clínica só | Hoje esse guard só libera planos com acesso à API (Business/Enterprise); o agendador passa a guardar uma chave por clínica; cada clínica nova exige provisionar a chave |
| **C. De lugar nenhum fora do backend** | Uma rotina interna percorre as clínicas e abre um contexto por clínica, como os workers das filas já fazem (`ContextIdFactory` + `tenantContext.set`, em `whatsapp-inbound-queue.worker.ts` e `message-queue.worker.ts`) | Nenhuma identidade de clínica entra por requisição: fecha o F2 de vez. Reaproveita um mecanismo que já roda em produção | Exige a enumeração (item 4) e deixa de permitir "rodar só para esta clínica" por chamada externa — se isso for necessário, vira um parâmetro de operação, não de rotina |

### 4. Quem deve enumerar clínicas e terapeutas

Só o backend pode. A ADR-0021 proíbe o n8n de ler o banco, e uma lista mantida à mão dentro de um workflow envelhece no primeiro terapeuta novo. Dois fatos do código pesam aqui:

- **Não existe leitura entre clínicas hoje.** A RLS tem só duas exceções, estreitas e nomeadas (`auth_lookup_by_email` para o login e `api_key_lookup_by_hash` para a chave por clínica). Listar as clínicas ativas pede uma terceira, igualmente estreita (por exemplo, só o id das clínicas com assinatura ativa), com teste crítico próprio. É mudança de segurança, não detalhe.
- **O telefone do terapeuta já está no cadastro** (`therapist.phone`, opcional), mas as rotas o exigem no corpo. O agendador não deveria saber telefone de ninguém. Falta decidir o que acontece com o terapeuta sem telefone cadastrado.

### 5. Qual componente deve agendar a execução

| Opção | O que é | A favor | Contra |
|---|---|---|---|
| **n8n auto-hospedado** | O previsto na ADR-0021 | Bom para fluxos com vários passos e integrações | Mais um serviço para subir, proteger, fazer backup e monitorar — para disparar quatro chamadas. Nada dele está versionado ou provisionado |
| **Cron externo** | `cron` do host, ou o agendador do provedor, chamando as rotas com a chave | Trivial; nenhum serviço novo | Se o backend estiver fora do ar no minuto do disparo, **a execução se perde** — e a régua não recupera dia perdido (o gatilho é por igualdade: `daysOverdue === 1`, `7`, `40`). Falha silenciosa, se ninguém monitorar o cron |
| **Agendador dentro do backend** | Jobs repetidos do BullMQ, sobre o Redis e os workers que já existem | Nenhum serviço novo. O job fica guardado no Redis: se o backend estiver fora do ar na hora, **roda quando ele voltar**. Repetição, retenção e encerramento gracioso já estão configurados para as filas. Com mais de uma instância, o BullMQ entrega o job a uma só | Diverge do desenho "n8n executa" da ADR-0021 (pede uma ADR nova, ou a atualização dela). Precisa de alerta quando um job falha de vez |

### 6. Alternativas compatíveis com a arquitetura atual

| Caminho | Identidade | Enumeração | Agendador | Esforço | Risco que fica |
|---|---|---|---|---|---|
| **1. Mínimo** | A (corpo) | Lista à mão no agendador | Cron externo ou n8n | Pequeno | F2 aberto; lista manual; dia perdido se o backend cair na hora |
| **2. Varredura interna, gatilho externo** | C | Backend | Cron externo: uma chamada por rotina, sem clínica no corpo | Médio | Dia perdido se o backend cair na hora; a chave ainda dispara a rotina (mas não escolhe clínica) |
| **3. Varredura e agendamento internos** | C | Backend | BullMQ | Médio | Atualizar a ADR-0021; alerta de falha por construir |

### Recomendação (para aprovação — nada foi implementado)

**Caminho 3 para o piloto**, com o 2 como alternativa se a preferência for manter o agendamento fora do backend:

1. a clínica **nunca** vem do corpo — a rotina percorre as clínicas por dentro (opção C);
2. a enumeração é do backend, com uma exceção de RLS nova e estreita, coberta por teste crítico de isolamento;
3. o disparo é um job repetido do BullMQ, que não perde o dia se o backend estiver fora do ar na hora — o que importa para a régua;
4. as quatro rotas HTTP deixam de ser o caminho de produção: ou são removidas, ou ficam como gatilho manual "para todas as clínicas", sem `tenantId` no corpo;
5. o n8n fica para quando existir um fluxo com mais passos, como este documento já dizia.

O caminho 1 **não é recomendado nem para o piloto**: é o que resolve mais rápido e o único que deixa uma chave com poder sobre todas as clínicas.

### Decisões que são do responsável pelo produto

| # | Decisão | Por que não é técnica |
|---|---|---|
| D1 | A clínica pode vir do corpo da chamada (opção A), de uma chave por clínica (B) ou só de dentro do backend (C)? | É a fronteira de segurança entre clínicas |
| D2 | O backend pode ganhar uma leitura entre clínicas para listar as ativas? Com que critério (assinatura ativa, canal de WhatsApp conectado)? | Abre uma exceção nova na RLS |
| D3 | n8n, cron externo ou agendador interno? | Muda o que precisa ser operado e a ADR-0021 |
| D4 | A que horas roda cada rotina, e isso é por clínica? Os documentos falam em "horário configurável por clínica" (sugestão: resumo às 20h); não existe essa configuração. Com a AD-039, a hora tem de ser a da clínica | Regra de produto |
| D5 | A régua deve recuperar um dia perdido (hoje não recupera: o gatilho é por igualdade)? | Muda quando o paciente recebe lembrete |
| D6 | O telefone do terapeuta vem do cadastro? E o terapeuta sem telefone? | Regra de produto |
| D7 | O piloto usa resumo de agenda, régua e fechamento por agendador? Se não usar, este item deixa de ser bloqueador do piloto | Escopo do piloto |

Enquanto essas decisões não vierem, as quatro rotas continuam respondendo 500 e o `todo` de `automations-scheduler-contract.test.ts` continua registrado.

## Documentos relacionados

- [ADR-0021](../02-Arquitetura/ADRs/ADR-0021.md) — fronteira Motor Operacional ↔ n8n.
- `docs/ARCHITECTURE_AUDIT_REPORT.md` (F2) e `docs/SPRINT_4_EXECUTION_PLAN.md` (item 2.2).
- [DEPLOY_RUNBOOK.md](DEPLOY_RUNBOOK.md).
