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

ADR-0056: `refresh` e `logout` recebem `{ "refreshToken": "..." }` no corpo. `refresh` responde 401 se o usuário foi desativado, se a sessão foi revogada ou se passou da duração máxima. `logout` revoga todos os refresh tokens do usuário e responde 204 (inclusive para token já inválido); sem `refreshToken` no corpo, responde 400. Só o access token é aceito como `Bearer` nas demais rotas.

---

# Usuários (`/api/v1/users`) — AD-001 (Epic 5, Gestão de Usuários)

Papel exigido por rota: fonte única `docs/02-Arquitetura/16-Politica-RBAC.md` (seções 1 e 3). Resumo: `GET` é aberto a qualquer autenticado do Tenant; `POST`/`PATCH`/`deactivate`/`reactivate` exigem `admin`; `bootstrap-admin` é a única rota pública deste recurso.

| Método | Rota | Caso de Uso | RF relacionado |
|---|---|---|---|
| POST | `/api/v1/users/bootstrap-admin` | ProvisionarPrimeiroAdminUseCase | — (provisionamento do primeiro administrador de um Tenant recém-criado; sem `JwtAuthGuard` — ver justificativa em `16-Politica-RBAC.md`, seção 3) |
| GET | `/api/v1/users` | ListarUsuariosUseCase | — |
| POST | `/api/v1/users` | CriarUsuarioUseCase | — |
| PATCH | `/api/v1/users/:id` | AtualizarUsuarioUseCase | — |
| POST | `/api/v1/users/:id/deactivate` | DesativarUsuarioUseCase | — |
| POST | `/api/v1/users/:id/reactivate` | ReativarUsuarioUseCase | — |

Notas de contrato:
- `POST /users/bootstrap-admin` — body `{ tenantId, email, password }`; só é aceito se o Tenant existir e tiver exatamente 0 usuários (garantido atomicamente, não por checagem de aplicação); retorna `201` com `{ accessToken, refreshToken }` (login imediato, sem passo extra); `404` se o Tenant não existir; `409` se o Tenant já tiver um admin (nunca cria um segundo, mesmo sob concorrência); protegido por rate limit dedicado (throttler nomeado `users-bootstrap-admin`, ver `docs/02-Arquitetura/06-Autenticacao.md`).
- `role` aceito em `POST`/`PATCH`: somente `admin` ou `therapist` — `super_admin` é sempre rejeitado com `400`, em 3 camadas independentes (tipo TypeScript, `class-validator`, invariante de domínio). `therapistId` é obrigatório quando `role: therapist` e deve referenciar um Terapeuta existente no mesmo Tenant (`400`/`404` caso contrário).
- Resposta de usuário nunca inclui `passwordHash`, em nenhuma rota.
- `deactivate`/`reactivate` são exclusão lógica (`deletedAt`), reaproveitando o mesmo padrão já usado por `Therapist`/`Patient` — um usuário desativado não consegue mais autenticar via `/auth/login`.

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
| PUT | `/api/v1/therapists/{id}/availability/exceptions` | DefinirExcecoesDisponibilidade | RF-019 a RF-022 |
| GET | `/api/v1/therapists/{id}/availability/calendar` | ConsultarCalendario | — (Tarefa 05 da auditoria) |

`GET .../availability/calendar` devolve o que está gravado — `{ therapistId, windows, exceptions }` — para o painel editar; responde 404 quando o terapeuta ainda não tem calendário. Não confundir com `GET .../availability` (seção Agenda), que devolve os horários livres já calculados.

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

**Tarefa 06 da auditoria (08/10/2026):** `GET /patients` pagina por cursor (`cursor`, `limit`, padrão 20); `limit` que não seja inteiro maior que zero responde 400 (antes, 500 ou comportamento indefinido). `PATCH /patients/{id}` passa a gravar o telefone — a rota aceitava o campo, devolvia o valor novo e não gravava nada.

---

# Contatos do WhatsApp — vínculo de número novo (`/api/v1/contacts`) — ADR-0063 (AD-038)

O mínimo para a clínica aprovar o vínculo de um número novo de WhatsApp a um paciente que já existe. As duas rotas são só de `admin`. Contato ou paciente de outra clínica responde 404 (RLS), como se não existisse.

| Método | Rota | Caso de Uso | Descrição |
|---|---|---|---|
| GET | `/api/v1/contacts/pending` | ListarContatosPendentes | Números que escreveram para a clínica e não identificam nenhum paciente — no máximo 100, os de atividade mais recente primeiro. Resposta: `{ "data": [{ "id", "phoneNumber", "name", "state", "createdAt" }] }`. `name` é o que a pessoa informou na conversa (ninguém o conferiu) ou `null`. |
| POST | `/api/v1/contacts/{id}/link` | VincularContatoAPaciente | Corpo: `{ "patientId": "<uuid>" }`. Aprova o vínculo: `201` com `{ "contactId", "patientId", "state": "Vinculado", "approvedByUserId", "approvedAt" }`. `400` identificador ou corpo inválido; `404` contato ou paciente inexistente; `409` contato que já tem paciente, ou número que já consta no cadastro de um paciente. |

