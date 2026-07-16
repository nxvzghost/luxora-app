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

- `ASAAS_ENV=production` — ambiente real, transações de verdade. Usar `ASAAS_BASE_URL=https://api.asaas.com/v3`.
- `ASAAS_ENV=sandbox` — ambiente de testes da Asaas, sem dinheiro real. Usar `ASAAS_BASE_URL=https://api-sandbox.asaas.com/v3`. **Recomendado para todo desenvolvimento local.**

---

## Configuração do WhatsApp (por clínica, não global)

Diferente do Asaas (uma única conta da Luxora), o WhatsApp **não tem variável de ambiente global** — cada clínica conecta seu próprio número e token, armazenados por Tenant no banco de dados (`whatsapp_integration`), nunca em `.env`. A Luxora não possui número de WhatsApp próprio — cada clínica preserva sua identidade no canal.

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
- [ ] Confirmar que `ASAAS_ENV` está correto para o ambiente (sandbox em dev, production em produção)
- [ ] Confirmar que `.env` está listado no `.gitignore` antes do primeiro commit
- [ ] Nunca colar nenhuma credencial em mensagem de commit, PR, ou documentação

---

## Documentos Relacionados

- `.env.example` (raiz do repositório) — modelo com todas as variáveis
- `LUXORA/03 - ENGINEERING/ADRs/ADR-0003.md` — decisão original de manter o Domain desacoplado do gateway de pagamento
- `LUXORA/03 - ENGINEERING/ADRs/ADR-0037-asaas-assinatura-luxora.md` — Asaas como gateway oficial
