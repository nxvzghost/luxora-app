# 08 - Auditoria

## Objetivo

Este documento define a estratégia de auditoria da camada de persistência da plataforma Luxora.

Seu objetivo é garantir que toda operação administrativa relevante seja registrada de forma imutável, rastreável e auditável, permitindo reconstruir o histórico de qualquer ação realizada na plataforma — por usuário, por agente de IA ou pelo próprio sistema.

Este documento corrige uma inconsistência anterior: o arquivo `08-Auditoria.md` continha, por erro, conteúdo duplicado de `10-Views.md`. A especificação abaixo é a primeira versão real da estratégia de auditoria.

---

# Filosofia

Na Luxora, auditoria não é um recurso opcional nem um log técnico de depuração.

É um requisito de negócio: a plataforma toma decisões administrativas em nome da clínica (via Motor Operacional e, eventualmente, via agentes de IA), e cada uma dessas decisões deve poder ser explicada, reconstituída e — se necessário — contestada.

Um registro de auditoria, uma vez criado, nunca é editado ou removido (Princípio 10 — "Todo Evento deve ser Imutável", já definido em `00-Principios-Arquiteturais.md`).

---

# O que deve ser registrado

Conforme já exigido por RNF-006 (PRD), Princípio 07 (Arquitetura) e `07-Multitenancy.md`, todo evento relevante deve gerar um registro de auditoria. No mínimo:

- Login e logout.
- Agendamento, remarcação, cancelamento e confirmação de sessão.
- Criação, envio e quitação de cobranças.
- Registro de pagamento e eventual estorno.
- Alterações cadastrais de Clínica, Terapeuta e Paciente.
- Alteração de configurações e políticas da clínica.
- Toda ação executada por um agente de IA em nome de um usuário.
- Toda ação administrativa executada por automação (n8n) que produza efeito no domínio.

---

# Tabela `audit_log`

```
audit_log
    id            UUID PK
    tenant_id     UUID NOT NULL           -- isolamento multi-tenant (ver 09-Multi-Tenant.md)
    user_id       UUID NULL               -- nulo quando a ação foi executada pelo sistema ou por um agente de IA
    actor_type    ENUM (user | ai_agent | system)
    action        VARCHAR NOT NULL        -- ex: "session.created", "payment.confirmed", "clinic.policy_updated"
    entity_type   VARCHAR NOT NULL        -- ex: "session", "billing", "patient"
    entity_id     UUID NOT NULL
    payload       JSONB                   -- snapshot relevante da ação (estado anterior/novo quando aplicável)
    result        ENUM (success | failure)
    ip_address    VARCHAR NULL
    created_at    TIMESTAMP NOT NULL DEFAULT now()
```

## Regras da tabela

- `audit_log` **nunca** possui `updated_at` nem `deleted_at` — um registro de auditoria é imutável por definição; correções geram um novo registro, nunca a edição do anterior (mesmo princípio já aplicado a Eventos de Domínio em `01-Domain/04-Eventos-de-Dominio.txt`).
- Todo registro pertence obrigatoriamente a um Tenant (`tenant_id NOT NULL`), com Row-Level Security ativa (ver `09-Multi-Tenant.md`).
- `actor_type = ai_agent` é obrigatório sempre que a ação tiver sido iniciada por um agente de IA, mesmo que executada em nome de um usuário — isso permite auditar separadamente decisões humanas e decisões mediadas por IA, algo explicitamente exigido por RN-018 e RNF-012 (o comportamento da IA deve ser auditável e nunca opaco).
- `payload` deve conter o suficiente para reconstruir o "antes/depois" da ação sem depender de outras tabelas que podem ter sido alteradas posteriormente.

---

# Índices

```
idx_audit_tenant_created   (tenant_id, created_at)
idx_audit_entity           (entity_type, entity_id)
idx_audit_actor            (actor_type, user_id)
```

O índice composto `(tenant_id, created_at)` é o mais crítico — a consulta mais comum é "histórico de auditoria de uma clínica, ordenado por data".

---

# Retenção

Registros de auditoria devem ser retidos por, no mínimo, o período exigido por obrigações legais aplicáveis (LGPD e, quando cabível, regulação do setor de saúde), e nunca removidos automaticamente antes desse prazo. Arquivamento (mover para armazenamento frio) é aceitável após período de retenção ativa; exclusão definitiva não é.

---

# Relação com Eventos de Domínio

Auditoria e Eventos de Domínio (`01-Domain/04-Eventos-de-Dominio.txt`) são conceitos relacionados mas não idênticos:

- **Evento de Domínio** existe para permitir reação (automações, notificações, agentes de IA reagindo a um fato).
- **Registro de Auditoria** existe para permitir reconstituição histórica e responsabilização (quem fez o quê, quando, com que resultado).

Na prática, todo Evento de Domínio relevante deve gerar um registro de auditoria correspondente, mas nem todo registro de auditoria precisa necessariamente disparar um Evento de Domínio (ex: um login bem-sucedido é auditado, mas normalmente não precisa acionar automações).

---

# Escopo

Este documento trata exclusivamente da estratégia de auditoria da camada de persistência.

Não contempla:

- Monitoramento técnico de infraestrutura (logs de aplicação, métricas) — ver `02-Arquitetura/11-Monitoramento.md`.
- Políticas de segurança gerais — ver `02-Arquitetura/12-Seguranca.md`.

---

# Documentos Relacionados

- 00 - Conceitos
- 01 - Diagrama ER
- 02 - Tabelas
- 09 - Multi-Tenant
- Domain/04 - Eventos de Domínio
- Arquitetura/11 - Monitoramento
- Arquitetura/12 - Segurança

---

# Observações

Esta especificação substitui o conteúdo anterior deste arquivo, que continha, por erro de geração, uma cópia do conteúdo de `10-Views.md`. A tabela `audit_log`, citada como obrigatória em múltiplos documentos desde a primeira versão da documentação, passa a ter, a partir desta versão, uma definição real de schema.
