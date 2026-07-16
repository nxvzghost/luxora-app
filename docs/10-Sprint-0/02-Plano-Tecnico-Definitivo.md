# Sprint 0 — Entregável 2: Plano Técnico Definitivo

## Decisões de nomenclatura fechadas nesta Sprint 0

Antes do plano em si, resolvendo as duas pendências herdadas da Auditoria Final (Entregável 1):

### Nomenclatura "Motor" (pendência #1)

**Decisão:** "Motor Operacional" é reservado exclusivamente para o núcleo central de decisão (ADR-0001). Os antigos "Motor Financeiro", "Motor Agenda", "Motor Cobrança" passam a se chamar **Serviços de Domínio**, nomeados por responsabilidade: `FinancialDomainService`, `SchedulingDomainService` etc. Nenhum componente além do núcleo central usa a palavra "Motor" em nome de classe, documento ou variável.

### Consolidação de Serviços de Domínio para o MVP (pendência #2)

**Decisão:** os 15 serviços originalmente listados na Arquitetura são consolidados em **6 Serviços de Domínio + o Motor Operacional** para o MVP:

| Serviço de Domínio (MVP) | Consolida |
|---|---|
| `PatientOpsDomainService` | Patient, Appointment, Schedule |
| `FinancialDomainService` | Finance, Charge, Payment |
| `CommunicationDomainService` | Notification, Message |
| `EngagementDomainService` | FollowUp, Dashboard |
| `PlatformDomainService` | Configuration, Policy, Audit |
| `AIDomainService` | AI Service (mantido isolado, dada a complexidade própria) |

Divisão adicional em serviços menores é permitida **apenas** quando um serviço consolidado ultrapassar complexidade que prejudique manutenção (critério: mais de ~15 Casos de Uso em um único serviço) — decisão tomada durante a implementação, não antecipada agora.

---

## Módulos, dependências e ordem de implementação

Mesma ordem já validada no relatório de arquitetura original, agora com critério de aceite formal por módulo.

### M1 — Fundação Técnica
**Dependências:** nenhuma.
**Entrega:** monorepo criado, CI básico, ambientes Dev/Staging, schema inicial do Postgres com RLS desde a primeira migration, Redis configurado.
**Critério de aceite:**
- [ ] Repositório criado com a estrutura definida no Entregável 3
- [ ] CI executando lint + testes em todo PR
- [ ] Ambiente Dev provisionado (Railway ou equivalente)
- [ ] Primeira migration aplicada com RLS ativo em ao menos uma tabela de teste
- [ ] `docs/` do repositório sincronizado com a documentação já produzida

### M2 — Domain Core
**Dependências:** M1.
**Entrega:** entidades, value objects, state machines (Sessão, Cobrança, Pagamento, Paciente) implementadas como camada pura, sem infraestrutura.
**Critério de aceite:**
- [ ] Todas as entidades do `01-Domain/01-Entidades.md` implementadas
- [ ] Todas as state machines do `01-Domain/03-Maquina-de-Estados.md` implementadas e testadas unitariamente
- [ ] 100% de cobertura de teste unitário na camada de domínio (sem exceção — é a camada mais barata de testar exaustivamente)
- [ ] Nenhuma dependência de framework, banco ou rede nesta camada

### M3 — Auth & Multitenancy
**Dependências:** M1, M2.
**Entrega:** JWT (access + refresh), RBAC básico (Admin/Terapeuta), TenantContext, RLS validado com teste real de isolamento.
**Critério de aceite:**
- [ ] Login/logout/refresh funcionando
- [ ] Teste crítico #1 e #2 (`09-Testes/01-Testes-Criticos.md`) passando: isolamento entre Tenants validado, inclusive com query proposital sem filtro
- [ ] RBAC bloqueando ação fora do perfil do usuário

### M4 — Motor Operacional (esqueleto)
**Dependências:** M2, M3.
**Entrega:** mecanismo de carregamento de política por clínica + roteamento de Caso de Uso, com ao menos 2-3 Casos de Uso reais conectados.
**Critério de aceite:**
- [ ] Motor Operacional carrega configuração real de `clinic_settings`
- [ ] Roteamento de Caso de Uso funcional, testado com ao menos 2 fluxos completos
- [ ] Nenhum Serviço de Domínio acessível diretamente sem passar pelo Motor (teste de arquitetura, não só funcional)

### M5 — Cadastros (Clínica, Terapeuta, Paciente)
**Dependências:** M3, M4.
**Entrega:** CRUD completo dos três, com `PatientOpsDomainService`.
**Critério de aceite:**
- [ ] RF-001 a RF-039 do PRD implementados
- [ ] `patient.billing_policy_override` funcional (herança de `clinic_settings.default_billing_policy` validada por teste)

### M6 — Agenda e Agendamento
**Dependências:** M5.
**Entrega:** `ConsultarDisponibilidade`, `AgendarConsulta`, `RemarcarConsulta`, `CancelarConsulta`, `ConfirmarConsulta`, `CriarAgendamentoRecorrente`.
**Critério de aceite:**
- [ ] RF-041 a RF-060 implementados
- [ ] Teste crítico #10 (`09-Testes`) passando: conflito de agenda concorrente resolvido corretamente

### M7 — API Layer
**Dependências:** M4, M5, M6.
**Entrega:** contratos REST de `04-API/01-Contratos-REST.md` implementados, OpenAPI gerado.
**Critério de aceite:**
- [ ] Todos os endpoints de Auth, Clínica, Terapeutas, Pacientes, Agenda documentados no `04-API` implementados e testados por integração
- [ ] Documentação OpenAPI publicada e navegável

