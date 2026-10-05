# test/manual/ — MANUAL / EXTERNAL: nunca automático, nunca em CI

Testes aqui chamam **serviços externos de verdade** (Meta, Anthropic, Asaas).
Diferente de `test/unit`, `test/integration` e `test/critical`, nada nesta
pasta roda via `pnpm test`, `pnpm dev`, nem nenhum job do
`.github/workflows/ci.yml`. Só roda quando você, explicitamente, executa:

```bash
pnpm --filter @luxora/backend test:manual
```

Cada arquivo confere as próprias credenciais e é **pulado por inteiro** quando
elas não existem — nunca falha por credencial ausente. Rodar o comando acima
sem nada configurado não chama serviço nenhum.

| Arquivo | Chama | Efeito externo |
|---|---|---|
| `providers-rejection-smoke.test.ts` | Meta, Anthropic e Asaas sandbox, com credencial inválida de propósito | Nenhum — cada serviço recusa a chamada |
| `whatsapp-worker-smoke.test.ts` | A fila de saída inteira até a Graph API | Nenhum sem credencial; com ela, 1 mensagem para o destinatário que você indicar |
| `whatsapp-smoke.test.ts` | Graph API da Meta, só o provider | 1 mensagem de texto para o destinatário que você indicar |
| `anthropic-smoke.test.ts` | API da Anthropic | 3 chamadas, centavos de dólar |
| `asaas-sandbox-smoke.test.ts` | Asaas **sandbox** | 1 cliente e 1 assinatura de teste, sem dinheiro real |
| `asaas-production-smoke.test.ts` | Asaas **produção** | cliente e assinatura reais (ver a última seção) |

As variáveis podem ficar em `apps/backend/.env` (nunca commitado) ou ser
exportadas no terminal; os nomes estão no fim do `.env.example` da raiz. Todos os arquivos leem o `.env` sozinhos, menos o de
produção da Asaas, que depende das variáveis exportadas no terminal.

Cada execução imprime uma linha `[SMOKE …]` com horário, chamada, id
devolvido pelo provider e latência. Nenhuma linha traz chave, token, telefone
ou texto de mensagem — pode ser colada num relatório.

Contrato de cada integração:
[`docs/04-API/02-Contratos-de-Integracoes-Externas.md`](../../../../docs/04-API/02-Contratos-de-Integracoes-Externas.md).

## Regras

- Nunca usar número de paciente, cartão real nem dado de clínica real.
- Nunca colar credencial em arquivo versionado, em teste ou em mensagem de commit.
- Nunca cadastrar estas credenciais como secrets do CI sem decisão prévia.

## Sem credencial nenhuma — `providers-rejection-smoke.test.ts`

```bash
EXTERNAL_SMOKE=1 pnpm --filter @luxora/backend test:manual
```

Faz uma chamada real a cada provider com uma credencial **inválida de
propósito**. Não usa nem exige credencial real, não custa nada e não produz
efeito. Prova que o endereço responde a partir desta máquina, que o corpo de
erro verdadeiro é lido pelo nosso código, que a falha é classificada como
permanente e que nada da credencial aparece na mensagem de erro. Também
confere que a Meta serve exatamente a versão da Graph API fixada no código
(`src/infrastructure/messaging/whatsapp-graph-api.ts`) — o teste falha se ela
tiver expirado, porque a Meta passa a atender com outra versão sem avisar.

A Asaas é chamada sempre no endereço de sandbox, fixado dentro do teste,
qualquer que seja o valor do `.env`.

Não prova o caminho feliz de nenhum provider.

## A fila de saída inteira — `whatsapp-worker-smoke.test.ts`

Também exige `EXTERNAL_SMOKE=1`, e mais o Postgres e o Redis do
`docker compose`. Sobe a aplicação com o worker de saída real e percorre
produtor → Redis → worker → Use Case → provider → Graph API, sem interceptar
nada. Usa o banco lógico 15 do Redis (nunca o 0, onde `pnpm dev` trabalha) e
clínicas descartáveis, apagadas ao final.

- Sem credencial: uma clínica com token inválido — a Meta recusa, o job
  encerra na primeira tentativa.
- Com as três variáveis `WHATSAPP_SMOKE_*` da próxima seção: envia **uma**
  mensagem pela fila, confere o registro com o id da Meta e que um segundo job
  com a mesma chave não envia de novo.

Se o número de teste já estiver conectado a uma clínica do banco local, o
teste para e avisa — o número só pode pertencer a uma clínica.

## Meta / WhatsApp — `whatsapp-smoke.test.ts`

No painel do App da Meta (developers.facebook.com → seu App → WhatsApp →
Configuração da API) há um **número de teste** gratuito, um token temporário
e uma lista de destinatários autorizados.

