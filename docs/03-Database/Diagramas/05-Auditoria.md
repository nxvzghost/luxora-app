\# 05 - Auditoria



\## Objetivo



Este documento apresenta a arquitetura de auditoria da plataforma Luxora.



Seu objetivo é garantir rastreabilidade completa das operações realizadas dentro do sistema, permitindo identificar quem realizou cada ação, quando ela ocorreu, onde ocorreu e quais informações foram alteradas.



A auditoria faz parte da arquitetura da plataforma desde sua concepção e não deve ser tratada como uma funcionalidade opcional.



\---



\## Fluxo de Auditoria



```mermaid

flowchart TD



&#x20;   Usuario --> Acao



&#x20;   Acao --> Registro



&#x20;   Registro --> AuditLog

```



\---



\## Conceito



Toda ação relevante executada dentro da plataforma gera um registro de auditoria.



O objetivo não é apenas registrar alterações no banco de dados, mas preservar o histórico operacional completo da clínica.



Cada registro representa um evento ocorrido dentro do sistema.



\---



\## O que deve ser auditado



A plataforma deve registrar eventos relacionados a:



\- Login e Logout;

\- Criação de usuários;

\- Alteração de permissões;

\- Cadastro de pacientes;

\- Agendamentos;

\- Remarcações;

\- Cancelamentos;

\- Início e encerramento de sessões;

\- Cobranças;

\- Pagamentos;

\- Alterações financeiras;

\- Configurações da clínica;

\- Integrações;

\- Operações executadas pela IA.



\---



\## Informações registradas



Cada evento de auditoria deverá conter, sempre que possível:



\- Identificador do Tenant;

\- Usuário responsável;

\- Tipo da operação;

\- Recurso afetado;

\- Identificador do recurso;

\- Data e hora (UTC);

\- Resultado da operação;

\- Endereço IP;

\- User-Agent;

\- Origem da requisição;

\- Correlação da requisição (Request ID).



\---



\## Objetivos da Auditoria



A auditoria existe para:



\- rastrear operações;

\- investigar problemas;

\- atender requisitos legais;

\- aumentar a segurança;

\- facilitar suporte;

\- preservar histórico operacional;

\- auxiliar futuras análises de comportamento.



\---



\## Princípios



A auditoria segue alguns princípios fundamentais.



\### Imutabilidade



Os registros não devem ser alterados.



\---



\### Rastreabilidade



Toda operação relevante deve possuir origem conhecida.



\---



\### Transparência



Toda alteração importante deve poder ser explicada posteriormente.



\---



\### Segurança



Os registros de auditoria devem possuir acesso restrito.



\---



\## Escopo



Este documento descreve apenas a arquitetura de auditoria.



Não fazem parte deste documento:



\- Logs técnicos;

\- Logs de infraestrutura;

\- Logs de aplicação;

\- Monitoramento;

\- Observabilidade;

\- Métricas.



Esses tópicos possuem documentação própria.



\---



\## Documentos Relacionados



\- 03 - Domínio

\- 04 - Multi-Tenant

\- 06 - Relacionamentos

\- 07 - Ciclo de Vida

\- 08 - Fluxo de Dados

\- Infrastructure

\- Security



\---



\## Observações



A auditoria representa um componente transversal da plataforma.



Ela acompanha todos os módulos da Luxora, independentemente do contexto de negócio.



Nenhuma funcionalidade considerada crítica deve ser implementada sem geração de eventos de auditoria.