### M8 — Frontend (Dashboard + Agenda)
**Dependências:** M7.
**Entrega:** primeira tela usável internamente, seguindo `06-UX/02-Fluxo-Dashboard.md` e `03-Fluxo-Agendamento.md`.
**Critério de aceite:**
- [ ] Dashboard consumindo `GET /dashboard/summary`
- [ ] Fluxo de agendamento completo funcional em tela
- [ ] Dogfooding interno possível a partir deste ponto (M1 do roadmap de negócio)

### M9 — Financeiro
**Dependências:** M6, M7. **Bloqueado até:** confirmação do modelo de cobrança por Pedro (já resolvido tecnicamente — ver `03-Database/03-Relacionamentos.md` — não é bloqueio real, apenas checagem final antes de codificar).
**Entrega:** `FinancialDomainService`, cobrança agregada (`billing_session`), pagamento com idempotência, segmentação por política individual do paciente.
**Critério de aceite:**
- [ ] RF-071 a RF-080 implementados
- [ ] Testes críticos #4 a #9 (`09-Testes`) passando — inclui idempotência de pagamento e modelo de cobrança agregada

### M10 — Auditoria
**Dependências:** M4 (para capturar toda ação do Motor).
**Entrega:** `audit_log` real, conforme `03-Database/08-Auditoria.md`.
**Critério de aceite:**
- [ ] Toda ação da lista mínima obrigatória gera registro de auditoria
- [ ] Teste crítico #11 e #12 passando (imutabilidade, `actor_type` correto)

### M11 — WhatsApp e Comunicação
**Dependências:** M6, M9.
**Entrega:** `CommunicationDomainService`, integração com WhatsApp Business API, filas com idempotência.
**Critério de aceite:**
- [ ] Envio de mensagem via WhatsApp funcional
- [ ] Idempotência de envio testada (sem duplicação em reenvio de fila)

### M12 — IA v1 (Agente de Recepção/Agendamento)
**Dependências:** M7, M11.
**Entrega:** `AIDomainService`, interface `IAIProvider` com Claude Haiku 4.5, tom de voz de `05-IA/01-Tom-de-Voz-e-Estilo-Conversacional.md` aplicado ao prompt.
**Critério de aceite:**
- [ ] Agente interpreta intenção de agendamento e cobrança corretamente em teste supervisionado
- [ ] `requiresEscalation` funcional com os critérios definidos ("tudo ok" = autônomo, resto = consulta de segurança)
- [ ] Custo real por conversa medido e dentro do teto de R$ 0,25 (RNF-021)
- [ ] Teste crítico #14 passando (nenhuma menção a suspensão/ameaça em mensagem automática)

### M13 — Follow-up, Dashboard consolidado, Gestão de Inadimplência
**Dependências:** M9, M12.
**Entrega:** `EngagementDomainService`, régua de comunicação de inadimplência (D+1/D+7/D+40), fechamento mensal.
**Critério de aceite:**
- [ ] Testes críticos #15 e #16 passando
- [ ] Fechamento mensal gerado corretamente com conclusão objetiva

### M14 — n8n e Automações
**Dependências:** M11, M13.
**Entrega:** rotina de controle de agenda diária (`05-IA/02`), automações classificadas conforme ADR-0021.
**Critério de aceite:**
- [ ] Teste crítico #13 passando (nenhuma decisão de negócio dentro de workflow n8n)
- [ ] Envio diário de agenda funcional, com reenvio em caso de alteração

### M15 — Observabilidade madura e Segundo Cliente Piloto
**Dependências:** todos os anteriores.
**Entrega:** os 4 pilares de observabilidade (`02-Arquitetura/11-Monitoramento.md`) maduros, prontos para operação com múltiplos clientes reais.

---

## Riscos técnicos por módulo

| Módulo | Risco | Mitigação |
|---|---|---|
| M3 (Auth/Multitenancy) | Falha de isolamento passar despercebida | Teste crítico #1/#2 como gate de merge, não apenas CI opcional |
| M4 (Motor Operacional) | Vira gargalo único de performance conforme volume cresce | Desenhar com observabilidade desde o início (não adicionar depois) |
| M9 (Financeiro) | Modelo de cobrança agregada mal implementado gera cobrança duplicada ou perdida | Testes críticos #4-7 bloqueantes antes de merge |
| M12 (IA) | Custo real de IA em produção divergir da estimativa | Alerta automático de custo (RNF-021) ativo desde o primeiro deploy do módulo, não depois |
| M14 (n8n) | Lógica de negócio vazar para dentro de workflow visual | Revisão de código aplicando o teste de aceite do ADR-0021 em todo PR que toca automação |

## Milestones de negócio (referência cruzada com o roadmap de produto)

| Marco | Módulos completos |
|---|---|
| M1 (negócio) — Motor rodando internamente | M1-M8 (técnicos) |
| M2 (negócio) — Primeiro cliente piloto real | M9-M11 |
| M3 (negócio) — Agente de IA v1 em produção | M12 |
| M4 (negócio) — Multi-cliente com automação | M13-M15 |

Este plano é a referência oficial da engenharia a partir desta Sprint 0 — qualquer desvio de ordem ou escopo deve ser justificado e registrado como ADR novo, não decidido informalmente durante a implementação.
