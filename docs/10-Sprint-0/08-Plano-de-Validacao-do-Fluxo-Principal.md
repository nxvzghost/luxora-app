# 08 — Plano de Validação do Fluxo Principal

## Objetivo

Fluxo oficial declarado:

```
Paciente → WhatsApp → Webhook → IA → Motor de Decisão → Agenda → Fila → WhatsApp
```

Este documento responde, com evidência de código (não suposição), o que
falta para esse fluxo rodar de ponta a ponta em ambiente real. **Nenhum
código foi escrito, nenhuma migration criada.** É investigação e plano.

## Método

Segui o fluxo literalmente, arquivo por arquivo, a partir de onde uma
mensagem de paciente teria que entrar no sistema até onde uma resposta
teria que sair. Toda afirmação de "existe"/"não existe"/"nunca executado"
foi verificada por leitura direta do código ou por comentário explícito
já deixado pelos próprios autores do módulo.

---

## 1. Fluxograma real, baseado no código atual

```
┌─────────┐
│ Paciente│
└────┬────┘
     │ envia mensagem via WhatsApp
     ▼
┌─────────────────┐
│ Meta/WhatsApp    │
│ Business API     │
└────┬─────────────┘
     │ POST webhook (payload de mensagem)
     ▼
╔═══════════════════════════════════════════╗
║  ①  INEXISTENTE                            ║  ← o fluxo real PARA aqui hoje
║  Nenhuma rota recebe isso. Nenhum          ║
║  Controller, nenhum endpoint, nenhuma      ║
║  verificação de assinatura/challenge.      ║
╚═══════════════════════════════════════════╝
     ┆ (se existisse, precisaria persistir a
     ┆  mensagem recebida — MessageLog hoje só
     ┆  grava mensagens de SAÍDA, ver seção 5)
     ▼
┌──────────────────────────┐
│ ②  ProcessarMensagemUseCase│  implementado e testado em unidade,
│    + IntentActionRouter    │  nunca invocado por nenhum caminho de
│    (IA interpreta intent)  │  produção real (só por testes)
└────┬──────────────────────┘
     │ chama aiProvider.interpretIntent()
     ▼
┌──────────────────────────┐
│ ③  AnthropicAIProvider     │  implementado, NUNCA chamou a API real da
│    (chamada HTTP real à    │  Anthropic (comentário do próprio autor:
│    api.anthropic.com)      │  "NÃO TESTADO CONTRA A API REAL — sem
└────┬──────────────────────┘  rede neste ambiente"). ANTHROPIC_API_KEY
     │ intent = agendar_consulta  vazio em .env — chamada real falharia hoje.
     ▼
┌──────────────────────────┐
│ ④  VerificarDisponibilidade│  implementado, testado, JÁ USADO em
│    UseCase (Motor)         │  produção via AppointmentsController
└────┬──────────────────────┘  (rota HTTP normal). Este pedaço é sólido.
     ▼
┌──────────────────────────┐
│ ⑤  AgendarConsultaUseCase  │  implementado, testado, JÁ USADO em
│    (Agenda)                 │  produção via AppointmentsController.
└────┬──────────────────────┘  Também sólido.
     │
     ▼
╔═══════════════════════════════════════════╗
║  ⑥  INEXISTENTE (para esta ação)           ║
║  AgendarConsultaUseCase NÃO enfileira      ║
║  nenhuma mensagem de confirmação — grep    ║
║  confirma que só billing/lembretes/        ║
║  resumo-de-agenda chamam a fila hoje.      ║
╚═══════════════════════════════════════════╝
     ▼
┌──────────────────────────┐
│ ⑦  MessageQueueProducer    │  implementado, testado em unidade,
│    (BullMQ)                 │  NUNCA rodou contra Redis real
└────┬──────────────────────┘  (comentário do autor no Worker: "código
     ▼                          completo, pendente de validação empírica
┌──────────────────────────┐   desde o Módulo 01").
│ ⑧  MessageQueueWorker      │
└────┬──────────────────────┘
     ▼
┌──────────────────────────┐
│ ⑨  EnviarMensagemUseCase   │  implementado, testado em unidade.
└────┬──────────────────────┘
     ▼
┌──────────────────────────┐
│ ⑩  WhatsAppMessageProvider │  implementado, NUNCA chamou a API real
│    (chamada HTTP real à    │  da Meta (comentário do próprio autor:
│    graph.facebook.com)     │  "NÃO TESTADO CONTRA A API REAL").
└────┬──────────────────────┘
     ▼
┌─────────┐
│ Paciente│  ← nunca alcançado por este caminho ainda
└─────────┘
```

