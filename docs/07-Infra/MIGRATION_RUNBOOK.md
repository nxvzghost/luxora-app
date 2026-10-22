# MIGRATION_RUNBOOK — Execução Operacional de Migrations

**Status:** Oficial — padrão operacional definitivo do projeto para execução de migrations. Aprovado pelo CTO em decisão de 2026-07-20 (CTO Decision – Database), a partir do diagnóstico real de bloqueio de permissão em `clinic_subscription` (ver histórico de diagnóstico de ambiente da Sprint 2 de Assinaturas); seções de Recovery Drill e CI/CD Integration acrescentadas e aprovadas na mesma data (CTO Approval).

## Escopo

Este documento é o complemento **operacional** de [06-Migrations.md](../03-Database/06-Migrations.md). Aquele documento define a filosofia e as regras de versionamento do schema; este define **quem executa, com qual credencial, em qual ordem, e como validar/reverter**, em cada ambiente.

Não repete decisões já fechadas em outro lugar — apenas referencia:
- Ferramenta oficial: Prisma Migrate ([06-Migrations.md](../03-Database/06-Migrations.md)).
- Fluxo de ambientes (Dev → Homologação → Produção) e exigência de aprovação antes de produção: [13-Deploy.md](../02-Arquitetura/13-Deploy.md).
- Provedor de infraestrutura para Homologação/Produção: Railway ([00-Provedor-e-Custos.md](00-Provedor-e-Custos.md)).

## Conclusões oficiais que fundamentam este runbook

1. A arquitetura de permissões está correta: `luxora_app` é intencionalmente um usuário restrito (sem `SUPERUSER`, sem `BYPASSRLS`) para que as policies de Row-Level Security de isolamento multi-tenant realmente se apliquem — inclusive contra os próprios objetos que ele criar. Ver comentário técnico em `infra/docker/postgres-init/01-app-role.sql`.
2. `luxora_app` deve continuar restrito. Ele é o usuário de **runtime** da aplicação (`DATABASE_URL` em `.env`) — nunca o usuário que executa DDL.
3. Migrations devem ser executadas **exclusivamente** por um usuário administrativo (`postgres` local, ou o usuário admin do banco gerenciado em Homologação/Produção) — nunca pelo usuário de runtime da aplicação.

### Por que isso importa na prática (causa raiz já confirmada)

`GRANT ALL ON ALL TABLES` (o que `luxora_app` recebe) concede privilégios de leitura/escrita — **não** concede posse (`OWNER`) do objeto. `ALTER TABLE` exige ser dono do objeto ou superusuário. Se, por qualquer motivo, uma tabela específica acabar sendo criada por uma sessão conectada como `luxora_app` em vez de como `postgres`, `luxora_app` passa a ser dono *daquela* tabela — mas se ela for criada por `postgres` (ou recriada/alterada em algum momento por ele), `luxora_app` nunca poderá rodar `ALTER TABLE` nela, mesmo tendo `GRANT ALL`. Foi exatamente esse cenário que produziu o erro `must be owner of table clinic_subscription` (`42501`) diagnosticado nesta sessão.

**Regra prática derivada:** para que a posse de schema fique previsível, **toda** migration — em todo ambiente — deve ser executada com a conexão do usuário admin. Nunca alternar entre "às vezes `luxora_app` roda migrate, às vezes `postgres` roda" — isso é o que gera divergência de ownership tabela a tabela.

---

## Papéis e responsáveis

