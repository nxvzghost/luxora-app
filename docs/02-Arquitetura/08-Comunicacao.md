# Comunicação

\# Luxora



\# Architecture Documentation



\## Documento 08 — Comunicação



\*\*Versão:\*\* 1.0



\*\*Status:\*\* Oficial



\---



\# Objetivo



Este documento define como todas as comunicações da Luxora acontecem, tanto entre usuários e plataforma quanto entre componentes internos do sistema.



A comunicação é um dos pilares da Luxora, pois praticamente toda operação administrativa nasce ou termina por meio de uma mensagem.



\---



\# Filosofia



Toda comunicação deve obedecer aos seguintes princípios:



\* Clareza.

\* Segurança.

\* Rastreabilidade.

\* Configuração por clínica.

\* Assincronismo sempre que possível.

\* Registro completo em auditoria.



Nenhuma mensagem importante poderá ser perdida.



\---



\# Tipos de Comunicação



A Luxora possui dois grandes grupos de comunicação.



\## Comunicação Externa



Ocorre entre usuários e a plataforma.



Exemplos:



\* WhatsApp

\* Portal Web

\* Aplicativo Mobile (futuro)

\* E-mail

\* SMS (futuro)



\---



\## Comunicação Interna



Ocorre entre componentes da própria plataforma.



Exemplos:



\* APIs

\* Eventos

\* Filas

\* Serviços

\* Motor Operacional



\---



\# Arquitetura Geral



```text

Paciente



↓



WhatsApp



↓



Gateway de Comunicação



↓



Agente de IA



↓



Motor Operacional



↓



Caso de Uso



↓



Resposta



↓



Paciente

```



Toda comunicação administrativa obrigatoriamente passa pelo Motor Operacional.



\---



\# Gateway de Comunicação



O Gateway de Comunicação é responsável por integrar todos os canais externos.



Responsabilidades:



\* receber mensagens;

\* validar origem;

\* normalizar formatos;

\* encaminhar ao Agente de IA;

\* enviar respostas.



O Gateway não executa regras de negócio.



\---



\# Canais Suportados



\## WhatsApp



Canal principal da plataforma.



Responsável por:



\* agendamentos;

\* confirmações;

\* cobranças;

\* lembretes;

\* follow-up;

\* atendimento administrativo.



\---



\## Painel Web



Canal utilizado pelos terapeutas e administradores.



Permite:



\* visualizar informações;

\* configurar políticas;

\* aprovar exceções;

\* consultar indicadores.



\---



\## Aplicativo Mobile (Futuro)



Voltado para terapeutas e pacientes.



\---



\## E-mail



Utilizado para:



\* recuperação de senha;

\* notificações administrativas;

\* comunicações institucionais.



\---



\# Fluxo das Mensagens



Toda mensagem seguirá o mesmo ciclo:



1\. Recebimento.

2\. Validação.

3\. Identificação do Tenant.

4\. Identificação do usuário.

5\. Interpretação da intenção.

6\. Consulta ao Motor Operacional.

7\. Execução do Caso de Uso.

8\. Registro em auditoria.

9\. Geração da resposta.

10\. Entrega ao canal de origem.



\---



\# Tipos de Mensagens



\## Agendamento



Solicitações de marcação de consulta.



\---



\## Confirmação



Confirmação automática de sessões.



\---



\## Cobrança



Mensagens financeiras.



\---



\## Lembrete



Avisos automáticos.



\---



\## Follow-up



Mensagens de acompanhamento.



\---



\## Informativas



Mensagens administrativas.



\---



\## Sistema



Mensagens internas entre componentes.



\---



\# Comunicação entre Serviços



Os serviços comunicam-se por eventos.



Exemplos:



```text

SessaoCriada



↓



Evento



↓



FinanceService



↓



ChargeService



↓



NotificationService

```



Essa arquitetura reduz acoplamento entre módulos.



\---



\# Comunicação Assíncrona



Sempre que possível, a comunicação será assíncrona.



Exemplos:



\* envio de mensagens;

\* geração de relatórios;

\* lembretes;

\* follow-up;

\* notificações.



Operações críticas não deverão aguardar essas tarefas.



\---



\# Tratamento de Falhas



Toda falha de comunicação deverá possuir estratégia de recuperação.



Exemplos:



\* nova tentativa automática;

\* fila de erros;

\* alerta operacional;

\* registro em auditoria.



Nenhuma mensagem deverá ser descartada silenciosamente.



\---



\# Idempotência



Uma mesma mensagem não poderá gerar duas operações iguais.



Exemplos:



\* duas cobranças;

\* dois pagamentos;

\* dois agendamentos;

\* dois cancelamentos.



O sistema deverá reconhecer mensagens repetidas.



\---



\# Auditoria



Toda comunicação deverá registrar:



\* Tenant.

\* Usuário.

\* Canal.

\* Tipo da mensagem.

\* Data.

\* Hora.

\* Resultado.

\* Tempo de processamento.



\---



\# Segurança



Toda comunicação deverá respeitar:



\* autenticação;

\* autorização;

\* criptografia em trânsito;

\* isolamento entre Tenants;

\* LGPD.



\---



\# Configuração por Clínica



Cada clínica poderá configurar:



\* horário de atendimento;

\* mensagens automáticas;

\* assinatura;

\* tom de comunicação;

\* idioma;

\* lembretes;

\* regras de follow-up.



Essas configurações serão carregadas antes da geração de qualquer resposta.



\---



\# Integrações Futuras



A arquitetura foi projetada para permitir novos canais.



Exemplos:



\* Telegram.

\* Microsoft Teams.

\* Google Chat.

\* Instagram Direct.

\* Facebook Messenger.

\* API pública.



Esses canais utilizarão o mesmo Gateway de Comunicação.



\---



\# Métricas



O sistema deverá monitorar:



\* mensagens recebidas;

\* mensagens enviadas;

\* tempo médio de resposta;

\* taxa de falha;

\* tempo de processamento;

\* utilização por clínica.



\---



\# Dependências



Este documento depende de:



\* Arquitetura Geral

\* Backend

\* Serviços

\* Autenticação

\* Multitenancy



Servirá como base para:



\* Filas

\* IA

\* Monitoramento

\* APIs

\* Integrações



\---



\# Conclusão



A arquitetura de comunicação da Luxora foi projetada para ser desacoplada, escalável e resiliente.



Todos os canais convergem para um único fluxo operacional, garantindo consistência, rastreabilidade e respeito às políticas configuradas por cada clínica.



A comunicação é tratada como parte essencial da operação da plataforma e não apenas como um meio de transporte de mensagens.



