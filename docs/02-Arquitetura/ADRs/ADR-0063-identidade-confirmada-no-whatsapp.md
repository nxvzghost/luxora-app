# ADR-0063 — Identidade pelo WhatsApp: confirmação explícita antes de criar ou vincular cadastro, e número compartilhado nunca resolvido por suposição

**Status:** APROVADA — decisão de produto de 8 de outubro de 2026. **Implementação pendente** (AD-037 e AD-038); nenhum comportamento foi alterado.
**Origem:** complemento da Tarefa 06 da auditoria. Os defeitos que motivaram a decisão estão descritos, com a evidência, na [ADR-0062](./ADR-0062-fechamento-dos-testes.md) ("O que o fluxo de Contact faz de verdade") e não são repetidos aqui.
**Relação com as anteriores:** aplica ao fluxo real o princípio da ADR-0046 (ambiguidade resolvida antes de qualquer ação clínica) e completa as ADR-0045 e ADR-0055, que deixaram em aberto de onde vem o nome do contato e como um vínculo é confirmado.

## Decisão

### 1. Identidade pelo WhatsApp

- O nome de perfil do WhatsApp **não comprova** a identidade do paciente.
- A secretária virtual deve pedir o **nome completo** e uma **confirmação explícita** antes de **criar** um cadastro de paciente ou de **vincular** a conversa a um cadastro existente.
- Enquanto a identidade estiver pendente, **nenhuma ação clínica ou financeira que dependa dela é executada**.

### 2. Número compartilhado

- Quando o mesmo número está associado a mais de um paciente, o sistema **nunca escolhe sozinho** — em particular, nunca o cadastro mais antigo.
- Ele **pede esclarecimento, sem expor informação de outro paciente**.
- Enquanto houver ambiguidade, **não realiza agendamento, cancelamento, cobrança nem qualquer outra alteração que dependa da identidade**.

## O que precisa mudar no código

A coluna "Hoje" traz o que o teste no fluxo real mostrou; onde diz "lido no código", a afirmação vem da leitura do código e ainda não tem teste.

| Hoje | Decidido | Backlog |
|---|---|---|
| Nenhum código guarda o nome do contato (`Contact.identificar()` sem chamador); contato novo nunca vira paciente e não marca a primeira consulta. | Pedir o nome completo, pedir a confirmação explícita e só então criar o cadastro. | AD-037 |
| Se houvesse nome, a promoção criaria o cadastro direto, sem confirmação (lido no código). | Sem confirmação explícita, nenhum cadastro. | AD-037 |
| A promoção não considera um paciente já reconhecido pelo telefone (lacuna D5b); hoje o duplicado só não acontece porque o nome nunca é guardado. | Nunca cadastrar de novo quem já é paciente. | AD-037 |
| Paciente cadastrado pelo painel não nasce vinculado ao seu Contact (`Contact.createAlreadyLinked()` sem chamador — Cenário 14). | Ver "Pontos a confirmar", item 1. | AD-037 |
| Dois pacientes no mesmo número: a busca por telefone devolve o mais antigo, a conversa é ligada a ele e a ação é executada. | Não ligar a conversa a ninguém, pedir esclarecimento e não agir. | AD-038 |
| Nesse caso a resposta é gerada no contexto do paciente mais antigo: o identificador dele é entregue ao provedor de IA (lido no código). | Nenhum dado de outro paciente no que é dito a quem escreve. | AD-038 |
| Quando o classificador pede confirmação de identidade, a ação é executada no mesmo turno. | Identidade pendente suspende a ação. | AD-038 |
| O pedido de encaminhar a um humano vindo do eixo de Contact não é lido por ninguém (lido no código). | Precisa ter destino (ver "Pontos a confirmar", item 4). | AD-038 |
| Número novo de paciente conhecido (Cenário 13): nada é vinculado — correto —, mas não há como concluir (`Contact.vincularAPacienteExistente()` sem chamador; o classificador não tem rótulo para isso). | Vincular só depois do nome completo e da confirmação explícita. | AD-038 |
| Segundo paciente no mesmo contato (Cenários 11 e 12): nenhuma associação é criada pelo fluxo. | Associar só depois de esclarecido para quem é. | AD-038 |
| Cancelar, confirmar presença, remarcar e consultar cobrança recebem da IA o identificador do registro e não conferem se ele é do paciente da conversa (lido em `IntentActionRouter`; não testado). | Entram na regra: nenhuma delas com identidade pendente ou ambígua. | AD-038 |