| Etapa | Quem executa | Credencial usada |
|---|---|---|
| Escrever/gerar a migration | Qualquer Engenheiro de Software (papel Claude/Principal AI Software Engineer ou humano equivalente) | Nenhuma (`prisma migrate dev` local, ambiente descartável) |
| Revisar a migration (SQL gerado) | CTO ou Engenheiro designado, em Code Review | — |
| Aplicar em Desenvolvimento | O próprio Engenheiro, na sua máquina | `postgres` (superusuário do container local) |
| Aplicar em Homologação | Pipeline de CI/CD (etapa "Deploy em Homologação" de [13-Deploy.md](../02-Arquitetura/13-Deploy.md)) | Credencial admin do Postgres gerenciado (Railway), armazenada como secret de CI — nunca digitada manualmente |
| Validar em Homologação | CTO (ou Engenheiro designado) | — |
| Aprovar execução em Produção | CTO (obrigatório — ver [13-Deploy.md](../02-Arquitetura/13-Deploy.md): "Somente usuários autorizados poderão executar Deploys em produção") | — |
| Aplicar em Produção | Pipeline de CI/CD, disparado somente após aprovação explícita | Credencial admin do Postgres gerenciado (Railway), secret de CI |

**Pendência em aberto, não coberta por este runbook:** não há, até o momento, evidência no repositório de que uma role restrita equivalente a `luxora_app` já foi provisionada nos bancos de Homologação/Produção do Railway. Provisionar essa role (replicando a lógica de `infra/docker/postgres-init/01-app-role.sql`: `CREATE ROLE ... LOGIN`, sem `SUPERUSER`, `GRANT ALL` em vez de `OWNER`) nesses ambientes é pré-requisito para este runbook valer neles, e é responsabilidade de quem administra a instância Railway — deve ser tratado como um item de infraestrutura separado, não assumido como já pronto.

---

## Procedimento — Desenvolvimento

Pré-requisito: `docker-compose up -d` rodando (`postgres` respondendo ao healthcheck `pg_isready`).

1. Nunca alterar o `DATABASE_URL` do `.env` — ele deve continuar apontando para `luxora_app`, é o que a aplicação usa em runtime.
2. Para gerar e aplicar uma nova migration, sobrescrever a variável de ambiente **apenas para o comando**, apontando para o usuário admin:
   ```
   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/luxora_dev" npx prisma migrate dev --name <nome_da_migration>
   ```
   `migrate dev` é interativo/destrutivo por natureza (pode propor reset de schema se detectar drift) — por isso é **exclusivo de Desenvolvimento**, nunca usado em Homologação/Produção.
3. Revisar o SQL gerado em `prisma/migrations/<timestamp>_<nome>/migration.sql` antes de commitar — não confiar cegamente no que o Prisma gerou.
4. Rodar `npx prisma generate` **somente depois** do passo 2 ter terminado com sucesso (nunca antes, nunca como forma de "contornar" uma aplicação que falhou — ver seção de Erros Conhecidos).

## Procedimento — Homologação

1. A migration já deve estar commitada e ter passado por Code Review (SQL revisado, não só o Use Case/domínio que a motivou).
2. Antes de aplicar, rodar `prisma migrate status` contra o banco de Homologação para confirmar o estado real (migrations já aplicadas vs. pendentes) — nunca assumir que o estado é o mesmo do commit anterior.
3. Aplicação via pipeline de CI/CD, usando `prisma migrate deploy` (não `migrate dev`):
   ```
   npx prisma migrate deploy
   ```
   com `DATABASE_URL` apontando para a credencial admin do Postgres de Homologação, injetada como secret de CI — nunca hardcoded, nunca em log de build.
4. Após aplicar, rodar a Suíte Crítica relevante (`test/critical/`) contra o ambiente de Homologação antes de liberar para Produção.

## Procedimento — Produção

1. Requer aprovação explícita do CTO antes da execução — sem exceção, mesmo para migrations consideradas "triviais" (consistente com [13-Deploy.md](../02-Arquitetura/13-Deploy.md)).
2. Validar backup imediatamente antes da execução (ver seção Backups de [13-Deploy.md](../02-Arquitetura/13-Deploy.md)) — sem backup validado, não aplicar.
3. Mesmo comando de Homologação (`prisma migrate deploy`), mesma exigência de credencial admin via secret de CI, nunca digitada manualmente por um humano.
4. Preferir aplicar fora de horário de pico, a menos que a migration seja comprovadamente aditiva e sem lock prolongado (ver Estratégia de Rollback abaixo, "expand/contract").
5. Registrar a execução como um Deploy (versão, data, responsável, ambiente, resultado, observações), conforme a seção Auditoria de [13-Deploy.md](../02-Arquitetura/13-Deploy.md).

