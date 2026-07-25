# 01 - Contratos REST

## Objetivo

Este documento define os endpoints da API para os módulos já especificados no PRD e no Backend, seguindo os princípios de `00-Principios-da-API.md`. Cada endpoint referencia o Caso de Uso e o(s) Requisito(s) Funcional(is) do PRD que implementa.

Escopo: módulos do MVP (Clínica, Terapeuta, Paciente, Agenda/Agendamento, Sessão, Financeiro, Dashboard, Auth). IA, WhatsApp e Follow-up avançado seguem o mesmo padrão e serão detalhados quando esses módulos entrarem em desenvolvimento (ver plano de implementação do relatório de arquitetura).

Qual papel (`admin`/`therapist`/`super_admin`) cada rota mutante exige não é repetido aqui — fonte única: `docs/02-Arquitetura/16-Politica-RBAC.md`.

---

# Auth

| Método | Rota | Caso de Uso | RF relacionado |
|---|---|---|---|
| POST | `/api/v1/auth/login` | AutenticarUsuario | — (`06-Autenticacao.md`) |
| POST | `/api/v1/auth/refresh` | RenovarSessao | — |
| POST | `/api/v1/auth/logout` | EncerrarSessao | — |
| POST | `/api/v1/auth/forgot-password` | SolicitarRecuperacaoSenha | — |

---

# Clínica (`/api/v1/clinic`)

Recurso singular por Tenant — cada Clínica só acessa os próprios dados via contexto do JWT, sem necessidade de `{id}` na rota.

| Método | Rota | Caso de Uso | RF relacionado |
|---|---|---|---|
| GET | `/api/v1/clinic` | ConsultarClinica | RF-001 |
| PATCH | `/api/v1/clinic` | AtualizarClinica | RF-002 a RF-009 |
| PUT | `/api/v1/clinic/policies` | AtualizarPoliticasClinica | RF-010 a RF-012 (Princípio 11 — Configuração acima de Programação) |

---

# Terapeutas (`/api/v1/therapists`)

| Método | Rota | Caso de Uso | RF relacionado |
|---|---|---|---|
| GET | `/api/v1/therapists` | ListarTerapeutas | — |
| POST | `/api/v1/therapists` | CadastrarTerapeuta | RF-015 a RF-025 |
| GET | `/api/v1/therapists/{id}` | ConsultarTerapeuta | — |
| PATCH | `/api/v1/therapists/{id}` | AtualizarTerapeuta | RF-015 a RF-025 |
| PUT | `/api/v1/therapists/{id}/availability` | DefinirDisponibilidade | RF-019 a RF-022 |

---

# Pacientes (`/api/v1/patients`)

| Método | Rota | Caso de Uso | RF relacionado |
|---|---|---|---|
| GET | `/api/v1/patients` | ListarPacientes | — |
| POST | `/api/v1/patients` | CadastrarPaciente | RF-026 a RF-039 |
| GET | `/api/v1/patients/{id}` | ConsultarPaciente | — |
| PATCH | `/api/v1/patients/{id}` | AtualizarPaciente | RF-026 a RF-039 |
| GET | `/api/v1/patients/{id}/history` | ConsultarHistoricoPaciente | — |
| POST | `/api/v1/patients/{id}/deactivate` | InativarPaciente | Estado "Inativo" (`01-Domain/03-Maquina-de-Estados.md`) |
| POST | `/api/v1/patients/{id}/reactivate` | ReativarPaciente | JP-013 — Retorno |
| POST | `/api/v1/patients/{id}/discharge` | DarAltaPaciente | JP-014 — Alta |

---

# Agenda e Agendamento (`/api/v1/appointments`)

Ver `01-Domain/05-Linguagem-Ubiqua.md` para a distinção entre `appointment` (reserva de horário) e `session` (atendimento realizado).

| Método | Rota | Caso de Uso | RF relacionado |
|---|---|---|---|
| GET | `/api/v1/therapists/{id}/availability` | ConsultarDisponibilidade | RF-043, RF-058 |
| POST | `/api/v1/appointments` | AgendarConsulta | RF-051 |
| PATCH | `/api/v1/appointments/{id}/reschedule` | RemarcarConsulta | RF-052 |
| POST | `/api/v1/appointments/{id}/cancel` | CancelarConsulta | RF-053 |
| POST | `/api/v1/appointments/{id}/confirm` | ConfirmarConsulta | RF-054, RN e JP-004 |
| POST | `/api/v1/appointments/recurring` | CriarAgendamentoRecorrente | RF-059, JP-010 |