**Achado estrutural, não só de gap:** o desenho acima mistura duas coisas
que talvez não devessem ser a mesma coisa. A fila (BullMQ) hoje serve para
mensagens *proativas/automatizadas* (lembrete, cobrança, resumo de
agenda) — processos que o próprio `docs/02-Arquitetura/09-Filas.md`
explicitamente diz que **não** devem usar fila são operações que exigem
resposta imediata. Uma *resposta conversacional* da IA a uma mensagem
recebida é exatamente esse caso — se ela passar pela fila assíncrona, o
paciente esperaria segundos a mais numa conversa de chat, sem necessidade.
**Isso precisa ser uma decisão explícita antes de implementar**, não uma
dedução automática do desenho atual — ver seção 9.

---

## 2. Todos os componentes envolvidos

| # | Componente | Camada |
|---|---|---|
| 1 | Endpoint de webhook do WhatsApp (entrada) | API — **não existe** |
| 2 | Verificação de assinatura/challenge do Meta | API — **não existe** |
| 3 | Persistência de mensagem recebida (schema + repository) | Domínio/Infra — **não existe** |
| 4 | `ProcessarMensagemUseCase` | Use Case — existe |
| 5 | `IntentActionRouter` | Use Case — existe |
| 6 | `AnthropicAIProvider` (`IAIProvider`) | Infra — existe, nunca chamado de verdade |
| 7 | `VerificarDisponibilidadeUseCase` (Motor) | Use Case — existe, já usado em produção |
| 8 | `AgendarConsultaUseCase` / `ConfirmarConsultaUseCase` / `CancelarConsultaUseCase` | Use Case — existem, já usados em produção |
| 9 | Gatilho "agendamento → mensagem de confirmação" | Use Case — **não existe** |
| 10 | `MessageQueueProducer` (BullMQ) | Infra — existe, nunca validado contra Redis real |
| 11 | `MessageQueueWorker` (BullMQ) | Infra — existe, nunca validado contra Redis real |
| 12 | `EnviarMensagemUseCase` | Use Case — existe |
| 13 | `WhatsAppMessageProvider` | Infra — existe, nunca chamado de verdade |
| 14 | `WhatsAppIntegration` (credencial por Tenant) | Persistência — existe, token em texto plano |
| 15 | `MessageLog` (registro de envio) | Persistência — existe, só cobre saída |
| 16 | `AuditService` (auditoria de cada turno de IA) | Domínio — existe, já usado |

---

## 3. Onde o fluxo começa hoje

**Não começa.** Não há nenhuma porta de entrada real para uma mensagem de
paciente. O único jeito de exercitar `ProcessarMensagemUseCase` hoje é
diretamente por teste automatizado (`test/unit/use-cases/ai/`), chamando o
Use Case com um `conversationHistory` montado manualmente na mão — nunca a
partir de um payload real do WhatsApp.

## 4. Onde ele termina hoje

Nos dois pontos "sólidos" do meio: `VerificarDisponibilidadeUseCase` →
`AgendarConsultaUseCase` funcionam de ponta a ponta **quando acionados
pela rota HTTP normal** (`POST /appointments`, via `AppointmentsController`,
usada por um humano logado ou por uma chamada de teste) — não quando
acionados pelo `IntentActionRouter`, porque nada aciona o
`IntentActionRouter` em produção.

---

## 5. Pontos que ainda não existem (não é "incompleto" — é zero código)

1. **Endpoint de webhook de entrada do WhatsApp.** Nenhuma rota, nenhum Controller.
2. **Verificação do handshake do Meta** (`GET` com `hub.challenge`, exigido pela Meta para ativar um webhook) e **validação de assinatura** (`X-Hub-Signature-256`) de cada `POST` recebido — sem isso, qualquer um poderia forjar uma mensagem de paciente.
3. **Persistência de mensagem recebida.** `MessageLog` hoje só tem `toPhoneNumber`/`body`/`idempotencyKey` de mensagens **enviadas** — não existe coluna de direção (entrada/saída), não existe `fromPhoneNumber`, não existe vínculo com `patientId`. Sem isso, não há de onde vir o `conversationHistory` que `ProcessarMensagemUseCase` exige como entrada.
4. **Método de repositório para reconstruir histórico de conversa** (ex: "últimas N mensagens entre este número e esta clínica") — não existe em nenhum Repository hoje.
5. **Gatilho "agendamento criado → mensagem de confirmação enfileirada/enviada".** `AgendarConsultaUseCase` não dispara nenhuma comunicação de saída.
6. **Decisão de design: resposta conversacional é síncrona (direto no handler do webhook) ou assíncrona (via fila)?** Não decidido — ver seção 1 e 9.
7. **Vínculo `WhatsAppIntegration` → identificação de qual Tenant/clínica recebeu a mensagem.** O webhook da Meta chega num número de telefone (`phoneNumberId`) — é preciso um lookup reverso (`phoneNumberId` → `tenantId`), que não existe hoje (só existe o caminho contrário: Tenant → credencial).