---

## Checklist — Antes de aplicar (qualquer ambiente)

- [ ] Migration gerada localmente, SQL lido e entendido (não só "o Prisma gerou, deve estar certo").
- [ ] `prisma migrate status` rodado contra o ambiente alvo — estado real confirmado, não presumido.
- [ ] A conexão usada é a do usuário **admin**, nunca a do usuário de runtime (`luxora_app` ou equivalente em Homologação/Produção).
- [ ] Ambientes anteriores no fluxo já validaram esta mesma migration (Dev antes de Homologação; Homologação antes de Produção — nunca pular etapa).
- [ ] Backup validado (obrigatório em Homologação/Produção).

## Checklist — Depois de aplicar (qualquer ambiente)

- [ ] `prisma migrate status` confirma "Database schema is up to date" — não apenas "o comando saiu com exit code 0".
- [ ] `prisma generate` executado **agora**, não antes — os tipos do Prisma Client devem refletir um schema que já existe de fato no banco.
- [ ] Smoke test real: pelo menos uma query tocando a(s) coluna(s)/tabela(s) novas, não só um healthcheck genérico da aplicação.
- [ ] Suíte Crítica relevante executada (obrigatório em Homologação; smoke test dirigido em Produção).
- [ ] Registro de auditoria do Deploy preenchido.

---

## Estratégia de rollback

Prisma Migrate **não gera migrations de reversão automaticamente** — não existe um "down" nativo. Reversão é sempre uma ação deliberada:

- **Caminho preferencial:** escrever uma **nova** migration que desfaz a mudança (consistente com a regra já registrada em [06-Migrations.md](../03-Database/06-Migrations.md): "Nunca editar uma migration já executada. Criar sempre uma nova migration."). Passa pelo mesmo fluxo Dev → Homologação → Produção de qualquer outra migration.
- **Quando uma migration falhou parcialmente** (aplicou parte do DDL e travou): usar `npx prisma migrate resolve --rolled-back <nome_da_migration>` para corrigir a tabela de controle interna do Prisma (`_prisma_migrations`). **Isso só corrige o registro do Prisma — não desfaz nenhum DDL que já tenha rodado.** Qualquer alteração parcial de schema precisa ser revertida manualmente, via SQL direto com o usuário admin, *antes* de marcar como `rolled-back` — caso contrário o schema real e o que o Prisma acredita que existe ficam divergentes (foi exatamente essa divergência, acumulada ao longo desta Sprint, que quebrou toda a Suíte Crítica de `ClinicSubscription`).
- **Para mudanças potencialmente destrutivas** (remover coluna/tabela, mudar tipo de forma incompatível), preferir o padrão expand/contract:
  1. **Expand** — migration aditiva (nova coluna/tabela), sem remover nada; deploy do código que já escreve no novo formato mas ainda lê o antigo.
  2. **Backfill** — preencher os dados novos a partir dos antigos.
  3. **Contract** — migration que remove a estrutura antiga, só depois de confirmar que nenhum código em nenhum ambiente ainda depende dela.

  Isso mantém as fases 1 e 2 sempre reversíveis (é só não prosseguir para a fase 3).

### Exigência de versão e retorno degradado (K2-a)

Desde a migration `20261022120000_k2a_billing_eligibility` ([ADR-0069](../02-Arquitetura/ADRs/ADR-0069-ciclo-de-vida-da-consulta.md), seção 3.7), o banco recusa por conta própria a cobrança e o vínculo que não passaram pela conferência de elegibilidade. Uma versão anterior da aplicação continua rodando contra esse banco, mas **não cria cobrança nem vínculo**: o banco recusa. Ela ainda atualiza o estado das cobranças que já existem (envio, régua, quitação). Esse é o **modo degradado**.

