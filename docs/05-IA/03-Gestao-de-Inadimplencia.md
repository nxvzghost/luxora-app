# 03 - Gestão de Inadimplência e Segmentação Financeira de Pacientes

## Objetivo

Documentar um princípio ético central confirmado pela liderança — **o terapeuta nunca abandona um paciente por dificuldade financeira** — e a segmentação operacional de pacientes por status de pagamento que sustenta esse princípio na prática. Este documento também fecha uma lacuna identificada no relatório de arquitetura original (Bloco 11): a ausência de uma régua de comunicação para inadimplência.

---

# Princípio ético central

Pode ocorrer de um paciente atravessar uma condição financeira ruim. Nesses casos, **o terapeuta jamais abandona o atendimento** — o tratamento continua enquanto se aguarda a melhora da situação financeira do paciente e a quitação dos débitos pendentes. A gestão de inadimplência é tratada como uma função **administrativa e financeira separada**, nunca como critério de continuidade do cuidado.

Isso não é apenas política de atendimento — é um princípio que restringe o comportamento técnico do sistema:

- O agente de IA **nunca** menciona suspensão de atendimento como consequência de inadimplência em nenhuma mensagem automática.
- Qualquer decisão sobre eventual limite de tolerância financeira (se e quando isso for considerado) é **exclusivamente do terapeuta/clínica**, nunca automatizada ou sugerida pela IA — reforça o Princípio 03 (IA nunca decide sozinha) em um contexto especialmente sensível, já que dificuldade financeira pode estar diretamente ligada ao próprio quadro que trouxe o paciente à terapia.
- A cobrança de valores em atraso segue sempre o mesmo tom de acolhimento já definido em `01-Tom-de-Voz-e-Estilo-Conversacional.md` — nunca linguagem de cobrança agressiva, ameaça ou constrangimento.

---

# Segmentação financeira de pacientes

Nova seção do módulo Financeiro, complementando `06-UX/04-Fluxo-Financeiro.md`, organizando pacientes em grupos observáveis. **Dois limiares confirmados pela liderança:**

- **Em atraso:** até 7 dias após o vencimento sem pagamento.
- **Inadimplente:** acima de 40 dias após o vencimento sem pagamento.
- Entre o 8º e o 40º dia, o paciente permanece classificado como **em atraso** — a transição para "inadimplente" só ocorre a partir do 40º dia. Não é um terceiro estágio nomeado à parte, é a continuação do mesmo estágio até cruzar o limiar.

Grupos da segmentação:

1. **Pacientes que pagam em dia** — sem cobrança em atraso (`billing.status != Atrasada`).
2. **Pacientes que pagam semanal** — `billing_policy = weekly` (ver `03-Database/02-Tabelas.md`, campo `patient.billing_policy_override`).
3. **Pacientes que pagam mensal** — `billing_policy = monthly`.
4. **Pacientes em atraso** — cobrança vencida há até 7 dias.
5. **Pacientes inadimplentes** — cobrança vencida há mais de 40 dias.

**Nota importante:** os grupos 2 a 5 não são mutuamente exclusivos com o grupo 1 nem entre si de forma rígida — um paciente mensal também pode estar em atraso ou inadimplente ao mesmo tempo; um paciente "em dia" é, por definição, quem não está em nenhuma cobrança vencida no momento, seja qual for sua política. A segmentação existe para dar visibilidade operacional ao terapeuta, não para categorizar o paciente de forma permanente.

---

# View de banco de dados

Adição a `03-Database/10-Views.md`:

```sql
CREATE VIEW patient_financial_segment AS
SELECT
  p.id AS patient_id,
  p.tenant_id,
  COALESCE(p.billing_policy_override, cs.default_billing_policy) AS effective_billing_policy,
  b.days_overdue,
  CASE
    WHEN b.days_overdue IS NULL THEN 'em_dia'
    WHEN b.days_overdue <= 7 THEN 'em_atraso'
    WHEN b.days_overdue > 40 THEN 'inadimplente'
    ELSE 'em_atraso'  -- entre 8 e 40 dias, ainda classificado como em atraso
  END AS financial_status
FROM patient p
JOIN clinic_settings cs ON cs.tenant_id = p.tenant_id
LEFT JOIN LATERAL (
  SELECT EXTRACT(DAY FROM now() - due_date)::int AS days_overdue
  FROM billing
  WHERE billing.patient_id = p.id AND billing.status = 'atrasada'
  ORDER BY due_date ASC
  LIMIT 1
) b ON true;
```

Esta view alimenta diretamente o Dashboard Financeiro (`06-UX/02-Fluxo-Dashboard.md`, `15-Metricas/05-Dashboard-Financeiro`) e o fechamento mensal (`06-UX/05-Fluxo-Fechamento-Mensal.md`).

---

# Régua de comunicação para inadimplência (lacuna fechada)

O relatório de arquitetura original identificou como risco a ausência de "nenhuma automação de cobrança de inadimplência com régua de comunicação". Esta seção resolve essa lacuna, aplicando o princípio ético acima e os dois limiares reais confirmados.

## Fluxo da régua

```
Cobrança vence sem pagamento
  ↓
D+1: lembrete gentil, sem menção a atraso ("Notei que ainda não recebemos a confirmação do pagamento de [data]. Está tudo bem?")
  ↓
D+7 (limite do estágio "em atraso"): segundo lembrete, tom igualmente acolhedor, oferecendo abertura para conversa ("Se estiver passando por um momento mais difícil, me avisa — podemos conversar sobre isso.")
  ↓
Entre D+8 e D+39: sem nova cobrança automática adicional por padrão — o paciente já foi contatado duas vezes com cuidado; insistência repetida nesta janela contrariaria o princípio de acolhimento
  ↓
D+40 (transição para "inadimplente"): sinalização ao terapeuta (nunca ação automática) — o Motor Operacional informa que aquele paciente cruzou o limiar de 40 dias, para que o terapeuta decida como conduzir a situação. Nenhuma mensagem automática adicional é enviada ao paciente neste ponto sem decisão humana.
```

**Regras da régua:**

- Nenhuma etapa da régua ameaça, cobra juros/multa automaticamente, ou menciona suspensão — isso seria uma decisão do terapeuta, nunca do agente.
- Os limiares de 7 e 40 dias são os padrões da Luxora, mas configuráveis por clínica (`clinic_settings`) para quem praticar prazos diferentes.
- Fronteira Motor Operacional ↔ n8n (ADR-0021): o Motor decide **quando** e **se** disparar cada etapa da régua (com base nos limiares e na política de tolerância da clínica); o n8n executa o envio agendado da mensagem.

---

# Documentos Relacionados

- 01-Tom-de-Voz-e-Estilo-Conversacional.md
- 03-Database/02-Tabelas.md (billing_policy_override, clinic_settings)
- 01-Domain/03-Maquina-de-Estados.md (estado Atrasada)
- 06-UX/04-Fluxo-Financeiro.md
- 02-Arquitetura/ADRs/ADR-0021.md
