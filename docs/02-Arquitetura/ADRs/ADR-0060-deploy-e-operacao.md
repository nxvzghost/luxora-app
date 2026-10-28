# ADR-0060 — Deploy e operação: imagens imutáveis, migrations em job próprio, readiness e rollback só da aplicação

**Status:** ADOTADO
**Origem:** Tarefa 04 da auditoria técnica de 04/10/2026 (Deploy e operação; Epic 14, AD-017; riscos R8 e R9).
**Data:** 7 de outubro de 2026

## Objetivo

Ter um caminho de deploy reproduzível e um rollback testado, sem contratar infraestrutura e sem depender das integrações externas (Fase 3, ainda parcial).

## Auditoria prévia (achados confirmados)

- **O Dockerfile do backend não construía.** Em um checkout limpo, o build falhava em 31 s no `pnpm install`: o `pnpm-workspace.yaml` não era copiado, o pnpm não reconhecia o monorepo e o `--filter` não achava o pacote. Mesmo que construísse, a imagem final copiava só `/app/node_modules` — num workspace pnpm, as dependências do backend ficam em `apps/backend/node_modules`. O risco R8 da auditoria estava certo, e era pior do que o descrito.
- **Não existia `.dockerignore`.** Um build a partir da pasta de trabalho levaria o `.env` local (com credenciais reais) para dentro do contexto.
- **Só havia liveness.** `GET /health` não consultava dependência nenhuma; nada dizia se a instância podia receber tráfego.
- **Os traces só iam para o console**, e os logs eram texto colorido — inúteis para um coletor.
- **Não havia Dockerfile do painel, ambiente de homologação, CD nem rollback.**

## Decisão

**Imagens.** Duas, a partir de `infra/docker/`, com o contexto na raiz filtrado por um `.dockerignore`:

- *backend*: build em um estágio, e a árvore final montada com `pnpm deploy --prod` (só dependências de produção, resolvidas de verdade), com o client do Prisma gerado de novo nela. Roda como usuário `node`, sem código-fonte, sem ferramentas de desenvolvimento.
- *painel*: saída `standalone` do Next, ligada só no build da imagem (`NEXT_OUTPUT=standalone`), para não mudar `pnpm dev` nem `next build` fora dela.

**A tag é a versão.** O commit curto vai gravado na imagem (`APP_VERSION`) e aparece em `GET /health`, nos logs e nos spans. Uma tag publicada não é sobrescrita.

**Migrations em job próprio.** O alvo `migrate` do mesmo Dockerfile roda `prisma migrate deploy` com a credencial **admin**; a aplicação conecta com a role restrita `luxora_app` e nunca recebe a senha de admin. É o que o MIGRATION_RUNBOOK já determinava; agora há um artefato que o cumpre.

**Duas sondas.** `GET /health` continua liveness puro. `GET /health/ready` consulta Postgres e Redis (2 s cada) e responde 503 quando a instância não pode receber tráfego — inclusive desde o SIGTERM, durante o encerramento gracioso. A resposta diz qual dependência caiu, sem detalhe de conexão. A consulta ao banco reaproveita um cliente Prisma já existente.

**Deploy em portões, com rollback automático.** `infra/scripts/deploy.sh`: backup → migrations → troca → readiness → smoke → registro. Falha no backup ou na migration não toca a aplicação. Falha na readiness ou no smoke devolve a versão anterior sozinha.

**O rollback troca só a aplicação.** O banco não volta. Em consequência, toda migration tem de ser compatível com a versão anterior da aplicação (expand/contract). É uma regra de processo: nada no código a impõe. Há **uma exceção aprovada**, em escopo restrito: ver "Exceção aprovada em 21/10/2026", abaixo.

**Observabilidade sem serviço pago.** Logs em JSON (uma linha por registro) em produção. O destino dos traces vem das variáveis padrão do OpenTelemetry: OTLP quando há endpoint, nada em produção sem endpoint, console fora dela. O SDK monta o exportador sozinho; nenhuma dependência nova entrou.

**Homologação como compose.** `infra/staging/docker-compose.yml` sobe a pilha inteira a partir das imagens, em qualquer host com Docker. É a referência validada; num provedor gerenciado reaproveitam-se as imagens, as variáveis e as sondas.

## Alternativas descartadas

