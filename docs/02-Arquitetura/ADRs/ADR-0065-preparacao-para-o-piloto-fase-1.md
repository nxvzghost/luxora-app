# ADR-0065 — Preparação para o piloto, fase 1: nada sensível nos traces, licenças das fontes junto do painel e situação dos bloqueadores

**Status:** ADOTADO (decisões 1 e 2). Executado localmente em 12 de outubro de 2026; **sem push, sem deploy, sem execução no CI remoto**.
**Origem:** Tarefa 07 da auditoria técnica de 04/10/2026 (piloto e produção), fase 1 — os bloqueadores que podiam ser resolvidos na máquina, com requisito definido e sem serviço externo.
**Veredito da fase: PARCIAL** — os três blocos de código (traces, fuso por clínica, licenças) estão implementados e validados localmente; o que falta para a fase ser dada como concluída é a execução no CI remoto, que depende de publicação autorizada, e as decisões pedidas nos itens 4 e 5. **Atualização de 12/10/2026, à noite:** o escopo local foi fechado — o fuso passou a ser alterável pelo painel, o painel mostra os horários no fuso da clínica e as decisões das automações foram registradas (seção "Fechamento do escopo local"). A fase continua PARCIAL pelo que não é local: publicação autorizada, CI remoto e a repetição do ensaio de deploy com as imagens. **Nada aqui torna o produto pronto para produção nem autoriza iniciar o piloto.**

## Objetivo

Tirar do caminho do piloto o que era resolvível sem custo e sem decisão nova, e deixar claro, item por item, o que ainda depende de decisão, de credencial ou de serviço externo.

| Bloco | O que era | O que ficou | Onde está o detalhe |
|---|---|---|---|
| 1 | O token de verificação do webhook da Meta ia para os traces | Corrigido na origem, com um segundo vazamento encontrado e corrigido | Decisão 1, abaixo |
| 2 | Agenda e vencimento dependiam do fuso do contêiner (AD-039) | Implementado: fuso por clínica; depois, alterável pelo administrador no painel, que passou a mostrar os horários no fuso da clínica | [ADR-0064](./ADR-0064-fuso-horario-por-clinica.md), "Implementação" e "Alteração do fuso pelo painel" |
| 3 | As licenças das fontes só existiam no repositório | Servidas pelo painel e guardadas na imagem | Decisão 2, abaixo |
| 4 | As quatro rotas de automação respondem 500 | **Só diagnóstico e registro das decisões** — as sete decisões foram tomadas e registradas; a implementação é etapa própria e as rotas continuam em 500 | [`docs/07-Infra/AUTOMACOES_AGENDADOR.md`](../../07-Infra/AUTOMACOES_AGENDADOR.md), "Diagnóstico de 12/10/2026" e "Decisões registradas em 12/10/2026" |
| 5 | Demais pendências antes do piloto | Classificadas, sem execução | "Bloqueadores antes do piloto", abaixo |

## Decisão 1 — Nada sensível sai em um trace

### O que vazava (medido com as instrumentações em uso)

1. **O token de verificação do webhook.** A instrumentação de HTTP do OpenTelemetry grava a query string inteira de toda requisição recebida no atributo `url.query` (e o endereço completo, `url.full`, nas requisições de saída). A verificação do webhook da Meta manda o token exatamente ali — `GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=…` — porque o protocolo dela exige. Com um coletor OTLP configurado, o token ia para ele.
2. **O conteúdo das mensagens e o telefone dos pacientes.** Achado desta revisão, maior que o primeiro: a instrumentação do Redis grava os argumentos dos comandos em `db.query.text`, e o BullMQ enfileira por script (`evalsha`), cujos argumentos são o job inteiro. O span de cada mensagem enfileirada levava o telefone do destinatário e o texto.

### A regra

**Negar por padrão, na origem — onde o span é montado, antes de qualquer exportação.**

