# Serviços

\# Luxora



\# Architecture Documentation



\## Documento 05 — Serviços



\*\*Versão:\*\* 1.0



\*\*Status:\*\* Oficial



\---



\# Objetivo



Este documento define todos os serviços internos da Luxora.



Os serviços representam os motores responsáveis por executar a operação administrativa da plataforma.



Toda inteligência operacional deverá existir nesta camada.



Nenhum Controller.



Nenhum Frontend.



Nenhum Agente de IA.



Nenhuma API externa.



Poderá implementar regras administrativas diretamente.



\---



\# Filosofia



A Luxora não é um conjunto de telas.



Ele é um conjunto de motores especializados.



Cada motor possui uma única responsabilidade.



Esses motores trabalham juntos para executar a operação completa da clínica.



\---



\# Organização



Todos os serviços pertencem ao Backend.



Estrutura prevista:



```text

services/



OperationalEngine/



PatientService/



AppointmentService/



ScheduleService/



FinanceService/



ChargeService/



PaymentService/



FollowUpService/



NotificationService/



MessageService/



DashboardService/



AuditService/



ConfigurationService/



PolicyService/



AIService/

```



\---



\# Serviço 01



\## Operational Engine



\### Objetivo



O Operational Engine é o núcleo da plataforma.



Nenhuma decisão administrativa poderá acontecer fora dele.



\---



\### Responsabilidades



Consultar regras da clínica.



Consultar políticas.



Consultar estados.



Executar Casos de Uso.



Emitir eventos.



Registrar auditoria.



Controlar fluxos administrativos.



\---



\### Não é responsabilidade



Enviar mensagens.



Persistir dados.



Renderizar telas.



Interpretar linguagem.



\---



\# Serviço 02



\## Patient Service



Responsável pelo ciclo administrativo do paciente.



Funções



Cadastrar.



Atualizar.



Consultar.



Ativar.



Inativar.



Registrar retorno.



Registrar alta.



Consultar histórico administrativo.



\---



\# Serviço 03



\## Appointment Service



Responsável pelas sessões.



Funções



Criar sessão.



Cancelar.



Confirmar.



Reagendar.



Finalizar.



Consultar.



\---



\# Serviço 04



\## Schedule Service



Responsável exclusivamente pela agenda.



Funções



Consultar horários.



Reservar horários.



Bloquear horários.



Liberar horários.



Detectar conflitos.



Encontrar encaixes.



\---



\# Serviço 05



\## Finance Service



Coordena toda a operação financeira.



Não executa cobranças diretamente.



Coordena os demais serviços financeiros.



\---



Funções



Consultar situação financeira.



Gerar fechamento.



Atualizar indicadores.



Consolidar pagamentos.



Calcular receita.



Calcular inadimplência.



\---



\# Serviço 06



\## Charge Service



Responsável apenas por cobranças.



Funções



Criar cobrança.



Atualizar cobrança.



Cancelar cobrança.



Consultar cobrança.



Escalar cobrança.



\---



\# Serviço 07



\## Payment Service



Responsável pelos pagamentos.



Funções



Registrar pagamento.



Validar pagamento.



Confirmar pagamento.



Registrar comprovante.



Atualizar indicadores.



\---



\# Serviço 08



\## FollowUp Service



Responsável pelo acompanhamento administrativo.



Funções



Detectar pacientes sem retorno.



Gerar lista.



Iniciar Follow-up.



Encerrar Follow-up.



Escalar terapeuta.



\---



\# Serviço 09



\## Notification Service



Responsável pelas notificações.



Exemplos



Confirmações.



Avisos.



Lembretes.



Mensagens administrativas.



Nunca envia conteúdo clínico.



\---



\# Serviço 10



\## Message Service



Responsável pela comunicação.



Integrações futuras



WhatsApp.



Email.



SMS.



Push.



Portal.



Todos os canais passam por este serviço.



\---



\# Serviço 11



\## Dashboard Service



Responsável pelos indicadores.



Exemplos



Agenda.



Receita.



Cobranças.



Pagamentos.



Pacientes ativos.



Sessões.



Follow-up.



Nunca altera dados.



Apenas consulta.



\---



\# Serviço 12



\## Audit Service



Responsável por registrar todas as operações.



Todo evento relevante passa por este serviço.



Informações registradas



Usuário.



Clínica.



Data.



Hora.



Resultado.



Origem.



Evento.



\---



\# Serviço 13



\## Configuration Service



Responsável pelas configurações da clínica.



Exemplos



Tempo de sessão.



Cobrança.



Cancelamento.



Remarcação.



Idioma.



Tom de comunicação.



Integrações.



\---



\# Serviço 14



\## Policy Service



Um dos serviços mais importantes.



Responsável por interpretar políticas da clínica.



Exemplo



Uma clínica cobra após a sessão.



Outra cobra mensalmente.



Outra cobra antecipadamente.



O Policy Service devolve ao Motor Operacional qual comportamento deve ser seguido.



\---



\# Serviço 15



\## AI Service



Responsável pela comunicação com provedores de IA.



Importante



A IA nunca altera o sistema.



Ela apenas interpreta linguagem.



Toda decisão volta para o Operational Engine.



\---



\# Comunicação entre Serviços



Fluxo obrigatório



```text

Agente IA



↓



Operational Engine



↓



Policy Service



↓



Caso de Uso



↓



Serviços Especializados



↓



Eventos



↓



Auditoria



↓



Resposta

```



Nenhum serviço deverá ignorar esta sequência quando houver decisão administrativa.



\---



\# Dependências



Os serviços dependem apenas de:



Interfaces.



Casos de Uso.



Domínio.



Nunca dependem diretamente de outros serviços sem uma interface bem definida.



\---



\# Eventos



Cada serviço poderá publicar eventos.



Exemplos



AppointmentCreated.



PaymentConfirmed.



ChargeCreated.



FollowUpStarted.



PatientActivated.



Os serviços poderão reagir a eventos publicados por outros serviços quando apropriado.



\---



\# Escalabilidade



Novos serviços poderão ser adicionados.



Exemplos futuros



VideoCall Service.



Receipt Service.



Report Service.



Insurance Service.



AI Analytics Service.



A adição de novos serviços não deverá exigir alterações no Operational Engine além da integração prevista.



\---



\# Regras Gerais



1\. Cada serviço possui uma única responsabilidade.



2\. Nenhum serviço conhece detalhes de interface.



3\. Nenhum serviço contém código de apresentação.



4\. Toda regra administrativa passa pelo Operational Engine.



5\. Toda decisão baseada em políticas passa pelo Policy Service.



6\. Toda comunicação com IA passa pelo AI Service.



7\. Toda comunicação externa passa pelo Message Service.



8\. Toda ação relevante gera auditoria.



\---



\# Dependências



Este documento depende de:



\* Princípios Arquiteturais

\* Visão Arquitetural

\* Arquitetura Geral

\* Backend

\* Domain



Servirá como base para:



\* APIs

\* Banco de Dados

\* Agentes de IA

\* Integrações

\* Filas

\* Monitoramento



\---



\# Conclusão



A camada de Serviços é o centro operacional da Luxora.



Ela organiza a execução dos processos administrativos, mantém o domínio isolado de tecnologias externas e garante que todas as clínicas sejam atendidas conforme suas próprias políticas operacionais.



O Operational Engine atua como orquestrador, enquanto os serviços especializados executam responsabilidades bem definidas, permitindo evolução contínua da plataforma sem comprometer sua consistência arquitetural.



