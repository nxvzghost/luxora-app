\# 02 - Tabelas



\## Objetivo



Este documento apresenta todas as tabelas que compõem a camada de persistência da plataforma Luxora.



Seu objetivo é definir a responsabilidade de cada tabela dentro do banco de dados, servindo como referência para implementação, manutenção e evolução da estrutura relacional.



As definições aqui apresentadas representam o modelo lógico da aplicação.



\---



\# Organização



As tabelas estão organizadas por contexto de domínio.



\- Core

\- Identity

\- Clinical

\- Financial

\- Operational

\- Audit

\- Configuration



\---



\# Core



\## tenant



Representa uma clínica cadastrada na plataforma.



É a entidade raiz da arquitetura Multi-Tenant.



Toda informação armazenada no banco pertence obrigatoriamente a um Tenant.



\---



\# Identity



\## user



Representa usuários autenticados da plataforma.



Responsável pelo acesso ao sistema.



\---



\## role



Define perfis e permissões disponíveis.



\---



\## permission



Representa permissões específicas do sistema.



\---



\# Clinical



\## therapist



Profissionais responsáveis pelos atendimentos.



\---



\## patient



Representa pacientes cadastrados.



É a principal entidade do domínio clínico.



Possui um campo opcional `billing_policy_override` (ENUM: per\_session | weekly | monthly | null). Quando nulo, o paciente herda a política padrão da clínica (`clinic.default_billing_policy`, ver `09-Multi-Tenant.md`). Quando definido, prevalece sobre o padrão da clínica para todas as cobranças futuras desse paciente específico — confirmado como prática real: a maioria dos pacientes segue o padrão da clínica (tipicamente por sessão), enquanto pacientes fixos de longa data frequentemente têm política individual (semanal ou mensal).



\---



\## session



Representa um atendimento clínico.



Cada sessão pertence a um paciente.



\---



\## appointment



Representa agendamentos futuros.



Uma sessão pode originar um ou mais agendamentos dependendo das regras da clínica.



\---



\# Financial



\## billing



Representa cobranças geradas.



Uma cobrança pode representar uma sessão avulsa ou agregar várias sessões, conforme a política de cobrança da clínica (diária, semanal ou mensal).



\---



\## billing\_session



Tabela de associação entre \`billing\` e \`session\`.



Permite que uma cobrança agregue múltiplas sessões (cobrança semanal/mensal) ou represente uma única sessão (cobrança diária, antes ou após a consulta).



\---



\## payment



Representa pagamentos realizados.



\---



\## payment\_method



Métodos de pagamento aceitos.



\---



\# Operational



\## notification



Notificações enviadas ao usuário.



\---



\## follow\_up



Representa ações posteriores ao atendimento.



\---



\## integration



Integrações externas configuradas pela clínica.



\---



\# Audit



\## audit\_log



Histórico completo das operações críticas.



\---



\# Configuration



\## clinic\_settings



Configurações específicas da clínica.



Inclui `default_billing_policy` (ENUM: per\_session | weekly | monthly) — a política de cobrança aplicada por padrão a todo paciente novo, definida na Etapa 2 do onboarding (`06-UX/01-Fluxo-Configuracao-Clinica.md`). Pacientes individuais podem sobrescrever esse padrão via `patient.billing_policy_override` (ver `02-Tabelas.md`, seção patient).



\---



\## ai\_settings



Configurações relacionadas ao comportamento da IA.



\---



\# Convenções



Todas as tabelas seguem os seguintes padrões.



\- Nome em inglês.

\- Singular.

\- UUID como Primary Key.

\- snake\_case.

\- created\_at.

\- updated\_at.

\- deleted\_at quando aplicável.



\---



\# Escopo



Este documento apresenta apenas a responsabilidade de cada tabela.



Não contempla.



\- Colunas.

\- Tipos SQL.

\- Índices.

\- Constraints.

\- Views.

\- Triggers.



Esses assuntos possuem documentação própria.



\---



\# Documentos Relacionados



\- 00 - Conceitos

\- 01 - Diagrama ER

\- 03 - Relacionamentos

\- 04 - Índices

\- 05 - Constraints

\- 06 - Migrations

\- 09 - Multi-Tenant



\---



\# Observações



Novas tabelas deverão ser adicionadas respeitando a divisão por contexto de domínio.



Nenhuma tabela deverá existir sem representar um conceito real da plataforma Luxora.

