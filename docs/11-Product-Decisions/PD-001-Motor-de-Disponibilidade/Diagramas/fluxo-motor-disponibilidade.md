# PD-001 — Diagrama: Fluxo Oficial do Motor de Disponibilidade

## Fluxo de agendamento (Fase 1 em diante)

```mermaid
sequenceDiagram
    participant P as Paciente
    participant W as WhatsApp Oficial da Clinica
    participant IA as Agente de IA
    participant M as Motor de Disponibilidade
    participant A as Agenda (Appointment)
    participant C as Confirmacao

    P->>W: Quero marcar uma consulta
    W->>IA: mensagem
    IA->>M: consultar horarios disponiveis
    M->>M: aplica janela padrao + excecoes + bloqueios recorrentes + agendamentos existentes
    M-->>IA: horarios livres
    IA-->>P: oferece horarios reais
    P->>IA: escolhe horario
    IA->>M: validar este horario especifico
    M-->>IA: confirmado disponivel
    IA->>A: criar Appointment
    A->>C: confirmacao enviada
    C-->>P: consulta confirmada
```

## Autoridade central — nenhum atalho

```mermaid
graph TD
    IA[Agente de IA] --> M[Motor de Disponibilidade]
    Agenda[Modulo Agenda] --> M
    Financeiro[Modulo Financeiro] --> M
    WhatsApp[Modulo Comunicacao] --> M
    Automacoes[Modulo Automacoes n8n] --> M
    Relatorios[Relatorios] --> M

    M --> DB[(AvailabilityCalendar por Terapeuta)]

    style M fill:#f0d9a8,stroke:#d9a441,stroke-width:2px
```

Leitura: todo módulo desenha uma seta PARA o Motor, nenhum módulo desenha uma seta direto pro banco de disponibilidade. Essa é a regra visual que resume o PD-001 inteiro.
