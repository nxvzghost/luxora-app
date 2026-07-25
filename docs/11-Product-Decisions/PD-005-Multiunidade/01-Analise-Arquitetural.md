# PD-005 — Multiunidade (Enterprise): Análise Arquitetural

> Nota de numeração (2026-07-18): este documento foi originalmente criado
> como PD-002. Renumerado para PD-005 para se alinhar à sequência oficial
> de Product Decisions da Luxora (PD-005 – Multi Unidade, PD-006 – IA
> Clínica, PD-007 – Identificação do Tenant via WhatsApp, PD-008 – Domínio
> Conversacional). Conteúdo inalterado, só a numeração.

## Origem

Registrado como pendência técnica durante a implementação de Benefícios por
Plano (2026-07-18): a tabela aprovada dá ao plano Enterprise "Multiunidade
(várias clínicas numa conta)", benefício sem nenhum gate implementado —
porque o conceito de "unidade" não existe no modelo de dados hoje. Esta
análise decide **o que precisa ser modelado**, não implementa nada.

## Método

Investiguei o código e a documentação real antes de propor qualquer coisa —
mesmo padrão usado no PD-001.

## A restrição fundamental (documentada, não incidental)

`docs/03-Database/09-Multi-Tenant.md` declara o axioma central da
plataforma, em uma frase:

> "Na Luxora, uma Clínica representa um Tenant."

Isso não é um detalhe de implementação — é o princípio em cima do qual toda
a defesa em profundidade multi-tenant foi construída:

- **Todo o RLS do Postgres é baseado num único `current_setting('app.tenant_id')` por transação** (`prisma/rls/enable-rls.sql`). Uma política, um valor escalar, por conexão.
- **`tenant_id` existe em ~20 tabelas** (confirmado por grep no schema: `clinic_settings`, `ai_settings`, `whatsapp_integration`, `user`, `therapist`, `patient`, `appointment`, `session`, `billing`, `billing_session`, `payment`, `audit_log`, `availability_calendar`, `clinic_holiday`, `recurring_block`, `clinic_subscription`, entre outras).
- **`TenantContext` (`@shared/tenant-context`) carrega exatamente 1 `tenantId` por sessão autenticada** — todo `Guard`, `UseCase` e `Repository` do sistema assume isso.
- **`ClinicSubscription` é 1:1 com `Tenant`** (`tenantId String @unique`) — 1 assinatura Asaas por clínica, criada em `CriarAssinaturaUseCase` ("modelo Netflix", ADR-0037).
- **`User.tenantId` não é nulável, nem múltiplo** — 1 usuário pertence a exatamente 1 Tenant.

Qualquer modelo de "multiunidade" precisa decidir explicitamente **onde**,
nessa pilha, o conceito de "unidade" entra — e "empurrar tudo pra baixo do
Tenant" ou "empurrar tudo pra cima do Tenant" têm custos radicalmente
diferentes.

## Opções consideradas

### Opção A — Unidade *dentro* do Tenant (Tenant vira "empresa")

Nova entidade `ClinicUnit`, e a maior parte dos dados clínicos
(`Therapist`, `Patient`, `Appointment`, `Session`, `Billing`, ...) passa a
referenciar `unitId` em vez de (ou além de) `tenantId`.

**Custo real:**
- Migração em ~15 tabelas, mudando a chave de particionamento que o RLS inteiro usa hoje.
- RLS deixa de ser "1 valor escalar por conexão" — vira "o usuário pode ver as unidades X, Y, Z dele", um conjunto, não um escalar. As políticas atuais (`USING (tenant_id = current_setting(...))`) precisariam virar subqueries ou uma tabela de associação usuário↔unidade consultada a cada política — mais lento, mais difícil de auditar, mais fácil de errar.
- Reescreve o axioma documentado ("uma Clínica representa um Tenant") para "uma Unidade representa uma Clínica, um Tenant representa uma Empresa" — precisa propagar essa mudança de vocabulário por toda a documentação e por quem já entende o sistema hoje.
- Broad blast radius: praticamente todo Repository, toda migration de RLS, a Suíte Crítica inteira de isolamento multi-tenant precisa ser reprovada sob o novo modelo.

**Quando faria sentido:** se o requisito real fosse "um mesmo terapeuta atende em duas unidades" ou "agenda compartilhada entre unidades" — aí a fronteira de isolamento *precisa* descer para dentro do Tenant. Não é isso que a tabela aprovada pede (ela só fala em "várias clínicas numa conta").

### Opção B — Conta *acima* do Tenant (Tenant não muda)

Nova entidade `Account` (ou `Organization`), que agrupa N `Tenant`s
existentes — sem tocar em nenhuma tabela clínica, nenhuma política de RLS,
nenhum Repository hoje existente. Cada clínica continua sendo exatamente 1
Tenant, exatamente como o axioma documentado já diz.

```
Account (Enterprise, 1 assinatura)
  ├── Tenant "Clínica A" (RLS igual a hoje, intocado)
  └── Tenant "Clínica B" (RLS igual a hoje, intocado)
```

