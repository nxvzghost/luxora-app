# 01 - Testes Críticos

## Objetivo

Lista de cenários de teste que não são opcionais, derivados diretamente dos riscos identificados na análise de arquitetura original da Luxora. Diferente da estratégia geral (`00-Estrategia-de-Testes.md`), esta lista é específica e deve ser tratada como checklist de bloqueio de release — nenhuma versão vai para produção sem esses testes passando.

---

# Isolamento Multi-Tenant (o risco de maior severidade identificado)

1. Usuário autenticado no Tenant A **nunca** consegue ler, via nenhum endpoint, um registro pertencente ao Tenant B — mesmo fornecendo um ID válido de outro Tenant diretamente na URL.
2. Uma query de Repository sem filtro de `tenant_id` (erro de programação simulado propositalmente no teste) ainda assim retorna zero linhas, graças à política de RLS (`03-Database/09-Multi-Tenant.md`) — este teste existe especificamente para validar que a segunda camada de defesa funciona mesmo quando a primeira falha.
3. Cache (Redis) nunca retorna dado de um Tenant para requisição de outro (`02-Arquitetura/07-Multitenancy.md`, seção Cache).

---

# Modelo de Cobrança Agregada

4. Cobrança por sessão avulsa: 1 `session` gera exatamente 1 `billing` via `billing_session` (caso N=1).
5. Cobrança semanal: N `sessions` da mesma semana geram exatamente 1 `billing`.
6. Cobrança mensal: N `sessions` do mesmo mês geram exatamente 1 `billing`.
7. Uma `session` já vinculada a uma `billing` em aberto não pode ser incluída em uma segunda `billing` simultaneamente (constraint `UNIQUE (session_id)` de `03-Database/03-Relacionamentos.md`).

---

# Idempotência de Pagamento

8. Duas requisições `POST /payments` com o mesmo `Idempotency-Key` produzem exatamente um registro de pagamento, não dois (RNF-008 — "nunca registrar pagamentos duplicados").
9. Reenvio de mensagem de cobrança pela fila (`02-Arquitetura/09-Filas.md`) após falha simulada não duplica o envio ao paciente.

---

# Conflito de Agenda

10. Duas requisições concorrentes de agendamento para o mesmo horário resultam em exatamente uma reserva bem-sucedida e uma resposta `SESSION_CONFLICT` — teste de concorrência real, não apenas sequencial. **Implementado no Módulo 07** via índice único parcial no Postgres (`prisma/rls/unique-active-appointment.sql`, ADR-0028) — a checagem em memória (`ScheduleSlot.overlapsWith()`) sozinha não é suficiente sob concorrência real (race condition de check-then-act); o banco é a fonte final de verdade.

---

# Auditoria

11. Toda ação da lista mínima obrigatória (`03-Database/08-Auditoria.md`) gera exatamente um registro em `audit_log`, e esse registro nunca pode ser alterado ou removido via nenhum endpoint da API.
12. Ação executada por agente de IA gera registro de auditoria com `actor_type = ai_agent`, nunca `user`, mesmo quando executada "em nome de" um usuário.

---

# Gestão de Inadimplência

14. Nenhuma mensagem automática gerada pelo agente ou pela régua de comunicação (`05-IA/03-Gestao-de-Inadimplencia.md`) contém menção a suspensão de atendimento, ameaça, cobrança de juros/multa automática ou linguagem constrangedora — teste de conteúdo sobre todas as mensagens geradas pela régua D+1/D+7/D+40.
15. Um paciente com cobrança em estado `Atrasada` continua aparecendo normalmente na agenda do terapeuta para novos agendamentos — nenhuma trava técnica impede agendamento por inadimplência (a decisão de continuar ou não atendendo é exclusivamente humana, nunca bloqueada pelo sistema).
16. A view `patient_financial_segment` classifica corretamente os 3 estágios pelos limiares exatos: `days_overdue` entre 1 e 7 → `em_atraso`; entre 8 e 40 → ainda `em_atraso` (não `inadimplente`); acima de 40 → `inadimplente`. Teste de fronteira nos valores exatos 7, 8, 40 e 41 dias.

---

# Fronteira Motor Operacional ↔ n8n

13. Nenhum workflow de n8n em produção altera dado do domínio sem passar por um endpoint de API que, por sua vez, passa pelo Motor Operacional — validado por revisão de workflow (teste de processo, não de código automatizado), conforme o teste de aceite definido em `02-Arquitetura/ADRs/ADR-0021.md`.

# Bypass de RLS do Login (adicionado no Módulo 04 — Multi-Tenant)

17. A política `auth_lookup_by_email` (`03-Database/09-Multi-Tenant.md`, ADR-0024) nunca vaza para nenhuma consulta além do login: uma transação aberta via `PrismaService.forTenant()` nunca enxerga usuário de outro Tenant, mesmo a policy de bypass existindo na tabela `user` — porque `app.bypass_tenant_check` só é setado dentro de `forAuthLookup()`, nunca em `forTenant()`. `SET LOCAL` é escopado à transação, não deve persistir entre reuso de conexão do pool.

---

# Documentos Relacionados

- 00 - Estratégia de Testes
- 03-Database/09-Multi-Tenant.md
- 03-Database/03-Relacionamentos.md
- 03-Database/08-Auditoria.md
- 02-Arquitetura/ADRs/ADR-0021.md
- 04-API/00-Principios-da-API.md
