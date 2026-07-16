\# 01 - Diagrama ER



\## Objetivo



Este documento apresenta o Modelo Entidade-Relacionamento (ER) da camada de persistência da plataforma Luxora.



Seu objetivo é representar visualmente a estrutura conceitual do banco de dados, demonstrando como as principais entidades se relacionam antes da implementação física.



Este diagrama serve como referência para modelagem, migrations, Prisma Schema e evolução futura da base de dados.



\---



\# Diagrama Principal



> \*(Inserir aqui o Diagrama ER atualizado da plataforma.)\*



```mermaid

erDiagram



&#x20;   TENANT ||--o{ USER : possui



&#x20;   TENANT ||--o{ THERAPIST : possui



&#x20;   TENANT ||--o{ PATIENT : possui



&#x20;   PATIENT ||--o{ SESSION : realiza



&#x20;   SESSION ||--o{ BILLING\_SESSION : associa



&#x20;   BILLING ||--o{ BILLING\_SESSION : agrega



&#x20;   BILLING ||--|| PAYMENT : recebe

```



\---



\# Entidades Principais



\## Tenant



Representa uma clínica cadastrada na plataforma.



Todo dado armazenado pertence obrigatoriamente a um Tenant.



\---



\## User



Usuário autenticado da plataforma.



Responsável por acessar e operar o sistema conforme suas permissões.



\---



\## Therapist



Profissional responsável pelos atendimentos clínicos.



\---



\## Patient



Representa um paciente pertencente à clínica.



É o elemento central do domínio operacional.



\---



\## Session



Representa um atendimento realizado ou agendado.



É a principal entidade operacional da plataforma.



\---



\## Billing



Representa uma cobrança gerada por uma sessão.



\---



\## Payment



Representa a liquidação financeira de uma cobrança.



\---



\# Princípios da Modelagem



O modelo segue alguns princípios fundamentais.



\- Toda entidade pertence a um Tenant.

\- UUID como chave primária.

\- Relacionamentos explícitos.

\- Integridade referencial obrigatória.

\- Normalização até onde fizer sentido para o domínio.

\- Evolução incremental através de migrations.



\---



\# Convenções



Toda modelagem deverá seguir os seguintes padrões.



\- Nome das tabelas em inglês.

\- Singular para entidades.

\- snake\_case para colunas.

\- UUID como Primary Key.

\- Foreign Keys explícitas.

\- Soft Delete quando aplicável.

\- created\_at

\- updated\_at

\- deleted\_at (quando necessário)



\---



\# Escopo



Este documento representa apenas a visão conceitual da estrutura relacional.



Não contempla.



\- Tipos SQL.

\- Índices.

\- Constraints.

\- Views.

\- Triggers.

\- Performance.

\- Particionamento.

\- Estratégias de consulta.



Esses tópicos possuem documentação própria.



\---



\# Documentos Relacionados



\- 00 - Conceitos

\- 02 - Tabelas

\- 03 - Relacionamentos

\- 04 - Índices

\- 05 - Constraints

\- 06 - Migrations

\- 09 - Multi-Tenant



\---



\# Observações



Este documento representa a estrutura principal da camada de persistência da Luxora.



Toda evolução do banco deverá preservar a consistência entre o domínio da aplicação e sua representação relacional.



O Diagrama ER é considerado a referência visual oficial da modelagem do banco de dados.

