\# 02 - Diagrama ER



\## Objetivo



Este documento apresenta o Modelo Entidade-Relacionamento (ER) da plataforma Luxora.



Seu objetivo é demonstrar como as principais entidades do domínio se relacionam entre si antes da implementação física do banco de dados.



Este diagrama representa apenas o relacionamento conceitual entre as entidades principais da plataforma. Estruturas físicas, índices, constraints e otimizações pertencem à documentação do banco de dados.



\---



\## Diagrama ER



```mermaid

erDiagram



&#x20;   CLINICA ||--o{ TERAPEUTA : possui



&#x20;   CLINICA ||--o{ PACIENTE : atende



&#x20;   PACIENTE ||--o{ SESSAO : realiza



&#x20;   SESSAO ||--o{ BILLING\_SESSION : associa



&#x20;   COBRANCA ||--o{ BILLING\_SESSION : agrega



&#x20;   COBRANCA ||--|| PAGAMENTO : recebe

```



\---



\## Explicação dos Relacionamentos



\### Clínica → Terapeuta



Uma clínica pode possuir diversos profissionais.



Cada terapeuta pertence a uma única clínica (Tenant).



\---



\### Clínica → Paciente



Cada clínica administra seus próprios pacientes.



Nenhum paciente pode pertencer simultaneamente a dois Tenants.



\---



\### Paciente → Sessão



Um paciente pode realizar inúmeras sessões durante sua jornada clínica.



Cada sessão pertence exclusivamente a um paciente.



\---



\### Sessão → Cobrança



Cada sessão gera uma cobrança correspondente.



A cobrança representa a obrigação financeira daquele atendimento.



\---



\### Cobrança → Pagamento



Uma cobrança é considerada encerrada quando recebe seu respectivo pagamento.



O pagamento representa a liquidação financeira da cobrança.



\---



\## Cardinalidades



| Relacionamento | Cardinalidade |

|----------------|---------------|

| Clínica → Terapeutas | 1 : N |

| Clínica → Pacientes | 1 : N |

| Paciente → Sessões | 1 : N |

| Sessão → Cobrança | 1 : 1 \*(MVP)\* |

| Cobrança → Pagamento | 1 : 1 \*(MVP)\* |



> \*\*Observação:\*\* As cardinalidades referentes a Cobranças e Pagamentos representam o escopo inicial do MVP e poderão evoluir para suportar parcelamentos, cobranças recorrentes ou múltiplos pagamentos no futuro.



\---



\## Princípios



O modelo segue alguns princípios fundamentais da plataforma:



\- Todo dado pertence a um Tenant.

\- Não existe Sessão sem Paciente.

\- Não existe Cobrança sem Sessão.

\- Não existe Pagamento sem Cobrança.

\- Toda relação deve preservar isolamento entre Tenants.



\---



\## Escopo



Este documento representa apenas o relacionamento conceitual entre entidades.



Não fazem parte deste diagrama:



\- Tipos de dados;

\- Chaves primárias;

\- Chaves estrangeiras;

\- Índices;

\- Constraints;

\- Estratégias de persistência;

\- Modelagem física do banco.



Esses elementos serão definidos posteriormente na documentação da camada de persistência.



\---



\## Documentos Relacionados



\- 01 - Visão Geral

\- 03 - Domínio

\- 04 - Multi-Tenant

\- 06 - Relacionamentos

\- 07 - Ciclo de Vida

\- Database Schema

\- Prisma Schema



\---



\## Observações



Este diagrama deve permanecer simples.



Sempre que novos módulos forem adicionados à plataforma, recomenda-se criar diagramas específicos por contexto de domínio, evitando transformar este documento em um diagrama excessivamente complexo.



Este documento deve representar apenas a estrutura central da plataforma Luxora.



