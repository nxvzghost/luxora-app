# PD-001 — Dependências

## Dentro do próprio PD-001

```
Fase 1 (Centralização)
   └── bloqueia → Fase 2 (Exceções/Recorrência)
                     └── bloqueia → Fase 3 (Assistente conversacional)
                                       └── bloqueia → Fase 4 (Importação externa + monitoramento)
```

Ordem estrita — cada fase depende da anterior estar completa e testada.

## Com módulos já implementados

| Depende de | Por quê |
|---|---|
| Módulo 02 (Domain Core) | `ScheduleSlot` já existe lá, migra de lá |
| Módulo 06 (Terapeuta) | `Therapist.availability` sai de lá — mudança de contrato da entidade |
| Módulo 07 (Agenda) | `AgendarConsultaUseCase`/`RemarcarConsultaUseCase`/`CriarAgendamentoRecorrenteUseCase` mudam de comportamento |
| Módulo 10 (Auditoria) | Novos eventos do Motor precisam ser auditáveis — mecanismo já existe, só precisa ser usado |
| Módulo 12 (IA) | `IntentActionRouter` muda — depende do Motor existir antes de poder ser corrigido |
| Módulo 14 (Automações) | Renovação automática usa o mesmo padrão de gatilho externo já construído |

## Dependências externas (fora do código)

- **Google Calendar API** (Fase 4) — precisa de credenciais OAuth próprias, mesma categoria de decisão que Asaas foi (ADR-0037) — quem tem a conta/projeto Google da Luxora precisa criar as credenciais antes da Fase 4 começar.
- **Nenhuma dependência de Asaas, WhatsApp ou Anthropic diretamente** — o Motor em si é lógica de domínio pura.

## Dependência de ambiente

Mesma limitação já registrada em todo o projeto: qualquer teste contra Google Calendar real (Fase 4) exige rede, que não existe neste ambiente de desenvolvimento — a implementação pode ser escrita com testes unitários mockados, mas validação real depende do ambiente onde o Pedro rodar o projeto.