## Critérios de aceite

**AD-037 — identificação e cadastro com confirmação**

- Contato novo, depois de informar o nome completo **e** confirmar explicitamente, vira paciente e consegue marcar a primeira consulta.
- Só o nome, sem a confirmação, não cadastra ninguém.
- O nome de perfil do WhatsApp nunca é usado como nome do cadastro.
- Quem já é paciente e é reconhecido pelo telefone nunca é cadastrado de novo.

**AD-038 — identidade pendente ou ambígua não age**

- Com mais de um paciente no mesmo número, nenhuma consulta é marcada, cancelada, confirmada ou remarcada e nenhuma cobrança é consultada ou alterada antes do esclarecimento.
- O pedido de esclarecimento não cita nome, consulta nem cobrança de nenhum dos pacientes do número.
- No turno em que o sistema pede confirmação de identidade, nenhuma ação é executada.
- Número novo que diz ser de paciente conhecido só é vinculado depois do nome completo e da confirmação explícita; o contato antigo permanece.

## Testes

`apps/backend/test/critical/contact-scenarios-real-flow.test.ts` percorre o fluxo real (webhook, banco, casos de uso; só a IA é roteirizada).

- **Garantias que já valem** e continuam obrigatórias depois da implementação: sem nome ninguém é cadastrado; só o nome, sem confirmação, também não; paciente reconhecido não é duplicado; número novo nunca é vinculado por conta própria; ninguém é associado pelo nome dito na mensagem.
- **Defeitos conhecidos**, um por comportamento decidido que o código ainda não tem. Eles **falham**: `pnpm --filter @luxora/backend test:known-defects` (três falhas hoje — uma da AD-037, duas da AD-038). Na suíte que libera o CI aparecem como pulados, nunca como aprovados. Ao corrigir, cada um vira um teste normal.

Os critérios de aceite que ainda não têm teste (esclarecimento sem exposição, cancelamento e cobrança com identidade ambígua, vínculo do número novo) devem ser escritos junto com a implementação.

## Pontos a confirmar na implementação

A decisão não trata destes pontos, e nenhum foi resolvido aqui:

1. **Paciente já cadastrado e sozinho no número.** Hoje ele é reconhecido pelo telefone gravado pela clínica e atendido sem que o nome seja pedido. Esta ADR foi lida como **não alterando** esse caso — a regra do nome completo e da confirmação vale para criar um cadastro e para vincular um número que a clínica não cadastrou. Se a intenção for pedir confirmação também a quem é reconhecido pelo telefone, o comportamento que hoje funciona muda.
2. **O que basta como confirmação para vincular um número novo a um cadastro que já existe.** A confirmação de quem escreve prova tão pouco quanto o nome de perfil: qualquer pessoa que saiba o nome completo de um paciente poderia pedir o vínculo e passar a receber dados dele. Falta decidir se a confirmação do próprio interlocutor basta ou se a clínica aprova pelo painel.
3. **De onde o backend recebe o nome e a confirmação.** O classificador de Contact hoje devolve só um rótulo e um "nome mencionado"; não há rótulo para "confirmou" nem para "vincular a paciente existente". É mudança no contrato com a IA.
4. **Para onde vai a conversa enquanto a identidade está pendente** e o que acontece quando a pessoa não esclarece: hoje não existe fila de atendimento humano.
5. **Como o esclarecimento do número compartilhado é resolvido** sem listar os pacientes do número: pela resposta do interlocutor, conferida com os cadastros, ou pela clínica.

## O que não muda agora

Nenhuma linha do pipeline de Contact, de IA ou do WhatsApp foi alterada. O comportamento descrito na coluna "Hoje" continua em vigor até a AD-037 e a AD-038 serem executadas. Entrada real da Meta e respostas reais da Anthropic continuam não validadas (Tarefa 03).

## Documentos relacionados

- [ADR-0062](./ADR-0062-fechamento-dos-testes.md) — achados e evidência; ADR-0045, ADR-0046 e ADR-0055 — modelo de Contact
- `docs/PLANO_DE_EXECUCAO.md` — AD-037 e AD-038 (Epic 9)
- `docs/04-API/02-Contratos-de-Integracoes-Externas.md` — D5b
- `docs/01-Domain/07-Event-Storming-WhatsApp.md` — Cenários 11 a 14