- **Query string:** ficam os nomes dos parâmetros; o valor sai (`REDACTED`), exceto para uma lista curta de parâmetros que não identificam ninguém nem autenticam nada — `limit`, `from`, `to`, `state` e `hub.mode`. Um parâmetro novo nasce redigido, sem ninguém precisar lembrar dele. Vale para `url.query`, `url.full` e para os atributos das convenções semânticas antigas (`http.url`, `http.target`).
- **Comando Redis:** ficam o nome do comando e a quantidade de argumentos; mais o hash do script, no caso de `evalsha`. As chaves saem junto com os valores: a chave de um job é o id dele, e o id do job de entrada é o identificador da mensagem no WhatsApp, que embute o telefone de quem escreveu.
- **O que continua no trace**, e é o que se usa para operar: método, rota, caminho, status, duração, nomes dos parâmetros, nome do comando, versão e ambiente.

Implementação: `shared/observability/trace-redaction.ts` (as regras, funções puras) e `shared/observability/instrumentations.ts` (as três instrumentações, agora em um lugar só — é daqui que `tracing.ts` e os testes as tiram, para o que é testado ser o que roda). A redação entra pelo `requestHook` da instrumentação de HTTP e pelo `dbStatementSerializer` da do Redis.

### Alternativas descartadas

- **Lista de parâmetros a redigir** (`redactedQueryParams` da própria instrumentação): é lista do que tirar, não do que deixar — o próximo parâmetro sensível passaria. E só cobre requisições de saída.
- **Redigir na exportação**, com um processador de spans: exigiria montar à mão o exportador que hoje o SDK monta sozinho a partir das variáveis de ambiente, e o dado sensível já estaria no span.
- **Apagar os logs locais em que o token apareceu:** não impede a próxima execução de expor o valor.

### O que mais foi conferido, e não precisou mudar

- **Cabeçalhos e corpo** nunca foram capturados pelas instrumentações (`headersToSpanAttributes` não é configurado) — passou a ter teste: credencial de sessão, chave de automação, assinatura do webhook e corpo da mensagem não aparecem.
- **Log de erro:** o filtro de exceções registra a mensagem e a pilha do erro, nunca o endereço da requisição. Um 500 na verificação do webhook não leva o token nem ao log, nem à resposta, nem ao span (teste).
- **Rotas com segredo no caminho:** nenhuma.

### Achados registrados, não alterados

- **O id do job aparece nos logs dos workers**, e o id do job de entrada é o identificador da mensagem no WhatsApp, que embute o telefone do remetente em base64. É o identificador que permite cruzar com a Meta; tirá-lo dos logs tem custo operacional. Fica para decisão.
- **O `X-Correlation-Id` enviado pelo cliente é aceito como vier**, sem limite de tamanho nem de formato, e vai para os logs e para a resposta. Não carrega o token, mas é texto de fora dentro do log. Endurecer (aceitar só um formato curto) é mudança pequena, a decidir.
- **Os processos de teste também ligam o tracing**, com exportação para o console (é a origem do log de dezenas de megabytes do job `test-critical`). Os spans que saem ali agora também estão redigidos; reduzir esse volume não fez parte desta fase.

## Decisão 2 — As licenças das fontes seguem junto com o painel

O painel distribui Fraunces e Inter sob a SIL Open Font License 1.1, que pede que o aviso de direitos autorais e o texto da licença acompanhem as fontes. Os dois `OFL.txt` estavam só no repositório; ao navegador chegavam só os `.woff2`, e a imagem Docker não levava licença nenhuma.

Os textos passam a acompanhar as fontes em três lugares:

1. **Servidos pelo painel, sem login:** `/licencas/fontes.txt` é o índice — qual família está sob qual licença, com o aviso de direitos autorais de cada uma e o endereço do texto; `/licencas/fraunces-OFL.txt` e `/licencas/inter-OFL.txt` são os textos integrais. São gerados no build a partir dos mesmos `OFL.txt` de `apps/frontend/app/fonts`, byte a byte: fazem parte da saída do build, onde quer que o painel seja publicado.
2. **Em cada arquivo de fonte servido**, pelo cabeçalho `Link: </licencas/fontes.txt>; rel="license"`.
3. **Na imagem Docker**, em `/app/licenses/fonts/<família>/OFL.txt`.

