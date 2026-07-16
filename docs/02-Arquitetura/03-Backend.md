# Backend

\# Luxora



\# Architecture Documentation



\## Documento 03 — Backend



\*\*Versão:\*\* 1.0



\*\*Status:\*\* Oficial



\---



\# Objetivo



Este documento define a arquitetura do Backend da Luxora.



O Backend é responsável por executar todas as regras administrativas da plataforma.



Nenhuma regra de negócio poderá existir no Frontend.



Nenhuma regra poderá existir nos Controllers.



Toda lógica deverá ser centralizada em Casos de Uso e Serviços de Domínio.



\---



\# Objetivos do Backend



O Backend deverá ser:



\* Modular

\* Escalável

\* Testável

\* Independente da IA

\* Independente do Banco

\* Independente do Frontend



\---



\# Stack Oficial



Linguagem



TypeScript



Framework



NestJS



ORM



Prisma



Banco



PostgreSQL



Cache



Redis



Mensageria



BullMQ



Autenticação



JWT



Uploads



S3 Compatible Storage



Testes



Vitest



Documentação



OpenAPI (Swagger)



\---



\# Estrutura Oficial



```text

backend/



src/



main.ts



app.module.ts



modules/



core/



shared/



config/



infra/

```



\---



\# Organização dos Módulos



Cada módulo deverá representar um contexto do domínio.



Nunca uma tecnologia.



Exemplo correto



```text

modules/



patients/



appointments/



finance/



agenda/



followup/



notifications/



dashboard/



auth/



clinic/

```



Exemplo incorreto



```text

modules/



postgres/



redis/



openai/



```



Tecnologias pertencem à Infraestrutura.



\---



\# Estrutura de um Módulo



Exemplo:



```text

patients/



controllers/



use-cases/



domain/



repositories/



dto/



entities/



services/



events/



validators/

```



Cada módulo possui autonomia.



\---



\# Controllers



Responsabilidade:



Receber requisições.



Validar entrada.



Encaminhar ao Caso de Uso.



Retornar resposta.



Controllers nunca:



\* consultam banco;

\* executam regras;

\* enviam mensagens;

\* realizam cálculos.



\---



\# Casos de Uso



Representam ações executáveis.



Cada Caso de Uso deve possuir apenas uma responsabilidade.



Exemplos



AgendarConsulta



CancelarConsulta



RegistrarPagamento



ExecutarFollowUp



ConfirmarSessao



GerarCobranca



\---



\# Serviços de Domínio



Serviços de Domínio implementam regras compartilhadas.



Exemplos



Motor Financeiro



Motor Agenda



Motor Cobrança



Motor Follow-up



Motor Auditoria



\---



\# Repositórios



Responsáveis exclusivamente pelo acesso aos dados.



Nunca conterão regras de negócio.



Nunca enviarão mensagens.



Nunca chamarão APIs.



\---



\# DTOs



Todos os dados recebidos deverão possuir DTO próprio.



Exemplo



CreatePatientDTO



UpdatePatientDTO



CreateAppointmentDTO



RegisterPaymentDTO



\---



\# Validators



Responsáveis apenas por validação.



Exemplos



CPF válido



Telefone



Email



PIX



Data



Horário



\---



\# Eventos



Cada módulo poderá publicar eventos.



Exemplos



AppointmentCreated



PaymentConfirmed



PatientActivated



FollowUpStarted



\---



\# Comunicação entre módulos



Módulos nunca acessam diretamente entidades internas de outros módulos.



A comunicação ocorre através de:



Casos de Uso



Eventos



Interfaces



\---



\# Motor Operacional



É o componente mais importante do Backend.



Responsabilidades



Consultar políticas.



Consultar estados.



Escolher Caso de Uso.



Executar regras.



Gerar auditoria.



Publicar eventos.



Registrar métricas.



Nenhum módulo poderá ignorá-lo.



\---



\# Fluxo de Requisição



```text

Cliente



↓



Controller



↓



DTO



↓



Caso de Uso



↓



Motor Operacional



↓



Domínio



↓



Repository



↓



Banco



↓



Resposta

```



\---



\# Tratamento de Erros



Todo erro deverá possuir:



Código.



Mensagem.



Categoria.



Origem.



Data.



Contexto.



Nunca retornar Stack Trace ao usuário.



\---



\# Logs



Todo módulo deverá registrar:



Início.



Fim.



Tempo.



Resultado.



Erro.



Usuário.



Clínica.



\---



\# Configuração



Todas as configurações deverão ser centralizadas.



Nunca utilizar valores fixos no código.



Exemplos



Timeouts.



URLs.



Tokens.



Chaves.



Portas.



Limites.



\---



\# Dependências



Toda dependência externa deverá possuir uma interface.



Exemplo



IA.



WhatsApp.



Email.



Storage.



Pagamento.



Assim será possível trocar fornecedores sem alterar regras do domínio.



\---



\# Versionamento



Toda API deverá possuir versão.



Exemplo



/api/v1



/api/v2



\---



\# Testes



Todo Caso de Uso deverá possuir:



Teste unitário.



Teste de integração.



Testes de regressão para fluxos críticos.



\---



\# Performance



Objetivos



Resposta inferior a 2 segundos para operações administrativas.



Operações demoradas devem ser enviadas para filas.



Consultas frequentes poderão utilizar cache.



\---



\# Segurança



Todo endpoint deverá verificar:



Autenticação.



Autorização.



Tenant.



Permissões.



Auditoria.



\---



\# Escalabilidade



O Backend deverá permitir:



Novos módulos.



Novos provedores de IA.



Novos canais de comunicação.



Novos gateways de pagamento.



Novos tipos de usuários.



Sem alteração da arquitetura principal.



\---



\# Convenções



Classes



PascalCase



Métodos



camelCase



Arquivos



kebab-case



Interfaces



Prefixo "I"



Enums



PascalCase



Eventos



PascalCase no passado



Exemplo



AppointmentCreated



PaymentReceived



FollowUpStarted



\---



\# Dependências



Este documento depende de:



\* 00-Principios-Arquiteturais.md

\* 01-Visao-Arquitetural.md

\* 02-Arquitetura-Geral.md

\* Domain

\* PRD



Servirá como base para:



\* Database

\* APIs

\* IA

\* Testes

\* Deploy



\---



\# Conclusão



O Backend da Luxora é responsável por executar a operação administrativa da plataforma de forma previsível, auditável e escalável.



Sua arquitetura privilegia a separação de responsabilidades, a independência tecnológica e a centralização das regras de negócio no Domínio e no Motor Operacional.



Nenhuma implementação deverá violar esses princípios.