Para que ninguém entre nele sem saber:

- **A imagem declara o que sabe fazer** no rótulo `luxora.capabilities` (definido em `infra/docker/Dockerfile.backend`). A versão com o K2-a declara `billing-eligibility-v1`; as anteriores não declaram nada.
- **O banco declara o que exige** na tabela `deployment_requirement`, que só as migrations preenchem. A aplicação não lê nem escreve nela.
- **O ambiente guarda o que já exigiu** no estado `requirement-active` (diretório de estado do deploy), gravado assim que as migrations de um deploy passam pela conferência, mesmo que a troca da aplicação falhe depois.

| Script | Situação | O que faz |
|---|---|---|
| `deploy.sh` | A versão não tem uma capacidade que o banco exige ou que o ambiente já exigiu | Recusa antes do backup (código 3), registra `refused-capability` |
| `deploy.sh` | Depois das migrations, faltam restrições do K2-a, ou a aplicação voltou a ter um privilégio que as contornaria | Recusa sem trocar a aplicação (código 3), registra `failed-protections` |
| `deploy.sh` | A versão nova falha no **deploy que introduz a exigência**, e a anterior não tem a capacidade | Rollback automático em modo degradado, registrado como `degraded` (código 1): a versão nova não chegou a atender, e parar a aplicação seria pior (ADR-0069, seção 9.4) |
| `deploy.sh` | A versão nova falha num deploy posterior, e a anterior não tem uma capacidade que o ambiente **já exigia** | **Não volta**: para a aplicação (código 2), registra `rollback-refused`. Com `--allow-degraded --notes "justificativa"` no deploy, volta e registra `degraded` (código 1) |
| `rollback.sh` | O destino não tem a capacidade | Recusa (código 3), registra `refused-capability`. Com `--allow-degraded --notes "justificativa"`, volta e registra `mode: degraded` |
| `rollback.sh` | O banco não tem as proteções que exige, ou deixou de exigir o que o ambiente já exigia | Recusa, mesmo para uma versão com a capacidade (código 3), registra `refused-protections`. O caminho é `deploy.sh` |
| `restore-drill.sh` | O backup exige a capacidade | Confere restrições e privilégios no banco restaurado; reprova se faltarem |
| `restore-drill.sh` | O backup é anterior à exigência do ambiente | Passa, com o aviso `backup-anterior-à-exigência` no resultado e no histórico |

Cada linha do histórico (`history.jsonl`) tem agora o campo `mode` (`normal` ou `degraded`). Fora do deploy que introduz a exigência, um retorno degradado nunca é automático: exige a justificativa de quem decidiu, e fica registrado com ela.

**Antes de decidir por um retorno degradado:** durante ele, nenhuma cobrança nova é gerada (a tela de cobrança devolve erro), e as sessões continuam a faturar. Nada se perde, e o próximo deploy da versão com a capacidade sai do modo degradado. A prova com a versão anterior de verdade (`fd0874f`) está em `infra/tests/k2-compat-rehearsal.sh`.

**Para aposentar uma exigência** (uma migration futura que a remova), o estado `requirement-active` também tem de ser atualizado à mão, com registro. Sem isso, os scripts tratam a remoção como perda de proteção e recusam.

**Onde o papel da aplicação é dono das tabelas** (CI e ambiente local, em que as migrations rodam com `luxora_app`), ele pode devolver a si qualquer privilégio. Ali os privilégios por coluna não são barreira, e a migration dá a ele `UPDATE` em `billing_eligibility_protocol.description` e `billing_session.created_at`, colunas sem papel na integridade, porque a checagem de chave estrangeira trava linhas com o dono da tabela e isso exige algum `UPDATE`. Em homologação e produção as migrations rodam com o administrador, o dono é ele, e essas duas concessões não existem.

---

## Erros conhecidos e diagnóstico rápido

Catálogo baseado em falhas reais já encontradas e diagnosticadas nesta base de código — não hipotéticas.