Os dez arquivos `.woff2` não foram tocados (os mesmos dez SHA-256 são emitidos), nenhuma tela mudou — nada visível foi acrescentado — e o build continua sem consultar rede: só lê arquivos locais.

**Alternativa descartada:** copiar os textos para `public/`. Duplicaria a licença no repositório e dependeria de o Dockerfile lembrar de copiar a pasta para a imagem; gerada pelo build, ela não tem como ficar para trás.

**Travas:** uma pasta de fontes sem licença declarada falha o teste do painel; um arquivo do painel que volte a importar `next/font/google` também. O ensaio de deploy confere a imagem construída.

## Bloqueadores antes do piloto

Classificação pedida na fase, item por item. **Nenhum foi executado aqui.**

| Item | Resolve na máquina, sem custo? | Exige decisão de produto? | Exige credencial ou serviço externo? | Precisa estar resolvido antes do piloto? |
|---|---|---|---|---|
| Desfazer um vínculo de WhatsApp aprovado | Sim — rota, tela, registro na auditoria e testes | Pequena: quem desfaz e se o motivo fica registrado | Não | **Sim.** Hoje um vínculo aprovado por engano só se corrige direto no banco (ADR-0063, pendência 2) |
| Pacientes inativos ou com alta | Sim, depois da decisão | **Sim**, e vale para o sistema inteiro: hoje nenhum fluxo usa o estado do paciente para permitir ou negar nada | Não | A decisão, sim. Sem ela, o paciente com alta continua reconhecido e pode marcar pelo WhatsApp |
| Variantes de nome | Sim, depois da decisão | **Sim:** regra de correspondência aproximada, ou só aviso à clínica | Não | Não bloqueia: o efeito é cadastro duplicado, que a clínica corrige. Monitorar no piloto |
| Classificador contra a Anthropic real | Não | Não — só autorização de custo | **Sim:** créditos na conta da Anthropic (o teste anterior parou em saldo insuficiente) | **Sim**, se o piloto usar o WhatsApp com IA: o texto do classificador mudou depois do último teste real |
| Entrada da Meta (webhook) | Não | Não | **Sim:** URL pública (homologação ou túnel autorizado) e o app da Meta | **Sim.** A verificação e a redação do token estão testadas localmente; a entrega real de mensagens, nunca |
| Falha de envio depois da fila | Sim — registrar o desfecho e avisar a clínica, com provider simulado | Pequena: o que a clínica vê e o que acontece com a cobrança que ficou "Enviada" sem ter saído | Não | **Sim.** Hoje a falha definitiva só aparece em uma linha de log |
| Homologação, CD e provedor | Não | **Sim:** qual provedor, com que custo | **Sim:** contratação | **Sim** |
| Backup fora do host e alertas | Em parte — os scripts existem; o destino e o canal de alerta, não | **Sim:** onde guardar e quem é avisado | **Sim:** armazenamento e, talvez, serviço de alerta | **Sim** |
| Proteção da branch `master` | Não — é configuração do GitHub | **Sim:** muda o fluxo de publicação (hoje o push é direto e o CI informa, não bloqueia) | Conta do GitHub; sem custo em repositório público | Recomendado |
| Dependências com alerta de segurança | Sim — `overrides` do pnpm, como os nove que já existem (`proxy-addr`, crítico; `source-map-js`, alto), com a regressão completa | Não | Não | **Sim** para o crítico. A exposição real não foi analisada: a aplicação usa `trust proxy = 1`, por contagem de saltos |
| Armazenamento e validade dos tokens de sessão | Sim, mas é mudança de contrato (cookie `httpOnly` e proteção de rota no servidor); reduzir a validade é só configuração | **Sim** — a AD-028 está aberta por decisão (ADR-0056, ADR-0061) | Não | A decisão registrada basta para o piloto; rever antes de abrir para mais clínicas |
| Teste com mais de uma aba | Sim — Playwright, duas páginas no mesmo navegador | Só se o teste mostrar um comportamento a escolher | Não | Recomendado: é barato e fecha a lacuna registrada na ADR-0062 |
| Automações que respondem 500 | Sim — as sete decisões foram registradas em 12/10/2026 | Ainda: doze itens de especificação (horas de cada rotina, critério da enumeração, chave de ativação e outros), em `AUTOMACOES_AGENDADOR.md` | Não, no caminho decidido | Não bloqueia o piloto: pela decisão 7, as rotinas de comunicação nascem desligadas. Precisa estar implementado antes de uma clínica real ligá-las |

