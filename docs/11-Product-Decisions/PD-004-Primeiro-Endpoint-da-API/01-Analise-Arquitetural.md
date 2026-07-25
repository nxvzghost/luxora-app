# PD-004 — Qual deve ser o primeiro endpoint oficial da API da Luxora?

## Origem

PD-003 entregou a infraestrutura de autenticação (`TenantApiKey`,
`TenantApiKeyGuard`) sem nenhum endpoint de negócio conectado a ela, por
decisão deliberada — não antecipar superfície pública sem caso de uso
validado (mesma disciplina do PD-005/Account). Esta análise decide **qual
recurso conectar primeiro**. Não implementa nada.

## Método

Investiguei o código real (não a documentação) para saber, de cada
candidato, o que já existe pronto para reutilizar e o que exigiria
trabalho novo. Toda afirmação de "reaproveita" ou "não existe" abaixo foi
verificada por leitura direta do repositório.

## Arquivos analisados

- `apps/backend/src/api/{appointments,patients,billing,audit,communication,automations,subscription}/*.controller.ts`
- `apps/backend/src/use-cases/{appointment,patient,billing,payment,communication,audit,ai}/**/*.ts`
- `apps/backend/src/domain/{patient,appointment,session}/*.entity.ts`
- Busca por `webhook` em todo `src/` (para confirmar existência ou não de webhooks de saída)

## Candidatos

### 1. Agenda (Appointments)

- **Problema resolvido:** permitir que um sistema externo (ERP da clínica, calendário próprio, automação) consulte ou crie agendamentos sem um humano usar a tela da Luxora.
- **Consumidor:** ERP/sistema próprio da clínica, n8n, Power BI (leitura).
- **Valor entregue:** alto — agenda é o dado mais consultado no dia a dia de uma clínica; sincronizar com um sistema externo é o pedido mais óbvio de um cliente Enterprise com equipe/operação já estabelecida.
- **Complexidade: Baixa.** `AppointmentsController` já é um controller fino — `ListarAgendamentosUseCase`, `AgendarConsultaUseCase`, `ConsultarDisponibilidadeUseCase` já existem, já passam pelo Motor de Disponibilidade (regra de negócio vive no Use Case, não no Controller). Expor via API key é literalmente adicionar `TenantApiKeyGuard` como alternativa a `JwtAuthGuard` — nenhuma regra nova.
- **Segurança:** dado agendado é `patientId + therapistId + horário` — não inclui nome/telefone diretamente (esses vêm de Patient). Risco de LGPD baixo-médio (metadados de atendimento, não conteúdo clínico). Escrita (criar agendamento) tem mais superfície de abuso que leitura.
- **Tipo:** leitura e escrita (podem ser liberadas independentemente).
- **Reaproveitamento:** total — zero regra de negócio nova.

### 2. Pacientes (Patients)

- **Problema resolvido:** sincronizar cadastro de pacientes com CRM/ERP externo.
- **Consumidor:** CRM, ERP, sistema próprio.
- **Valor entregue:** alto — mas ver Segurança abaixo.
- **Complexidade: Baixa.** `PatientsController` é igualmente fino; `ListarPacientesUseCase`/`ConsultarPacienteUseCase` já existem, já paginam por cursor.
- **Segurança — achado real:** verifiquei `Patient` (domain entity) e o `PatientsController`: hoje o Paciente **só tem `name`, `phone`, `state`, `billingPolicyOverride`** — nenhum campo clínico (sem prontuário, diagnóstico, anotação de sessão) existe no modelo. Isso reduz o risco de LGPD "dado de saúde sensível" no sentido estrito — mas nome + telefone de uma pessoa em tratamento de saúde mental **já é, por si só, informação que identifica alguém como paciente de uma clínica desse tipo** — o simples fato de constar na lista é sensível, mesmo sem detalhe clínico. Risco: médio-alto por causa do contexto (saúde mental), não pelo volume de campos.
- **Tipo:** leitura e escrita.
- **Reaproveitamento:** total.

### 3. Sessões (Sessions)

