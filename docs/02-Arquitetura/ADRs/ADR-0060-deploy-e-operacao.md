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

**O rollback troca só a aplicação.** O banco não volta. Em consequência, toda migration tem de ser compatível com a versão anterior da aplicação (expand/contract). É uma regra de processo: nada no código a impõe.

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
- **16 conexões com o banco logo após o boot**: `PrismaClientProvider` é declarado em 15 módulos, cada um com seu pool. Não corrigido aqui.
- **As automações agendadas não funcionam**: as quatro rotas respondem 500 com a chave certa. Ver `docs/07-Infra/AUTOMACOES_AGENDADOR.md`.
- **Backups só no disco do host.** Cópia externa e retenção dependem do provedor.
- **TenantID e UserID não saem automaticamente nos logs**; `fetch` e Prisma continuam sem span (ADR-0051).
- **A imagem do job de migrations tem 1,45 GB.**

## Evidências

- Dockerfile anterior, em checkout limpo: falha em 31 s (`ERR_PNPM_NO_LOCKFILE`, depois do aviso de que o `pnpm-workspace.yaml` não existe).
- Dockerfiles novos, em checkout limpo e sem cache: backend em 133 s (543 MB), job de migrations em 47 s, painel em 102 s (405 MB).
- Ensaio local: 68 de 68 verificações — imagem, primeiro deploy, papéis do banco, borda HTTP em produção, logs, rollback automático, rollback manual, readiness com Redis e Postgres parados, traces no coletor, encerramento gracioso (2 s, código 0), restauração de backup (28 tabelas, 23 com RLS forçada, 19 migrations) e painel.

## Referências

- `docs/07-Infra/DEPLOY_RUNBOOK.md` — procedimento.
- `docs/07-Infra/MIGRATION_RUNBOOK.md` — migrations, backup e restauração.
- `docs/02-Arquitetura/13-Deploy.md` — estratégia de deploy.
- ADR-0051 (observabilidade), ADR-0057 (configuração no boot), ADR-0058 (encerramento e filas).