**O que muda de fato:**
- `Account` é puramente organizacional — **nunca** tem `PlanTier`, nunca tem `ClinicSubscription` própria, nunca distribui benefício nenhum para os Tenants que agrupa. Decisão oficial fechada em 2026-07-18 (ver "Decisão final", abaixo) — a alternativa cogitada nesta análise ("Account é quem tem a assinatura, Tenants herdam") foi explicitamente descartada: permitiria um cliente administrar N clínicas pagando 1 assinatura só, o que quebra o modelo comercial. `ClinicSubscription` continua exatamente 1:1 com `Tenant`, sem nenhuma mudança.
- Login continua 1 usuário = 1 Tenant (nenhuma mudança em `User`, `TenantContext`, `JwtAuthGuard`). Multiunidade, nesta opção, começa como "um dono de conta tem N logins/clínicas sob o mesmo guarda-chuva organizacional", não como SSO instantâneo entre unidades — isso pode vir depois, como uma segunda fase (um `AccountMembership` opcional ligando 1 usuário a N Tenants, só quando o produto realmente precisar de troca de unidade sem novo login).
- Relatório consolidado entre unidades (se um dia for pedido) vira uma leitura explícita, autorizada por pertencimento ao mesmo Account — nunca um enfraquecimento do RLS de tenant único por conexão.

**Custo real:** 1 tabela nova (`Account`, sem RLS — não é dado clínico), 1 FK opcional em `Tenant` (`accountId`). Nada muda em `ClinicSubscriptionRepository`/`CriarAssinaturaUseCase` — assinatura nunca sai do Tenant. Zero mudança em RLS, zero mudança nas ~20 tabelas clínicas, zero mudança na Suíte Crítica de isolamento hoje existente.

### Opção C — Nenhuma mudança estrutural agora (status quo comercial)

Enterprise multiunidade = N Tenants completamente independentes (como já é
possível hoje, criando N assinaturas), sem nenhum vínculo técnico — a
"conta única" é só uma percepção comercial (o time sabe que pertencem ao
mesmo cliente), não uma entidade no sistema.

**Custo real:** zero — já é o comportamento atual.
**Limite real:** nunca sustenta um dashboard consolidado, um único login
trocando de unidade, ou uma fatura consolidada — a promessa "várias
clínicas numa conta" fica só na descrição comercial, nunca na experiência
do produto. Não recomendo tratar isso como solução — é o "não fazer nada",
registrado aqui só para ficar explícito que foi considerado e descartado.

## Recomendação

**Opção B.** Resolve exatamente o que a tabela aprovada pede
("Multiunidade (várias clínicas numa conta)"), preserva 100% do axioma
"Tenant = Clínica" e do RLS existente (o pilar de segurança mais crítico do
sistema, descrito no próprio doc como "risco reputacional e legal
desproporcional"), e tem uma superfície de mudança pequena e isolada
(Módulo 17, não Módulo 04). A Opção A resolveria um problema diferente do
que foi pedido (unidades compartilhando dados clínicos), a um custo que
nenhuma linha da tabela aprovada justifica.

## Decisão final (2026-07-18) — Opção B aprovada, com esclarecimento adicional

As duas perguntas que esta análise tinha deixado em aberto foram
respondidas oficialmente pelo CEO:

- **Herança de plano entre clínicas de um Account: não existe, nunca vai
  existir por padrão.** Cada Tenant tem seu próprio `PlanTier` e sua
  própria `ClinicSubscription`, de forma totalmente independente dos
  outros Tenants do mesmo Account. Um grupo com 3 clínicas Enterprise paga
  3 assinaturas Enterprise — nunca 1 compartilhada. Isso elimina de vez a
  alternativa "Account tem a assinatura" que a Opção B original ainda
  cogitava como possibilidade — está descartada, não é mais uma opção em
  aberto.
- **Cancelamento é, por consequência, sempre por Tenant** — como não existe
  assinatura no nível do Account, não há "cancelar o Account" que afete
  outro Tenant além dele mesmo. Cada clínica liga/desliga seu próprio
  acesso, exatamente como o `SubscriptionAccessGuard` já faz hoje por
  Tenant, sem nenhuma mudança de comportamento.
- **Enterprise, especificamente**, ganhou uma regra adicional nesta rodada
  (fora do escopo original desta análise, mas decidida junto): é
  contratado por clínica, com um teto comercial de terapeutas (hoje 5,
  configurável) — ver `plan-benefits.ts` e o MODELO.md do CEO.

## Impacto (ainda não implementado — só a correção de PLAN_BENEFITS foi feita nesta rodada)

- **Módulos afetados quando a entidade Account for construída:** 17 (Assinatura) só na parte de agrupamento/exibição — nunca na parte de billing, que continua 100% por Tenant; 04 (Multi-Tenant) permanece intocado.
- **Migração:** 1 tabela nova (`account`), 1 coluna nova opcional (`tenant.account_id`) — aditiva, não destrutiva. Nenhuma mudança em `clinic_subscription`.
- **RLS:** nenhuma mudança — `account` não precisa de RLS por tenant_id (é a entidade que agrupa tenants, não um dado clínico).
- **Fases sugeridas** (não aprovadas para implementação ainda — só esboçadas para dar noção de tamanho; nenhuma foi construída nesta rodada, por instrução explícita de não antecipar complexidade sem necessidade):
  1. `Account` + N `Tenant`s vinculados, cada um com sua própria `ClinicSubscription` intocada.
  2. Tela de "trocar de unidade" no frontend, ainda com 1 login por Tenant.
  3. (Só se pedido no futuro) `AccountMembership` para login único trocando de unidade sem nova autenticação.
  4. (Fora do MVP, não influencia o design acima) Um eventual plano Corporate/Multi-Clinic viveria no nível do Account quando/se for priorizado.
