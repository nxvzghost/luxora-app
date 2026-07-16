# PD-001 — Decisão Oficial (registro estruturado da diretriz recebida)

## Princípio central

> Toda decisão de disponibilidade deverá passar obrigatoriamente por este motor. A IA nunca poderá decidir horários sozinha — ela apenas consulta o Motor de Disponibilidade. **O Motor decide.**

## Componentes exigidos

### 1. Motor de Disponibilidade (Availability Engine)
Componente central do qual todos os módulos dependem: IA, Agenda, Agendamento, Reagendamento, Financeiro, Sessões, WhatsApp, Confirmações, Cobranças, Relatórios.

### 2. Assistente de configuração na implantação
IA pergunta obrigatoriamente, por dia da semana: atende? horário inicial/final, intervalo de almoço, intervalo entre pacientes, duração padrão da consulta. Também pergunta: dias que não atende, feriados, sábados, domingos, horários bloqueados, dias de reunião/administrativos.

### 3. Pacientes recorrentes
Antes de operar, a IA identifica/cadastra pacientes recorrentes (semanal, quinzenal, mensal, personalizado) — esses horários bloqueiam a agenda automaticamente. Só o que sobra é oferecido a paciente novo.

### 4. Importação inteligente de agenda existente
Pergunta obrigatória na implantação: "Você já usa alguma agenda?". Prioridade de integração: Google Calendar → Apple Calendar (iCloud) → Microsoft Outlook → arquivos .ICS → CSV → Excel → cadastro manual assistido. Após importar, IA analisa automaticamente recorrência, horários vagos, conflitos, duplicidades — sem digitação manual.

### 5. Disponibilidade padrão
Configurada uma vez, permanece válida até ser alterada. IA nunca pergunta de novo sem necessidade.

### 6. Renovação da agenda
Por terapeuta, escolha entre Renovação Automática (agenda futura criada sozinha a partir do padrão) ou Renovação mediante confirmação (IA pergunta antes de estender pra próxima semana/mês).

### 7. Exceções
Motor suporta: férias, feriados, congressos, cursos, licenças, bloqueios temporários, horários especiais, mudanças de rotina.

### 8. Monitoramento contínuo da IA
IA monitora: agenda inexistente, quase cheia, totalmente cheia, vazia, mudança de rotina, ausência de disponibilidade futura — inicia conversa proativa com o profissional quando necessário.

### 9. Regras obrigatórias, não-negociáveis
- A IA nunca oferece horário sem consultar o Motor.
- Nenhum módulo acessa a agenda diretamente.
- Toda decisão passa pelo Motor de Disponibilidade.

### 10. Fluxo oficial
```
Paciente → WhatsApp Oficial da Clínica → IA → Motor de Disponibilidade → Agenda → Confirmação → Agendamento
```

## Missão explícita, nesta ordem

1. Documentação oficial completa
2. Todos os arquivos necessários dentro da documentação oficial
3. Análise de quais módulos já implementados são impactados
4. Atualização da arquitetura
5. Atualização de ADRs, se necessário
6. Atualização de diagramas de arquitetura
7. Avaliação se o Motor deve virar novo Bounded Context
8. **Nenhum código implementado agora**

Entrega esperada antes de qualquer código: análise arquitetural, impactos, plano de implementação, novos arquivos criados, dependências, riscos. Implementação só começa após aprovação explícita.