Os dois pontos da ADR-0064 que a implementação tinha deixado abertos — o painel mostrar os horários no fuso da clínica e quem pode alterar o fuso — foram decididos e implementados no fechamento do escopo local (abaixo).

## Evidências de validação

Tudo local, em 12/10/2026. Nenhuma chamada a Meta, Anthropic ou Asaas, nenhum custo, nenhum deploy, nenhum push.

**Regressão no commit `4240e39`** (o último que altera código ou teste), em clone limpo, sem `.env`, em ambiente vazio e com o processo em UTC, na ordem dos jobs do CI:

| Verificação | Resultado | Antes da fase |
|---|---|---|
| Lint | limpo; nenhum arquivo alterado | — |
| Tipos (`pnpm typecheck`) | sem erros nos três pacotes | — |
| Backend — unitários | 1178 | 1088 |
| Painel | 229, em 20 arquivos | 217 |
| Backend — integração | 56, em 4 arquivos (migrations aplicadas em banco vazio, inclusive a nova) | 42 |
| Backend — críticos | 524 aprovados, 1 pulado e 1 `todo` (os mesmos de antes); nenhum defeito conhecido | 505 |
| Ponta a ponta | 30 de 30, com o backend em UTC e o navegador em `America/Sao_Paulo` | 27 |
| Imagens e ensaio de deploy | 78 de 78; contêiner do backend em UTC; nenhuma imagem com `.env` | 68 |

**Ressalva sobre as imagens.** As imagens e o ensaio foram executados a partir da árvore de trabalho, com o conteúdo que entra nas imagens idêntico ao do commit `4240e39`. A repetição a partir do clone limpo foi interrompida no meio do build: o disco da máquina encheu (cache de build do Docker acumulado). Não foi refeita; o cache foi limpo e o repositório conferido íntegro.

**Fuso do processo.** As três suítes do backend rodadas inteiras com o processo em UTC, `Asia/Tokyo` e `America/Sao_Paulo`: mesmo resultado nas três.

**Provas por mutação** (código alterado de propósito, uma regra por vez, e restaurado):

| Mutação | Resultado |
|---|---|
| Sem a redação da query string | 3 testes unitários e 5 críticos falham |
| Sem o serializador do Redis | 1 teste crítico falha |
| Hora de parede lida no fuso do processo | 53 testes falham com o processo em UTC; 22 com ele em São Paulo |
| Corte do atraso de volta à meia-noite UTC | 9 unitários e 3 de integração falham |
| Dias de atraso em blocos de 24 h | 8 falham |
| Dias do calendário percorridos em UTC | 1 falha (a primeira rodada não pegava; o teste foi acrescentado) |
| Janela convertida em UTC | 15 falham |
| Repositório ignorando o fuso da clínica | 1 de integração falha |

**Nas imagens de verdade** (ensaio de deploy, com o coletor OTLP): a verificação do webhook aceita o token do ambiente e recusa um errado; o span chega ao coletor com `url.query: hub.mode=subscribe&hub.verify_token=REDACTED&hub.challenge=REDACTED`; nem o token, nem o token errado, nem o desafio aparecem em nada do que o coletor recebeu. As licenças servidas pelo painel e as guardadas na imagem têm o mesmo SHA-256 dos `OFL.txt` do repositório, e o arquivo de fonte servido traz o cabeçalho `Link`.

