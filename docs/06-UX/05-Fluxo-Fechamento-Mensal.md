# 05 - Fluxo: Fechamento Mensal

## Objetivo

Documentar o balanço financeiro mensal que a Luxora entrega a cada clínica — um fechamento formal, distinto do Dashboard Financeiro ao vivo (`02-Fluxo-Dashboard.md`, `04-Fluxo-Financeiro.md`), que mostra o estado em tempo real. O fechamento mensal é um **documento de referência gerado ao final do mês**, resumindo o que aconteceu no período.

**Origem:** confirmado pela liderança como prática já necessária e esperada pelo cliente — todo final de mês, a clínica precisa desse balanço.

---

# Formato de referência (base confirmada pela liderança) — elevado a balanço profissional completo

O formato original fornecido pela liderança é a base — mantido integralmente — mas o documento final entregue ao cliente deve ter qualidade de balanço profissional: detalhado, especificado, com uma conclusão objetiva ao final, não apenas números soltos.

```
═══════════════════════════════════════
BALANÇO FINANCEIRO MENSAL — [Nome da Clínica]
Fechamento do mês de [Mês/Ano]
═══════════════════════════════════════

1. RESUMO DE ATENDIMENTOS
Total de atendimentos realizados: [N]
Valor por consulta: R$ [valor] (conforme configuração da clínica)
Total bruto do período: R$ [total]

2. RECEBIMENTOS
Valor recebido até o momento: R$ [recebido]  ([X]% do total bruto)
Resta receber: R$ [pendente]  ([Y]% do total bruto)

3. DETALHAMENTO DE PENDÊNCIAS POR PACIENTE
  → [Nome do paciente]: R$ [valor], [N] consulta(s) — [status: em atraso / inadimplente]
  → [Nome do paciente]: R$ [valor], [N] consulta(s) — [status: em atraso / inadimplente]
  (uma linha por paciente com saldo pendente, usando a classificação de
   05-IA/03-Gestao-de-Inadimplencia.md)

4. COMPARATIVO COM O MÊS ANTERIOR
Total bruto: R$ [mês atual] (variação de [+/-X]% em relação a R$ [mês anterior])
Taxa de recebimento: [Y]% (variação de [+/-Z pontos percentuais])

5. CONCLUSÃO OBJETIVA
[1 a 3 frases geradas automaticamente, resumindo o mês em linguagem direta —
 ex: "O mês de [Mês] fechou com [N] atendimentos e taxa de recebimento de [X]%,
 [acima/em linha com/abaixo] da média dos últimos 3 meses. [N] pacientes seguem
 com pendência financeira, sendo [N] em atraso e [N] inadimplentes, já sinalizados
 conforme a régua de acompanhamento em curso."]
═══════════════════════════════════════
```

**Nota:** "valor da consulta" no exemplo assume preço único por sessão; clínicas com preços diferentes por terapeuta/tipo de sessão devem ter o total bruto calculado como somatório real (Σ valor de cada `billing_session`), não como uma multiplicação simples de "nº de atendimentos × valor único" quando isso não refletir a realidade daquela clínica.

## Seção 5 — Conclusão Objetiva: regras de geração

A conclusão não é texto livre gerado sem controle — segue regras estritas para permanecer objetiva e profissional, nunca especulativa:

- Baseada exclusivamente em números já calculados nas seções 1 a 4 deste mesmo documento — nunca introduz dado novo ou opinião não sustentada por cálculo.
- Compara sempre com histórico real (mês anterior, média móvel de 3 meses) quando disponível; na ausência de histórico (primeiro mês de uso), a conclusão apenas descreve o mês corrente sem comparação.
- Menciona pendências financeiras com a mesma neutralidade factual do restante do documento — nunca tom de cobrança ou alarme, coerente com o princípio ético de `05-IA/03-Gestao-de-Inadimplencia.md`.
- Gerada pelo Motor Operacional a partir de um template estruturado (variáveis preenchidas), não por geração livre de texto via IA — garante consistência e auditabilidade mês a mês.

---

# Caso de Uso: `GerarFechamentoMensal`

```
Gatilho: automação mensal (cron, via n8n — ADR-0021) no último dia do mês, ou no primeiro dia útil do mês seguinte, configurável por clínica
Entrada: tenant_id, mês de referência
Processamento:
  1. Motor Operacional consulta todas as sessions realizadas no mês (session.status = Realizada)
  2. Calcula total bruto: soma de todos os billing_session vinculados a essas sessions
  3. Calcula valor recebido: soma de payment confirmados no período
  4. Calcula resta receber: total bruto − valor recebido
  5. Para o detalhamento "resta receber", consulta patient_financial_segment (`03-Database/10-Views.md`)
     e classifica cada pendência como em_atraso ou inadimplente
  6. Consulta o fechamento do(s) mês(es) anterior(es) para montar o comparativo (Seção 4)
  7. Gera a conclusão objetiva (Seção 5) a partir do template estruturado, conforme regras definidas acima
  8. Monta o documento completo no formato de balanço profissional acima
Saída: relatório enviado à clínica (WhatsApp e/ou e-mail, conforme preferência configurada) e disponibilizado também na tela de Relatórios do Dashboard
```

---

# Endpoint de API

Adição a `04-API/01-Contratos-REST.md`, seção Financeiro:

| Método | Rota | Caso de Uso |
|---|---|---|
| GET | `/api/v1/reports/monthly-closing?month=YYYY-MM` | GerarFechamentoMensal (consulta sob demanda) |
| POST | `/api/v1/reports/monthly-closing/send` | Disparo do envio automático (acionado por n8n) |

---

# Relação com a segmentação de inadimplência

O detalhamento "resta receber" deste fechamento é a mesma fonte de dado já usada na segmentação financeira e na régua de comunicação (`05-IA/03-Gestao-de-Inadimplencia.md`) — reaproveita `patient_financial_segment`, não recalcula do zero. Mesmo princípio ético se aplica aqui: o fechamento mensal existe para dar visibilidade financeira ao terapeuta, nunca para servir como instrumento de pressão sobre o paciente — é um documento interno da clínica, não uma comunicação enviada ao paciente.

---

# Tom da entrega ao terapeuta

Ainda que seja um documento financeiro, a entrega ao terapeuta segue os mesmos princípios de clareza e cuidado já definidos em `05-IA/01-Tom-de-Voz-e-Estilo-Conversacional.md` — direto, bem formatado, sem jargão técnico de banco de dados, permitindo que o terapeuta entenda o mês inteiro em poucos segundos de leitura.

---

# Documentos Relacionados

- 05-IA/03-Gestao-de-Inadimplencia.md
- 03-Database/10-Views.md (patient_financial_segment)
- 04-API/01-Contratos-REST.md
- 06-UX/02-Fluxo-Dashboard.md
- 02-Arquitetura/ADRs/ADR-0021.md