**Erro de negócio esperado:** `SESSION_CONFLICT` (409) quando o horário solicitado colide com bloqueio, férias ou outro agendamento — nunca deixado para validação apenas no Frontend (RF-044, Princípio 09).

---

# Sessões (`/api/v1/sessions`)

| Método | Rota | Caso de Uso | RF relacionado |
|---|---|---|---|
| GET | `/api/v1/sessions` | ListarSessoes | — |
| GET | `/api/v1/sessions/{id}` | ConsultarSessao | — |
| POST | `/api/v1/sessions/{id}/complete` | RegistrarSessaoRealizada | JP-006 — Sessão |

---

# Financeiro — Cobranças (`/api/v1/billings`)

Reflete o modelo N:N `session ↔ billing` via `billing_session`, corrigido em `03-Database/03-Relacionamentos.md`.

| Método | Rota | Caso de Uso | RF relacionado |
|---|---|---|---|
| GET | `/api/v1/billings` | ListarCobrancas | — |
| POST | `/api/v1/billings` | GerarCobranca | RF-071 (aceita `session_ids: []`, permitindo 1 ou N sessões conforme política da clínica) |
| GET | `/api/v1/billings/{id}` | ConsultarCobranca | — |
| POST | `/api/v1/billings/{id}/send` | EnviarCobranca | RF-075 |

---

# Financeiro — Pagamentos (`/api/v1/payments`)

| Método | Rota | Caso de Uso | RF relacionado |
|---|---|---|---|
| POST | `/api/v1/payments` | RegistrarPagamento | RF-072, RF-073 |
| GET | `/api/v1/payments/{id}` | ConsultarPagamento | — |
| POST | `/api/v1/payments/{id}/refund` | EstornarPagamento | Estado "Estornado" (`01-Domain/03-Maquina-de-Estados.md`) |

**Idempotência obrigatória:** `POST /payments` exige `Idempotency-Key` (ver `00-Principios-da-API.md`) — requisito direto de RNF-008 ("nunca registrar pagamentos duplicados").

---

# Rotina de Agenda para o Terapeuta (`/api/v1/agenda-summary`)

Endpoints de suporte à automação descrita em `05-IA/02-Rotina-de-Controle-de-Agenda.md` — voltados ao terapeuta, não ao paciente.

| Método | Rota | Caso de Uso | Documento relacionado |
|---|---|---|---|
| POST | `/api/v1/agenda-summary/send` | EnviarResumoAgendaDoDia | `05-IA/02-Rotina-de-Controle-de-Agenda.md` |
| POST | `/api/v1/agenda-summary/resend` | ReenviarAgendaAtualizada | `05-IA/02-Rotina-de-Controle-de-Agenda.md` |

Ambos os endpoints são acionados por automação (n8n, via ADR-0021), nunca chamados diretamente pelo Frontend.

---

# Dashboard (`/api/v1/dashboard`)

Somente leitura — nunca altera dados (mesmo princípio já definido em `02-Arquitetura/02-Arquitetura-Geral.md`, seção Dashboard).

| Método | Rota | RF relacionado |
|---|---|---|
| GET | `/api/v1/dashboard/summary` | RF-081 a RF-090 |
| GET | `/api/v1/dashboard/financial` | RF-083 a RF-085, RF-090 |
| GET | `/api/v1/dashboard/occupancy` | RF-088, RF-089 |

---

# Relatórios — Fechamento Mensal (`/api/v1/reports`)

Ver detalhamento completo em `06-UX/05-Fluxo-Fechamento-Mensal.md`.

| Método | Rota | Caso de Uso |
|---|---|---|
| GET | `/api/v1/reports/monthly-closing?month=YYYY-MM` | GerarFechamentoMensal |
| POST | `/api/v1/reports/monthly-closing/send` | Disparo do envio automático (acionado por n8n) |

---

# Auditoria (`/api/v1/audit-log`) — acesso restrito a Administrador

| Método | Rota | RF/RNF relacionado |
|---|---|---|
| GET | `/api/v1/audit-log` | RNF-006, `03-Database/08-Auditoria.md` |

---

# Documentos Relacionados

- 00 - Princípios da API
- 02-Arquitetura/03-Backend.md
- 01-Domain/05-Linguagem-Ubiqua.md
- 03-Database/03-Relacionamentos.md
- 00-PRD/PRD v1.0 (partes 1–5)
