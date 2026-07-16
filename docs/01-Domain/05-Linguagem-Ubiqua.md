# 05 - Linguagem Ubíqua

## Objetivo

Este documento consolida o vocabulário oficial de negócio da Luxora — a **Linguagem Ubíqua** exigida pelo princípio de Domain-Driven Design já adotado (ADR-0002).

Ele estava listado como "em desenvolvimento" desde a primeira versão da documentação de Domain. O conteúdo abaixo não é criado do zero: é a consolidação de termos que já existiam, dispersos, em quatro documentos diferentes — o Glossário do PRD, as Entidades do Domain, o Glossário Técnico da Arquitetura e os nomes de tabelas do Database — resolvendo as divergências encontradas entre eles.

---

# Princípio

Todo documento, todo nome de classe, toda tabela, todo endpoint de API e todo prompt de agente de IA devem usar exatamente os termos definidos aqui. Divergência de nomenclatura entre camadas (ex: um conceito chamado de um jeito no Domain e de outro no Database) é tratada como defeito de documentação, não como detalhe estilístico.

---

# Tabela de termos

| Termo de negócio (PT) | Nome técnico (Database/Código) | Definição |
|---|---|---|
| Clínica | `tenant` | Organização que utiliza a Luxora. Raiz do isolamento multi-tenant. |
| Terapeuta | `therapist` | Profissional responsável pelos atendimentos, vinculado a uma Clínica. |
| Paciente | `patient` | Pessoa atendida, vinculada a uma Clínica. |
| Usuário | `user` | Qualquer pessoa autenticada na plataforma (Terapeuta, Administrador etc. — ver `06-Autenticacao.md`). Conceito técnico de acesso, distinto de Terapeuta (papel de negócio). |
| Sessão | `session` | Atendimento realizado ou agendado entre Terapeuta e Paciente — o registro central da operação clínica-administrativa. |
| Agendamento | `appointment` | Reserva de horário na Agenda que **origina** uma Sessão. Ver nota de resolução abaixo. |
| Agenda | `AvailabilityCalendar` (Aggregate Root, Bounded Context `Availability` — ver ADR-0040) | Disponibilidade de horários de um Terapeuta. Não é mais atributo do Terapeuta: `AvailabilityCalendar` referencia `therapistId`, nunca o contrário (PD-001 / ADR-0040). |
| Cobrança | `billing` | Valor devido por um Paciente, podendo agregar uma ou mais Sessões (ver `03-Database/03-Relacionamentos.md`). |
| Pagamento | `payment` | Quitação de uma Cobrança. |
| Mensagem | `message` | Comunicação administrativa enviada a Paciente ou Terapeuta. |
| Follow-up | `follow_up` | Ação de acompanhamento administrativo para paciente sem retorno. |
| Regra / Política | `policy` | Configuração da Clínica que altera comportamento do sistema (cobrança, cancelamento, confirmação etc.). |
| Notificação | `notification` | Aviso enviado internamente (a Terapeuta ou Administrador), distinto de Mensagem (externa, a Paciente). |
| Motor Operacional | `Operational Engine` | Núcleo de decisão da plataforma (ADR-0001). Nunca chamado de outro nome em código ou documentação. |
| Motor de Disponibilidade | `AvailabilityCalendar.isAvailable()` (Bounded Context `Availability`) | Componente central que decide "esse horário está livre?" para todo o sistema (PD-001 / ADR-0040). Delegado pelo Motor Operacional, mesmo padrão de delegação já usado para o Policy Engine (ver ADR-0001). Nenhum módulo consulta agenda diretamente. |
| Agente | `AI Agent` | Componente de IA que interpreta linguagem natural e consulta o Motor Operacional — nunca decide sozinho (ADR-0006). |
| Tenant | `tenant` | Sinônimo técnico de Clínica, usado especificamente no contexto de isolamento multi-tenant. |

---

# Resolução de divergência: Sessão vs. Agendamento

A leitura conjunta do Domain (`01-Domain/01-Entidades.md`, que define apenas "Sessão" e "Agenda") e do Database (`03-Database/02-Tabelas.md`, que define tabelas `session` **e** `appointment` separadamente) revelava uma divergência não resolvida. Esta é a definição oficial, a partir desta versão:

- **`appointment`** representa a **reserva de horário** — o momento em que um horário é bloqueado na Agenda do Terapeuta para um Paciente. Corresponde aos estados iniciais da máquina de estados de Sessão (`Criada`, `Reservada`, `Confirmada`, `Reagendada`, `Cancelada`).
- **`session`** representa o **atendimento em si** — criado a partir de um `appointment` confirmado, e responsável pelos estados posteriores (`Realizada`, `Faturada`, `Recebida`).
- Um `appointment` sempre origina no máximo uma `session`; uma `session` sempre se origina de exatamente um `appointment`.
- No vocabulário de negócio (PT), "Sessão" continua sendo o termo usado no dia a dia para se referir tanto ao agendamento quanto ao atendimento — a distinção `appointment`/`session` é uma decisão técnica interna, não deve vazar para a comunicação com o cliente final nem para o Frontend.

Esta resolução deve ser refletida em `01-Domain/01-Entidades.md` e `01-Domain/03-Maquina-de-Estados.md` na próxima revisão desses documentos, adicionando "Agendamento" como conceito de domínio explícito, hoje implícito apenas na tabela `appointment`.

---

# Eventos de domínio e a Linguagem Ubíqua

Os nomes de eventos já definidos em `01-Domain/04-Eventos-de-Dominio.txt` seguem a Linguagem Ubíqua e devem continuar sendo a referência (ex: `SessaoCriada`, `CobrancaCriada`, `PagamentoConfirmado`), enquanto os equivalentes em inglês usados no Backend (`AppointmentCreated`, `PaymentConfirmed` — ver `02-Arquitetura/03-Backend.md`) são a tradução técnica direta desses mesmos conceitos. Nenhum evento novo deve ser criado sem entrada correspondente nesta tabela de termos.

---

# Regras

1. Nenhum termo novo de negócio entra em código, API ou prompt de IA sem antes ser adicionado a esta tabela.
2. Divergência de nome entre documentos é tratada como bug de documentação — corrigir aqui primeiro, depois propagar.
3. Termos em português são a referência para comunicação com o cliente e documentação de produto; termos em inglês são a referência para código, banco de dados e API.

---

# Documentos Relacionados

- 01-Domain/01-Entidades.md
- 01-Domain/02-Relacionamentos.md
- 01-Domain/03-Maquina-de-Estados.md
- 01-Domain/04-Eventos-de-Dominio.txt
- 02-Arquitetura/Glossario-Tecnico.md
- 03-Database/02-Tabelas.md