| Sintoma | Causa | Ação |
|---|---|---|
| `P3018` / `must be owner of table X` (código Postgres `42501`) | Migration executada com a credencial de runtime (`luxora_app`), que tem `GRANT` mas não `OWNER` sobre a tabela | Reconectar com a credencial admin (`postgres` ou equivalente) e reaplicar |
| `P1001: Can't reach database server` | O serviço de banco não está no ar (em Dev: container Docker no WSL2 parado — ver [`ADR-0047`](../02-Arquitetura/ADRs/ADR-0047-docker-engine-nativo-wsl2.md); em Homologação/Produção: instância gerenciada indisponível) | Confirmar que o serviço está de fato rodando antes de qualquer outro diagnóstico — sem conexão, nenhum outro sintoma pode ser distinguido |
| `permission denied for table X` (`42501`) ao criar ou apagar uma linha que tem chave estrangeira, com o papel da aplicação dono das tabelas (CI, ambiente local) | A checagem de chave estrangeira trava a linha da outra tabela com `SELECT … FOR KEY SHARE`, executado com o dono dela, e isso exige `UPDATE` em pelo menos uma coluna. Um privilégio por coluna revogado por completo derruba a checagem | Conceder `UPDATE` só numa coluna sem papel na integridade, e só onde o papel da aplicação é o dono (ver a migration do K2-a). Nunca devolver o privilégio da coluna protegida |
| `permission denied for table billing` ao criar cobrança, mesmo com o privilégio de `INSERT` nas colunas que o código grava | O Prisma Client manda no `INSERT` o padrão estático (`@default(false)`) de toda coluna do modelo, inclusive as que o papel da aplicação não pode gravar | A coluna fica no schema com `@ignore` (`Billing.legacyBilling`, `BillingSession.legacyLink`): sai do client, e quem aplica o padrão é o banco |
| `deploy.sh`/`rollback.sh` saem com código 3 e `refused-capability` ou `refused-protections` no histórico | A versão não tem uma capacidade que o banco exige, ou o banco não tem as proteções que declara | Ver "Exigência de versão e retorno degradado" |
| `PrismaClientKnownRequestError: The column X does not exist in the current database` em runtime (não durante a migration em si) | `prisma generate` foi executado a partir de um `schema.prisma` mais novo do que o banco real — a migration correspondente nunca chegou a ser aplicada com sucesso, mas os tipos do Prisma Client já assumem que a coluna existe | Nunca rodar `prisma generate` como forma de "seguir em frente" quando uma migration falha. Aplicar a migration pendente com o usuário admin primeiro; só então gerar o client novamente |

**Antipadrão a evitar, confirmado nesta sessão:** rodar `prisma generate` repetidamente sem que a migration correspondente tenha sido de fato aplicada ao banco real. Isso não gera nenhum erro imediato — o comando termina com sucesso, porque só lê `schema.prisma`, nunca toca o banco. O problema só aparece depois, silenciosamente, em qualquer query tocando o modelo afetado, e pode se acumular por múltiplas migrations até ser descoberto por um teste de integração real (foi assim que a Suíte Crítica inteira de `ClinicSubscription` foi encontrada quebrada nesta Sprint).

---

## Recovery Drill

Complementa a seção "Backup" e "Recuperação de Desastres" de [10-Armazenamento.md](../02-Arquitetura/10-Armazenamento.md), que já exige "testes periódicos de restauração" em nível de princípio — esta seção é a instanciação operacional concreta desse princípio para o banco de dados.

### Procedimento de restauração de backup

