# PD-009 — Pipeline Conversacional: Análise Arquitetural

## Objetivo

Definir o **pipeline oficial** — a sequência ordenada de etapas, e o
padrão arquitetural que as organiza — desde o recebimento de uma
mensagem do WhatsApp até a resposta chegar ao paciente. Constrói em cima
de três decisões já tomadas, sem repeti-las:

- **PD-007** já decidiu *como* identificar o Tenant a partir do número.
- **PD-008** já decidiu *o que é* uma `Conversation`/`Message` como domínio.
- `docs/10-Sprint-0/08-Plano-de-Validacao-do-Fluxo-Principal.md` já
  mapeou, componente por componente, o que existe e o que falta.

Esta análise responde o que aquelas três ainda não respondiam: **em que
ordem as etapas acontecem, quem é dono de cada uma, e qual padrão
arquitetural organiza tudo isso.** Nenhum código, schema, migration ou
entidade foi alterado.

## Método

Não repeti a investigação de arquivo por arquivo já feita no plano de
validação — reaproveitei aquela evidência como base e investiguei
especificamente o que faltava para responder *ordem* e *padrão*: como o
WhatsApp Cloud API se comporta em relação a confirmação de webhook, e como
o `MessageQueueProducer` hoje enfileira (ou não) por prioridade.

---

## 1. Fluxo atual (evidência já estabelecida, resumida aqui)

Confirmado em `08-Plano-de-Validacao-do-Fluxo-Principal.md`: o fluxo
**não roda de ponta a ponta hoje.** Os trechos que existem e já
funcionam (Motor de Disponibilidade → Agenda, via `IntentActionRouter`)
só são alcançados por chamada direta de teste — nunca por uma mensagem
real, porque não há webhook de entrada.

## 2. Gargalos

1. **Nenhuma etapa de recepção existe** (PD-007 resolve *quem identifica*
   o Tenant, mas o Controller que recebe o payload em si ainda não foi
   desenhado nem aqui).
2. **Nenhuma etapa de persistência de conversa existe** (PD-008 decidiu o
   modelo, não construiu).
3. **As duas chamadas de rede mais lentas do pipeline (interpretar
   intenção + gerar resposta, ambas via `AnthropicAIProvider`) nunca
   rodaram contra a API real** — não sabemos hoje, com certeza empírica,
   quanto tempo cada uma leva.
4. **Envio da resposta (`WhatsAppMessageProvider`) também nunca rodou
   contra a API real.**

## 3. Responsabilidades (quem já é dono do quê)

| Responsabilidade | Dono hoje | Status |
|---|---|---|
| Identificar o Tenant a partir do número | Decidido no PD-007 | Arquitetura pronta, não implementada |
| Guardar a conversa/mensagem | Decidido no PD-008 (`Conversation`/`Message`) | Arquitetura pronta, não implementada |
| Interpretar intenção | `AnthropicAIProvider.interpretIntent` | Implementado, nunca testado contra API real |
| Decidir se uma ação deve ser tomada | `IntentActionRouter` | Implementado e testado |
| Executar a ação (Motor, Agenda, Billing) | Use Cases de cada domínio | Implementado, testado, já em produção via rota HTTP humana |
| Gerar a resposta em linguagem natural | `AnthropicAIProvider.generateResponse` | Implementado, nunca testado contra API real |
| Enviar a resposta | `EnviarMensagemUseCase` + `WhatsAppMessageProvider` | Implementado, nunca testado contra API real |
| Auditar cada turno | `AuditService` (via `AiInteractionAuditEvent`, hoje fora do padrão — ver PD-008) | Implementado |

## 4. Pontos sem definição (o que esta análise decide)

1. **Ordem exata das etapas** — não formalizada em nenhum documento até agora.
2. **Padrão arquitetural que organiza a sequência** — orquestração simples? pipeline de handlers? orientado a eventos? Não decidido.
3. **Onde (se em algum lugar) o processamento deixa de ser síncrono** — o plano de validação já tinha levantado essa pergunta (Fase E) sem responder.
4. **Requisito de confirmação rápida do webhook** — a WhatsApp Cloud API (Meta) exige que o endpoint de webhook confirme recebimento rapidamente, ou a Meta reenvia o mesmo payload por entender que falhou. Isso não está documentado em nenhum lugar do repositório da Luxora hoje — é uma restrição externa da plataforma, que só será confirmada com precisão empírica na Fase F do plano de validação (teste com conta real). Tratada aqui como restrição conhecida, não como número exato.

