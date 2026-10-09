# ADR-0063 — Identidade pelo WhatsApp: cadastro novo só com nome completo e confirmação, número novo só vinculado com aprovação da clínica, número compartilhado nunca resolvido por suposição

**Status:** APROVADA — decisão de produto de 8 de outubro de 2026, confirmada e detalhada em 9 de outubro de 2026 (ver "Histórico"). **Implementação pendente** (AD-037 e AD-038): nenhum comportamento foi alterado e os defeitos descritos aqui **continuam abertos**.
**Origem:** complemento da Tarefa 06 da auditoria. Os defeitos que motivaram a decisão estão descritos, com a evidência, na [ADR-0062](./ADR-0062-fechamento-dos-testes.md) ("O que o fluxo de Contact faz de verdade") e não são repetidos aqui.
**Relação com as anteriores:** aplica ao fluxo real o princípio da ADR-0046 (ambiguidade resolvida antes de qualquer ação clínica) e completa as ADR-0045 e ADR-0055, que deixaram em aberto de onde vem o nome do contato e como um vínculo é confirmado.

## Decisão

### 1. Identificação e cadastro (AD-037)

- Um número previamente vinculado a **exatamente um** paciente pode continuar sendo usado para reconhecer esse paciente, **sem pedir o nome completo a cada mensagem**.
- O nome de perfil do WhatsApp **não é prova de identidade**.
- A **criação de um paciente novo** exige **nome completo e confirmação explícita**.

### 2. Identidade ambígua (AD-038)

- Se um número corresponder a **dois ou mais pacientes**, as ações que dependem dessa identidade são **interrompidas**, e o sistema **pede esclarecimento ou encaminha a um humano**.
- **Nunca** escolhe automaticamente o cadastro mais antigo.
- **Nunca** revela dados de pacientes durante a resolução da ambiguidade.

### 3. Vinculação de número novo (AD-038)

- Vincular um número novo a um cadastro existente exige **aprovação explícita de um usuário autorizado da clínica, pelo painel, depois de verificação adequada**.
- A confirmação do interlocutor, feita pelo próprio número novo, **não basta**.
- **Nenhuma informação do paciente** é revelada antes da aprovação.

Vale para os três casos a regra de 8 de outubro: enquanto a identidade estiver pendente, nenhuma ação clínica ou financeira que dependa dela é executada.

## O que precisa mudar no código

A coluna "Hoje" traz o que o teste no fluxo real mostrou; onde diz "lido no código", a afirmação vem da leitura do código e ainda não tem teste. **Nenhuma destas linhas foi corrigida.**

| Hoje | Decidido | Backlog |
|---|---|---|
| Paciente cadastrado, sozinho no número: é reconhecido pelo telefone que a clínica gravou e atendido sem que o nome seja pedido. | Continua assim (decisão 1). Nada a mudar. | — |
| O nome de perfil do WhatsApp não é lido em lugar nenhum (lido no código). | Continua sem valor de prova; se um dia for lido, não serve para cadastrar nem para vincular. | AD-037 |
| Nenhum código guarda o nome do contato (`Contact.identificar()` sem chamador); contato novo nunca vira paciente e não marca a primeira consulta. | Pedir o nome completo, pedir a confirmação explícita e só então criar o cadastro. | AD-037 |
| Se houvesse nome, a promoção criaria o cadastro direto, sem confirmação (lido no código). | Sem confirmação explícita, nenhum cadastro. | AD-037 |
| A promoção não considera um paciente já reconhecido pelo telefone (lacuna D5b); hoje o duplicado só não acontece porque o nome nunca é guardado. | Nunca cadastrar de novo quem já é paciente. | AD-037 |
| Paciente cadastrado pelo painel não nasce vinculado ao seu Contact (`Contact.createAlreadyLinked()` sem chamador — Cenário 14). | Coerente com a decisão 1 quando o número é de exatamente um paciente: foi a clínica que o gravou. Com dois ou mais, vale a decisão 2. | AD-037 |
| Dois ou mais pacientes no mesmo número: a busca por telefone devolve o mais antigo, a conversa é ligada a ele e a ação é executada. | Não ligar a conversa a ninguém, interromper as ações e pedir esclarecimento ou encaminhar a um humano. | AD-038 |
| Nesse caso a resposta é gerada no contexto do paciente mais antigo: o identificador dele é entregue ao provedor de IA (lido no código). | Nenhum dado de paciente no que é dito durante a resolução. | AD-038 |
| Quando o classificador pede confirmação de identidade, a ação é executada no mesmo turno. | Identidade pendente interrompe a ação. | AD-038 |
| O pedido de encaminhar a um humano vindo do eixo de Contact não é lido por ninguém (lido no código). | O encaminhamento humano passa a ser uma das duas saídas da decisão 2 e precisa de destino (ver "Pontos a confirmar", item 3). | AD-038 |
| Número novo de paciente conhecido (Cenário 13): nada é vinculado — correto —, mas não há como concluir (`Contact.vincularAPacienteExistente()` sem chamador; nenhuma tela ou rota de aprovação). | O vínculo só acontece depois de um usuário autorizado da clínica aprovar pelo painel; o que o interlocutor disser pelo número novo não vincula nem libera dado do paciente. | AD-038 |
| Segundo paciente no mesmo contato (Cenários 11 e 12): nenhuma associação é criada pelo fluxo. | Só depois de resolvida a ambiguidade, pela decisão 2 (ver "Pontos a confirmar", item 4). | AD-038 |
| Cancelar, confirmar presença, remarcar e consultar cobrança recebem da IA o identificador do registro e não conferem se ele é do paciente da conversa (lido em `IntentActionRouter`; não testado). | Entram na regra: nenhuma delas com identidade pendente ou ambígua. | AD-038 |