1. **Nunca restaurar por cima de um ambiente vivo (Homologação ou Produção) como primeiro passo.** Restaurar sempre para uma instância isolada e descartável primeiro — só promover para o ambiente real depois de validado, ou quando a restauração for de fato a resposta a um desastre confirmado (banco real perdido/corrompido).
2. Provisionar a instância de destino com a mesma versão do PostgreSQL usada em produção (`postgres:16`, per `docker-compose.yml`).
3. Restaurar o dump mais recente disponível usando o usuário admin do banco de destino:
   ```
   pg_restore -h <host> -U postgres -d luxora_dev --clean --if-exists <arquivo_de_backup>
   ```
   (`pg_dump`/`pg_restore` é a mesma ferramenta já referenciada em [00-Provedor-e-Custos.md](00-Provedor-e-Custos.md) como caminho de portabilidade do banco — não introduz uma ferramenta nova.)
4. Em Homologação/Produção (Railway), usar o mecanismo de backup/restore nativo do provedor gerenciado quando disponível, em vez de `pg_dump`/`pg_restore` manual — `pg_restore` manual é o caminho de referência para Desenvolvimento e para validar a integridade de um dump exportado, não necessariamente o caminho de produção real no provedor gerenciado (que ainda precisa ser confirmado/documentado por quem administra a instância Railway — não assumido aqui como já configurado).
5. Reaplicar, se necessário, quaisquer migrations que tenham sido geradas **depois** do momento em que o backup foi tirado (o backup reflete o schema de quando foi gerado, não necessariamente o schema atual).

**Restauração no ambiente real, depois do K2-a** (ver "Exigência de versão e retorno degradado"):

1. **Pare a aplicação antes** (`docker compose … stop backend`). Ela não volta sozinha: a política de reinício não religa um container parado.
2. **Backup de um schema anterior ao atual vai para um banco vazio** (apague e recrie o banco, ou use uma instância nova). `pg_restore --clean` só apaga os objetos que existem no backup: por cima do banco atual, as tabelas criadas depois (`billing_eligibility_protocol`, `deployment_requirement`) ficariam, e a migration do K2-a não conseguiria ser reaplicada. `--clean` sobre o banco em uso só serve para um backup do mesmo schema.
3. **Suba a aplicação só com `deploy.sh`**, que reaplica as migrations pendentes e confere as proteções antes de trocar a aplicação. `rollback.sh` recusa: o banco restaurado não declara a exigência que o ambiente já tinha. A sequência inteira está ensaiada em `infra/tests/k2-compat-rehearsal.sh` (etapa 6).
4. O que foi gravado depois do backup se perde, como em qualquer restauração.

Limite: a recusa do `rollback.sh` depende do estado `requirement-active` do host. Restaurado num host novo, sem esse estado, nada impede subir uma versão anterior ao K2-a num banco também anterior a ele. É o mesmo comportamento de antes do K2-a, mas a proteção do K2-a só volta depois do `deploy.sh`.

### Validação pós-restauração

- [ ] `prisma migrate status` contra o banco restaurado — confirma que o schema restaurado é consistente com o histórico de migrations esperado (nem faltando, nem com migrations "fantasma" não reconhecidas).
- [ ] Contagem de linhas/sanidade básica nas tabelas centrais (`tenant`, `patient`, `therapist`, `clinic_subscription`) — comparar ordem de grandeza com o esperado, não só "a tabela existe".
- [ ] **Isolamento multi-tenant via RLS segue ativo** — específico da Luxora: como os Repositories não têm `WHERE tenant_id` explícito (dependem inteiramente de RLS, ver `01-app-role.sql`), uma restauração que recrie roles/policies incorretamente pode silenciosamente vazar dados entre clínicas sem gerar nenhum erro visível. Validar explicitamente que uma query como `luxora_app` autenticado como Tenant A não retorna linhas de Tenant B.
- [ ] Aplicação sobe e conecta normalmente ao banco restaurado (não só o banco aceita conexões — a aplicação precisa inicializar sem erro).
- [ ] Suíte Crítica (`test/critical/`) executada contra o banco restaurado, verde.
- [ ] Resultado do drill registrado (data, ambiente-alvo, origem do backup usado, sucesso/falha, tempo total do procedimento) — sustenta o "monitoramento contínuo de backups" já exigido em [10-Armazenamento.md](../02-Arquitetura/10-Armazenamento.md).

