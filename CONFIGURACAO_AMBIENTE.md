# Configuração de Ambiente — Luxora

## Objetivo

Este documento é a referência oficial e única sobre como configurar variáveis de ambiente na Luxora. Vale para todo desenvolvedor, presente ou futuro, que for rodar o projeto localmente ou configurar um ambiente novo.

---

## Os dois arquivos: `.env` e `.env.example`

### `.env` — credenciais reais

Contém os valores reais usados para rodar a aplicação: chaves de API, segredos, URLs de banco de dados. **Este arquivo nunca deve ser enviado ao GitHub, nem a nenhum outro sistema de controle de versão.** Ele vive apenas na máquina local de quem está rodando o projeto (ou nas variáveis de ambiente do provedor de hospedagem, em produção — nunca como arquivo commitado).

### `.env.example` — modelo do arquivo

Contém a mesma lista de variáveis que o `.env`, mas com valores vazios ou de exemplo óbvio (nunca uma credencial real, nem parcial). Serve como modelo: qualquer pessoa configurando o projeto pela primeira vez copia este arquivo para `.env` e preenche os valores reais.

```bash
cp .env.example .env
# depois, editar .env com os valores reais
```

---

## Regra permanente: nenhuma credencial em código-fonte

Toda credencial — chave de API, token, segredo — é lida **exclusivamente** através de `process.env.NOME_DA_VARIAVEL`. Nunca:

- hardcoded diretamente em um arquivo `.ts`/`.tsx`;
- colada num commit, mesmo que "temporariamente para testar";
- exposta em log, mensagem de erro, ou resposta de API.

Se uma credencial aparecer em código-fonte ou for versionada por engano, ela deve ser considerada comprometida e revogada/trocada no provedor correspondente — não basta remover do código depois.

---

## Configuração do Asaas (gateway oficial de pagamentos do MVP)

Três variáveis, todas obrigatórias:

```bash
ASAAS_API_KEY=SUA_CHAVE_AQUI
ASAAS_ENV=production
ASAAS_BASE_URL=https://api.asaas.com/v3
```

### Onde conseguir a chave

A `ASAAS_API_KEY` é obtida no painel da própria Asaas (conta da Luxora), nunca gerada ou inventada pelo time de engenharia. Ela deve ser colada exatamente na variável `ASAAS_API_KEY`, substituindo o placeholder `SUA_CHAVE_AQUI`.

**Exemplo de preenchimento** (chave abaixo é ilustrativa, não é uma chave real):

```bash
ASAAS_API_KEY=$aap_live_xxxxxxxxxxxxxxxxxxxxxxxxx
ASAAS_ENV=production
ASAAS_BASE_URL=https://api.asaas.com/v3
```

### Ambientes

- `ASAAS_ENV=production` — ambiente real, transações de verdade. Usar `ASAAS_BASE_URL=https://api.asaas.com/v3`. **É o único ambiente que a Luxora usa** — não existe conta sandbox da Asaas para este projeto.
- `ASAAS_ENV=sandbox` — existe na documentação oficial da Asaas (`ASAAS_BASE_URL=https://api-sandbox.asaas.com/v3`), mas a Luxora não tem conta configurada lá. Não usar a menos que uma conta sandbox seja criada no futuro.

Por não haver sandbox, nenhum teste automatizado (`test:unit`, `test:integration`, `test:critical`, CI) chama a API da Asaas de verdade — todos usam um `PaymentProvider` fake/mock. A única exceção é `apps/backend/test/manual/`, que chama a Asaas de produção de propósito e **nunca roda sozinho** — só quando um humano decide, manualmente, validar o ambiente real. Ver `apps/backend/test/manual/README.md`.

---

## Configuração do WhatsApp (por clínica, não global)

Diferente do Asaas (uma única conta da Luxora), o WhatsApp **não tem variável de ambiente global** — cada clínica conecta seu próprio número e token, armazenados por Tenant no banco de dados (`whatsapp_integration`), nunca em `.env`. A Luxora não possui número de WhatsApp próprio — cada clínica preserva sua identidade no canal.

