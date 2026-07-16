# Arquitetura Geral

\# Luxora



\# Architecture Documentation



\## Documento 02 — Arquitetura Geral



\*\*Versão:\*\* 1.0



\*\*Status:\*\* Oficial



\---



\# Objetivo



Este documento define a arquitetura geral da Luxora.



Seu objetivo é apresentar todos os componentes da plataforma, suas responsabilidades, dependências e forma de comunicação.



A Arquitetura Geral representa a estrutura oficial da plataforma e deverá servir como referência para Backend, Frontend, APIs, Banco de Dados, Inteligência Artificial e Infraestrutura.



\---



\# Visão Geral



A Luxora é uma plataforma SaaS orientada ao domínio.



Sua arquitetura foi projetada para atender clínicas de diferentes portes, mantendo isolamento entre clientes, facilidade de evolução e alta confiabilidade.



A plataforma é composta por módulos independentes que se comunicam através do Motor Operacional.



\---



\# Componentes da Plataforma



A arquitetura é formada pelos seguintes componentes principais:



\* Cliente (Paciente ou Terapeuta)

\* Canal de Comunicação

\* Agentes de IA

\* API Gateway

\* Motor Operacional

\* Casos de Uso

\* Camada de Domínio

\* Infraestrutura

\* Banco de Dados

\* Sistema de Eventos

\* Sistema de Filas

\* Auditoria

\* Dashboard



\---



\# Diagrama Conceitual



```text

Paciente / Terapeuta

&#x20;         │

&#x20;         ▼

&#x20;Canal de Comunicação

(WhatsApp / Web / Mobile)

&#x20;         │

&#x20;         ▼

&#x20;     Agente de IA

&#x20;         │

&#x20;         ▼

&#x20;     API Gateway

&#x20;         │

&#x20;         ▼

&#x20;  Motor Operacional

&#x20;         │

&#x20;┌────────┼─────────┐

&#x20;│        │         │

&#x20;▼        ▼         ▼

Casos   Eventos  Auditoria

de Uso

&#x20;│

&#x20;▼

&#x20;Domínio

&#x20;│

&#x20;▼

Infraestrutura

&#x20;│

&#x20;▼

Banco de Dados

```



\---



\# Descrição dos Componentes



\## Cliente



Representa qualquer usuário da plataforma.



Perfis previstos:



\* Paciente

\* Terapeuta

\* Administrador

\* Futuros perfis administrativos



O cliente nunca acessa diretamente o banco de dados.



Toda comunicação ocorre através das APIs oficiais.



\---



\## Canal de Comunicação



É responsável apenas pelo transporte das mensagens.



Exemplos:



\* WhatsApp

\* Painel Web

\* Aplicativo Mobile (futuro)

\* Integrações externas



Não possui lógica de negócio.



\---



\## Agentes de IA



Os agentes interpretam linguagem natural.



Cada agente possui uma responsabilidade específica.



Exemplos futuros:



\* Agente de Recepção

\* Agente de Agenda

\* Agente Financeiro

\* Agente de Follow-up

\* Agente Administrativo



Todos consultam o Motor Operacional antes de executar qualquer ação.



\---



\## API Gateway



É o ponto único de entrada da plataforma.



Responsabilidades:



\* autenticação;

\* autorização;

\* validação;

\* roteamento;

\* limitação de requisições;

\* observabilidade.



Nenhuma regra de negócio deverá existir nesta camada.



\---



\## Motor Operacional



O Motor Operacional é o núcleo da Luxora.



Ele coordena todas as decisões administrativas.



Responsabilidades:



\* carregar políticas da clínica;

\* validar estados;

\* selecionar Casos de Uso;

\* emitir eventos;

\* registrar auditoria;

\* controlar fluxos administrativos.



Nenhum módulo poderá ignorar o Motor Operacional.



\---



\## Casos de Uso



Cada funcionalidade do sistema deverá existir como um Caso de Uso independente.



Exemplos:



\* AgendarConsulta

\* CancelarConsulta

\* ConfirmarConsulta

\* RegistrarPagamento

\* GerarCobranca

\* ExecutarFollowUp



Cada Caso de Uso executa apenas uma responsabilidade.



\---



\## Domínio



O Domínio contém:



\* Entidades

\* Objetos de Valor

\* Serviços de Domínio

\* Políticas

\* Eventos

\* Regras



É totalmente independente da tecnologia utilizada.



\---



\## Infraestrutura



