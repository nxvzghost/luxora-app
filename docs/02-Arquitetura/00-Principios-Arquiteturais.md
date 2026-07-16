# Princípios Arquiteturais

## Luxora — Architecture Documentation — Documento 00

**Versão:** 1.0

**Status:** Documento Oficial

---

# Objetivo

Este documento estabelece todos os princípios arquiteturais obrigatórios para o desenvolvimento da Luxora.

Seu propósito é garantir que a plataforma permaneça consistente, escalável, segura e independente de tecnologias específicas ao longo de sua evolução.

Todas as decisões técnicas futuras deverão respeitar estes princípios.

Quando houver conflito entre uma implementação e este documento, este documento deverá prevalecer até revisão oficial da arquitetura.

---

# Filosofia

A Luxora não é apenas um software.

Ela representa o conhecimento operacional de clínicas de saúde mental transformado em uma plataforma.

A arquitetura existe para preservar esse conhecimento.

Tecnologias poderão mudar. Frameworks poderão mudar. Modelos de IA poderão mudar.

O domínio do negócio deverá permanecer.

---

# Princípio 01 — O Domínio é o Centro do Sistema

Toda decisão da plataforma nasce no domínio. Jamais o contrário.

Nenhuma tecnologia poderá alterar o funcionamento do negócio — banco de dados, framework, IA, Frontend. Todos dependem do domínio. O domínio não depende de nenhum deles.

---

# Princípio 02 — Separação de Responsabilidades

Cada componente do sistema possui uma única responsabilidade.

Exemplos: Recepção, Agenda, Financeiro, Dashboard, Follow-up.

Nenhum componente deverá assumir responsabilidades pertencentes a outro módulo.

---

# Princípio 03 — A IA Nunca Decide Sozinha

A Inteligência Artificial não possui autoridade para executar regras próprias.

Toda decisão deverá seguir esta sequência:

```
Paciente
  ↓
Agente IA
  ↓
Motor Operacional
  ↓
Regras da Clínica
  ↓
Domínio
  ↓
Caso de Uso
  ↓
Infraestrutura
  ↓
Resposta
```

A IA interpreta linguagem. O Motor Operacional toma decisões.

---

# Princípio 04 — Toda Regra Pertence ao Domínio

Nunca colocar regras de negócio em: Controllers, Rotas, Frontend, Banco de dados, Prompts.

Toda regra pertence ao Domínio.

---

# Princípio 05 — Toda Clínica é Única

Cada clínica possui suas próprias políticas — cobrança, cancelamento, remarcação, confirmação, tom de comunicação, tempo de sessão, forma de pagamento.

A plataforma jamais poderá assumir comportamentos fixos. Tudo deverá ser configurável.

---

# Princípio 06 — O Sistema é Orientado a Eventos

A Luxora reage a acontecimentos: sessão criada, sessão confirmada, sessão cancelada, cobrança criada, pagamento recebido, follow-up iniciado.

Os eventos representam fatos. Eles nunca representam intenções.

---

# Princípio 07 — Auditoria Obrigatória

Toda ação relevante deverá gerar auditoria — login, alteração cadastral, agendamento, pagamento, cancelamento, configuração.

Nenhuma informação crítica poderá desaparecer.

---

# Princípio 08 — Nenhum Dado Clínico

A Luxora não é um prontuário eletrônico. Ela administra operações.

Nunca armazenará: diagnósticos, sessões terapêuticas, relatos clínicos, interpretações, hipóteses, conteúdo terapêutico.

---

# Princípio 09 — Estados são Fonte da Verdade

Toda entidade possui um único estado — Paciente, Sessão, Cobrança, Pagamento, Agenda.

Nunca existirão dois estados simultâneos. Toda mudança gera evento.

---

# Princípio 10 — Todo Evento Deve Ser Imutável

Eventos representam fatos ocorridos. Após registrados, nunca poderão ser alterados.

Caso exista correção, um novo evento deverá ser criado. Jamais editar o evento anterior.

---

# Princípio 11 — Configuração Acima de Programação

Sempre que possível, uma clínica deverá configurar. Jamais solicitar alteração de código.

Exemplos: cobrança, confirmação, lembretes, cancelamentos, follow-up.

---

# Princípio 12 — Escalabilidade Desde o Primeiro Dia

Toda arquitetura deverá suportar crescimento: 1 clínica, 10 clínicas, 100 clínicas, 10.000 clínicas — sem necessidade de reescrever módulos.

---

# Princípio 13 — Independência Tecnológica

O domínio nunca conhecerá: NestJS, NextJS, PostgreSQL, Redis, Claude, OpenAI, WhatsApp.

Essas tecnologias poderão ser substituídas. O domínio permanecerá igual.

---

# Princípio 14 — Clean Architecture

Toda implementação deverá seguir os princípios de Clean Architecture, separando Domínio, Aplicação, Infraestrutura e Interface.

Cada camada conhece apenas aquilo que lhe compete.

---

# Princípio 15 — Domain-Driven Design

Toda modelagem seguirá Domain-Driven Design.

As entidades representam o negócio. Não representam tabelas. O banco será consequência do domínio. Nunca o contrário.

---

# Princípio 16 — SOLID

Todos os componentes deverão respeitar: Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion.

---

# Princípio 17 — Casos de Uso

Toda funcionalidade deverá existir como Caso de Uso — AgendarConsulta, CancelarConsulta, GerarCobranca, RegistrarPagamento, ExecutarFollowUp.

Nenhuma regra ficará espalhada pelo sistema.

---

# Princípio 18 — Segurança por Padrão

Toda funcionalidade nasce segura. Nunca adicionar segurança depois.

Princípios: menor privilégio, autenticação, autorização, criptografia, auditoria, LGPD.

---

# Princípio 19 — Observabilidade

Toda operação deverá poder ser monitorada: logs, eventos, métricas, alertas, performance.

---

# Princípio 20 — Simplicidade

A solução mais simples que atende corretamente ao domínio deverá ser priorizada.

Complexidade somente quando absolutamente necessária.

---

# Princípio 21 — Motor Operacional

O Motor Operacional é o coração da Luxora.

Nenhum agente, nenhuma API, nenhum Frontend e nenhuma integração poderá executar ações administrativas sem consultar o Motor Operacional.

Ele representa oficialmente o comportamento operacional da plataforma.

---

# Princípio 22 — IA como Interface

A IA é considerada uma interface conversacional.

Ela não substitui: o domínio, os casos de uso, as regras, os eventos.

A IA apenas traduz linguagem humana para operações administrativas.

---

# Princípio 23 — Documentação como Fonte Oficial

Toda implementação deverá possuir documentação correspondente.

Nenhuma funcionalidade será considerada concluída sem documentação atualizada.

---

# Considerações Finais

Este documento representa a Constituição Técnica da Luxora.

Todos os documentos produzidos a partir deste momento deverão respeitar integralmente estes princípios.

Caso algum princípio precise ser alterado, a alteração deverá ser registrada nas Decisões de Arquitetura (ADR – Architecture Decision Records), justificando a mudança e avaliando seus impactos.
