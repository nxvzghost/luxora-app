# 07 — Event Storming: Jornada do Paciente pelo WhatsApp

**Status:** Documento Oficial — Marco 1 da Arquitetura do Vertex.
**Escopo:** fluxo de domínio completo, do primeiro contato ao encerramento da conversa. Sem banco de dados, sem API, sem código — exclusivamente Comando → Aggregate → Evento → Política → Processo de Longa Duração (Process Manager).

Convenção: **Comando** (intenção, verbo no infinitivo) → **Aggregate** (quem decide) → **Evento de domínio** (fato consumado, particípio passado) → **Política** (regra reativa "sempre que X, então Y") → **Process Manager** (só quando há coordenação real ao longo do tempo) → **Evento publicado** → **Estado resultante**.

---

## 1. Primeiro contato

| | |
|---|---|
| Comando | `ReconhecerOuCriarContato` |
| Aggregate | `Contact` (novo) |
| Evento de domínio | `ContatoCriado` |
| Política | Mensagem chega de telefone sem Contact nem Patient correspondente → disparar `ReconhecerOuCriarContato` |
| Process Manager | **Processo de Qualificação do Contato** — inicia aqui, coordena tudo até promoção ou arquivamento |
| Evento publicado | `ContatoCriado` |
| Estado resultante | Contact.estado = `Novo` |

## 2. Pergunta simples ("vocês atendem Unimed?")

| | |
|---|---|
| Comando | `RegistrarInteracao` |
| Aggregate | `Contact` |
| Evento de domínio | `ContatoInteragiu` |
| Política | Nenhuma cross-aggregate — só avança Contact de `Novo` para `Conversando` |
| Process Manager | Mesmo Processo de Qualificação, permanece em espera (não avança para Identificado sem nome) |
| Evento publicado | `ContatoInteragiu` |
| Estado resultante | Contact.estado = `Conversando`, sem nome. Sem resposta futura, o Processo de Qualificação aciona o Cenário 15 depois do prazo de retenção |

## 3. Agendamento

| | |
|---|---|
| Comando | (a) `PromoverContatoParaPaciente` — só se ainda não promovido; (b) `AgendarConsulta` |
| Aggregate | (a) `Contact`; (b) `Appointment` |
| Evento de domínio | (a) `ContatoPromovidoParaPaciente`; (b) `ConsultaAgendada` |
| Política | Sempre que `ContatoPromovidoParaPaciente` (ou já Vinculado) e há intenção de agendar, então disparar `AgendarConsulta` |
| Process Manager | Este é o evento que **encerra** o Processo de Qualificação do Contato |
| Evento publicado | `ContatoPromovidoParaPaciente`, `ConsultaAgendada` |
| Estado resultante | Contact.estado = `Promovido` (permanece ativo como canal); Patient criado/referenciado; Appointment.state = `Reservada` |

## 4. Consulta de horários (exploratória)

| | |
|---|---|
| Comando | `ConsultarHorariosDisponiveis` — é uma Query, não um Comando que muda estado |
| Aggregate | Nenhum — consulta direta ao Motor de Disponibilidade |
| Evento de domínio | **Nenhum** — nada aconteceu no domínio, só uma pergunta respondida |
| Estado resultante | Nenhuma mudança em nenhum Aggregate |

Nem toda etapa da jornada é um evento de domínio — forçar um evento aqui seria artificial.

## 5. Confirmação

| | |
|---|---|
| Comando | `ConfirmarConsulta` |
| Aggregate | `Appointment` → dispara `Session` |
| Evento de domínio | `ConsultaConfirmada`, `SessaoCriada` |
| Política | Sempre que `ConsultaConfirmada`, então criar Sessão |
| Evento publicado | `ConsultaConfirmada`, `SessaoCriada` |
| Estado resultante | Appointment.state = `Confirmada`; Session criada |

## 6. Reagendamento

| | |
|---|---|
| Comando | `RemarcarConsulta` |
| Aggregate | `Appointment` |
| Evento de domínio | `ConsultaRemarcada` |
| Política | Sempre que `ConsultaRemarcada`, então reverificar disponibilidade do novo horário |
| Evento publicado | `ConsultaRemarcada` |
| Estado resultante | Appointment mantém identidade, novo horário |

## 7. Cancelamento

| | |
|---|---|
| Comando | `CancelarConsulta` |
| Aggregate | `Appointment` |
| Evento de domínio | `ConsultaCancelada` |
| Evento publicado | `ConsultaCancelada` |
| Estado resultante | Appointment.state = `Cancelada` — Patient permanece existindo (agendar é o que promove; cancelar depois não desfaz) |

