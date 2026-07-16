\# 05 - Constraints



\## Objetivo



Este documento define as restrições (Constraints) utilizadas na camada de persistência da plataforma Luxora.



Seu objetivo é garantir integridade, consistência e confiabilidade dos dados armazenados, impedindo que informações inválidas sejam persistidas no banco de dados.



As constraints representam regras estruturais da base de dados e complementam as validações realizadas pela aplicação.



\---



\# Filosofia



Na Luxora, a aplicação valida regras de negócio.



O banco de dados protege a integridade dos dados.



Mesmo que a aplicação falhe, a base de dados deve impedir estados inválidos.



\---



\# Tipos de Constraints



A plataforma utiliza os seguintes tipos de restrições.



\- Primary Key

\- Foreign Key

\- Unique

\- Not Null

\- Check

\- Default



\---



\# Primary Keys



Toda tabela possui obrigatoriamente uma chave primária.



Padrão:



\- UUID

\- NOT NULL

\- UNIQUE



\---



\# Foreign Keys



Todos os relacionamentos devem possuir Foreign Keys explícitas.



Objetivos:



\- garantir integridade referencial;

\- impedir registros órfãos;

\- manter consistência entre entidades.



\---



\# Unique Constraints



Serão utilizadas sempre que um valor não puder se repetir dentro do mesmo contexto.



Exemplos.



\## Tenant



\- slug



\---



\## User



\- email (por Tenant)



\---



\## Patient



\- document (por Tenant)



\---



\## Therapist



\- registration\_number (quando aplicável)



\---



\# Not Null



Campos obrigatórios deverão ser protegidos por NOT NULL.



Exemplos.



\- tenant\_id

\- created\_at

\- updated\_at

\- full\_name

\- status



\---



\# Check Constraints



Utilizadas para impedir valores inválidos.



Exemplos.



Status válidos.



```text

ACTIVE



INACTIVE



SUSPENDED

```



Valores financeiros.



```text

amount >= 0

```



Datas.



```text

due\_date >= created\_at

```



\---



\# Default Values



Sempre que possível utilizar valores padrão.



Exemplos.



```text

created\_at = now()



status = ACTIVE



deleted = false

```



\---



\# Regras Gerais



Toda constraint deve seguir os princípios abaixo.



\- Simplicidade.

\- Clareza.

\- Integridade.

\- Consistência.

\- Facilidade de manutenção.



\---



\# Boas Práticas



\- Nunca confiar apenas na aplicação.

\- Evitar regras complexas dentro do banco.

\- Utilizar CHECK apenas quando fizer sentido.

\- Evitar triggers para validações simples.

\- Toda constraint deve possuir justificativa.



\---



\# Escopo



Este documento descreve apenas as restrições estruturais do banco de dados.



Não contempla.



\- Regras de negócio.

\- Políticas da aplicação.

\- Permissões.

\- Fluxos operacionais.

\- Validações do Backend.



Esses aspectos pertencem às respectivas camadas da arquitetura.



\---



\# Documentos Relacionados



\- 00 - Conceitos

\- 01 - Diagrama ER

\- 02 - Tabelas

\- 03 - Relacionamentos

\- 04 - Índices

\- 06 - Migrations

\- 09 - Multi-Tenant



\---



\# Observações



As constraints representam a última camada de proteção da integridade dos dados.



Toda nova tabela criada na plataforma deverá seguir os padrões definidos neste documento.



Alterações em constraints deverão ser realizadas exclusivamente através de migrations versionadas e revisadas pela equipe de engenharia.