## Critérios de aceite

**AD-037 — identificação e cadastro**

- Paciente cujo número está vinculado a exatamente um cadastro continua reconhecido e atendido sem que o nome seja pedido.
- Contato novo, depois de informar o nome completo **e** confirmar explicitamente, vira paciente e consegue marcar a primeira consulta.
- Só o nome, sem a confirmação, não cadastra ninguém.
- O nome de perfil do WhatsApp nunca é usado como nome do cadastro nem como prova de identidade.
- Quem já é paciente e é reconhecido pelo telefone nunca é cadastrado de novo.

**AD-038 — identidade ambígua e vínculo de número novo**

- Com dois ou mais pacientes no mesmo número, nenhuma consulta é marcada, cancelada, confirmada ou remarcada e nenhuma cobrança é consultada ou alterada enquanto a ambiguidade não for resolvida.
- Nesse caso o sistema pede esclarecimento ou encaminha a um humano, e o que ele diz não cita nome, consulta nem cobrança de nenhum dos pacientes do número.
- No turno em que o sistema pede confirmação ou esclarecimento de identidade, nenhuma ação é executada.
- Número novo que diz ser de paciente conhecido: nada é vinculado e nada do paciente é revelado até um usuário autorizado da clínica aprovar pelo painel. A confirmação do interlocutor, sozinha, não vincula.
- Depois da aprovação, o número novo passa a reconhecer o paciente; o contato antigo permanece no histórico.

## Testes

`apps/backend/test/critical/contact-scenarios-real-flow.test.ts` percorre o fluxo real (webhook, banco, casos de uso; só a IA é roteirizada).

- **Garantias que já valem** e continuam obrigatórias depois da implementação: paciente sozinho no número é reconhecido e atendido; sem nome ninguém é cadastrado; só o nome, sem confirmação, também não; paciente reconhecido não é duplicado; número novo nunca é vinculado por conta própria, mesmo quando quem escreve insiste; ninguém é associado pelo nome dito na mensagem.
- **Defeitos conhecidos**, um por comportamento decidido que o código ainda não tem. Eles **falham de verdade**: `pnpm --filter @luxora/backend test:known-defects` (três falhas — uma da AD-037, duas da AD-038). Na suíte que libera o CI aparecem como pulados, nunca como aprovados. Só viram testes normais quando o defeito for corrigido.

Os critérios de aceite que ainda não têm teste — esclarecimento sem exposição de dados, cancelamento e cobrança com identidade ambígua, pedido de vínculo aguardando a clínica e aprovação pelo painel — devem ser escritos junto com a implementação.

## Pontos a confirmar na implementação

As decisões não tratam destes pontos, e nenhum foi resolvido aqui:

1. **Quem é o "usuário autorizado da clínica"** que aprova o vínculo (só o administrador, ou também o terapeuta) e **o que conta como "verificação adequada"**: se o painel só registra a aprovação ou se também pede e guarda como a identidade foi conferida.
2. **O que o interlocutor ouve** enquanto o pedido de vínculo espera a clínica, e **como a clínica fica sabendo** do pedido. Já existem notificações internas no painel; usá-las é escolha da implementação.
3. **Encaminhamento humano.** Não existe hoje fila de atendimento humano nem destino para esse pedido. Falta definir quando o sistema pede esclarecimento e quando encaminha, e para onde.
4. **Como a ambiguidade do número compartilhado é resolvida** sem listar os pacientes do número — pela resposta do interlocutor conferida com os cadastros, ou pela clínica — e por quanto tempo a resposta vale (a mensagem, a conversa). Inclui a associação do contato a mais de um paciente (Cenários 11 e 12).
5. **De onde o backend recebe o nome completo e a confirmação explícita** do cadastro novo. O classificador de Contact hoje devolve só um rótulo e um "nome mencionado"; não há rótulo para "confirmou". É mudança no contrato com a IA.

A aprovação pelo painel é funcionalidade nova (rota, tela e registro de quem aprovou). Nada dela foi criado nesta etapa.

## O que não muda agora

Nenhuma linha do pipeline de Contact, de IA ou do WhatsApp foi alterada, e nenhuma tela ou rota foi criada. O comportamento descrito na coluna "Hoje" continua em vigor até a AD-037 e a AD-038 serem executadas. Entrada real da Meta e respostas reais da Anthropic continuam não validadas (Tarefa 03).

## Histórico

- **8 de outubro de 2026** — primeira versão: nome completo e confirmação explícita antes de criar ou vincular um cadastro; número compartilhado nunca resolvido por suposição. Dois pontos ficaram a confirmar: se o paciente já reconhecido pelo telefone continuava dispensado de informar o nome, e o que bastava como confirmação para vincular um número novo.
- **9 de outubro de 2026** — confirmação do responsável pelo produto, que resolve os dois pontos: o número vinculado a exatamente um paciente continua reconhecendo esse paciente; o vínculo de um número novo passa a depender de aprovação da clínica pelo painel, e a confirmação de quem escreve deixa de bastar; na ambiguidade, o sistema pode pedir esclarecimento ou encaminhar a um humano, sem revelar dados de pacientes.

## Documentos relacionados

- [ADR-0062](./ADR-0062-fechamento-dos-testes.md) — achados e evidência; ADR-0045, ADR-0046 e ADR-0055 — modelo de Contact
- `docs/PLANO_DE_EXECUCAO.md` — AD-037 e AD-038 (Epic 9)
- `docs/04-API/02-Contratos-de-Integracoes-Externas.md` — D5b
- `docs/01-Domain/07-Event-Storming-WhatsApp.md` — Cenários 11 a 14
