# 02 - Rotina de Controle de Agenda

## Objetivo

Documentar a rotina de controle de agenda voltada ao **terapeuta/clínica** (diferente de `01-Tom-de-Voz-e-Estilo-Conversacional.md`, que trata da conversa com o **paciente**). Esta rotina foi descrita pela liderança como prática já validada e precisa ser incorporada à automação da Luxora — é conteúdo novo, sem equivalente anterior na documentação técnica.

---

# Cadências de controle

## Controle semanal

Visão consolidada da agenda da semana, permitindo observar consultas futuras com antecedência suficiente para agir (confirmar com pacientes, identificar horários vagos, prever necessidade de reagendamento).

## Controle diário — o núcleo desta rotina

**Toda noite, ao final do dia, a agenda do dia seguinte é enviada ao terapeuta.** Esta é uma automação proativa — não é o terapeuta que consulta, é o sistema que entrega.

**Regra crítica de atualização:** se a agenda sofrer qualquer alteração após o envio inicial (ex: um horário vago é preenchido por um paciente de encaixe/emergência, um cancelamento abre um novo espaço), o sistema deve enviar um **lembrete com a agenda atualizada** — o terapeuta nunca deve operar com uma versão desatualizada da agenda do dia seguinte só porque a mudança aconteceu depois do envio original.

---

# Especificação técnica

## Caso de Uso: `EnviarResumoAgendaDoDia`

```
Gatilho: horário fixo configurável por clínica (padrão sugerido: fim do expediente, ex: 20h)
Entrada: tenant_id, therapist_id
Processamento:
  1. Motor Operacional consulta todas as sessions/appointments do dia seguinte para o terapeuta
  2. Monta resumo: horário, paciente, modalidade (presencial/online), status de confirmação
  3. Formata mensagem seguindo os mesmos princípios de tom definidos em 01-Tom-de-Voz-e-Estilo-Conversacional.md (curto, claro, sem jargão técnico)
Saída: mensagem enviada ao terapeuta via WhatsApp
```

## Caso de Uso: `ReenviarAgendaAtualizada`

```
Gatilho: qualquer alteração na agenda do dia seguinte, ocorrida DEPOIS do envio de EnviarResumoAgendaDoDia
Entrada: tenant_id, therapist_id, appointment_id alterado
Processamento:
  1. Detecta que já existe um resumo enviado para aquela data (idempotência — não reenviar do zero, apenas sinalizar a mudança)
  2. Monta mensagem de atualização, destacando especificamente o que mudou (não repete a agenda inteira sem necessidade)
Saída: mensagem de atualização enviada ao terapeuta
```

---

# Fronteira Motor Operacional ↔ n8n para esta rotina (aplicando ADR-0021)

Seguindo o princípio já estabelecido em `02-Arquitetura/ADRs/ADR-0021.md` ("o Motor decide, o n8n executa"):

- **Decide (Motor Operacional):** o que entra no resumo, como priorizar/ordenar, se uma mudança é relevante o suficiente para gerar reenvio (ex: uma alteração de observação interna sem impacto de horário não deveria disparar reenvio de agenda inteira).
- **Executa (n8n):** o disparo agendado do envio diário (cron/trigger de horário), o envio da mensagem via WhatsApp Business API.

---

# Motivo de negócio (contexto da liderança)

Esta rotina existe para dar ao terapeuta visibilidade e controle total da própria agenda sem esforço manual — o mesmo princípio de "tempo devolvido ao terapeuta" que já orienta toda a proposta de valor da Luxora (`CEO/05 - Proposta de valor`). O caso de uso mencionado pela liderança — um horário vago sendo preenchido por um paciente de emergência após o envio inicial — é um cenário real e recorrente em clínicas de saúde mental, e a automação precisa lidar com ele sem exigir que o terapeuta descubra a mudança sozinho.

---

# Documentos Relacionados

- 05-IA/01-Tom-de-Voz-e-Estilo-Conversacional.md
- 02-Arquitetura/ADRs/ADR-0021.md (fronteira Motor Operacional ↔ n8n)
- 04-API/01-Contratos-REST.md (Agenda e Agendamento)
- 02-Arquitetura/09-Filas.md
