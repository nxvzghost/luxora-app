# Frontend

\# Luxora



\# Architecture Documentation



\## Documento 04 — Frontend



\*\*Versão:\*\* 1.0



\*\*Status:\*\* Oficial



\---



\# Objetivo



Este documento define a arquitetura do Frontend da Luxora.



O Frontend é responsável por apresentar informações e permitir a interação do usuário com a plataforma.



O Frontend nunca executa regras de negócio.



Toda decisão administrativa pertence ao Backend.



\---



\# Filosofia



O Frontend da Luxora foi projetado para ser um Centro de Operações.



O objetivo não é apenas mostrar dados.



O objetivo é reduzir esforço cognitivo.



O terapeuta deve olhar para a tela e imediatamente compreender:



\* quem precisa de atenção;

\* quais sessões ocorrerão hoje;

\* quais pagamentos estão pendentes;

\* quais pacientes precisam de follow-up;

\* quais problemas exigem intervenção.



\---



\# Objetivos



O Frontend deverá ser:



\* Simples

\* Intuitivo

\* Responsivo

\* Escalável

\* Modular

\* Acessível

\* Rápido

\* Consistente



\---



\# Stack Oficial



Framework



Next.js



Linguagem



TypeScript



Gerenciamento de Estado



Zustand



Data Fetching



TanStack Query



Formulários



React Hook Form



Validação



Zod



Componentes



Shadcn/UI



Ícones



Lucide



Gráficos



Recharts



\---



\# Estrutura



```text

frontend/



src/



app/



components/



features/



hooks/



services/



stores/



types/



styles/



assets/

```



\---



\# Organização



A organização será feita por funcionalidades.



Nunca por tecnologia.



Exemplo



```text

features/



patients/



appointments/



finance/



dashboard/



followup/



settings/



auth/

```



\---



\# Componentes



Todo componente deverá possuir apenas uma responsabilidade.



Exemplos



AppointmentCard



PatientCard



PaymentCard



DashboardMetric



NotificationBadge



CalendarView



Sidebar



Header



SearchBar



\---



\# Layout Geral



O sistema possuirá um layout único.



```text

┌────────────────────────────────────────────┐

│ Header                                     │

├──────────────┬─────────────────────────────┤

│ Sidebar      │                             │

│              │ Conteúdo Principal          │

│              │                             │

│              │                             │

├──────────────┴─────────────────────────────┤

│ Footer (opcional)                          │

└────────────────────────────────────────────┘

```



\---



\# Dashboard



O Dashboard será a primeira tela do sistema.



Ele deverá responder imediatamente:



\* Quantas consultas existem hoje?

\* Quem ainda não confirmou?

\* Quem está em atraso?

\* Quem precisa de follow-up?

\* Quanto já foi recebido hoje?

\* Quanto falta receber?

\* Existem conflitos?



\---



\# Módulos



\## Dashboard



Indicadores gerais.



\---



\## Agenda



Calendário.



Lista diária.



Semana.



Mês.



Encaixes.



Bloqueios.



\---



\## Pacientes



Cadastro.



Pesquisa.



Histórico administrativo.



Próxima sessão.



Situação financeira.



\---



\## Sessões



Visualização das consultas.



Confirmações.



Remarcações.



Cancelamentos.



\---



\## Financeiro



Cobranças.



Pagamentos.



Recebimentos.



Inadimplência.



Fechamento mensal.



\---



\## Follow-up



Pacientes sem retorno.



Histórico.



Fila de acompanhamento.



\---



\## Configurações



Dados da clínica.



Políticas.



Integrações.



Usuários.



IA.



\---



\# Navegação



A navegação deverá ser simples.



Menu lateral fixo.



Breadcrumb.



Pesquisa global.



Atalhos rápidos.



\---



\# Pesquisa



A pesquisa deverá localizar rapidamente:



Paciente.



Sessão.



Cobrança.



Pagamento.



Mensagem.



Terapeuta.



\---



\# Atualização em Tempo Real



O Frontend deverá atualizar automaticamente informações críticas.



Exemplos



Novo pagamento.



Nova mensagem.



Novo agendamento.



Cancelamento.



Confirmação.



\---



\# Responsividade



O sistema deverá funcionar em:



Desktop.



Notebook.



Tablet.



Celular.



Entretanto, a experiência principal será otimizada para desktop, considerando que o trabalho administrativo é realizado predominantemente nesse ambiente.



\---



\# Estados de Interface



Cada tela deverá possuir:



Loading.



Empty State.



Success.



Warning.



Error.



Offline.



\---



\# Feedback ao Usuário



Toda ação deverá produzir feedback visual.



Exemplos



Agendamento realizado.



Pagamento registrado.



Erro.



Conflito de agenda.



Sucesso.



\---



\# Acessibilidade



Todos os componentes deverão seguir boas práticas de acessibilidade.



\* Navegação por teclado.

\* Labels.

\* Contraste adequado.

\* Foco visível.

\* Textos compreensíveis.



\---



\# Segurança



O Frontend nunca armazenará:



Tokens permanentes.



Regras de negócio.



Dados sensíveis desnecessários.



Toda comunicação ocorrerá através das APIs oficiais.



\---



\# Comunicação



Fluxo padrão



```text

Usuário



↓



Frontend



↓



API



↓



Backend



↓



Resposta



↓



Atualização da Interface

```



O Frontend nunca acessará o banco diretamente.



\---



\# Cache



O cache será utilizado apenas para melhorar desempenho.



Nunca como fonte oficial de dados.



Sempre que necessário, os dados serão sincronizados com o Backend.



\---



\# Tratamento de Erros



Toda falha deverá informar:



\* o que aconteceu;

\* qual ação pode ser tomada;

\* quando possível, permitir nova tentativa.



Mensagens técnicas não deverão ser exibidas ao usuário final.



\---



\# Design System



Toda interface seguirá um Design System único.



Benefícios:



\* consistência visual;

\* reutilização de componentes;

\* facilidade de manutenção;

\* evolução contínua.



\---



\# Escalabilidade



Novos módulos deverão ser adicionados sem alterar o layout principal.



Exemplos futuros:



\* Convênios.

\* Portal do Paciente.

\* Aplicativo Mobile.

\* BI.

\* Relatórios Avançados.



\---



\# Dependências



Este documento depende de:



\* Visão Arquitetural

\* Arquitetura Geral

\* Backend

\* PRD



Servirá como base para:



\* UX

\* Componentes

\* Telas

\* Design System

\* Testes de Interface



\---



\# Conclusão



O Frontend da Luxora foi concebido como um Centro de Operações para clínicas de saúde mental.



Seu foco é reduzir a carga operacional do terapeuta, apresentando apenas informações relevantes no momento certo.



Toda inteligência administrativa permanece no Backend, enquanto o Frontend atua como uma interface clara, rápida e consistente para interação com a plataforma.