**Fontes:** os dez `.woff2` emitidos pelo build têm o mesmo conjunto de SHA-256 dos dez do repositório; nenhuma menção ao Google Fonts no HTML nem no CSS servidos.

## Fechamento do escopo local (12/10/2026)

Segunda rodada da fase, no mesmo dia, a pedido do responsável pelo produto: terminar o que ainda era local. **Sem push, sem deploy, sem CD, sem chamada a Meta, Anthropic ou Asaas, sem custo.** Os commits da fase — nove, com o desta documentação — continuam só na máquina.

### O que entrou

| Bloco | O que foi feito | Detalhe |
|---|---|---|
| Fuso pelo painel | O administrador altera o fuso da clínica em Configurações (`PUT /clinic/time-zone`, com validação IANA e registro na auditoria, na mesma transação), e o painel passou a mostrar e a ler horários no fuso da clínica | [ADR-0064](./ADR-0064-fuso-horario-por-clinica.md), "Alteração do fuso pelo painel" |
| Automações | As sete decisões do responsável pelo produto foram **registradas**, com o mapa das quatro rotinas e doze itens que ainda exigem especificação. **Nada foi implementado:** as quatro rotas continuam respondendo 500 e o `todo` da suíte crítica continua | [`AUTOMACOES_AGENDADOR.md`](../../07-Infra/AUTOMACOES_AGENDADOR.md), "Decisões registradas em 12/10/2026" |
| Licenças | Só conferência, abaixo | — |
| Traces | Só conferência, abaixo | — |

### Conferência das licenças das fontes

Sem reconstruir imagem. Os dois `OFL.txt` e os dez `.woff2` não mudaram desde o commit publicado (`b00fa17`) nem na árvore de trabalho; os dez `.woff2` batem com os SHA-256 registrados em `apps/frontend/app/fonts/README.md`; nenhum arquivo do painel importa `next/font/google` (a única menção é um comentário). Na saída do build de produção feito para os testes de ponta a ponta, `/licencas/fraunces-OFL.txt` e `/licencas/inter-OFL.txt` têm o mesmo SHA-256 dos arquivos do repositório, e os três testes de ponta a ponta das licenças passaram contra o painel servido (`next start`).

**Não repetido nesta rodada: a licença dentro da imagem Docker** (`/app/licenses/fonts/<família>/OFL.txt`). As imagens da rodada anterior foram removidas na limpeza que se seguiu ao disco cheio, e construir outra com cerca de 5,5 GB livres no disco da máquina repetiria o risco. A evidência desse caminho continua sendo o ensaio de deploy da rodada anterior (78 de 78, a partir da árvore de trabalho). O `Dockerfile` e os arquivos de infraestrutura não foram tocados desde então.

### Conferência dos traces

Os testes da redação rodaram de novo, dentro das suítes, com o processo em UTC, em `Asia/Tokyo` e em `America/Sao_Paulo`, e passaram nos três:

- **O token não aparece no que é exportado:** verificação do webhook aceita, recusada e com erro 500 (log de erro e resposta incluídos), e a requisição de saída (`test/critical/trace-no-secrets.test.ts`, `test/unit/shared/observability/trace-export.test.ts`).
- **Telefone, texto e id do job não aparecem no span do Redis:** um job enfileirado pelo BullMQ grava o comando e o hash do script, e só (`trace-no-secrets.test.ts`; as regras, em `trace-redaction.test.ts`).
- **O que serve para operar continua lá:** caminho, rota, status, nomes dos parâmetros e paginação; nome do comando e quantidade de argumentos; e as sondas de saúde continuam sem trace.

Nenhuma chamada à Meta: a verificação é feita localmente, do jeito que ela a faz. **A conferência nas imagens de verdade, com o coletor OTLP (ensaio de deploy), também não foi repetida**, pela mesma razão das licenças.

