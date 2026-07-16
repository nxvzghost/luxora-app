\# 03 - Domínio



\## Objetivo



Este documento apresenta o fluxo central do domínio da plataforma Luxora.



Seu objetivo é demonstrar como as principais entidades operacionais interagem durante a jornada de um paciente, representando a essência do negócio antes de qualquer detalhe técnico de implementação.



Este documento descreve apenas o domínio principal da plataforma. Fluxos auxiliares, integrações, autenticação e infraestrutura são tratados em documentos específicos.



\---



\## Fluxo Principal do Domínio



```mermaid

graph LR



&#x20;   Paciente --> Sessao



&#x20;   Sessao --> Cobranca



&#x20;   Cobranca --> Pagamento



&#x20;   Paciente --> FollowUp

```



\---



\## Explicação do Fluxo



\### Paciente



O paciente representa o elemento central do domínio da Luxora.



Toda a operação clínica acontece em função da jornada do paciente, desde o primeiro contato até o encerramento do tratamento.



\---



\### Sessão



A sessão representa um atendimento realizado ou agendado.



Ela concentra a maior parte das operações da plataforma, servindo como ponto de origem para processos administrativos, financeiros e clínicos.



\---



\### Cobrança



Após a realização da sessão, é gerada uma cobrança correspondente.



A cobrança registra a obrigação financeira relacionada ao atendimento realizado.



\---



\### Pagamento



O pagamento representa a liquidação financeira de uma cobrança.



Sua confirmação conclui o fluxo financeiro daquela sessão.



\---



\### Follow-up



Após cada atendimento podem existir ações posteriores, como:



\- retorno clínico;

\- reagendamento;

\- acompanhamento;

\- lembretes;

\- continuidade do tratamento.



O Follow-up representa a manutenção do relacionamento entre clínica e paciente.



\---



\## Regras Fundamentais do Domínio



O domínio da Luxora segue alguns princípios fundamentais.



\- O paciente é o centro da operação.

\- Toda sessão pertence a um único paciente.

\- Toda cobrança é originada por uma sessão.

\- Todo pagamento pertence a uma cobrança.

\- O Follow-up representa a continuidade da jornada do paciente.

\- Nenhum fluxo operacional deve existir fora desse ciclo principal.



\---



\## O que este documento representa



Este diagrama representa apenas o domínio operacional da plataforma.



Não contempla:



\- autenticação;

\- usuários;

\- permissões;

\- integrações;

\- infraestrutura;

\- banco de dados;

\- filas;

\- eventos internos;

\- arquitetura técnica.



Esses aspectos possuem documentação própria.



\---



\## Documentos Relacionados



\- 01 - Visão Geral

\- 02 - Diagrama ER

\- 04 - Multi-Tenant

\- 05 - Auditoria

\- 06 - Relacionamentos

\- 07 - Ciclo de Vida

\- 08 - Fluxo de Dados



\---



\## Observações



O domínio apresentado neste documento representa apenas o fluxo principal da plataforma.



Novos módulos poderão expandir esse domínio ao longo da evolução do produto, porém deverão preservar a mesma filosofia arquitetural:



O paciente permanece como centro da operação, enquanto sessões, cobranças, pagamentos e acompanhamentos representam as etapas naturais da jornada clínica.



Este documento serve como referência conceitual para toda a plataforma Luxora.