Quem aprovou e quando ficam também na trilha de auditoria (ação `ContatoVinculadoAPacienteExistente`, ator `user`), gravada na **mesma transação** do vínculo: se o registro não puder ser gravado, a rota responde `500` e nada muda. `approvedByUserId` vem da sessão; `approvedAt` é tomado uma vez, dentro da transação. Duas aprovações simultâneas do mesmo contato — para pacientes diferentes ou para o mesmo — resultam em uma `201` e uma `409`, nunca em dois vínculos nem em dois registros. A aprovação **não altera** o telefone do cadastro do paciente, e não existe rota para desfazer um vínculo aprovado (pendência registrada na ADR-0063).

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

**Tarefa 06 da auditoria (08/10/2026):**
- `POST /appointments`, `POST /appointments/recurring` e a criação de horário fixo respondem **404** (`Paciente não encontrado.` / `Terapeuta não encontrado.`) quando o id informado não existe **ou é de outra clínica**. Antes, o id de um paciente de outra clínica era aceito (201) e um id inexistente respondia 500.
- `GET /appointments` e `GET /therapists/{id}/availability` exigem `from` e `to` como datas válidas; ausentes ou inválidos respondem **400** (antes, 500).

---

# Sessões (`/api/v1/sessions`)

| Método | Rota | Caso de Uso | RF relacionado |
|---|---|---|---|
| GET | `/api/v1/sessions` | ListarSessoes | — |
| GET | `/api/v1/sessions/{id}` | ConsultarSessao | — |
| POST | `/api/v1/sessions/{id}/complete` | RegistrarSessaoRealizada | JP-006 — Sessão |

**Estado em 08/10/2026:** das três, só `GET /sessions` existe no código, implementada na Tarefa 05 da auditoria (só leitura; qualquer usuário autenticado da clínica, com assinatura ativa). Filtros opcionais: `state` (`Realizada`, `Faturada` ou `Recebida`), `patientId` e `limit` (1 a 200, padrão 200); valor inválido responde 400. Cada item traz `id`, `appointmentId`, `patientId`, `therapistId`, `state` e `scheduledAt` (a data da consulta de origem). `state=Realizada` devolve as sessões ainda não cobradas — é de onde o painel monta uma cobrança nova. A sessão continua nascendo da confirmação da consulta, não de `POST /sessions/{id}/complete`.

---

# Financeiro — Cobranças (`/api/v1/billings`)

Reflete o modelo N:N `session ↔ billing` via `billing_session`, corrigido em `03-Database/03-Relacionamentos.md`.

| Método | Rota | Caso de Uso | RF relacionado |
|---|---|---|---|
| GET | `/api/v1/billings` | ListarCobrancas | — |
| POST | `/api/v1/billings` | GerarCobranca | RF-071 (aceita `session_ids: []`, permitindo 1 ou N sessões conforme política da clínica) |
| GET | `/api/v1/billings/{id}` | ConsultarCobranca | — |
| POST | `/api/v1/billings/{id}/send` | EnviarCobranca | RF-075 |
| GET | `/api/v1/billings/{id}/payments` | ListarPagamentosDaCobranca | — (Tarefa 05 da auditoria) |

Acrescentado na Tarefa 05 da auditoria (ADR-0061), sem mudar o que já existia:

