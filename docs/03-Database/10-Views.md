\# 10 - Views



\## Objetivo



Este documento define a estratégia de utilização de Views na camada de persistência da plataforma Luxora.



Seu objetivo é disponibilizar consultas reutilizáveis, organizadas e otimizadas para leitura, relatórios e integrações, preservando a separação entre persistência e regras de negócio.



As Views representam uma camada de abstração para consumo de dados consolidados.



\---



\# Filosofia



Na Luxora, Views existem para simplificar consultas.



Elas não substituem regras de negócio nem processamento realizado pelo Backend.



Toda lógica do domínio permanece na aplicação.



\---



\# Objetivos



As Views possuem quatro objetivos principais.



\- Simplificar consultas complexas.

\- Apoiar dashboards.

\- Facilitar relatórios.

\- Reutilizar consultas recorrentes.



\---



\# Tipos de Views



As Views poderão ser organizadas por contexto.



\## Clinical



Consultas relacionadas ao domínio clínico.



Exemplos.



\- vw\_active\_patients

\- vw\_patient\_history

\- vw\_today\_sessions



\---



\## Financial



Consultas financeiras.



Exemplos.



\- vw\_open\_billings

\- vw\_received\_payments

\- vw\_cash\_flow

\- patient\_financial\_segment — segmentação de pacientes por política de cobrança efetiva (por sessão/semanal/mensal) e status financeiro em 3 estágios (em dia / em atraso até 7 dias / inadimplente acima de 40 dias), usada pelo Dashboard Financeiro, pelo fechamento mensal e pela régua de comunicação de inadimplência (ver `05-IA/03-Gestao-de-Inadimplencia.md`)



\---



\## Operational



Consultas operacionais.



Exemplos.



\- vw\_dashboard\_metrics

\- vw\_pending\_followups

\- vw\_today\_schedule



\---



\## Audit



Consultas de auditoria.



Exemplos.



\- vw\_recent\_logs

\- vw\_user\_activity

\- vw\_security\_events



\---



\# Convenções



Toda View deverá seguir a nomenclatura.



```



vw\\\_<contexto>\\\_<nome>



```



Exemplos.



```



vw\_active\_patients



vw\_today\_schedule



vw\_pending\_payments



vw\_dashboard



```



\---



\# Regras



Toda View deverá.



\- Ser somente leitura.

\- Possuir responsabilidade única.

\- Ser reutilizável.

\- Possuir documentação.

\- Evitar consultas excessivamente complexas.



\---



\# Performance



Views devem ser utilizadas quando proporcionarem:



\- maior organização;

\- reutilização;

\- melhor legibilidade das consultas.



Quando necessário poderão evoluir para Materialized Views após análise de desempenho.



\---



\# Boas Práticas



\- Não colocar regras de negócio.

\- Não utilizar Views para mascarar problemas de modelagem.

\- Revisar periodicamente consultas pouco utilizadas.

\- Priorizar simplicidade.



\---



\# Escopo



Este documento trata exclusivamente da utilização de Views.



Não contempla.



\- Materialized Views.

\- Functions.

\- Triggers.

\- Procedures.

\- Relatórios da aplicação.



Esses assuntos possuem documentação própria.



\---



\# Documentos Relacionados



\- 02 - Tabelas

\- 03 - Relacionamentos

\- 04 - Índices

\- 08 - Functions

\- 09 - Triggers

\- 11 - Backup

\- 12 - Performance



\---



\# Observações



As Views representam uma camada de leitura da plataforma.



Toda View deverá permanecer alinhada ao domínio da aplicação e nunca substituir a lógica implementada no Backend.



Seu uso deverá priorizar organização, reutilização e facilidade de manutenção.