## 8. Cobrança

| | |
|---|---|
| Comando | `GerarCobranca` |
| Aggregate | `Billing` |
| Política | Ciclo de cobrança do paciente fecha → gerar cobrança; `CobrancaGerada` → enviar mensagem pelo WhatsApp |
| Process Manager | **Processo de Fechamento de Ciclo Financeiro** — agrega N sessões ao longo do período de cobrança do paciente, com estado próprio, até fechar |
| Evento publicado | `CobrancaGerada` |
| Estado resultante | Billing.state = `Criada` → `Enviada` |

## 9. Pagamento

| | |
|---|---|
| Comando | `RegistrarPagamento` |
| Aggregate | `Payment` |
| Política | `PagamentoRegistrado` reconcilia com cobrança → quitar Billing |
| Process Manager | Continuação do Processo de Fechamento de Ciclo Financeiro — termina aqui, ou desvia para régua de inadimplência |
| Evento publicado | `PagamentoRegistrado`, `CobrancaQuitada` |
| Estado resultante | Payment.state = `Confirmado`; Billing.state = `Quitada` |

## 10. Reativação após meses

| | |
|---|---|
| Comando | `ReconhecerOuCriarContato` (mesmo comando do Cenário 1 — busca encontra Patient vinculado) |
| Aggregate | `Patient` |
| Evento de domínio | `PacienteReativado` |
| Política | Contact conhecido interage e o Patient vinculado está Inativo → reativar |
| Evento publicado | `PacienteReativado` |
| Estado resultante | Patient.state: `Inativo → Ativo` |

## 11. Responsável falando por paciente

| | |
|---|---|
| Comando | `AssociarContatoAPaciente` (papel = `responsavel_por`) |
| Aggregate | `Contact` (associação) + `Patient` (criado ou referenciado) |
| Evento de domínio | `ContatoAssociadoAPaciente` |
| Política | IA identifica paciente diferente do interlocutor → confirmar antes de associar, nunca assumir |
| Process Manager | Processo de Qualificação ganha passo extra de desambiguação |
| Evento publicado | `ContatoAssociadoAPaciente` |
| Estado resultante | Associação Contact↔Patient com papel `responsavel_por`; Patient (dependente) criado/referenciado |

## 12. Casal compartilhando telefone

| | |
|---|---|
| Comando | `DesambiguarFalante` |
| Aggregate | `Contact` (múltiplas associações) |
| Evento de domínio | **Nenhum evento durável** — resolução de contexto por turno de conversa |
| Política | Contact com mais de um Patient associado e mensagem ambígua → perguntar antes de agir |
| Estado resultante | Nenhuma mudança até a ambiguidade ser resolvida — só então segue para o Cenário 3 |

## 13. Troca de número

| | |
|---|---|
| Comando | `VincularNovoTelefoneAoPaciente` |
| Aggregate | `Contact` (novo) + associação a `Patient` existente |
| Evento de domínio | `ContatoVinculadoAPacienteExistente` |
| Política | Número novo se identificando como paciente conhecido → nunca vincular automaticamente, encaminhar para confirmação |
| Process Manager | Processo de Qualificação trata como bifurcação especial, aguardando confirmação |
| Evento publicado | `ContatoVinculadoAPacienteExistente` (só após confirmação) |
| Estado resultante | Novo Contact associado ao Patient antigo; Contact do número antigo permanece no histórico |

## 14. Paciente cadastrado pelo painel, manda mensagem meses depois

| | |
|---|---|
| Comando | `ReconhecerOuCriarContato` — busca por telefone normalizado bate direto com Patient existente |
| Aggregate | `Patient` (referenciado) + `Contact` (criado, já associado) |
| Evento de domínio | `ContatoReconciliadoComPacienteExistente` |
| Política | Telefone normalizado bate com Patient existente → pular qualificação, associar direto |
| Evento publicado | `ContatoReconciliadoComPacienteExistente` |
| Estado resultante | Contact nasce já `Vinculado` (nunca passa por Novo/Conversando); Patient inalterado |

## 15. Contato que nunca virou paciente