Implementa detalhes técnicos.



Exemplos:



\* PostgreSQL

\* Redis

\* Provedor de IA

\* WhatsApp Business API

\* Serviço de E-mail

\* Armazenamento de arquivos



Pode ser substituída sem alterar o Domínio.



\---



\## Banco de Dados



Responsável pela persistência.



Armazena:



\* clínicas;

\* terapeutas;

\* pacientes;

\* sessões;

\* cobranças;

\* pagamentos;

\* mensagens;

\* eventos;

\* auditoria;

\* configurações.



Não armazena conteúdo clínico das sessões.



\---



\## Sistema de Eventos



Todo fato relevante gera um evento.



Exemplos:



\* SessaoCriada

\* SessaoConfirmada

\* PagamentoRecebido

\* FollowUpIniciado



Os eventos permitem automações desacopladas.



\---



\## Sistema de Filas



Processa tarefas assíncronas.



Exemplos:



\* envio de mensagens;

\* lembretes;

\* follow-up;

\* sincronizações;

\* geração de relatórios.



Isso evita bloqueios durante operações críticas.



\---



\## Auditoria



Toda operação relevante deverá ser registrada.



Informações mínimas:



\* usuário;

\* clínica;

\* ação;

\* data;

\* hora;

\* resultado.



\---



\## Dashboard



Responsável por consolidar indicadores administrativos.



Exemplos:



\* ocupação da agenda;

\* faturamento;

\* inadimplência;

\* pacientes ativos;

\* pacientes em follow-up;

\* sessões realizadas.



O Dashboard consulta dados oficiais e nunca altera informações.



\---



\# Fluxo Arquitetural



Toda solicitação segue o fluxo abaixo:



1\. O usuário inicia uma interação.

2\. O canal entrega a solicitação.

3\. O Agente de IA interpreta a intenção.

4\. O API Gateway valida a requisição.

5\. O Motor Operacional identifica o Caso de Uso.

6\. O Caso de Uso consulta o Domínio.

7\. O Domínio valida as regras.

8\. A Infraestrutura executa operações técnicas.

9\. O Banco de Dados persiste as alterações.

10\. Eventos são publicados.

11\. Auditoria registra a operação.

12\. O resultado retorna ao usuário.



\---



\# Comunicação entre Componentes



Regras obrigatórias:



\* O Frontend nunca acessa o banco diretamente.

\* A IA nunca altera dados diretamente.

\* O Banco nunca contém regras de negócio.

\* O Domínio nunca conhece APIs externas.

\* Os Casos de Uso nunca dependem do Frontend.

\* Integrações externas comunicam-se apenas pelas APIs oficiais.



\---



\# Escalabilidade



A arquitetura deve suportar:



\* múltiplas clínicas;

\* múltiplos terapeutas por clínica;

\* múltiplos agentes de IA;

\* múltiplos canais de comunicação;

\* crescimento horizontal de serviços.



Novos módulos devem ser adicionados sem modificar o núcleo da plataforma.



\---



\# Princípios de Evolução



Toda nova funcionalidade deverá:



1\. Ser documentada no PRD.

2\. Atualizar o Domínio quando necessário.

3\. Possuir Caso de Uso próprio.

4\. Respeitar o Motor Operacional.

5\. Gerar eventos quando aplicável.

6\. Produzir registros de auditoria.



\---



\# Dependências



Este documento depende de:



\* 00-Principios-Arquiteturais.md

\* 01-Visao-Arquitetural.md

\* Documentação do Domínio

\* PRD v1.0



Servirá como base para:



\* 03-Backend.md

\* 04-Frontend.md

\* 05-Servicos.md

\* 06-Autenticacao.md

\* 07-Multitenancy.md

\* 08-Comunicacao.md

\* 09-Filas.md

\* 10-Armazenamento.md

\* 11-Monitoramento.md

\* 12-Seguranca.md

\* 13-Deploy.md

\* 14-Decisoes-de-Arquitetura.md

\* 15-Escalabilidade.md



\---



\# Conclusão



A Arquitetura Geral da Luxora foi projetada para separar claramente responsabilidades, preservar o domínio do negócio e permitir crescimento contínuo. O Motor Operacional atua como o centro da plataforma, garantindo que todas as ações administrativas respeitem as políticas configuradas por cada clínica e que a Inteligência Artificial permaneça como uma interface inteligente, mas nunca como a autoridade das regras do sistema.



