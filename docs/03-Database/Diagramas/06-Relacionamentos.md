\# 06 - Relacionamentos



\## Objetivo



Este documento apresenta os principais relacionamentos existentes entre as entidades do domínio da plataforma Luxora.



Seu objetivo é demonstrar como as entidades interagem entre si dentro da operação da clínica, servindo como complemento ao Diagrama ER e como referência para implementação da camada de domínio.



Este documento representa apenas os relacionamentos principais da plataforma.



\---



\## Diagrama de Relacionamentos



```mermaid

erDiagram



&#x20;   CLINICA ||--o{ TERAPEUTA : possui



&#x20;   TERAPEUTA ||--o{ PACIENTE : atende



&#x20;   PACIENTE ||--o{ SESSAO : participa



&#x20;   SESSAO ||--|| COBRANCA : gera



&#x20;   COBRANCA ||--|| PAGAMENTO : liquida

```



\---



\## Relacionamentos



\### Clínica → Terapeuta



Uma clínica pode possuir diversos profissionais.



Cada terapeuta pertence exclusivamente a uma única clínica.



\---



\### Terapeuta → Paciente



Cada terapeuta acompanha diversos pacientes.



Um paciente pode permanecer vinculado ao mesmo terapeuta durante todo o tratamento ou ser transferido conforme as regras da clínica.



\---



\### Paciente → Sessão



Cada paciente pode possuir inúmeras sessões.



A sessão representa uma unidade operacional do atendimento.



\---



\### Sessão → Cobrança



Após a realização de uma sessão é gerada uma cobrança correspondente.



Cada cobrança pertence exclusivamente a uma sessão.



\---



\### Cobrança → Pagamento



Uma cobrança pode ser liquidada através de um pagamento.



Durante o MVP considera-se uma relação 1:1.



\---



\## Dependências do Domínio



Os relacionamentos seguem uma ordem lógica de dependência.



```text

Clínica



↓



Terapeuta



↓



Paciente



↓



Sessão



↓



Cobrança



↓



Pagamento

```



Uma entidade superior sempre deve existir antes da criação da entidade seguinte.



\---



\## Princípios



Os relacionamentos da plataforma seguem alguns princípios fundamentais.



\- Todo relacionamento pertence a um Tenant.

\- Nenhuma entidade pode existir sem sua entidade de origem.

\- As dependências seguem o fluxo natural da operação clínica.

\- Toda alteração deve preservar a integridade referencial.

\- Os relacionamentos representam vínculos do domínio e não apenas chaves estrangeiras.



\---



\## Escopo



Este documento descreve apenas os relacionamentos conceituais entre entidades.



Não contempla:



\- Tipos de dados;

\- Índices;

\- Constraints;

\- Estratégias de persistência;

\- Regras financeiras;

\- Eventos de domínio.



Esses assuntos possuem documentação própria.



\---



\## Documentos Relacionados



\- 01 - Visão Geral

\- 02 - Diagrama ER

\- 03 - Domínio

\- 04 - Multi-Tenant

\- 05 - Auditoria

\- 07 - Ciclo de Vida

\- 08 - Fluxo de Dados



\---



\## Observações



Os relacionamentos apresentados representam a estrutura principal do domínio da Luxora.



Novos módulos poderão introduzir novas entidades e relacionamentos, desde que preservem a consistência do domínio e mantenham a integridade entre as entidades existentes.



Este documento complementa o Diagrama ER, oferecendo uma visão mais orientada ao domínio do negócio do que à modelagem física do banco de dados.



