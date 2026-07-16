\# ADRs — Architecture Decision Records



Esta pasta contém todas as decisões arquiteturais oficiais da Luxora.



Cada ADR registra uma decisão importante, o contexto em que ela foi tomada, sua justificativa e seus impactos na plataforma.



As ADRs fazem parte da documentação oficial do projeto e devem ser consideradas referência para qualquer implementação.



\---



\# O que é uma ADR?



Uma Architecture Decision Record (ADR) documenta uma decisão técnica relevante.



Ela responde principalmente às seguintes perguntas:



\* Qual decisão foi tomada?

\* Por que essa decisão foi tomada?

\* Quais alternativas foram avaliadas?

\* Quais impactos essa decisão gera?



\---



\# Ordem de Leitura



As ADRs foram organizadas em uma sequência lógica.



| ADR      | Tema                              |

| -------- | --------------------------------- |

| ADR-0001 | Operational Engine                |

| ADR-0002 | Domain-Driven Design              |

| ADR-0003 | Clean Architecture                |

| ADR-0004 | Multi-tenancy                     |

| ADR-0005 | Event-Driven Architecture         |

| ADR-0006 | IA como Interface Conversacional  |

| ADR-0007 | NestJS                            |

| ADR-0008 | PostgreSQL                        |

| ADR-0009 | Redis e BullMQ                    |

| ADR-0010 | Prisma ORM                        |

| ADR-0011 | API First                         |

| ADR-0012 | JWT Authentication                |

| ADR-0013 | Object Storage                    |

| ADR-0014 | Observabilidade da Plataforma     |

| ADR-0015 | Configuration over Code           |

| ADR-0016 | Policy Engine                     |

| ADR-0017 | State Machine                     |

| ADR-0018 | Resiliência e Tolerância a Falhas |

| ADR-0019 | Arquitetura Modular               |

| ADR-0020 | Governança da Arquitetura         |

| ADR-0021 | Fronteira entre Motor Operacional e n8n |



\---



\# Relação entre as ADRs



```text

Operational Engine

&#x20;       │

&#x20;       ▼

Policy Engine

&#x20;       │

&#x20;       ▼

State Machine

&#x20;       │

&#x20;       ▼

Use Cases

&#x20;       │

&#x20;       ▼

Domain

&#x20;       │

&#x20;       ▼

Event Bus

&#x20;       │

&#x20;       ▼

Workers

&#x20;       │

&#x20;       ▼

Infraestrutura

&#x20;       │

&#x20;       ▼

Observabilidade

```



Cada ADR complementa as anteriores.



Evite ler documentos isoladamente.



\---



\# Como criar uma nova ADR



Uma nova ADR deve ser criada quando houver uma decisão que:



\* altera a arquitetura;

\* impacta vários módulos;

\* define um padrão técnico;

\* muda um princípio da plataforma;

\* influencia futuras implementações.



Mudanças pequenas de código não exigem ADR.



\---



\# Estrutura Padrão



Toda ADR deverá conter:



\* Objetivo;

\* Contexto;

\* Problema;

\* Decisão;

\* Impacto na Arquitetura;

\* Benefícios;

\* Riscos;

\* Evolução Futura;

\* Documentos Relacionados;

\* Histórico;

\* Considerações Finais.



\---



\# Regras



\* Não apagar ADRs existentes.

\* Atualizar uma ADR quando a decisão evoluir.

\* Registrar mudanças importantes no histórico.

\* Manter consistência entre todas as ADRs.

\* Revisar documentos relacionados quando necessário.



\---



\# Fluxo de Evolução



```text

Nova necessidade



↓



Discussão



↓



Nova ADR ou atualização de ADR existente



↓



Revisão Arquitetural



↓



Implementação



↓



Atualização da documentação

```



\---



\# Objetivo das ADRs



As ADRs existem para preservar o conhecimento arquitetural da Luxora.



Elas permitem entender não apenas \*\*como\*\* a plataforma funciona, mas principalmente \*\*por que\*\* determinadas decisões foram tomadas.



Isso reduz retrabalho, melhora o onboarding de novos desenvolvedores e garante que a evolução da plataforma permaneça alinhada aos princípios definidos desde o início do projeto.