**AD-005 — `WHATSAPP_TOKEN_ENCRYPTION_KEY`:** o `accessToken` de cada clínica é cifrado em repouso (AES-256-GCM, `TokenCipherService`) antes de ser gravado — nunca fica em texto puro no banco. A chave de cifragem vem desta variável, com a mesma UX de `JWT_SECRET` (qualquer string aleatória longa serve, não precisa ser uma chave exata em base64 — uma derivação via `scrypt` produz os 32 bytes necessários para AES-256 a partir de qualquer segredo). **Trocar este valor torna todo `accessToken` já cifrado irrecuperável** — tratar com o mesmo cuidado de backup dado a `JWT_SECRET`/credenciais da Asaas: nunca perder, nunca rotacionar sem um plano de re-cifragem.

---

## Rate limit de login (AD-006)

`POST /auth/login` é protegido por `@nestjs/throttler` — `AUTH_THROTTLE_LIMIT` (padrão `5`) tentativas a cada `AUTH_THROTTLE_TTL_MS` (padrão `60000`, 60s), por IP do cliente. Em produção, atrás do proxy do Railway, isso só funciona corretamente porque `main.ts` chama `app.set('trust proxy', 1)` — sem isso, o backend enxergaria o IP do proxy para todo mundo, e um único usuário errando a senha bloquearia o login de todas as clínicas simultaneamente. A Suíte Crítica sobrescreve estas duas variáveis para valores muito mais altos (`test/critical/support/global-setup.ts`) — sem isso, os ~18 arquivos de teste fazendo login real quebrariam a suíte inteira.

---

## Observabilidade — Correlation ID, OpenTelemetry, Prometheus (AD-016)

`GET /metrics` (fora do prefixo `api/v1`, convenção de scrapers Prometheus) expõe métricas HTTP/Express/ioredis coletadas pelo OpenTelemetry — protegido por `METRICS_ACCESS_TOKEN`, comparado ao header `X-Metrics-Token`. Sem essa variável configurada, a rota lança erro em vez de responder sem autenticação (mesmo padrão de `AUTOMATION_API_KEY`). Todo request HTTP recebe um `X-Correlation-Id` (aceito do cliente/proxy ou gerado como UUID) desde o primeiro middleware do processo — nenhuma variável de ambiente nova é necessária para isso. Traces são exportados via `ConsoleSpanExporter` (nenhum backend de tracing provisionado ainda — ver ADR-0051). Detalhes completos, incluindo por que a instrumentação do Prisma foi adiada, em [ADR-0051](docs/02-Arquitetura/ADRs/ADR-0051-observabilidade-correlation-id-otel-prometheus.md).

---

## `.gitignore` obrigatório

Todo repositório da Luxora deve conter, no mínimo, estas entradas no `.gitignore`:

```
.env
.env.local
.env.production
.env.development
```

Nenhuma variação de `.env` é aceitável em controle de versão.

---

## Checklist para configurar um ambiente novo

- [ ] Copiar `.env.example` para `.env`
- [ ] Preencher `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` com valores do ambiente local ou da infraestrutura real
- [ ] Preencher `ASAAS_API_KEY` com a chave real da conta Asaas da Luxora (nunca inventada)
- [ ] Confirmar `ASAAS_ENV=production` (único ambiente Asaas que a Luxora usa — não há sandbox)
- [ ] Confirmar que `.env` está listado no `.gitignore` antes do primeiro commit
- [ ] Nunca colar nenhuma credencial em mensagem de commit, PR, ou documentação

---

## Documentos Relacionados

- `.env.example` (raiz do repositório) — modelo com todas as variáveis
- `LUXORA/03 - ENGINEERING/ADRs/ADR-0003.md` — decisão original de manter o Domain desacoplado do gateway de pagamento
- `LUXORA/03 - ENGINEERING/ADRs/ADR-0037-asaas-assinatura-luxora.md` — Asaas como gateway oficial
