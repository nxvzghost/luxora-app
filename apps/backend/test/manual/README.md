# test/manual/ — nunca automático, nunca em CI

Testes aqui tocam a **API real de produção da Asaas** — dinheiro de verdade,
clientes e assinaturas reais no painel deles. Diferente de `test/unit`,
`test/integration` e `test/critical`, nada nesta pasta roda via `pnpm test`,
`pnpm dev`, nem nenhum job do `.github/workflows/ci.yml`. Só roda quando
você, explicitamente, executa `pnpm test:manual` com as credenciais reais
configuradas no seu `.env` local.

## Por que isso existe

A Luxora não tem conta sandbox da Asaas — a integração usa a API de
produção desde o início (`ASAAS_ENV=production`). Isso significa que
qualquer teste automatizado que chamasse a Asaas de verdade estaria
criando clientes/assinaturas reais toda vez que alguém rodasse a suíte de
testes — inaceitável. Esta pasta existe para separar completamente
"testado contra a implementação real da Asaas" de "roda sozinho sem
supervisão".

## Como rodar

```bash
# 1. no seu .env local (nunca commitado):
#    ASAAS_API_KEY=<sua chave de produção real>
#    ASAAS_ENV=production
#    ASAAS_BASE_URL=https://api.asaas.com/v3
#    ASAAS_TEST_CPF_CNPJ=<um CPF ou CNPJ real, seu ou da clínica —
#      nunca um valor inventado; a Asaas valida e este teste cria um
#      cliente de verdade associado a esse documento>

pnpm --filter @luxora/backend test:manual
```

Sem `ASAAS_API_KEY` e `ASAAS_ENV=production` configurados, o teste é
automaticamente pulado (`describe.skipIf`) — nunca falha por credencial
ausente, porque ele não deveria rodar em ambiente nenhum a não ser o seu,
de propósito, quando você decidir validar.

## O que o teste faz (e o que ele NÃO faz)

Cria um cliente de teste claramente identificado (`[TESTE MANUAL LUXORA]`
no nome) e uma assinatura mínima via PIX (sem cobrar cartão), depois
**cancela a assinatura imediatamente** no `afterAll` — mas cancelar não
apaga o cliente nem o histórico no painel da Asaas. Depois de rodar,
confira o painel da Asaas e apague manualmente o cliente de teste se
quiser um ambiente limpo.

`attachCreditCard` (anexar cartão de crédito) **não está incluído** neste
teste automatizado — é a operação de maior risco financeiro real (cobra um
cartão de verdade) e precisa ser validada manualmente por você, direto no
fluxo da aplicação (`POST /subscription/credit-card`) com um cartão real
seu, quando decidir validar esse passo especificamente.
