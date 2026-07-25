# ADR-0041 — WhatsApp é a interface oficial do paciente

**Status:** Aprovada como decisão de arquitetura — Marco 1 (Arquitetura de Domínio) desta fase.
**Origem:** decisão de produto formalizada como decisão de arquitetura de domínio.
**Data:** Julho de 2026

## Contexto

O domínio da Luxora, até esta fase, não distinguia explicitamente qual canal é a via oficial de relacionamento do paciente com a clínica. WhatsApp, IA (`ProcessarMensagemUseCase`/`IntentActionRouter`) e o painel web coexistiam sem uma declaração clara de qual é o principal.

## Problema

Sem essa decisão explícita, o WhatsApp continua sendo tratado, na prática, como um recurso periférico e adiável — o que não reflete mais a visão de produto da Luxora, e deixa o domínio sem base para decisões consequentes (como a necessidade do Aggregate `Contact`, ver ADR-0043).

## Alternativas avaliadas

- **Manter WhatsApp como canal opcional/secundário**: rejeitada — contraria diretamente a decisão de produto formalizada nesta fase.
- **Tratar WhatsApp e painel como produtos e domínios separados**: rejeitada — duplicaria backend e domínio sem necessidade real; ambos compartilham exatamente os mesmos Aggregates de negócio (`Appointment`, `Billing`, `Payment`, `Session`).

## Decisão

O WhatsApp é a interface oficial e obrigatória de relacionamento do paciente com a clínica. Toda a jornada do paciente — primeiro contato, agendamento, consulta de horários, confirmação, reagendamento, cancelamento, cobrança, pagamento, reengajamento — deve ser executável integralmente por esse canal, sem que o paciente precise perceber a complexidade da plataforma por trás.

## Consequências

- Exige a existência do Aggregate `Contact` (ADR-0043), já que o primeiro evento do sistema passa a ser "telefone desconhecido inicia contato", não "paciente já existente age".
- `IntentActionRouter` precisa, na implementação futura, cobrir toda a jornada mínima obrigatória (hoje cobre parcialmente — reagendamento e consulta exploratória de horários são pendências de implementação, não de domínio, documentadas em `01-Domain/07-Event-Storming-WhatsApp.md`).
- WhatsApp deixa de poder ser deprioritizado como "nice to have" em qualquer roadmap futuro de produto.

## Documentos relacionados

- `docs/01-Domain/06-Decisoes-de-Dominio-WhatsApp.md`, `07-Event-Storming-WhatsApp.md`, `10-Arquitetura-WhatsApp-e-Painel.md`
- ADR-0042, ADR-0043, ADR-0006 (IA como Interface Conversacional)