## 6. Pontos que existem mas nunca rodaram em ambiente real

1. **`AnthropicAIProvider`** — chamada HTTP real a `api.anthropic.com` nunca executada; `ANTHROPIC_API_KEY` vazio em `.env`.
2. **`WhatsAppMessageProvider`** — chamada HTTP real a `graph.facebook.com` nunca executada.
3. **`MessageQueueProducer`/`MessageQueueWorker`** — nunca rodaram contra um Redis real (comentário do próprio autor, "mesma pendência desde o Módulo 01").
4. **Ciclo completo de idempotência de 3 camadas** (checagem prévia + constraint única + `jobId` do BullMQ) — cada camada testada isoladamente em unidade, nunca as três em conjunto contra infraestrutura real.

---

## 7. Dependências externas necessárias

| Dependência | Status hoje |
|---|---|
| **WhatsApp Business API (Meta)** | Nenhuma conta de teste configurada neste ambiente; fluxo de conexão (`POST /whatsapp/connect`) existe e funciona tecnicamente, mas nunca foi exercitado com credencial real |
| **Token de verificação do webhook (Meta)** | Não existe variável de ambiente nem conceito no código — precisa ser criado |
| **Assinatura de payload (`X-Hub-Signature-256`)** | Não implementada |
| **Redis** | `.env` aponta para `redis://localhost:6379` — não confirmado se há uma instância rodando neste ambiente; BullMQ nunca conectou de fato |
| **BullMQ** | Biblioteca integrada, filas/worker escritos, nunca executados contra Redis real |
| **Banco (Postgres)** | Real e validado — é a parte mais madura de toda a cadeia |
| **Webhook de saída/entrada** | Só existe o de ENTRADA da Asaas (pagamento) — nenhum webhook de WhatsApp em nenhuma direção além do que a Meta exige |
| **`ANTHROPIC_API_KEY`** | Vazio em `.env` — chamada real falharia imediatamente com erro explícito ("é obrigatório") |
| **Filas** | Só a fila `'messages'` existe; a arquitetura documentada em `09-Filas.md` descreve múltiplas filas especializadas (cobrança, pagamento, lembrete, follow-up, relatório) — só uma foi construída |

---

## 8. Status por etapa

| Etapa do fluxo | Status |
|---|---|
| Paciente envia mensagem no WhatsApp | Depende só da Meta — N/A |
| Webhook recebe a mensagem | **Inexistente** |
| Verificação de assinatura/challenge | **Inexistente** |
| Persistência da mensagem recebida | **Inexistente** (schema não suporta) |
| Reconstrução do histórico de conversa | **Inexistente** |
| IA interpreta intenção (`AnthropicAIProvider`) | **Implementado, nunca executado contra API real** |
| Roteamento de ação (`IntentActionRouter`) | **Implementado e testado**, nunca acionado em produção |
| Motor de Disponibilidade valida horário | **Implementado, testado, já usado em produção** (via rota HTTP humana) |
| Agenda cria o Appointment | **Implementado, testado, já usado em produção** (via rota HTTP humana) |
| Agendamento dispara confirmação | **Inexistente** |
| Enfileiramento da mensagem (BullMQ) | **Implementado, nunca executado contra Redis real** |
| Worker consome a fila | **Implementado, nunca executado contra Redis real** |
| Envio via WhatsApp (`WhatsAppMessageProvider`) | **Implementado, nunca executado contra API real** |
| Paciente recebe a resposta | Depende de tudo acima — hoje, nunca acontece |
| Auditoria de cada turno de IA | **Implementado e testado** — única parte do lado "IA" comprovadamente sólida |

---

## 9. Checklist sequencial de implementação e validação

Ordem pensada para validar a infraestrutura mais barata/arriscada primeiro,
sem depender de conta real do WhatsApp até o final.

**Fase A — Infraestrutura de fila (isolada, sem depender de WhatsApp/IA)**
1. Confirmar Redis disponível no ambiente de desenvolvimento (subir via Docker se preciso).
2. Rodar `MessageQueueProducer.enqueue()` → `MessageQueueWorker` → `EnviarMensagemUseCase` de ponta a ponta contra um `MessageProvider` fake/log (sem WhatsApp real ainda) — provar que a fila em si funciona.
3. Só depois, trocar o `MessageProvider` fake pelo `WhatsAppMessageProvider` real, com uma conta de teste da Meta (WhatsApp Business Platform tem sandbox/número de teste gratuito).