---

## Ordem recomendada das etapas (o pipeline oficial)

```
1. Recepção do webhook (Controller) — responde rápido, não processa ainda
2. Verificação de assinatura/challenge (Meta)
3. Identificação do Tenant (PD-007 — lookup por phoneNumberId)
4. Carregar ou iniciar a Conversation (PD-008)
5. Persistir a Message de entrada
   ── daqui pra frente, ver "Ponto de desacoplamento", abaixo ──
6. Interpretar intenção (IAIProvider.interpretIntent)
7. Rotear ação (IntentActionRouter → Motor/Agenda/Billing)
8. Gerar resposta em linguagem natural (IAIProvider.generateResponse)
9. Persistir a Message de saída
10. Enviar a resposta (WhatsAppMessageProvider)
11. Auditoria (a cada mutação, não como etapa separada no fim)
```

Onde entra cada peça pedida: **WhatsApp** nas etapas 1–2 (entrada) e 10
(saída); **IA** nas etapas 6 e 8; **regras de negócio** na etapa 7
(delegada aos Use Cases de cada domínio, nunca reimplementada aqui);
**persistência** nas etapas 5 e 9 (a própria `Conversation`); **envio da
resposta** na etapa 10.

---

## 5. Alternativas arquiteturais (como organizar essa sequência)

### Alternativa A — Orquestração sequencial num Use Case (extensão do que já existe)

Um único Use Case coordena as etapas em ordem, delegando cada uma a um
colaborador já existente (`ConversationRepository`, `IAIProvider`,
`IntentActionRouter`, `MessageProvider`) — a mesma estrutura de
`ProcessarMensagemUseCase` hoje, só estendida para incluir a
`Conversation`.

- **Vantagens:** é literalmente o padrão que 100% do resto do sistema já usa (nenhum outro fluxo da Luxora — Agenda, Billing, Paciente — usa outra coisa que não Use Cases sequenciais simples); mínima mudança sobre o que já existe e já está testado; fácil de ler, seguir e depurar (um método, uma ordem linear).
- **Desvantagens:** um Use Case com várias responsabilidades coordenadas (mesmo que delegadas) — aceitável no volume de etapas de hoje, pode exigir quebra em métodos privados se crescer muito.
- **Complexidade:** baixa. **Risco:** baixo.

### Alternativa B — Pipeline explícito de Handlers (Chain of Responsibility)

Cada etapa vira uma classe com uma interface comum (`handle(context)`),
encadeadas numa lista.

- **Vantagens:** cada etapa testável isoladamente; fácil reordenar/adicionar sem tocar nas outras; abriria caminho para reaproveitar etapas comuns entre canais futuros (voz, e-mail — ver PD-008).
- **Desvantagens:** introduz um padrão que **nenhum outro fluxo da Luxora usa hoje** — quebra consistência arquitetural sem necessidade comprovada, mesmo argumento já usado para rejeitar abstrações antecipadas em PD-002(agora PD-005)/PD-004/PD-008. Canais futuros não são prioridade hoje (só WhatsApp, por decisão de PD-001).
- **Complexidade:** média-alta, sem necessidade comprovada. **Risco:** médio (ineditismo).

### Alternativa C — Pipeline orientado a eventos (cada etapa assíncrona via fila)

Cada etapa emite um evento, a próxima é um handler de fila separado.

- **Vantagens:** desacopla completamente cada etapa; resiliente a falha parcial; escala melhor sob volume alto.
- **Desvantagens:** para uma *conversa*, cada salto de fila adiciona latência real — o próprio `docs/02-Arquitetura/09-Filas.md` já diz que operação de resposta imediata não deveria usar fila; `MessageQueueWorker` nunca rodou contra Redis real (achado do plano de validação) — construir um pipeline inteiro sobre infraestrutura ainda não comprovada é o oposto de "validar antes de expandir", que é literalmente o objetivo desta fase do projeto.
- **Complexidade:** alta. **Risco:** alto. **Descartada** pelo mesmo motivo já usado no plano de validação (Fase E) e em toda a disciplina de YAGNI desta sessão.

---

## 6. Recomendação oficial

