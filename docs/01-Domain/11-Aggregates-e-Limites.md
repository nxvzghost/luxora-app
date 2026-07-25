# 11 — Aggregates e Limites de Consistência

**Status:** Documento Oficial — Marco 1 da Arquitetura do Vertex.
**Escopo:** Aggregates relevantes a esta fase (`Contact`, e a relação com `Patient`) mais a confirmação de que os demais Aggregates já existentes não mudaram de limite.

## Aggregate: Contact (novo nesta fase)

- **Raiz**: Contact.
- **Invariante que ele protege**: uma identidade de comunicação nunca existe sem ao menos um dado de canal (telefone); seu estado de qualificação só avança em ordem (`Novo → Conversando → Identificado → Qualificado/Vinculado → Promovido`); nunca pula etapa.
- **O que NÃO está dentro do limite de consistência de Contact**: os Patients aos quais ele se associa. A associação Contact↔Patient é uma referência entre dois Aggregates diferentes, nunca uma composição — mudar um não exige transação atômica com o outro.
- **Objetos de Valor dentro do limite**: identidade de canal normalizada (telefone).

## Aggregate: Patient (já existente — confirmado sem alteração de limite)

- **Raiz**: Patient.
- **Invariante que protege**: máquina de estados clínica (`Cadastrado → Ativo → ... → Alta`), billingPolicyOverride.
- **O que mudou nesta fase**: nada na definição do Aggregate em si. O que mudou é que agora ele pode nascer a partir de uma promoção de Contact, além de nascer diretamente pelo painel — a origem não é parte do invariante do Aggregate.

## Aggregates não tocados nesta fase (confirmados sem mudança)

`Appointment`, `Session`, `Billing`, `Payment`, `ClinicSubscription`, `AvailabilityCalendar`, `RecurringBlock`, `ClinicHoliday`, `Clinic`, `Therapist` — todos continuam com exatamente os mesmos limites de consistência já documentados antes desta fase. Nenhum deles referencia `Contact` diretamente; todos continuam referenciando `Patient.id`, como já faziam.

## Por que a relação Contact↔Patient não é, ela mesma, um Aggregate

Foi cogitado (e descartado) tratar a associação como sua própria entidade forte, com ciclo de vida independente. Não há invariante que justifique isso — a associação é um dado simples (quem, para qual Patient, com qual papel, desde quando), sem regra de transição própria além de "existe ou não existe, e pode ter mais de uma por Contact". Modelá-la como Aggregate seria complexidade sem benefício correspondente.

## Documentos relacionados

- `08-Contact-e-Identidade-de-Comunicacao.md`, `12-Domain-Events.md`
