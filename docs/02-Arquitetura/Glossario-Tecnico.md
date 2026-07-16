# Glossário Técnico da Luxora

Versão: 1.0

## Agente

Componente de IA especializado em executar uma função administrativa específica.

## Motor Operacional

Camada responsável por aplicar as regras de negócio e decidir quais ações administrativas podem ser executadas.

## Caso de Uso

Fluxo de aplicação que implementa uma ação do sistema, como AgendarConsulta ou RegistrarPagamento.

## Entidade

Objeto central do domínio com identidade própria (Paciente, Sessão, Cobrança etc.).

## Evento de Domínio

Fato que ocorreu no sistema e pode disparar outras ações.

## Estado

Situação atual de uma entidade.

## Workflow

Sequência de etapas executadas para concluir um processo.

## Policy

Regra configurável da clínica que altera o comportamento do sistema.

## Tenant

Uma clínica isolada das demais dentro da plataforma.

## Multitenancy

Arquitetura que permite atender várias clínicas mantendo isolamento total dos dados.

## Auditoria

Registro permanente das ações importantes executadas no sistema.

## Dashboard

Painel de indicadores operacionais e financeiros.

## Follow-up

Contato administrativo para manter o relacionamento com pacientes e reduzir abandono.

## Escalonamento

Encaminhamento de uma situação para intervenção humana.

## IA como Interface

Princípio segundo o qual a IA interpreta linguagem natural, mas não toma decisões administrativas sozinha.

## Camada de Domínio

Parte do sistema que contém as regras de negócio independentes de tecnologia.

## Clean Architecture

Modelo arquitetural que separa domínio, aplicação, infraestrutura e interface.

## DDD (Domain-Driven Design)

Abordagem de desenvolvimento centrada no domínio do negócio.

## ADR

Architecture Decision Record: documento que registra uma decisão arquitetural importante.









\# Luxora



\# Glossário Oficial



\*\*Versão:\*\* 1.0



\*\*Status:\*\* Oficial



\---



\# Objetivo



Este documento define a terminologia oficial utilizada em toda a documentação, código-fonte, banco de dados, APIs, interfaces e comunicação interna da Luxora.



Todos os documentos deverão utilizar exatamente estes termos.



Sinônimos deverão ser evitados sempre que puderem gerar ambiguidade.



\---



\# A



\## Agente de IA



Componente responsável por interpretar linguagem natural e conversar com usuários.



Não possui autoridade para tomar decisões administrativas.



Toda decisão é encaminhada ao Motor Operacional.



\---



\## Agenda



Conjunto organizado de horários disponíveis, reservados ou bloqueados para atendimento.



\---



\## Agendamento



Processo de criação de uma nova sessão na agenda.



\---



\## API



Interface utilizada para comunicação entre sistemas.



Toda comunicação oficial ocorre através das APIs da Luxora.



\---



\## Auditoria



Registro permanente de ações relevantes executadas dentro da plataforma.



\---



\# B



\## Backend



Camada responsável pelas regras de negócio, processamento e persistência dos dados.



\---



\## Banco de Dados



Sistema responsável pelo armazenamento persistente das informações da plataforma.



\---



\## BullMQ



Sistema oficial de filas utilizado pelo Luxora.



\---



\# C



\## Cache



Armazenamento temporário utilizado para melhorar desempenho.



Nunca representa a fonte oficial dos dados.



\---



\## Caso de Uso (Use Case)



Implementação de uma única ação do sistema.



Exemplos:



\* Agendar Consulta

\* Registrar Pagamento

\* Cancelar Sessão



\---



\## Clínica



Empresa ou profissional cadastrado na plataforma.



Cada clínica representa um Tenant.



\---



\## Configuração



Conjunto de parâmetros personalizados definidos por cada clínica.



\---



\## Controller



Camada responsável por receber requisições e encaminhá-las aos Casos de Uso.



Nunca implementa regras de negócio.



\---



\## Correlation ID



Identificador único que acompanha uma operação por toda a plataforma.



Utilizado para rastreamento e observabilidade.



\---



\# D



\## Dashboard



Painel que apresenta indicadores administrativos da clínica.



\---



\## Deploy



Processo de publicação de uma nova versão da plataforma.



\---



\## Domínio



Representação das regras administrativas do negócio.



É o núcleo conceitual da Luxora.



\---



\## DTO (Data Transfer Object)



Objeto utilizado para transportar dados entre camadas da aplicação.



\---



\# E



\## Entidade



Objeto principal do domínio com identidade própria.



Exemplos:



\* Paciente

\* Sessão

\* Clínica

\* Cobrança



\---



\## Escalabilidade



Capacidade da plataforma crescer sem alterar sua arquitetura principal.



\---



\## Evento



Representação de um fato importante ocorrido no sistema.



Exemplo:



PagamentoConfirmado.



\---