- **Problema resolvido:** confirmar/consultar quais sessões efetivamente aconteceram (para faturamento externo, por exemplo).
- **Consumidor:** ERP financeiro, sistema próprio.
- **Valor entregue:** médio — geralmente coberto indiretamente por Agenda + Cobranças.
- **Complexidade: Média.** **Achado real:** não existe nenhum `ListarSessoesUseCase` nem controller para Session — `Session` só é criada internamente por `ConfirmarConsultaUseCase`, nunca consultada isoladamente por API nenhuma hoje, nem a JWT. Expor isso como recurso próprio exige escrever um Use Case novo, não é reaproveitamento puro.
- **Segurança:** mesma natureza de Agenda, risco baixo-médio.
- **Tipo:** leitura (não há motivo de negócio para criar Session via API — ela nasce de uma ação dentro do fluxo de Agenda).
- **Reaproveitamento:** parcial — precisa de Use Case novo (baixo risco de regra, mas não é zero trabalho).

### 4. Financeiro (segmentação/inadimplência)

- **Problema resolvido:** dar visão de saúde financeira da clínica (quem está em atraso, quem é inadimplente) para um BI ou dashboard externo.
- **Consumidor:** Power BI, planilha, sistema próprio de gestão.
- **Valor entregue:** alto para Enterprise (decisão de negócio, não operação do dia a dia).
- **Complexidade: Baixa-Média.** **Achado real:** `ConsultarSegmentacaoFinanceiraUseCase` já existe, já implementa a regra de negócio (limiares de 7/40 dias já confirmados pela liderança) — mas **não está conectado a nenhum controller hoje** (só é usado internamente por `ExecutarReguaInadimplenciaUseCase`, via `automations`, que exige contexto de tenantId no body, não JWT/API key). Precisaria de um endpoint novo (fino), mas zero regra de negócio nova.
- **Segurança:** dado financeiro agregado, sem valor de cobrança individual detalhado por padrão — risco baixo-médio (é uma leitura agregada, não movimentação de dinheiro).
- **Tipo:** leitura.
- **Reaproveitamento:** quase total (Use Case pronto, só falta o Controller).

### 5. Cobranças (Billing) e Pagamentos (Payment)

- **Problema resolvido:** sincronizar cobranças/pagamentos com um ERP financeiro.
- **Consumidor:** ERP financeiro, contabilidade.
- **Valor entregue:** alto — mas é dinheiro de verdade.
- **Complexidade: Baixa (técnica) / Alta (risco).** `BillingController`/`PaymentController` já são finos e reutilizáveis tecnicamente — mas `PaymentController.create()` já tem uma trava de idempotência (RNF-008) pensada para clientes que controlam exatamente uma chamada por vez; abrir isso para automação externa (n8n, Zapier) aumenta a chance de erro de configuração externa criar/estornar pagamento de verdade.
- **Segurança:** **o mais alto risco de todos os candidatos** — é literalmente movimentação financeira (criar cobrança, registrar pagamento, estornar). Um erro de escopo (ex: uma automação mal configurada estornando pagamentos em massa) tem impacto financeiro direto e irreversível.
- **Tipo:** leitura e escrita — a escrita aqui é a mais perigosa de toda a lista.
- **Reaproveitamento:** total tecnicamente, mas "reaproveitar" não é o mesmo que "seguro por padrão" — dinheiro exige mais cautela que reuso de código sozinho justifica.

### 6. Mensagens (WhatsApp/Communication)

- **Problema resolvido:** permitir que um sistema externo dispare mensagens pelo canal da clínica.
- **Consumidor:** n8n, sistema de campanha, CRM.
- **Valor entregue:** médio — depende de a clínica já ter conectado WhatsApp (Módulo 11).
- **Complexidade: Média-Alta.** **Achado real:** `WhatsAppController` só tem `POST /whatsapp/connect` — não existe endpoint de "enviar mensagem avulsa" hoje; `EnviarMensagemUseCase` existe mas é acionado internamente por fluxos automáticos (cobrança, lembrete), não desenhado para receber um destinatário/texto arbitrário de fora.
- **Segurança:** risco real de abuso — expor "enviar mensagem" por API third-party é abrir a identidade de WhatsApp da clínica para spam/uso indevido por uma integração mal configurada, com risco reputacional real para o número da clínica.
- **Tipo:** escrita, majoritariamente.
- **Reaproveitamento:** parcial — exigiria um Use Case novo desenhado para uso externo, hoje não existe.