- **Copiar `node_modules` inteiro do estágio de build.** Funciona, mas leva TypeScript, Vitest, ESLint e o CLI do Prisma para a imagem de produção.
- **Rodar as migrations no boot da aplicação.** Exigiria dar a credencial admin à aplicação, e duas instâncias subindo juntas disputariam a migration.
- **Apontar o liveness para a readiness.** Uma queda do banco reiniciaria a aplicação em laço.
- **Configuração do Railway versionada agora.** Sem conta para testar, seria um arquivo nunca executado. O mapeamento está descrito no runbook e marcado como não validado.
- **`@nestjs/terminus` para as sondas.** Uma dependência a mais para duas consultas.

## Consequências

- O caminho de deploy passa a ser testado a cada mudança: o CI constrói as imagens e roda o ensaio completo.
- `NODE_ENV=production` em homologação e produção; `APP_ENV` distingue os dois.
- O painel tem uma imagem por ambiente, porque a URL da API é embutida no build.
- A troca de versão tem alguns segundos de pausa enquanto houver uma instância só.

## Limitações conhecidas

- **Nada rodou em um host de homologação real nem no GitHub Actions.** A validação é local (`infra/tests/rehearsal.sh`, 68 verificações) e estática (`actionlint`, `shellcheck`, `docker compose config`).
- **16 conexões com o banco logo após o boot**: `PrismaClientProvider` é declarado em 15 módulos, cada um com seu pool. Não corrigido aqui. *Corrigido em 22/10/2026:* eram 17 declarações (17 conexões no ensaio); o provider passou a ser declarado só no `DatabaseModule` global, e a aplicação abre uma conexão ao subir.
- **As automações agendadas não funcionam**: as quatro rotas respondem 500 com a chave certa. Ver `docs/07-Infra/AUTOMACOES_AGENDADOR.md`.
- **Backups só no disco do host.** Cópia externa e retenção dependem do provedor.
- **TenantID e UserID não saem automaticamente nos logs**; `fetch` e Prisma continuam sem span (ADR-0051).
- **A imagem do job de migrations tem 1,45 GB.**

## Evidências

- Dockerfile anterior, em checkout limpo: falha em 31 s (`ERR_PNPM_NO_LOCKFILE`, depois do aviso de que o `pnpm-workspace.yaml` não existe).
- Dockerfiles novos, em checkout limpo e sem cache: backend em 133 s (543 MB), job de migrations em 47 s, painel em 102 s (405 MB).
- Ensaio local: 68 de 68 verificações — imagem, primeiro deploy, papéis do banco, borda HTTP em produção, logs, rollback automático, rollback manual, readiness com Redis e Postgres parados, traces no coletor, encerramento gracioso (2 s, código 0), restauração de backup (28 tabelas, 23 com RLS forçada, 19 migrations) e painel.

## Exceção aprovada em 21/10/2026

O responsável pelo produto aprovou **uma única exceção** à regra de compatibilidade com a versão anterior. Ela vale **só** no escopo descrito na [ADR-0069, seção 9.4](./ADR-0069-ciclo-de-vida-da-consulta.md) (bloqueador K2):

- **O que muda:** depois da migration do K2, versões sem a capacidade `billing-eligibility-v1`:
  - continuam operando em modo degradado;
  - **não conseguem criar cobrança nem vínculo de cobrança**, porque o banco recusa (restrições declarativas, sem trigger);
  - não conseguem alterar consulta que já tem desfecho registrado.
- **O que não muda:** o restante da regra desta ADR. Nenhum enum existente é ampliado (o desfecho da consulta fica em tabela própria, `appointment_outcome`, conforme a ADR-0069, seção 2.4), e a versão anterior continua lendo os dados.
- **Rollback:**
  - o automático, no deploy que introduz a exigência, pode voltar à versão anterior em modo degradado, com registro em `history.jsonl`;
  - o manual para versão sem a capacidade é recusado, salvo `--allow-degraded` com motivo, também registrado;
  - nenhuma restauração de backup sobe a aplicação sem reaplicar as migrations e conferir as restrições.
- **Situação em 23/10/2026:** a exceção está **implementada e publicada**, e o K2 foi **encerrado tecnicamente** pelas provas exigidas (ADR-0069, seção 9.4). A ADR-0069 continua proposta em revisão. Sem deploy real: homologação e CD nunca rodaram.

### Implementação da exceção [EV]

**Capacidades publicadas.** A imagem declara as capacidades no rótulo `luxora.capabilities`, e as migrations gravam as exigências em `deployment_requirement`:

| Capacidade | Commit | O que exige |
|---|---|---|
| `billing-eligibility-v1` | K2-a, `c801b91` | Protocolo na cobrança; vínculo com o paciente e a clínica da cobrança e da sessão (chaves compostas); privilégios por coluna |
| `appointment-outcome-v1` | K2-b, `ea9163c` | Desfecho em `appointment_outcome`, com a consulta congelada (FK do retrato e política RLS restritiva `appointment_frozen_after_outcome`); elegibilidade da sessão exigida no vínculo; 23 restrições, sem trigger nem função |
| `appointment-ai-confirmation-v1` | K11, implementado localmente em 23/10/2026, **sem commit** | Desfecho da IA (`ai_agent`, sem usuário) só para cancelamento ou remarcação confirmados pelo paciente, ligado ao pedido e à resposta dele (ADR-0069, seção 10.1, D1 a D8); 7 restrições, sem trigger nem função |

A imagem publicada declara as duas primeiras capacidades; a do K11, quando publicada, declara as três. A `2b9147a` declara as duas do K2, a `fb93885` só a primeira, e versões anteriores ao K2-a nenhuma. Contra o banco migrado, todas elas são retorno degradado.

**K11 — comportamento degradado verificado** (ensaio local com a imagem real da `2b9147a` contra o banco com o K11, `infra/tests/k11-compat-rehearsal.sh`, 79 de 79; ensaio de deploy com as checagens do K11, 124 de 124). A `2b9147a`:
- continua cancelando e remarcando pelo painel, e o banco aceita o desfecho que ela grava (autoria de pessoa pelo padrão da coluna);
- responde 500 ao confirmar ou cancelar a consulta encerrada pela IA, porque não lê o desfecho sem usuário, e não grava nada; a agenda dela não é afetada (consulta cancelada não é listada);
- pelo WhatsApp, volta a cancelar e remarcar numa etapa só (o comportamento dela, não ensaiado: exigiria chamar a IA). É o motivo de o retorno ser degradado.

As migrations do K11 não reescrevem as tabelas nem mudam desfechos e comunicações existentes (impressão digital e arquivos das tabelas iguais); o rollback manual é recusado sem `--allow-degraded` e justificativa; o backup anterior ao K11 restaurado não sobe aplicação até o `deploy.sh` reaplicar as migrations.

**Comportamento degradado verificado.** Ensaio com a imagem real da `fb93885` contra o banco migrado (`infra/tests/k2b-compat-rehearsal.sh`, 104 de 104). A versão anterior:
- sobe e confirma consulta sem desfecho; a sessão que ela cria nasce não elegível;
- quita cobrança existente;
- cobra só sessão elegível, criada pela versão nova;
- não cobra sessão não elegível: o banco recusa, e nada é gravado;
- não confirma, cancela nem remarca consulta com desfecho;
- não deixa cobrança sem vínculo, vínculo inválido nem pagamento confirmado com cobrança em aberto, em nenhuma fase.

No banco, o SQL que a versão anterior emite continua agendando, confirmando e cancelando consulta sem desfecho (teste crítico da K2-b). O K2-a foi ensaiado contra a `fd0874f` (75 de 75).

**Condições verificadas:**
- **Rollback automático:** no deploy que introduz a exigência, volta em modo degradado, registrado em `history.jsonl`.
- **Rollback manual:** para versão sem a capacidade, é recusado sem `--allow-degraded`; com ele, exige justificativa e fica registrado.
- **Proteções removidas:** se a política sumir ou a aplicação voltar a poder apagar desfecho, o rollback é recusado.
- **Restauração:** um banco restaurado de backup anterior à K2-b não sobe aplicação até o `deploy.sh` reaplicar as migrations e conferir as proteções.
- **Ensaio de deploy:** 116 de 116 no local; 126 de 126 no CI `40001325916`.
- **Testes no PostgreSQL 16:** cada uma das 23 restrições com teste automatizado (`421b251`). CI `40030315146` (`23cf0d9`) verde nos 7 jobs.

**Limitações que continuam:**
- O banco não impede cobrança com zero vínculos, nem SQL direto com credencial de administrador.
- Restauração ou subida feitas por fora dos scripts escapam do controle.
- Os ensaios de compatibilidade rodam no local, não no CI.
- A versão anterior ao K2-a não foi ensaiada como imagem contra o banco da K2-b; está coberta só pelos testes no banco.
- Não há homologação, CD nem deploy real.
- O `connection_limit` de produção não está dimensionado.

Detalhes e limites completos na ADR-0069, seção 9.4.

## Referências

- `docs/07-Infra/DEPLOY_RUNBOOK.md` — procedimento.
- `docs/07-Infra/MIGRATION_RUNBOOK.md` — migrations, backup e restauração.
- `docs/02-Arquitetura/13-Deploy.md` — estratégia de deploy.
- ADR-0051 (observabilidade), ADR-0057 (configuração no boot), ADR-0058 (encerramento e filas).
