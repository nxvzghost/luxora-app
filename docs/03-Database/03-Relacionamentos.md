\# 03 - Relacionamentos



\## Objetivo



Este documento descreve os relacionamentos existentes entre as tabelas da camada de persistência da plataforma Luxora.



Seu objetivo é definir como as entidades do banco de dados se conectam, garantindo integridade referencial, consistência dos dados e alinhamento com o domínio da aplicação.



Os relacionamentos aqui definidos representam a implementação persistente do domínio documentado anteriormente.



\---



\# Filosofia



Na Luxora, relacionamentos existem para representar conceitos reais do negócio.



Toda Foreign Key deve possuir significado dentro do domínio.



Relacionamentos não devem ser criados apenas para facilitar consultas.



\---



\# Relacionamentos Principais



\## tenant → user



Um Tenant pode possuir vários usuários.



Todo usuário pertence obrigatoriamente a um único Tenant.



```

tenant (1)

&#x20;   │

&#x20;   └───────< user (N)

```



\---



\## tenant → therapist



Uma clínica pode possuir diversos terapeutas.



Cada terapeuta pertence a apenas uma clínica.



```

tenant (1)

&#x20;   │

&#x20;   └───────< therapist (N)

```



\---



\## tenant → patient



Uma clínica administra diversos pacientes.



Cada paciente pertence exclusivamente a um Tenant.



```

tenant (1)

&#x20;   │

&#x20;   └───────< patient (N)

```



\---



\## therapist → patient



Representa o vínculo clínico entre terapeuta e paciente.



Dependendo das regras do negócio, esse relacionamento poderá evoluir para uma tabela intermediária.



```

therapist (1)



&#x20;       │



&#x20;       └───────< patient (N)

```



> \*\*Observação:\*\* Caso futuramente um paciente possa ser atendido por múltiplos terapeutas, este relacionamento deverá ser remodelado para muitos-para-muitos utilizando uma tabela de associação.



\---



\## patient → session



Um paciente pode possuir inúmeras sessões.



Cada sessão pertence obrigatoriamente a um único paciente.



```

patient (1)



&#x20;     │



&#x20;     └────────< session (N)

```



\---



\## session ↔ billing (via billing\_session)



Cada clínica possui sua própria política de cobrança — diária (antes ou após a consulta), semanal ou mensal.



Isso significa que uma cobrança pode representar uma única sessão avulsa ou agregar várias sessões de um mesmo ciclo.



Para representar isso sem duas modelagens distintas, a relação entre \*\*session\*\* e \*\*billing\*\* é \*\*muitos-para-muitos\*\*, mediada pela tabela de associação \*\*billing\\\_session\*\*.



```

session (N)  ────< billing\_session >────  billing (1)

```



\### Regras



\- Uma \*\*billing\*\* sempre pertence a exatamente um Tenant e a um Paciente.

\- Uma \*\*billing\*\* referencia 1 ou mais \*\*session\*\* através de \*\*billing\\\_session\*\*.

\- Cobrança diária (antes/depois da consulta): 1 billing → 1 session (caso particular do modelo N:N, com N=1).

\- Cobrança semanal ou mensal: 1 billing → N sessions do mesmo período.

\- Uma \*\*session\*\* nunca pertence a mais de uma \*\*billing\*\* em aberto simultaneamente.



\### Tabela billing\_session



```

billing\_session

&#x20;   id UUID PK

&#x20;   tenant\_id UUID NOT NULL

&#x20;   billing\_id UUID NOT NULL (FK → billing)

&#x20;   session\_id UUID NOT NULL (FK → session)

&#x20;   created\_at TIMESTAMP

```



Constraint: \`UNIQUE (session\_id)\` enquanto a billing associada estiver em aberto — garante que a mesma sessão não seja cobrada duas vezes.



\---



\## billing → payment



Cada cobrança pode possuir um pagamento.



No MVP considera-se relação 1:1.



```

billing (1)



&#x20;     │



&#x20;     └──────── payment (1)

```



\---



\# Integridade Referencial



Todos os relacionamentos devem utilizar Foreign Keys explícitas.



Não serão aceitos relacionamentos implícitos ou dependentes apenas da aplicação.



Toda exclusão deverá respeitar as políticas de integridade definidas na documentação de Constraints.



\---



\# Regras Gerais



Os relacionamentos seguem alguns princípios.



\- Todo relacionamento pertence a um Tenant.

\- Nenhuma entidade pode existir sem sua entidade de origem.

\- As dependências devem refletir o domínio.

\- Toda Foreign Key deve possuir significado de negócio.

\- O banco representa o domínio, nunca o contrário.



\---



\# Evolução



Durante futuras versões poderão surgir novos relacionamentos como:



\- patient ↔ document

\- patient ↔ attachment

\- session ↔ prescription

\- therapist ↔ specialization

\- billing ↔ installment

\- payment ↔ refund



Essas evoluções deverão preservar compatibilidade com a arquitetura atual.



\---



\# Documentos Relacionados



\- 00 - Conceitos

\- 01 - Diagrama ER

\- 02 - Tabelas

\- 04 - Índices

\- 05 - Constraints

\- 09 - Multi-Tenant



\---



\# Observações



Os relacionamentos apresentados representam o estado atual da arquitetura da Luxora.



Alterações estruturais deverão ser refletidas simultaneamente na documentação do Domínio, Diagrama ER e Schema do banco de dados.



A consistência entre domínio e persistência é um princípio fundamental da plataforma.