### Regressão desta rodada

No commit `9e5bdce` (o último que altera código ou teste), **na árvore de trabalho** do repositório — não em clone limpo — e sem construir imagem:

| Verificação | Resultado | Antes desta rodada |
|---|---|---|
| Lint (backend e painel) | limpo | — |
| Tipos (`pnpm typecheck`) | sem erros nos três pacotes | — |
| Backend — unitários | 1190, em 98 arquivos | 1178 |
| Backend — integração | 56, em 4 arquivos | 56 |
| Backend — críticos | 567 aprovados, 1 pulado e 1 `todo` (os mesmos de antes), em 47 arquivos | 524 |
| Painel | 274, em 22 arquivos | 229 |
| Ponta a ponta | 32 de 32, com o backend em UTC e o navegador em `America/Sao_Paulo` (e, antes, 32 de 32 com o backend no fuso da máquina) | 30 |
| Imagens e ensaio de deploy | **não executados** | 78 de 78 |

As três suítes do backend e a do painel deram as mesmas contagens com o processo em UTC, em `Asia/Tokyo` e em `America/Sao_Paulo`. Quinze mutações do fuso pelo painel, todas detectadas (lista na ADR-0064).

**O que não foi repetido, e por quê.** (1) Imagens Docker e ensaio de deploy: risco de encher o disco de novo. (2) Clone limpo, sem `.env`: a réplica do CI em clone limpo pede a instalação das dependências em outra pasta e, para valer como a anterior, as imagens. As suítes rodaram na árvore de trabalho, com o `.env` local de desenvolvimento. (3) Varredura de segredos antes de publicar: é o gate de pré-publicação, que não foi pedido nesta rodada. **Os três ficam para o gate, quando houver espaço em disco.**

### Estado do disco

No começo desta rodada: 6,2 GB livres no disco da máquina; 24 GB usados dentro do disco virtual do WSL; cache de build do Docker com 16,1 GB. Ao fim dos testes: cerca de 5,4 GB livres — a diferença são os builds do backend e do painel para os testes de ponta a ponta e os logs das suítes; nenhuma imagem foi construída. Nada foi apagado, podado ou compactado. O disco virtual do WSL não foi compactado: é decisão do responsável.

## Limitações conhecidas

- Tudo foi validado na máquina, em clone limpo e em contêineres locais. **O CI remoto não rodou com estes commits.**
- **Os três commits do fechamento do escopo local não passaram por clone limpo nem por imagem Docker**: foram validados na árvore de trabalho, sem ensaio de deploy (seção acima).
- Nenhuma integração real foi exercitada: a verificação do webhook foi feita localmente, do jeito que a Meta a faz. Entrada real da Meta e respostas reais da Anthropic continuam não validadas.
- A lista de parâmetros cujo valor continua visível nos traces é uma escolha desta implementação; acrescentar um nome a ela é decisão consciente, com teste.
- A ligação entre arquivo de fonte e licença depende de o servidor do painel aplicar o cabeçalho `Link`; atrás de uma CDN que reescreva cabeçalhos, conferir de novo.

## Documentos relacionados

- [ADR-0064](./ADR-0064-fuso-horario-por-clinica.md) — fuso por clínica (AD-039), com a seção "Implementação"
- [ADR-0051](./ADR-0051-observabilidade-correlation-id-otel-prometheus.md) — observabilidade de base; [ADR-0060](./ADR-0060-deploy-e-operacao.md) — imagens e deploy
- [ADR-0062](./ADR-0062-fechamento-dos-testes.md) e [ADR-0063](./ADR-0063-identidade-confirmada-no-whatsapp.md) — de onde vêm as pendências classificadas aqui
- `docs/07-Infra/AUTOMACOES_AGENDADOR.md` — diagnóstico das automações, decisões registradas e o que falta especificar
- `apps/frontend/app/fonts/README.md` — origem das fontes e onde a licença as acompanha
- `CHANGELOG.md` — Tarefa 07, fase 1
