\# 04 - Índices



\## Objetivo



Este documento define a estratégia de indexação da camada de persistência da plataforma Luxora.



Seu objetivo é estabelecer padrões para criação, manutenção e evolução dos índices do banco de dados, garantindo consultas eficientes sem comprometer a integridade e a capacidade de escrita da aplicação.



Os índices representam uma estratégia de otimização e não fazem parte do domínio da aplicação.



\---



\# Filosofia



Na Luxora, índices existem para acelerar consultas frequentes.



Nenhum índice deve ser criado sem justificar um benefício real para a aplicação.



Toda otimização deve ser baseada em necessidade operacional ou análise de desempenho.



\---



\# Estratégia Geral



Os índices serão classificados em quatro categorias:



\- Primary Indexes

\- Foreign Key Indexes

\- Search Indexes

\- Performance Indexes



\---



\# Primary Indexes



Toda tabela possui obrigatoriamente uma chave primária.



Exemplo:



\- tenant.id

\- user.id

\- therapist.id

\- patient.id

\- session.id

\- billing.id

\- payment.id



\---



\# Foreign Key Indexes



Toda Foreign Key deverá possuir índice próprio.



Exemplos:



\- tenant\_id

\- therapist\_id

\- patient\_id

\- session\_id

\- billing\_id

\- created\_by

\- updated\_by



Esses índices garantem desempenho adequado nas operações de JOIN.



\---



\# Search Indexes



Serão utilizados para consultas frequentes realizadas pelos usuários.



Exemplos:



\## Pacientes



\- document

\- phone

\- email

\- full\_name



\---



\## Sessões



\- scheduled\_at

\- status

\- therapist\_id

\- patient\_id



\---



\## Cobranças



\- due\_date

\- status

\- patient\_id



\---



\## Pagamentos



\- payment\_date

\- payment\_method



\---



\# Composite Indexes



Sempre que necessário poderão ser utilizados índices compostos.



Exemplos.



```text

tenant\_id + patient\_id



tenant\_id + status



tenant\_id + scheduled\_at



tenant\_id + due\_date

```



Esses índices tornam consultas multi-tenant significativamente mais eficientes.



\---



\# Regras



Os índices seguem alguns princípios.



\- Toda Primary Key possui índice.

\- Toda Foreign Key possui índice.

\- Índices compostos devem refletir consultas reais.

\- Evitar duplicidade de índices.

\- Remover índices não utilizados.

\- Toda alteração deve ser documentada.



\---



\# Convenções



Os índices seguirão nomenclatura padronizada.



Exemplos.



```text

idx\_patient\_document



idx\_patient\_email



idx\_session\_status



idx\_session\_schedule



idx\_billing\_due\_date



idx\_payment\_date

```



\---



\# Boas Práticas



\- Criar índices apenas quando necessários.

\- Priorizar leitura sem prejudicar escrita.

\- Revisar índices periodicamente.

\- Monitorar planos de execução.

\- Evitar excesso de índices.



\---



\# Escopo



Este documento descreve apenas estratégias de indexação.



Não contempla.



\- Particionamento.

\- Cache.

\- Materialized Views.

\- Query Optimization.

\- Replicação.

\- Performance de infraestrutura.



Esses assuntos possuem documentação própria.



\---



\# Documentos Relacionados



\- 00 - Conceitos

\- 01 - Diagrama ER

\- 02 - Tabelas

\- 03 - Relacionamentos

\- 05 - Constraints

\- 12 - Performance



\---



\# Observações



Os índices representam uma otimização da camada de persistência.



A criação de novos índices deverá sempre considerar o impacto sobre escrita, armazenamento e manutenção do banco de dados.



Toda decisão de indexação deve ser orientada por padrões de uso reais da plataforma.