- **`GET /billings` — campo `paymentState` em cada item:** o estado do pagamento da cobrança (`Recebido`, `EmConferencia`, `Confirmado`, `Divergente` ou `Estornado`), ou `null` quando não há pagamento. Um estorno deixa a cobrança em `Quitada` (ADR-0052); é por este campo que se sabe que o dinheiro foi devolvido. A lista continua paginada por cursor (`cursor`, `limit`, padrão 20) e não devolve `next_cursor`: uma página com `limit` itens pode ter continuação a partir do `id` do último.
- **`GET /billings/{id}/payments`:** devolve `{ data: [...] }` com o pagamento da cobrança — no máximo um, porque `payment.billing_id` é único — ou lista vazia. Cada item: `id`, `billingId`, `amount`, `state`. 404 para cobrança inexistente ou de outra clínica.
- **`POST /billings/{id}/send` — erro novo:** `WHATSAPP_NOT_CONNECTED` (409) quando a clínica não tem WhatsApp conectado e ativo. Nada é enfileirado e a cobrança continua em `Criada`. Com canal conectado, a resposta 201 significa que a mensagem entrou na fila de envio, não que foi entregue.
- **Cobrança `Enviada` pode ir direto a `Quitada`:** registrar o pagamento de uma cobrança já enviada respondia 500.
- **Campo `overdue` em toda cobrança devolvida** (`GET /billings`, `GET /billings/{id}`, `POST /billings`, `POST /billings/{id}/send`): `true` quando a cobrança está em atraso. Regra: estado `Atrasada`; ou estado `Criada`, `Enviada`, `Visualizada` ou `Pendente` com o vencimento passado há um dia inteiro ou mais (o dia do vencimento ainda está em dia; o corte é em UTC). `Quitada` e `Cancelada` nunca; `Negociada` e `Escalada` não entram. É a mesma regra de `overdueBillings` em `GET /dashboard/summary`. O estado gravado não muda. **O corte em UTC é o comportamento vigente, não o pretendido:** a decisão de 08/10/2026 ([ADR-0064](../02-Arquitetura/ADRs/ADR-0064-fuso-horario-por-clinica.md)) é que o atraso comece à meia-noite do dia seguinte ao vencimento, no fuso da clínica. Ainda não implementada (AD-039).

Tarefa 06 da auditoria (08/10/2026, ADR-0062):

- **`POST /billings` responde 404** quando o paciente ou alguma sessão informada não existe ou é de outra clínica, e **nada é gravado**. Antes, o paciente não era conferido e, com a sessão de outra clínica, a resposta era 404 mas o vínculo com essa sessão ficava gravado — a outra clínica não conseguia mais cobrá-la.
- **`limit` inválido responde 400** em `GET /billings` e em `GET /notifications` (inteiro maior que zero; antes, 500).

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

`GET /dashboard/summary` devolve `{ activePatients, overdueBillings, totalPending }`. Desde a Tarefa 05 da auditoria (ADR-0061), **`overdueBillings` conta as cobranças em atraso pelo vencimento**: estado `Atrasada`, ou estado que ainda aguarda pagamento (`Criada`, `Enviada`, `Visualizada`, `Pendente`) com o vencimento passado há um dia inteiro ou mais. Antes contava só o estado `Atrasada`, a que nenhum fluxo chega, e ficava sempre em zero. É a mesma regra do campo `overdue` das cobranças. `totalPending` não mudou: soma tudo que não está `Quitada` nem `Cancelada`.

---

# Notificações (`/api/v1/notifications`) — implementado no Epic 12 (AD-021)

Notificações internas por Tenant (isoladas por RLS), sem destinatário por usuário; papéis `admin` e `therapist`. `GET /notifications` usa paginação por cursor (`cursor`, `limit`, padrão 20; resposta com `data` e `next_cursor`).

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/v1/notifications` | Lista as notificações do Tenant |
| GET | `/api/v1/notifications/unread-count` | Devolve `{ "count": n }` com o total de não lidas |
| POST | `/api/v1/notifications/:id/read` | Marca a notificação como lida e a devolve |

Gatilhos: um pagamento registrado com valor divergente gera uma notificação `payment_divergent`; e, desde a ADR-0063 (09/10/2026), uma conversa do WhatsApp que o sistema não pode resolver sozinho gera `whatsapp_shared_number` (número de mais de um paciente), `whatsapp_link_request` (número novo que diz ser de um paciente), `whatsapp_possible_duplicate` (pedido de cadastro com nome que já existe) ou `whatsapp_human_review` — sempre com `entityType: "Contact"`, só os quatro últimos dígitos do número no texto e no máximo uma não lida por contato e por tipo. Não há canal externo (e-mail ou push).

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

**Contrato verificado por teste na Tarefa 06 da auditoria (08/10/2026, `test/critical/audit-log-read.test.ts`):** só `admin`, com assinatura ativa (terapeuta recebe 403). Devolve só as entradas da própria clínica, das mais recentes para as mais antigas. Paginação por cursor: `limit` (padrão 50) e `cursor` (o `id` da última entrada recebida); `limit` que não seja inteiro maior que zero responde 400; cursor inexistente devolve lista vazia, e o `id` de uma entrada de outra clínica usado como cursor nunca devolve entradas dela. Cada entrada traz `id`, `tenantId`, `userId`, `actorType`, `action`, `entityType`, `entityId`, `payload` e `result`. Ler a trilha não acrescenta entrada a ela, e nenhuma senha, hash de senha ou token do WhatsApp aparece no conteúdo.

---

# Documentos Relacionados

- 00 - Princípios da API
- 02-Arquitetura/03-Backend.md
- 01-Domain/05-Linguagem-Ubiqua.md
- 03-Database/03-Relacionamentos.md
- 00-PRD/PRD v1.0 (partes 1–5)
