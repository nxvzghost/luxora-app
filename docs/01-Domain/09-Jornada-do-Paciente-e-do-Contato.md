# 09 — Jornada do Paciente e do Contato

**Status:** Documento Oficial — Marco 1 da Arquitetura do Vertex.

Duas jornadas coexistem — a do `Contact` (identidade de comunicação) e a do `Patient` (vínculo clínico) — conectadas por um único evento de promoção.

## Jornada do Contact

```
Número desconhecido
        ↓
Conversa no WhatsApp (Contact.estado: Novo → Conversando)
        ↓
Descobre nome (Contact.estado: Identificado)
        ↓
Agenda primeira consulta  ← evento de promoção
        ↓
Vira/associa-se a Paciente (Contact.estado: Promovido; permanece ativo como canal)
        ↓
Continua existindo, permanentemente, mesmo depois do Patient ficar Inativo
        ↓
(meses depois) Volta a escrever — mesmo Contact, ou Contact novo associado ao mesmo Patient
```

## Jornada do Patient (já existente, sem alteração de significado)

```
Cadastrado (criado no momento da promoção, ou diretamente pelo painel)
        ↓
Ativo
        ↓
Agendado → Confirmado → EmSessao → PagamentoPendente → Pago
        ↓
(ciclo se repete a cada nova sessão)
        ↓
Inativo (sem retorno por período)
        ↓
Ativo novamente (reativação — mesmo Patient.id, histórico completo preservado)
        ↓
Alta (estado terminal — reingresso exige novo cadastro, não reabertura)
```

## O ponto de conexão: promoção

**"Agenda primeira consulta" é o evento que conecta as duas jornadas** — não "ter cadastro mínimo" (critério vago, descartado nesta fase). O motivo é estrutural, não arbitrário: `Appointment` já exige um `Patient` real para existir. No momento em que um Contact tenta agendar de verdade, o sistema precisa, nesse exato ponto, de um Patient para anexar o agendamento — e é aí, exatamente, que a promoção acontece. Antes disso (só nome, sem agendamento) não há obrigação nenhuma; depois disso não há como existir Appointment sem Patient.

## Painel web vs. WhatsApp, por etapa da jornada

| Etapa | Onde acontece | Quem participa |
|---|---|---|
| Primeiro contato, identificação, agendamento, confirmação, reagendamento, cancelamento, cobrança, pagamento | WhatsApp | Paciente (ou seu responsável), conduzido pelo Agente de IA |
| Acompanhar agenda, pacientes, financeiro, indicadores, terapeutas, configurações, auditoria, supervisionar o Agente de IA | Painel web | Equipe da clínica |
| Cadastro manual de paciente (sem passar pelo WhatsApp primeiro) | Painel web | Equipe da clínica — jornada alternativa, reconciliada quando o paciente eventualmente escreve pelo WhatsApp (ver `08-Contact-e-Identidade-de-Comunicacao.md`, caso especial correspondente) |

Os dois lados operam sobre o **mesmo backend, mesmo domínio, mesmos Aggregates** (`Appointment`, `Billing`, `Payment`, `Session` não têm nenhuma noção de "por qual canal chegou o pedido") — ver `10-Arquitetura-WhatsApp-e-Painel.md`.

## Nota de compatibilidade encontrada na revisão final — não resolvida nesta fase

`Contact.estado` usa `Novo` e `Identificado` como nomes de estado. **Esses dois nomes já existiam antes desta fase, como estados válidos de `Patient`** (`docs/01-Domain/03-Maquina-de-Estados.md`, confirmado em `patient.entity.ts`). Isso é uma colisão de nome real, não apenas um risco teórico: com `Contact` absorvendo toda a fase anterior ao vínculo clínico, um `Patient` — pela lógica desta fase (ADR-0045) — nunca deveria mais nascer nos estados `Novo`/`Identificado`, já que ele só passa a existir no momento da promoção, quando nome e telefone já são conhecidos.

Isso **não foi decidido nem corrigido nesta fase** — corrigir a máquina de estados de `Patient` seria redesenhar domínio já congelado antes desta análise, fora do escopo autorizado aqui. Fica registrado explicitamente como pendência a resolver antes ou durante a implementação: revisar `03-Maquina-de-Estados.md` para decidir se `Patient.Novo`/`Patient.Identificado` devem ser removidos como estados alcançáveis, ou se permanecem por outro motivo não coberto por esta análise. Ver `docs/ARCHITECTURE_MILESTONE.md`, seção "Riscos conhecidos".

## Continuidade de identidade — "continua sendo a mesma pessoa"

A garantia de que alguém que volta meses depois é reconhecido como a mesma pessoa **não depende do Contact permanecer vivo com o mesmo telefone** — depende de `Patient.id` ser a identidade estável do sistema, e da associação Contact↔Patient (não o telefone isolado) ser o que o sistema consulta para reconhecer alguém. Isso é o que permite, ao mesmo tempo: reconhecer quem volta (Cenário de reativação), sobreviver a uma troca de número (Cenário 5 do Event Storming) e não quebrar quando o mesmo número serve mais de uma pessoa (Cenário de casal).

## Documentos relacionados

- `06-Decisoes-de-Dominio-WhatsApp.md`, `07-Event-Storming-WhatsApp.md`, `08-Contact-e-Identidade-de-Comunicacao.md`
- `03-Maquina-de-Estados.md` (estados de Patient, sem alteração nesta fase)
