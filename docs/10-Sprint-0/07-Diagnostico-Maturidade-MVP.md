# 07 — Diagnóstico de Maturidade do MVP (2026-07-18)

## Objetivo e método

Diagnóstico do estado real do código (não da documentação de intenção) —
o que falta para uma clínica operar completamente o sistema em produção.
Nenhuma funcionalidade nova é proposta aqui — só o que já foi decidido e
ainda não está pronto, provisório, ou arriscado. Toda afirmação abaixo foi
verificada por leitura direta do código, grep por marcadores de dívida
(`TODO`, "dívida", "não implementado") e pelos achados já registrados ao
longo desta sessão (Etapas 1/2 de estabilidade, PD-001 a PD-004).

Complementa `01-Auditoria-Final.md` (que auditou a *documentação*, em
2026-07, antes da implementação começar) — este documento audita a
*implementação real*, meses depois.

---

## 1. Gaps críticos — impedem uma clínica de operar em produção hoje

### 1.1 Não existe entrada real para o fluxo Paciente → WhatsApp → IA

**O achado mais grave desta auditoria.** O PD-001 declara, como fluxo
oficial e não-negociável: *"Paciente → WhatsApp Oficial da Clínica → IA →
Motor de Disponibilidade → Agenda → Confirmação → Agendamento."* O código
de `ProcessarMensagemUseCase`/`IntentActionRouter` (Módulo 12) existe e
está correto — mas **não há nenhum Controller, nenhuma rota, nenhum
webhook recebendo mensagem real de paciente**. Confirmado por grep: zero
ocorrência de rota de entrada para `ProcessarMensagemUseCase` em todo
`api/`. O próprio `AIModule` documenta isso: *"Sem Controller próprio
ainda — o ponto de entrada real (webhook do WhatsApp recebendo mensagem do
paciente) continua como dívida explícita."*

**Impacto:** o diferencial central da Luxora segundo a própria pesquisa de
concorrência (IA conversacional como interface) **não pode ser usado por
um paciente real hoje**, mesmo com WhatsApp já conectado (Módulo 11).

### 1.2 Fila de envio de mensagens nunca foi validada contra Redis real

`MessageQueueWorker` (BullMQ) tem comentário explícito no próprio código:
*"NÃO EXECUTADO NESTE AMBIENTE (sem Redis real disponível) — código
completo, pendente de validação empírica junto com o restante da
infraestrutura (mesma pendência desde o Módulo 01)."* Isso significa que
lembretes, confirmações e mensagens de cobrança — todo o lado de *saída*
da comunicação — nunca rodou de ponta a ponta contra uma fila real.

**Combinado com 1.1:** o pipeline de comunicação inteiro (entrada e
saída) é código correto e bem testado em unidade, mas **nunca foi provado
funcionando de ponta a ponta contra infraestrutura real**.

### 1.3 Histórico de migrations nunca foi validado do zero

Toda migration deste projeto, desde muito cedo nesta sessão, foi criada
manualmente (`prisma migrate diff` + `prisma db execute` + `prisma migrate
resolve --applied`) contra um banco de desenvolvimento **já existente e
incrementalmente atualizado** — nunca contra um banco vazio. O próprio
`prisma/migrations/README.md` (ainda não atualizado) documenta a
premissa original — "não gerar migration manualmente" — que já não reflete
a realidade do projeto. O workflow de CI (`test-integration`,
`test-critical`) roda `prisma migrate deploy` contra um Postgres **vazio**,
recém-criado pelo `docker` do runner — ou seja, **a primeira vez que a
sequência completa de migrations será testada do zero é a próxima execução
do CI**, não algo já verificado localmente.

**Risco real:** se qualquer migration manual tiver uma dependência de
ordem sutil ou uma diferença entre o que rodou localmente (via `db
execute`) e o que `migrate deploy` replica, isso só aparece no CI ou, pior,
em um deploy real — não antes.

---

## 2. Bugs reais conhecidos, registrados, não corrigidos

### 2.1 `Billing` órfã quando `linkSessions()` falha (`GerarCobrancaUseCase`)

Achado na investigação da Etapa 1 (Critical Suite), nunca corrigido em
produção — só contornado no cleanup dos testes. `repo.save(billing)` e
`repo.linkSessions(...)` são duas chamadas não-transacionais; se a sessão
já estiver cobrada (`SESSION_ALREADY_BILLED`, 409), a `Billing` já salva
nunca é revertida. Fica uma cobrança real, órfã, sem nenhum id exposto na
resposta de erro para rastrear. Correção correta: envolver `save()` +
`linkSessions()` em uma transação dentro do próprio Use Case.

### 2.2 Token de acesso do WhatsApp armazenado em texto plano

Documentado no próprio `schema.prisma` (`WhatsAppIntegration.accessToken`)
como dívida de segurança explícita, "precisa de endurecimento antes de
produção real com clientes pagantes." Não é hipotético — é uma credencial
de canal de comunicação da clínica guardada sem criptografia em repouso.

### 2.3 Nenhum rate limiting em nenhum endpoint

Busca confirmou: zero implementação de rate limiting/throttling em todo o
backend — inclusive `POST /auth/login`. Um MVP em produção real, mesmo com
poucos clientes, fica exposto a força bruta de login e abuso de qualquer
endpoint público sem nenhuma camada de proteção.

### 2.4 Inconsistência de dado real no frontend (achada, nunca investigada)

Registrada durante uma revisão visual anterior nesta sessão: o Dashboard
mostra "pacientes recentes" enquanto a tela de Pacientes mostra "Nenhum
paciente cadastrado" — mesma conta, mesma sessão. Bug real de
consistência de dado, nunca investigado a fundo (decisão explícita do
usuário na época: registrar, não investigar naquele momento).

