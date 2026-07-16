\# 11 - Funções e Triggers



\## Objetivo



Este documento define a estratégia de utilização de Funções (Functions) e Triggers na camada de persistência da plataforma Luxora.



Seu objetivo é estabelecer responsabilidades claras para esses recursos do PostgreSQL, garantindo que sejam utilizados apenas quando agregarem valor técnico à persistência, preservando a separação entre banco de dados e regras de negócio.



Funções e Triggers devem complementar a camada de persistência, nunca substituir a lógica da aplicação.



\---



\# Filosofia



Na Luxora:



\- O PostgreSQL protege os dados.

\- O Backend executa as regras de negócio.

\- O Operational Engine coordena o comportamento da plataforma.



Funções e Triggers possuem responsabilidades técnicas e nunca devem conter lógica de domínio.



\---



\# Functions



\## Objetivo



As Functions são utilizadas para centralizar operações reutilizáveis relacionadas exclusivamente à persistência.



Seu uso deve priorizar simplicidade, desempenho e reutilização.



\---



\## Casos Permitidos



Functions poderão ser utilizadas para:



\- Cálculos técnicos relacionados ao banco;

\- Normalização de dados;

\- Manipulação de datas;

\- Conversões de valores;

\- Consultas reutilizáveis;

\- Funções auxiliares para Views.



\---



\## Casos Proibidos



As Functions não deverão:



\- Criar pacientes;

\- Agendar sessões;

\- Gerar cobranças;

\- Confirmar pagamentos;

\- Enviar mensagens;

\- Chamar APIs;

\- Executar integrações;

\- Aplicar regras clínicas;

\- Implementar regras financeiras.



Essas responsabilidades pertencem exclusivamente ao Backend.



\---



\# Triggers



\## Objetivo



As Triggers automatizam pequenas tarefas relacionadas à própria persistência dos dados.



Seu uso deve ser excepcional e sempre documentado.



\---



\## Casos Permitidos



\- Atualização automática de `updated\_at`;

\- Versionamento técnico;

\- Auditoria estrutural;

\- Soft Delete;

\- Validação complementar da persistência.



\---



\## Casos Proibidos



As Triggers não deverão:



\- Enviar WhatsApp;

\- Enviar E-mail;

\- Gerar cobranças;

\- Alterar estados do domínio;

\- Executar integrações;

\- Criar notificações;

\- Tomar decisões clínicas.



Toda lógica operacional pertence ao Backend.



\---



\# Convenções



\## Functions



```

fn\_<contexto>\_<nome>

```



Exemplos.



```

fn\_calculate\_age



fn\_format\_phone



fn\_generate\_slug



fn\_normalize\_document

```



\---



\## Triggers



```

trg\_<evento>\_<tabela>

```



Exemplos.



```

trg\_update\_timestamp\_patient



trg\_soft\_delete\_session



trg\_audit\_billing



trg\_increment\_version

```



\---



\# Regras



Toda Function deverá:



\- possuir responsabilidade única;

\- ser reutilizável;

\- ser documentada;

\- possuir testes.



Toda Trigger deverá:



\- possuir justificativa técnica;

\- ser simples;

\- evitar processamento pesado;

\- não depender de serviços externos.



\---



\# Performance



Functions e Triggers devem executar rapidamente.



Nenhum processamento complexo deverá ocorrer dentro do banco.



Operações demoradas pertencem ao Backend ou aos Workers.



\---



\# Escopo



Este documento trata exclusivamente do uso de Functions e Triggers.



Não contempla:



\- Procedures;

\- Jobs;

\- Workers;

\- Event Bus;

\- Operational Engine;

\- Regras de negócio.



Esses componentes possuem documentação específica.



\---



\# Documentos Relacionados



\- 05 - Constraints

\- 06 - Migrations

\- 08 - Auditoria

\- 09 - Multi-Tenant

\- 10 - Views

\- 12 - Performance

\- Backend

\- Operational Engine



\---



\# Observações



Functions e Triggers representam mecanismos auxiliares da camada de persistência.



Sua utilização deve priorizar simplicidade, previsibilidade e facilidade de manutenção.



Toda regra de negócio da plataforma Luxora deverá permanecer implementada no Backend.