| | |
|---|---|
| Comando | Nenhum — ausência de interação ao longo do tempo |
| Aggregate | `Contact` |
| Evento de domínio | `ContatoArquivado`, depois `ContatoAnonimizado` |
| Política | Contact em Novo/Conversando sem interação por N dias → arquivar; depois de mais tempo → anonimizar |
| Process Manager | **Processo de Retenção/Expurgo de Contato** — orientado a tempo (timer), não a ação de usuário |
| Evento publicado | `ContatoArquivado`, `ContatoAnonimizado` |
| Estado resultante | Contact.state = `Arquivado` → `Descartado` |

---

## Diagrama textual do fluxo completo

```
                         ┌─────────────────────────┐
                         │ Mensagem recebida        │
                         │ (telefone qualquer)      │
                         └────────────┬─────────────┘
                                      │
                    Comando: ReconhecerOuCriarContato
                                      │
        ┌─────────────────┬──────────┴───────────┬──────────────────────┐
        │                 │                       │                     │
  Telefone bate     Telefone bate            Telefone bate         Telefone
  com Contact        com Patient              com Contact          totalmente
  existente          existente (14)           existente,           novo
        │            (cadastro via            outro Patient        │
        │            painel)                  associado (12)       │
        │                 │                       │                ▼
        │                 ▼                       ▼        Contact CRIADO
        │      Contact nasce Vinculado    DesambiguarFalante  estado: Novo
        │      (pula qualificação)         (Cenário 12)             │
        │                 │                       │           ContatoInteragiu
        ▼                 │                       │           (Cenário 2)
Patient Inativo?          │                       │                 │
        │                 │                       │          ┌──────┴──────┐
   sim  │  não            │                       │      nome dado?   nunca mais
        ▼      ▼          │                       │          │        responde
PacienteReativado         │                       │       Identificado    │
(Cenário 10)              │                       │          │            ▼
        │                 │                       │     Contato conhece  Processo de
        └─────────────────┴───────┬───────────────┘     um Patient?      Retenção
                                  │                       │   │       (Cenário 15)
                          Intent interpretado         sim │   │ não     │
                          pela IA                          │   │        ▼
                                  │                         ▼   ▼   Arquivado
              ┌───────────────────┼──────────────────┐  Vinculado  → Descartado
              │                   │                  │      │
       "quero agendar"    "quais horários      responsável   │
              │             vocês têm?"        por outro   Qualificado
              │             (Cenário 4,        paciente?          │
              │              é Query,          (Cenário 11)  PromoverContato
              │              sem evento)              │      ParaPaciente
              │                   │                   ▼            │
              │           resposta direta,   ContatoAssociadoA      │
              │           sem mudar estado    Paciente (papel)      │
              │                   │                   │             │
              └───────────────────┴───────────────────┴─────────────┘
                                  │
                          ConsultaAgendada
                          (Appointment: Reservada)
                                  │
                    ┌─────────────┼─────────────┐
                    │             │             │
            RemarcarConsulta  ConfirmarConsulta  CancelarConsulta
             (Cenário 6)       (Cenário 5)        (Cenário 7)
                    │             │             │
             ConsultaRemarcada  ConsultaConfirmada  ConsultaCancelada
                    │             │             │
                    │       SessaoCriada         │
                    │             │             │
                    │    [Processo de Fechamento │
                    │     de Ciclo Financeiro]   │
                    │             │             │
                    │      CobrancaGerada        │
                    │      (Cenário 8)           │
                    │             │             │
                    │    EnviarCobranca          │
                    │    (WhatsApp)              │
                    │             │             │
                    │      PagamentoRegistrado   │
                    │      (Cenário 9)           │
                    │             │             │
                    │      CobrancaQuitada       │
                    │             │             │
                    └─────────────┴─────────────┘
                                  │
                     Patient permanece Ativo,
                     Contact permanece vivo como canal
                                  │
                            (meses depois)
                                  │
                                  ▼
                    Volta ao topo: "Mensagem recebida"
                    → reconhecido direto via Contact↔Patient
                    → PacienteReativado (Cenário 10)

        [Troca de número — Cenário 13, ramo à parte:]
        Novo Contact criado → identifica-se como paciente conhecido
        → NUNCA vincula automático → aguarda confirmação
        → ContatoVinculadoAPacienteExistente
        → Contact antigo permanece no histórico, nunca apagado
```

## Documentos relacionados

- `06-Decisoes-de-Dominio-WhatsApp.md` — síntese das decisões
- `08-Contact-e-Identidade-de-Comunicacao.md` — detalhe do Aggregate Contact
- `11-Aggregates-e-Limites.md`, `12-Domain-Events.md`, `13-Process-Managers.md`