---

## 3. Módulos/fluxos incompletos ou provisórios

### 3.1 Dois caminhos paralelos para agendamento recorrente

`CriarAgendamentoRecorrenteUseCase` (antigo, exposto em
`POST /appointments/recurring`) cria ocorrências em intervalo fixo **sem
consultar feriados/exceções** — dívida documentada no próprio código desde
antes do PD-001. Depois, C1–C5 construíram `RecurringBlock` (o sistema
correto, que materializa respeitando o Motor de Disponibilidade completo),
exposto em `POST /recurring-blocks`. **As duas rotas coexistem hoje** —
um cliente ou a própria IA podem acidentalmente usar a rota antiga e
receber um comportamento sabidamente incorreto. Isso não é uma feature
faltando — é uma inconsistência arquitetural ativa.

### 3.2 Fechamento mensal incompleto e sem paginação real

`GerarFechamentoMensalUseCase`: uma das 5 seções do relatório (agregação
por período) não está implementada — `BillingRepository` não expõe o
método necessário, dívida registrada no próprio código. Além disso, a
consulta usa `findAllByTenant({ limit: 1000 })` com um comentário `TODO:
paginação real se volume crescer` — acima de 1000 cobranças no Tenant, o
fechamento mensal passa a considerar dados incompletos silenciosamente.

### 3.3 Logout stateless, sem revogação de token

Documentado como decisão consciente do MVP, não bug: sem blacklist de
JWT, um token roubado continua válido até expirar (15 min) mesmo após
logout. Aceitável para o estágio atual, mas é uma lacuna real de resposta
a incidente de segurança.

### 3.4 Estado `EmConferencia` de Payment nunca é alcançado

`payment.entity.ts` documenta um fluxo de conferência manual de pagamento
que nenhum caller do sistema hoje aciona — estado morto na máquina de
estados, à espera de um fluxo que não foi construído.

### 3.5 Nenhuma camada de cache de aplicação

Deliberado e bem documentado (`cache-tenant-isolation.test.ts`, skip
explícito) — Redis hoje só serve a fila BullMQ, não há cache de dado de
aplicação. Não é urgente para o volume atual, mas é a razão de o Teste
Crítico #3 estar pulado, não verde.

---

## 4. Decisões arquiteturais em aberto (registradas, não esquecidas)

| Decisão | Status |
|---|---|
| PD-005 — Account/Multiunidade | Arquitetura aprovada, implementação congelada até 1º caso real |
| PD-004 — Primeiro endpoint público da API | Infraestrutura pronta, superfície congelada até validação comercial |
| Estratégia de timezone | Nunca implementada (dívida pré-existente, ADR rascunhado, não aprovado) |
| Contract test `ClinicHoliday.overlaps()` (domínio) vs. SQL do Repository | Registrado desde B3, nunca escrito |
| Semântica de pausar/cancelar `RecurringBlock` já materializado | Proposta, não confirmada como decisão de produto |
| Job de materialização contínua de `RecurringBlock` (C6) | Não desenhado em detalhe |
| Acesso parcial no `SubscriptionAccessGuard` (ex: PastDue só lê, não cria) | Hoje é tudo-ou-nada; granularidade adiada |
| Nome/vocabulário "Motor" usado tanto para o núcleo quanto para sub-serviços | Já registrado como pendente desde a Auditoria Final de Sprint 0, nunca resolvido |

---

## 5. Prontidão operacional (não é bug de código — é checklist de lançamento)

Não avaliado como "gap de engenharia", mas relevante para "operar
completamente em produção": `.env` de desenvolvimento tem
`ANTHROPIC_API_KEY`, `S3_ACCESS_KEY`/`S3_SECRET_KEY` e `ASAAS_API_KEY`
vazios, `ASAAS_ENV="sandbox"` (gateway de pagamento ainda não em modo
real), `JWT_SECRET` é um valor de exemplo de desenvolvimento. O provedor
de infraestrutura (Railway, `07-Infra/00-Provedor-e-Custos.md`) é uma
recomendação documentada, nunca provisionado de fato — o próprio documento
recomenda "validar com conta de teste real antes de comprometer
orçamento", ainda não feito.

---

## 6. Qual deve ser a próxima prioridade

Ordenado por "o que impede uma clínica de operar de verdade", não por
facilidade de implementação:

1. **Fechar o pipeline de comunicação de ponta a ponta (1.1 + 1.2).** Sem
   webhook de entrada do WhatsApp e sem validação real da fila BullMQ, o
   produto não tem o fluxo que a própria Luxora define como central — não
   é uma funcionalidade a mais, é a espinha dorsal do produto ainda não
   comprovada em produção.
2. **Validar o histórico de migrations do zero (1.3), antes de qualquer
   deploy real** — risco silencioso até o dia em que for tarde para
   descobrir.
3. **Corrigir a `Billing` órfã (2.1)** — é dinheiro real ficando
   inconsistente, com correção conhecida e pequena (envolver `save()` +
   `linkSessions()` em uma transação).
4. **Resolver a duplicidade de agendamento recorrente (3.1)** — decidir
   entre aposentar `CriarAgendamentoRecorrenteUseCase` ou documentar
   explicitamente por que os dois caminhos coexistem; hoje é uma
   inconsistência ativa, não uma dívida passiva.
5. **Criptografia do token do WhatsApp em repouso (2.2) e rate limiting
   básico (2.3)** — antes do primeiro cliente pagante real, não depois.
6. Só então revisitar o que já está conscientemente congelado (PD-005,
   PD-004) — ambos corretamente adiados até haver sinal real de demanda,
   não bloqueiam operação hoje.
