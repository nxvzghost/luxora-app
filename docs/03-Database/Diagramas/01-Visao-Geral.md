\# 01 - Visão Geral



\## Objetivo



Este documento apresenta uma visão macro da estrutura operacional da plataforma Luxora.



Seu objetivo é permitir que qualquer engenheiro, arquiteto de software ou inteligência artificial compreenda rapidamente os principais elementos do domínio e como eles se relacionam, antes de aprofundar-se nos demais diagramas e documentações.



Este não é um diagrama de banco de dados nem um diagrama completo do domínio. Trata-se apenas de uma representação conceitual da operação principal da plataforma.



\---



\## Visão Geral



```mermaid

graph TD



&#x20;   Tenant(Clínica) --> Terapeuta

&#x20;   Tenant --> Paciente



&#x20;   Paciente --> Sessao



&#x20;   Sessao --> Cobranca



&#x20;   Cobranca --> Pagamento



&#x20;   Sessao --> FollowUp

```



\---



\## Fluxo Operacional



Em alto nível, a operação da plataforma ocorre na seguinte ordem:



1\. Uma Clínica (Tenant) administra toda sua operação dentro da plataforma.



2\. A clínica possui profissionais responsáveis pelos atendimentos.



3\. Os pacientes pertencem à clínica e iniciam sua jornada através do agendamento de sessões.



4\. Cada sessão representa um atendimento realizado ou planejado.



5\. Após a realização da sessão, é gerada uma cobrança correspondente.



6\. A cobrança é posteriormente liquidada através de um pagamento.



7\. Após o atendimento podem existir ações de acompanhamento (Follow-up), encerrando ou dando continuidade ao tratamento.



\---



\## Princípios



Este diagrama segue alguns princípios arquiteturais importantes da Luxora.



\- Toda operação pertence a um único Tenant.

\- O Paciente é o centro do domínio operacional.

\- Sessões representam o principal evento operacional da plataforma.

\- Cobranças sempre são originadas por sessões.

\- Pagamentos sempre pertencem a uma cobrança.

\- O Follow-up representa a continuidade do relacionamento após um atendimento.



\---



\## Escopo



Este documento apresenta apenas a visão macro da plataforma.



Detalhes de implementação podem ser encontrados nos documentos específicos:



\- 02 - Diagrama ER

\- 03 - Domínio

\- 04 - Multi-Tenant

\- 05 - Auditoria

\- 06 - Relacionamentos

\- 07 - Ciclo de Vida

\- 08 - Fluxo de Dados



\---



\## Observações



Este documento não representa:



\- Modelo físico do banco de dados;

\- Cardinalidades;

\- Regras de negócio;

\- Fluxos completos;

\- Estados da aplicação.



Seu objetivo é apenas apresentar uma visão executiva da arquitetura do domínio.



