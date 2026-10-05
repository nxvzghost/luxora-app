# ADR-0057 — Configuração validada no boot, headers de segurança (Helmet) e Swagger por ambiente

**Status:** ADOTADO
**Origem:** Fase 2 da auditoria técnica de 04/10/2026 (Segurança e dependências), risco R7.
**Data:** 5 de outubro de 2026

## Objetivo

Fechar três lacunas de configuração da borda da aplicação: nada conferia as variáveis de ambiente antes de subir, nenhuma resposta saía com headers de segurança, e a documentação interativa da API ficava pública em qualquer ambiente.

## Auditoria prévia (achados confirmados no código)

- **Sem validação no boot.** `ConfigModule.forRoot()` só carregava o `.env`. `JwtModule.register({ secret: process.env.JWT_SECRET })` aparece em 12 módulos; sem a variável, a aplicação subia e o login respondia 500 na primeira tentativa. O `.env.example` traz `JWT_SECRET` e `WHATSAPP_TOKEN_ENCRYPTION_KEY` com um valor de exemplo de 34 caracteres — público, porque está no repositório —, que uma checagem só de tamanho aceitaria.
- **Os guards por segredo já falhavam fechado.** `AutomationApiKeyGuard`, `MetricsAccessGuard`, `AsaasWebhookGuard` e `WhatsAppWebhookGuard` lançam erro quando a variável falta; nenhum libera acesso. O problema era a ausência de falha cedo, não uma brecha de acesso.
- **Sem Helmet.** Nenhum header de segurança; `X-Powered-By: Express` exposto.
- **Swagger sempre registrado** em `api/v1/docs`, `api/v1/docs-json` e `api/v1/docs-yaml`, sem distinção de ambiente.
- **O `.env` é carregado antes do registro do JWT.** Medido: o `JwtModule.register` do `AuthModule` captura o segredo mesmo quando ele só existe no `.env`, porque a importação do Prisma Client carrega o arquivo antes de os decorators dos módulos serem avaliados. Não há segredo indefinido por ordem de carga.

## Decisão

**Validação no ConfigModule existente.** `validateEnv` (`src/shared/env.validation.ts`) entra em `ConfigModule.forRoot({ validate })`; nenhum sistema de configuração paralelo. A falha se propaga quando o Nest monta os módulos, antes de qualquer provider ser instanciado e antes de a aplicação escutar uma porta: o processo termina com código 1. As mensagens citam o nome da variável e o motivo, nunca o valor.

Três grupos:

| Grupo | Variáveis | Regra |
|---|---|---|
| Sempre obrigatórias | `DATABASE_URL`, `JWT_SECRET`, `WHATSAPP_TOKEN_ENCRYPTION_KEY` | Ausência impede o boot em qualquer ambiente. `JWT_SECRET` e `WHATSAPP_TOKEN_ENCRYPTION_KEY` precisam de 32 caracteres ou mais; `DATABASE_URL` precisa ser `postgresql://`. |
| Obrigatórias em produção | `REDIS_URL`, `FRONTEND_URL`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `ASAAS_WEBHOOK_TOKEN`, `AUTOMATION_API_KEY`, `METRICS_ACCESS_TOKEN` | Exigidas com `NODE_ENV=production`. Fora dela, cada guard já falha fechado quando a sua falta. |
| Opcionais | Todo o resto, incluindo `ANTHROPIC_API_KEY`, `ASAAS_API_KEY` e os ajustes com valor padrão | Não impedem o boot. As numéricas (`PORT`, limites de throttle, `JWT_SESSION_MAX_AGE_DAYS`, timeouts), quando definidas, precisam ser inteiros positivos. |

Só em produção, além disso: um segredo com valor de exemplo (`.env.example`) ou de teste (os valores do CI) é recusado, e `DATABASE_URL` não pode usar o usuário `postgres` — superusuário ignora Row-Level Security sem erro nenhum.

**Helmet com a configuração padrão**, aplicado logo depois do Correlation ID. A API só responde JSON; a única página HTML é a do Swagger UI, que usa script e estilo inline, então a Content-Security-Policy é relaxada só quando o Swagger está habilitado. Em produção vale a CSP padrão.

**Swagger só fora de produção.** Com `NODE_ENV=production` a documentação não é registrada: as três rotas respondem 404. Não há guard nem variável de ativação — a rota não existe. Nenhum endpoint da API foi alterado.

**Mesmo código em produção e em teste.** `applySecurityHeaders()` e `setupSwagger()` (`src/shared/http-hardening.ts`) são chamadas por `main.ts` e, na mesma ordem, por `test/critical/support/bootstrap-app.ts`.

## Alternativas consideradas

- **Proteger o Swagger com senha em produção.** Rejeitada: mais um segredo para configurar e uma superfície a mais, sem necessidade identificada de ter a documentação em produção.
- **Trocar os 12 `JwtModule.register` por `registerAsync` com `ConfigService`.** Rejeitada nesta fase: mudança mecânica em 12 módulos sem ganho de segurança, já que a validação garante o segredo presente e a ordem de carga foi medida.
- **Exigir as variáveis de produção em todos os ambientes.** Rejeitada: quebraria o ambiente de testes e o desenvolvimento local, e os guards já falham fechado.

## Limitações conhecidas

- A decisão do Swagger depende de `NODE_ENV=production` estar definido no ambiente implantado. O `Dockerfile.backend` já define; um deploy sem a variável teria o Swagger registrado.
- Os guards por segredo comparam com `!==`, não em tempo constante. Não alterado nesta ADR.
- `tracing.ts` registra um handler de `SIGTERM` que não encerra o processo; a aplicação só para com `SIGKILL`. Observado durante a validação, fora do escopo desta ADR.

## Evidências

**Arquivos novos:** `apps/backend/src/shared/env.validation.ts`, `apps/backend/src/shared/http-hardening.ts`.
**Arquivos alterados:** `apps/backend/src/app.module.ts`, `apps/backend/src/main.ts`, `apps/backend/test/critical/support/bootstrap-app.ts`, `apps/backend/package.json` e `pnpm-lock.yaml` (dependência nova `helmet`), `.env.example`, `CONFIGURACAO_AMBIENTE.md`.

**Testes:**
- `test/unit/shared/env.validation.test.ts` — 33 testes: cada variável obrigatória, tamanho mínimo, valores numéricos, regras de produção, mensagem sem valores e a integração com `ConfigModule.forRoot`.
- `test/critical/http-hardening.test.ts` — 7 testes com o app real subido como desenvolvimento e como produção: headers de segurança (inclusive em resposta 401), CSP sem script inline em produção, Swagger 200 fora de produção e 404 em produção, API funcionando nos dois modos.

**Prova no processo real** (`node dist/main.js`): em desenvolvimento, preflight do frontend com `Access-Control-Allow-Origin` e os headers do Helmet juntos, origem não permitida sem eco, Swagger 200; `NODE_ENV=production` com chaves de produção faltando → processo termina com código 1, lista só os nomes e não abre a porta; `JWT_SECRET` vazio → código 1; produção completa → sobe, mesmos headers, Swagger 404.

**Resultado das suítes:** unitária 78 arquivos, 725 testes; integração 9 testes; crítica 30 arquivos, 221 testes (1 skip pré-existente); 0 falhas. `nest build` e `eslint` limpos.

## Referências

- `CONFIGURACAO_AMBIENTE.md` — seção "Validação no boot, headers de segurança e Swagger".
- `infra/docker/postgres-init/01-app-role.sql` — por que a aplicação não pode conectar como superusuário.
- `docs/02-Arquitetura/12-Seguranca.md`.