### 7. Dashboard

- **Problema resolvido:** visão executiva consolidada.
- **Complexidade: N/A — não avaliável hoje.** **Achado real:** não existe absolutamente nada para expor — Módulo 16 (Observabilidade/Dashboard) nunca foi implementado, confirmado em `plan-benefits.ts` e no MODELO.md do CEO. Candidato desqualificado por enquanto: não há Use Case, não há dado agregado pronto.

### 8. Eventos (Audit Log)

- **Problema resolvido:** permitir que um sistema externo reaja a mudanças (ex: "quando uma cobrança for criada, notifique X").
- **Consumidor:** n8n, sistema de auditoria externo.
- **Valor entregue:** médio — mais um recurso técnico de integração do que uma dor de cliente expressa.
- **Complexidade: Baixíssima.** **Achado real:** `AuditLogController` (`GET /audit-log`, hoje só admin via JWT) já existe, pronto, com paginação por cursor — `ConsultarAuditLogUseCase` não precisa de nenhuma mudança.
- **Segurança:** o audit log, por natureza, contém referências a **todo** tipo de dado do Tenant (pagamento, paciente, agenda) no `payload` de cada evento — expor isso por API é, na prática, expor um resumo de tudo o que acontece na clínica. Risco de exposição excessiva é real, mesmo sendo "só leitura".
- **Tipo:** leitura.
- **Reaproveitamento:** total, zero trabalho novo de Use Case.

### 9. Webhooks (saída)

- **Problema resolvido:** notificar sistemas externos em tempo real, sem polling.
- **Achado real:** **não existe nenhuma infraestrutura de webhook de saída no sistema** — busquei "webhook" em todo `src/`; tudo que existe é o webhook de ENTRADA da Asaas (`webhook.controller.ts`, `processar-webhook-assinatura.use-case.ts`), nada que envie eventos da Luxora para fora.
- **Complexidade: Alta.** Exigiria desenhar do zero: modelo de assinatura de webhook por Tenant, fila de entrega, retry, assinatura HMAC do payload, painel de configuração. Não é "conectar um guard a um controller existente" como os outros — é um subsistema novo inteiro.
- **Reaproveitamento:** nenhum.

### 10. IA

- **Problema resolvido:** deixar um sistema externo conversar com o agente de IA da clínica.
- **Achado real:** `ProcessarMensagemUseCase`/`IntentActionRouter` existem, mas foram desenhados para o fluxo WhatsApp-in→WhatsApp-out, com controle de custo por conversa (`AI_COST_CEILING_PER_CONVERSATION`) pensado nesse contexto específico.
- **Complexidade: Alta.** Expor isso a chamadas externas arbitrárias multiplica o vetor de custo (uma automação em loop poderia gerar custo de IA sem limite pensado para esse uso) e o vetor de ação (a IA já pode `AgendarConsulta` sozinha via `IntentActionRouter` — dar a um sistema externo esse mesmo poder sem desenho novo de escopo é arriscado).
- **Reaproveitamento:** parcial, e o que reaproveita foi desenhado com premissas erradas para esse uso.

### Nota sobre "Integrações"

Não é um recurso — é o nome do objetivo geral (a própria API é "a integração"). Não avaliado como candidato independente.

## Ranking

| Endpoint | Valor | Complexidade | Prioridade |
|---|---|---|---|
| Agenda (leitura) | Alto | Baixa | 1 |
| Eventos (Audit Log) | Médio | Baixíssima | 2 |
| Financeiro (segmentação) | Alto | Baixa-Média | 3 |
| Pacientes | Alto | Baixa (técnica) / risco médio-alto (LGPD) | 4 |
| Sessões | Médio | Média | 5 |
| Cobranças/Pagamentos | Alto | Baixa (técnica) / risco alto (dinheiro) | 6 |
| Mensagens | Médio | Média-Alta | 7 |
| IA | Médio | Alta | 8 |
| Webhooks (saída) | Alto (a médio prazo) | Alta | 9 |
| Dashboard | — | N/A (não existe) | Desqualificado |