**Alternativa A — orquestração sequencial**, com **um único ponto de
desacoplamento assíncrono**, não mais que isso: entre a etapa 1
(confirmar recebimento do webhook) e as etapas 3–11 (processamento real).

**Por quê:** a WhatsApp Cloud API é uma plataforma de terceiro com
requisito de confirmação rápida de webhook — se o Controller esperar as
duas chamadas de IA (nunca medidas contra a API real) mais a chamada de
envio antes de responder à Meta, corre o risco real de a Meta considerar
o webhook como falho e reenviar o mesmo payload, causando processamento
duplicado. Isso não é o mesmo argumento já rejeitado na Alternativa C —
lá, a fila envolveria *toda* a conversa (rejeitado); aqui, é só o
suficiente para: **responder 200 à Meta primeiro, processar depois**,
reaproveitando a fila BullMQ **que já existe** (nenhuma infraestrutura
nova) — mesmo `MessageQueueProducer`/`MessageQueueWorker` já
desenhados, só usados aqui pela primeira vez para o próprio recebimento,
não só para envio de lembrete/cobrança.

**O que isso NÃO muda:** a demora percebida pelo paciente é a mesma —
dominada pelo tempo real das chamadas de IA, que a fila não acelera. O
que muda é a garantia de que a Meta nunca reenvia o mesmo webhook por
achar que falhou.

---

## 7. Impacto, se aprovada

- **Módulos afetados:** Módulo 11 (Comunicação) ganha a definição de pipeline que faltava; Módulo 12 (IA) passa a ser chamado dentro de uma etapa clara, não um Use Case solto.
- **Documentos que dependem/precisam ser atualizados quando implementado:** `docs/10-Sprint-0/08-Plano-de-Validacao-do-Fluxo-Principal.md` (a Fase E, hoje uma pergunta em aberto, ganha resposta); `docs/02-Arquitetura/09-Filas.md` (passaria a listar "confirmação de webhook" como um uso legítimo adicional da fila `messages`, sem ser o mesmo caso já rejeitado de "conversa inteira na fila").
- **PDs impactados:** nenhum PD anterior precisa ser revisto — esta decisão é aditiva sobre PD-007/PD-008, não os contradiz.

---

## Relatório executivo

1. **Arquivos analisados:** toda a evidência já reunida em `08-Plano-de-Validacao-do-Fluxo-Principal.md` (reaproveitada, não reinvestigada), mais `message-queue.producer.ts` (confirmar ausência de prioridade de fila) e `docs/02-Arquitetura/09-Filas.md` (confirmar a regra já documentada sobre "operação de resposta imediata não deveria usar fila").
2. **Evidências:** nenhuma etapa de recepção/persistência de conversa existe (confirmado em PD-007/PD-008); as duas chamadas de IA e a chamada de envio nunca rodaram contra API real; a WhatsApp Cloud API tem requisito de confirmação rápida de webhook — restrição de plataforma conhecida, ainda não documentada nos próprios docs da Luxora, a validar empiricamente na Fase F do plano de validação.
3. **Alternativas avaliadas:** orquestração sequencial (recomendada); pipeline de handlers explícito (descartado — ineditismo sem necessidade comprovada); pipeline orientado a eventos (descartado — latência incompatível com conversa em tempo real, mesmo argumento já usado no plano de validação).
4. **Recomendação:** orquestração sequencial, com confirmação rápida do webhook desacoplada do processamento via a fila BullMQ já existente — não uma infraestrutura nova, um segundo uso da mesma.
5. **Trade-offs:** nenhuma redução na latência percebida pelo paciente (dominada pelas chamadas de IA); ganho é exclusivamente de confiabilidade frente à Meta.
6. **Riscos:** o requisito exato de timeout da Meta não está confirmado empiricamente — só será validado na Fase F (conta de teste real); se as chamadas de IA se mostrarem muito mais lentas que o esperado, a arquitetura recomendada já comporta isso (é justamente o motivo do desacoplamento), mas o *quanto* de folga isso dá só se sabe testando de verdade.
7. **Próximos passos:** com esta decisão aprovada, o pipeline está definido o suficiente para que o desenho técnico do Controller de webhook (Fase D do plano de validação) e da persistência de `Conversation`/`Message` (próxima etapa natural do PD-008) possam começar — cada um como sua própria etapa de aprovação, ainda sem código.