**Fase B — IA (isolada, sem depender de webhook ainda)**
4. Configurar `ANTHROPIC_API_KEY` real (mesmo que de conta de teste/créditos mínimos).
5. Rodar `AnthropicAIProvider.interpretIntent()`/`generateResponse()` manualmente (script ou teste manual) contra a API real, com um `conversationHistory` fabricado — provar que a chamada HTTP e o parsing da resposta funcionam contra o modelo de verdade, não só contra mock.

**Fase C — Modelo de dados para conversa (decisão + schema, antes do webhook)**
6. Decidir o desenho de `MessageLog` (ou uma entidade nova) para suportar direção de mensagem (entrada/saída) e vínculo com paciente/telefone.
7. Decidir a estratégia de lookup reverso `phoneNumberId → tenantId` (é literalmente o único jeito de saber qual clínica recebeu a mensagem, no modelo atual de "cada clínica com seu próprio número").
8. Só então desenhar a migration correspondente (não incluída neste plano — próxima etapa, com aprovação própria).

**Fase D — Webhook de entrada**
9. Desenhar e documentar o contrato do endpoint (verificação `GET`, payload `POST`, validação de assinatura) — a Meta exige HTTPS público, então isso só é testável de verdade com o backend exposto (túnel tipo ngrok em dev, ou ambiente de staging real).
10. Implementar o Controller, escrevendo a mensagem recebida no modelo decidido na Fase C.
11. Conectar o Controller a `ProcessarMensagemUseCase`, passando o histórico reconstruído.

**Fase E — Decisão de latência (síncrono vs. fila)**
12. Decidir explicitamente: a resposta da IA ao paciente sai direto no fluxo do webhook (síncrono) ou é enfileirada? Recomendo síncrono para a resposta conversacional (mesma lógica que `09-Filas.md` já documenta: "operação que exige resposta imediata" não deveria usar fila) — mas é uma decisão de produto/UX, não só técnica, e precisa ser tomada antes de implementar, não depois.
13. Implementar o gatilho "agendamento criado → confirmação" (enfileirada, essa sim — não é conversa em tempo real).

**Fase F — Ponta a ponta com conta de teste real**
14. Conectar uma clínica de teste de verdade ao WhatsApp (`POST /whatsapp/connect` com credencial de sandbox da Meta).
15. Enviar uma mensagem real de um número de teste, observar o ciclo completo até a resposta chegar de volta.
16. Só depois disso, considerar o fluxo "validado" — não antes.

---

## 10. Riscos técnicos antes da primeira execução em produção

1. **Segurança do webhook.** Sem validação de assinatura (`X-Hub-Signature-256`), qualquer requisição forjada poderia acionar `AgendarConsultaUseCase`/`CancelarConsultaUseCase` em nome de um paciente — a única defesa hoje seria a obscuridade da URL, insuficiente.
2. **Custo de IA sem controle real.** `checkCostCeiling()` hoje só *loga um aviso* (RNF-021 é um alerta, não um bloqueio) — em produção real, sem monitoramento ativo desse log, o teto de R$ 0,25/conversa pode ser ultrapassado sem que ninguém perceba a tempo.
3. **Falha silenciosa de fila.** Se Redis cair ou a fila travar, hoje não há alerta — `docs/02-Arquitetura/09-Filas.md` descreve DLQ e monitoramento que não existem na implementação real.
4. **Lookup reverso `phoneNumberId → tenantId` inexistente.** É um requisito de segurança, não só de roteamento — sem ele, uma mensagem recebida não tem como ser atribuída ao Tenant certo, e um erro aqui teria o mesmo peso de uma falha de isolamento multi-tenant.
5. **Decisão de latência não tomada (item 12 do checklist)** pode virar um bug de UX real (resposta demorada) se implementada errado por pressa, em vez de decidida antes.
6. **Nenhuma das 2 chamadas HTTP externas (Anthropic, Meta) tem tratamento de timeout/circuit breaker** — ambos os providers usam `fetch` simples, sem timeout configurado; uma API externa lenta pode travar a requisição inteira sem limite.
7. **Custo de teste real.** Validar contra a API da Meta exige uma conta WhatsApp Business real (mesmo que sandbox) e, possivelmente, número de telefone verificado — não é instantâneo, deve ser iniciado com antecedência em relação à data desejada de "primeira execução em produção".