## Recomendação

**Agenda, começando só por leitura** (`GET /appointments`, já existente
tecnicamente) deve ser o primeiro endpoint oficial da API, por:

1. **Maior valor por menor risco de toda a lista.** É o dado mais óbvio que um cliente Enterprise pediria para sincronizar com um sistema próprio, e ler agenda não move dinheiro nem expõe conteúdo clínico — só `patientId`/`therapistId`/horário/estado.
2. **Reaproveitamento total, comprovado no código** — `ListarAgendamentosUseCase` já existe, já filtra por tenant via RLS, já não tem regra de negócio nenhuma pendente. Conectar `TenantApiKeyGuard` é literalmente adicionar o guard ao controller existente — não há Use Case novo, não há decisão de domínio nova.
3. **Prova o conceito da API pública com o menor blast radius possível.** Se algo estiver errado no desenho da autenticação/autorização (algo que só um uso real revela), o pior cenário de um bug em leitura de agenda é vazamento de horários — não perda de dinheiro, não vazamento de identidade clínica em massa, não spam em nome da clínica.

**Por que os demais devem esperar:**
- **Eventos** teria complexidade ainda menor, mas entrega menos valor de produto direto — é mais insumo de automação (n8n) do que resposta a uma dor de cliente Enterprise específica, e o payload do audit log expõe demais para ser um bom "primeiro" endpoint (risco de over-exposure antes de existir prática de uso real).
- **Financeiro** é o 2º candidato natural — mas depende de escrever um Controller novo (mesmo que fino), então tem uma fração a mais de trabalho e superfície nova que Agenda não tem.
- **Pacientes** tem valor alto mas risco de LGPD desproporcional para ser o primeiro teste da superfície pública — melhor validar o modelo de autenticação/autorização com um dado de menor sensibilidade antes.
- **Cobranças/Pagamentos** — dinheiro nunca deveria ser o primeiro teste de uma superfície de API nova, mesmo tecnicamente pronta.
- **Sessões, Mensagens, IA, Webhooks** exigem trabalho novo real (Use Case, subsistema ou redesenho de escopo) — não fazem sentido antes de validar o primeiro caso mais simples.
- **Dashboard** não pode ser exposto — não existe.

## Riscos

- Mesmo só leitura, expor Agenda via API key significa que uma chave vazada permite ver a agenda inteira da clínica — mitigação já existente (chave revogável via regeneração, reavaliação de plano a cada request) é suficiente para um primeiro passo, mas vale reforçar ao cliente que a chave deve ser tratada como segredo.
- Nenhuma decisão de rate limiting foi tomada (explicitamente fora do escopo desta análise) — um endpoint de leitura sem rate limit pode ser usado para scraping intensivo por engano de configuração externa.

## Trade-offs

- Começar só por leitura entrega menos valor imediato do que leitura+escrita, mas reduz drasticamente o risco de uma automação externa mal configurada criar/cancelar agendamentos reais.
- Escolher o candidato de menor risco (não o de maior valor absoluto) como primeiro atrasa a entrega do que provavelmente é mais pedido por um cliente Enterprise (Pacientes, Cobranças) — aceitável, porque o objetivo desta fase é validar a superfície, não maximizar valor de dia 1.

## Próximos passos sugeridos (ordem de prioridade)

1. Validar com um cliente Enterprise real (ou o time comercial) se "consultar agenda por API" é de fato a integração mais pedida — esta análise é técnica, não substitui validação de mercado.
2. Se confirmado: implementar `GET /appointments` sob `TenantApiKeyGuard`, como tarefa própria, com plano de implementação e aprovação antes de codificar (mesmo processo de sempre).
3. Só depois de um primeiro endpoint em produção e validado, revisitar Financeiro/Eventos como 2º e 3º.
4. Cobranças e Pacientes só depois de haver prática real de operação da API (rate limiting, observação de uso, resposta a incidente) — não antes.