### Cadência

Recovery Drill deve ser executado periodicamente (não apenas quando um desastre real acontece) e obrigatoriamente antes de qualquer migration classificada como potencialmente destrutiva (remoção de coluna/tabela — ver "Estratégia de rollback", fase *contract*). A cadência exata (ex.: trimestral) é uma decisão operacional do CTO, ainda não fixada neste documento.

---

## CI/CD Integration

Ordem oficial de execução no pipeline, para Homologação e Produção. Cada etapa é um *gate*: falha em qualquer etapa interrompe o pipeline e impede o avanço para a próxima (consistente com [13-Deploy.md](../02-Arquitetura/13-Deploy.md): "Caso qualquer etapa falhe, o Deploy será interrompido.").

1. **Backup** — snapshot do banco do ambiente-alvo imediatamente antes de qualquer alteração de schema. Sem backup bem-sucedido, o pipeline não avança.
2. **`prisma migrate deploy`** — aplica exclusivamente as migrations pendentes, usando a credencial admin injetada como secret de CI (nunca `migrate dev`, nunca a credencial de runtime da aplicação — ver "Procedimento — Homologação/Produção" acima).
3. **`prisma generate` (quando aplicável)** — regenera o Prisma Client a partir do `schema.prisma` **somente depois** do passo 2 ter concluído com sucesso. "Quando aplicável" porque, se o artefato de deploy já foi construído com `prisma generate` executado no passo de build (padrão comum), repetir aqui é redundante — mas inofensivo, desde que nunca rode antes do passo 2 ter sucedido (é exatamente essa ordem invertida que causou o desalinhamento Prisma Client/banco real nesta Sprint, ver "Erros conhecidos"). Se o passo de build e o passo de deploy do banco rodam em estágios/containers separados, este passo é obrigatório aqui.
4. **Deploy da aplicação** — só ocorre depois de as migrations terem sido aplicadas com sucesso e o client estar sincronizado; nunca em paralelo com os passos 2–3.
5. **Smoke tests** — validação funcional real pós-deploy (não apenas "o container subiu"), cobrindo pelo menos os fluxos que a migration em questão afeta diretamente.
6. **Liberação do ambiente** — só depois de smoke tests verdes; é o ponto em que o ambiente passa a receber tráfego real (ou sai de modo de manutenção). Falha em qualquer etapa anterior significa que este passo nunca é alcançado.

**Ponto de decisão de rollback conforme a etapa em que a falha ocorreu:**
- Falha no passo 1 (Backup) ou 2 (`migrate deploy`): nenhuma mudança de aplicação foi publicada ainda — corrigir a migration e repetir o pipeline é suficiente, sem necessidade de rollback de código.
- Falha no passo 3, 4 ou 5: o schema do banco já foi alterado, mas a aplicação nova ainda não está (ou não deve ser considerada) recebendo tráfego — usar a Estratégia de Rollback definida acima antes de tentar o pipeline novamente.
- Falha no passo 6 (já com tráfego real): tratar como incidente — rollback da aplicação para a versão anterior tem prioridade sobre qualquer rollback de schema, especialmente se a migration seguiu o padrão *expand/contract* (a versão anterior do código deve continuar funcionando contra o schema expandido).

---

## Documentos relacionados

- [06-Migrations.md](../03-Database/06-Migrations.md) — filosofia e regras de versionamento do schema.
- [13-Deploy.md](../02-Arquitetura/13-Deploy.md) — fluxo geral de Deploy, ambientes oficiais, auditoria.
- [10-Armazenamento.md](../02-Arquitetura/10-Armazenamento.md) — princípios de backup, recuperação de desastres e retenção que fundamentam o Recovery Drill.
- [00-Provedor-e-Custos.md](00-Provedor-e-Custos.md) — provedor de infraestrutura (Railway) para Homologação/Produção.
- `infra/docker/postgres-init/01-app-role.sql` — script real que define a role `luxora_app` em Desenvolvimento.