\# F



\## Follow-up



Processo administrativo de acompanhamento de pacientes que necessitam de contato após determinado período sem atendimento ou conforme política da clínica.



\---



\## Frontend



Camada responsável pela interface utilizada pelos usuários.



\---



\# G



\## Gateway



Componente responsável por receber e encaminhar comunicações externas.



\---



\# H



\## Horário



Intervalo disponível, reservado ou bloqueado na agenda.



\---



\# I



\## IA



Inteligência Artificial utilizada para interpretar mensagens e auxiliar na comunicação.



Não executa regras administrativas.



\---



\## Infraestrutura



Conjunto de recursos técnicos necessários para executar a plataforma.



\---



\# J



\## Job



Unidade de trabalho processada por uma fila.



\---



\## JWT



Token utilizado para autenticação dos usuários.



\---



\# L



\## Log



Registro técnico utilizado para monitoramento e diagnóstico da plataforma.



\---



\# M



\## Mensagem



Comunicação trocada entre usuários e a plataforma.



\---



\## Motor Operacional



Núcleo da Luxora.



Responsável por interpretar políticas, executar regras administrativas, coordenar Casos de Uso e orquestrar toda a operação da plataforma.



\---



\## Multitenancy



Modelo arquitetural que permite múltiplas clínicas utilizarem a mesma plataforma mantendo isolamento completo dos dados.



\---



\# N



\## Notificação



Mensagem enviada automaticamente para informar usuários sobre eventos administrativos.



\---



\# O



\## Operational Engine



Nome técnico do Motor Operacional.



\---



\# P



\## Paciente



Pessoa atendida por uma clínica cadastrada na Luxora.



\---



\## Pagamento



Registro financeiro que representa a quitação de uma ou mais cobranças.



\---



\## Política



Conjunto de regras configuradas pela clínica para definir comportamentos da plataforma.



Exemplos:



\* política de cobrança;

\* política de cancelamento;

\* política de follow-up.



\---



\## Prisma



ORM oficial utilizado para acesso ao banco de dados.



\---



\# R



\## Redis



Sistema utilizado para cache, filas e armazenamento temporário.



\---



\## Repository



Camada responsável pelo acesso ao banco de dados.



\---



\## Role



Perfil de acesso de um usuário.



Exemplos:



\* Administrador

\* Terapeuta

\* Assistente



\---



\# S



\## SaaS



Software disponibilizado como serviço através da internet.



A Luxora é uma plataforma SaaS.



\---



\## Sessão



Unidade de atendimento realizada entre terapeuta e paciente.



Este é o termo oficial utilizado na plataforma.



\---



\## Serviço



Componente responsável por executar responsabilidades específicas da aplicação.



Exemplo:



FinanceService.



\---



\## Sprint



Período de desenvolvimento com objetivos definidos.



\---



\# T



\## Tenant



Representação lógica de uma clínica dentro da plataforma.



Todo dado pertence obrigatoriamente a um Tenant.



\---



\## Terapeuta



Profissional responsável pelos atendimentos realizados na plataforma.



O termo inclui psicólogos, psicanalistas e outros profissionais da saúde mental que utilizam a Luxora.



\---



\## Trace



Rastreamento completo de uma operação ao longo da plataforma.



\---



\# U



\## Usuário



Pessoa autenticada que utiliza o sistema.



Pode assumir diferentes perfis.



\---



\# V



\## Worker



Processo responsável por executar Jobs em segundo plano.



\---



\# W



\## WhatsApp Gateway



Componente responsável pela integração entre o WhatsApp e a Luxora.



\---



\# Convenções Oficiais



A plataforma utilizará sempre:



\*\*Sessão\*\* (e não "consulta" ou "atendimento") para representar o encontro entre terapeuta e paciente.



\*\*Paciente\*\* para a pessoa atendida.



\*\*Terapeuta\*\* como termo genérico para os profissionais da saúde mental atendidos pelo Luxora.



\*\*Clínica\*\* para representar cada cliente da plataforma, independentemente de ser um consultório individual ou uma organização maior.



\*\*Tenant\*\* como termo técnico para o isolamento lógico de cada clínica.



\*\*Motor Operacional\*\* como nome funcional do núcleo da plataforma.



\*\*Operational Engine\*\* como nome técnico utilizado na documentação de engenharia e implementação.



\---



\# Evolução do Glossário



Novos termos poderão ser adicionados.



Nenhum termo existente deverá ser alterado sem atualização deste documento.



O Glossário Oficial é considerado fonte única da terminologia utilizada pelo Luxora.



\---



\# Conclusão



Este Glossário estabelece uma linguagem única para toda a plataforma.



Ao padronizar a terminologia utilizada em documentação, código, APIs e comunicação interna, reduz ambiguidades, melhora a colaboração entre equipes e facilita a evolução da Luxora ao longo do tempo.