```
WHATSAPP_SMOKE_PHONE_NUMBER_ID=<id do número de teste>
WHATSAPP_SMOKE_ACCESS_TOKEN=<token temporário do App>
WHATSAPP_SMOKE_TO=<seu próprio número, autorizado no painel, só dígitos com DDI>
```

O teste envia uma mensagem de texto pelo `WhatsAppMessageProvider` real, sem
banco. Fora da janela de 24 horas de conversa a Meta só **entrega** mensagens
de modelo aprovado: a API aceita o texto livre (o teste passa), mas a mensagem
pode não chegar ao aparelho. Para ver a entrega, mande antes qualquer mensagem
do seu número para o número de teste.

O que este teste **não** cobre: a entrada (Meta → webhook → Luxora). Ela exige
o backend acessível por um endereço público HTTPS, configurado no painel do
App com o `WHATSAPP_WEBHOOK_VERIFY_TOKEN` e o App Secret real em
`WHATSAPP_APP_SECRET`.

## Anthropic — `anthropic-smoke.test.ts`

```
ANTHROPIC_SMOKE=1
ANTHROPIC_API_KEY=<chave de uma conta de desenvolvimento>
```

`ANTHROPIC_SMOKE=1` é exigido além da chave, para que ter a chave no `.env`
(necessária para rodar a aplicação) não dispare chamadas pagas por acidente.

Faz as 3 chamadas de um turno — `interpretIntent`, `ContactIntentClassifier` e
`generateResponse` — pelos providers reais, com clínica, terapeutas e mensagem
**inventados**. Nenhum banco é lido; nenhum dado real sai da máquina. Imprime
modelo, tokens, latência e custo estimado de cada chamada.

O primeiro teste falha se o modelo real devolver o JSON de intenção embrulhado
(cerca de código, texto em volta): é o defeito que só uma chamada real revela.

## Asaas sandbox — `asaas-sandbox-smoke.test.ts`

Exige uma conta no ambiente de testes da Asaas (sandbox.asaas.com), separada
da conta de produção, e a chave de API **dessa** conta:

```
ASAAS_ENV=sandbox
ASAAS_BASE_URL=https://api-sandbox.asaas.com/v3
ASAAS_API_KEY=<chave da conta sandbox>
```

O arquivo só roda quando `ASAAS_BASE_URL` aponta para um host de sandbox. Com
a URL de produção ele é pulado, mesmo com a chave definida.

Cria um cliente e uma assinatura via PIX, consulta as cobranças geradas e
registra o estado, lista os webhooks cadastrados e confere que o modo de envio
é o sequencial, confere que uma chave inválida é recusada sem expor a chave
real, e cancela a assinatura ao final. O CPF do
cliente é gerado na hora (só dígitos verificadores válidos); para usar um
documento específico, defina `ASAAS_SANDBOX_CPF_CNPJ`.

O que este teste **não** cobre: o webhook (Asaas → Luxora), que exige endereço
público, e o cartão (abaixo).

### Cartão

`attachCreditCard` não está em nenhum teste desta pasta. Número e código de
segurança ainda passam pelo backend a caminho da Asaas, e esse modelo aguarda
decisão arquitetural (checkout hospedado ou tokenização no navegador). Até lá,
a exposição é coberta por `test/critical/card-data-exposure.test.ts`, com a
Asaas simulada. Nunca usar cartão real.

## Asaas produção — `asaas-production-smoke.test.ts`

Anterior aos demais e mantido como estava, salvo o rótulo. Toca a **API real
de produção da Asaas** — dinheiro de verdade, clientes e assinaturas reais no
painel deles.

A documentação de ambiente do projeto registra a produção como único ambiente
Asaas da Luxora. A Fase 3 da auditoria pede o contrário — sandbox primeiro —,
e é para isso que existe o arquivo da seção anterior. Enquanto não houver
conta sandbox, a integração com a Asaas continua sem validação real.

```bash
# exportadas no terminal:
#    ASAAS_API_KEY=<chave de produção real>
#    ASAAS_ENV=production
#    ASAAS_BASE_URL=https://api.asaas.com/v3
#    ASAAS_TEST_CPF_CNPJ=<um CPF ou CNPJ real, seu ou da clínica —
#      nunca um valor inventado; a Asaas valida e este teste cria um
#      cliente de verdade associado a esse documento>

pnpm --filter @luxora/backend test:manual
```

Cria um cliente de teste claramente identificado (`[TESTE MANUAL LUXORA]`
no nome) e uma assinatura mínima via PIX (sem cobrar cartão), depois
**cancela a assinatura imediatamente** no `afterAll` — mas cancelar não
apaga o cliente nem o histórico no painel da Asaas. Depois de rodar,
confira o painel da Asaas e apague manualmente o cliente de teste se
quiser um ambiente limpo.
