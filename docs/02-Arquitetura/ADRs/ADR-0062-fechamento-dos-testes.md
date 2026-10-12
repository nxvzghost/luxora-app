# ADR-0062 — Fechamento dos testes: ponta a ponta em pilha descartável, referências entre clínicas recusadas e defeitos conhecidos presos por teste

**Status:** ADOTADO
**Origem:** Tarefa 06 da auditoria técnica de 04/10/2026 (Fechamento dos testes; Epic 13 — AD-012, AD-022, AD-031, AD-032, AD-035 — e os Cenários 11, 12 e 13 de Contact, do Epic 9).
**Data:** 8 de outubro de 2026
**Veredito da Tarefa 06: CONCLUÍDA** (12/10/2026, seção "Fechamento" abaixo), por decisão do responsável pelo produto depois de avaliar o resultado remoto. Os critérios da tarefa estão atendidos e confirmados no CI remoto com o código final: em 12/10/2026, com push autorizado, o commit `ad05a87` passou nos sete jobs da execução 38249354910 do workflow `CI`, inclusive `typecheck` (primeira execução no GitHub) e `test-e2e` (27 de 27), já com a AD-037, a AD-038 ([ADR-0063](./ADR-0063-identidade-confirmada-no-whatsapp.md)), a correção de integridade da aprovação de vínculo, o build do painel sem o Google Fonts, os tipos dos testes e o isolamento entre sessões no painel. **A conclusão da tarefa não significa que o produto esteja pronto para produção.** Fora da tarefa e ainda abertos, antes do piloto: a AD-039 (fuso), a execução das automações pelo agendador, as pendências da ADR-0063 e a validação externa de Meta e Anthropic (Tarefa 03); a lista completa está em "Fechamento". A Tarefa 07 (piloto e produção) não foi iniciada.

## Objetivo

Ter o fluxo principal da clínica coberto por testes de ponta a ponta automatizados, prontos para o CI, e fechar as lacunas de teste atribuídas à Tarefa 06 — sem criar teste para aumentar contagem e sem dar como resolvido o que só existe em uma classe isolada.

## Reconciliação (o que havia antes)

| Item | Estado encontrado |
|---|---|
| AD-012 | Nenhum teste de ponta a ponta; nenhuma dependência de Playwright ou Cypress. |
| AD-022 | `GET /audit-log` sem nenhum teste. |
| AD-032 | `PatientsController` e `AppointmentsController` só com o RBAC das rotas de escrita coberto. |
| AD-035 | Quatro arquivos críticos fora do padrão de fixture dedicada; dois gravavam na clínica semeada e não limpavam. |
| AD-031 | 155 testes no frontend depois da Tarefa 05; a tela de Assinatura sem nenhum, Pacientes e Configurações só com o erro de carregamento. |
| Contact 11/12/13 | Só testes unitários com repositórios de mentira. O plano dava 11 e 12 como cobertos. |

## Decisão

### 1. Ponta a ponta com Playwright, em pilha descartável (AD-012)

- Pacote próprio, `apps/e2e`, fora do backend e do frontend: os testes dirigem o painel pelo navegador e não chamam rota de negócio por conta própria.
- `infra/tests/e2e.sh` é o único jeito de rodar, igual na máquina e no CI: sobe Postgres (em memória, porta 55432) e Redis (porta 56379) de `infra/e2e/docker-compose.yml`, aplica as migrations, constrói backend e painel, roda os testes e derruba tudo ao sair — inclusive quando falha.
- O banco de desenvolvimento não é usado. `apps/e2e/support/env.ts` recusa qualquer banco cujo nome não termine em `_e2e`.
- Cada teste recebe uma clínica própria, criada pela fixture e removida ao fim, com falha ou não. Nenhum teste depende de outro nem da ordem; o encerramento global falha se sobrar alguma clínica de teste.
- Nenhuma integração externa: as chaves da Anthropic e da Asaas vão vazias para o backend do teste e a clínica não tem WhatsApp conectado. O envio de cobrança é exercitado justamente pela recusa (`WHATSAPP_NOT_CONNECTED`) — nenhum envio é simulado como sucesso.
- Fuso fixado em `America/Sao_Paulo` no backend do teste e no navegador; as datas dos testes são calculadas nesse fuso, qualquer que seja o da máquina.
- No CI, o job `test-e2e` instala o Chromium, roda o mesmo script e, se falhar, publica os traces e o relatório como artefato.

Os 20 testes cobrem: entrar, recarregar, sair e a proteção das rotas; sessão encerrada pelo servidor e renovação do token; disponibilidade; marcar, confirmar, remarcar e cancelar consulta; criar cobrança, registrar pagamento, valores do Financeiro e do Dashboard; cobrança em atraso; pagamento divergente e a notificação; estorno; e o que o perfil terapeuta vê.

### 2. Referência a registro de outra clínica é recusada na entrada

A RLS impede uma clínica de **ler** o dado de outra, mas a chave estrangeira não olha a clínica. Quatro casos de uso gravavam o id que viesse no corpo da requisição. Agora leem o paciente (e o terapeuta) pelo repositório, que respeita a RLS, e respondem 404 quando não é da clínica:

- `AgendarConsultaUseCase` e `CriarAgendamentoRecorrenteUseCase` — paciente;
- `CriarRecurringBlockUseCase` — paciente e terapeuta;
- `GerarCobrancaUseCase` — paciente, e as sessões passam a ser lidas **antes** de qualquer gravação.

### 3. Parâmetro de lista inválido responde 400

`limit` que não seja inteiro maior que zero responde 400 nas listas de auditoria, pacientes, cobranças e notificações (`src/shared/pagination.ts`); `from` e `to` ausentes ou inválidos respondem 400 em `GET /appointments` e na consulta de disponibilidade. Antes respondiam 500. Não foi criado teto novo: quem já enviava um número válido não vê diferença.

### 4. Fixture dedicada nos quatro arquivos da AD-035

Os quatro passam a usar `createDedicatedFixture`/`cleanupDedicatedFixture`, com datas fixas no lugar das sorteadas. A limpeza da fixture apaga também consultas, horários fixos e feriados da clínica do teste. Nenhuma asserção mudou.

### 5. Defeito conhecido fica preso em um teste que falha — e nunca conta como aprovado

Quando um teste desta tarefa mostrou um comportamento errado que **não cabia corrigir aqui** (é do pipeline de IA e WhatsApp, da Tarefa 03), o teste foi mantido afirmando o comportamento correto. Ele é escrito com `knownDefect` (`test/critical/support/known-defect.ts`) e o título começa por `DEFEITO CONHECIDO (AD-xxx)`, com o item de backlog que o corrige:

- `pnpm --filter @luxora/backend test:known-defects` executa só esses testes, de verdade, e **termina em falha** enquanto houver defeito aberto;
- na suíte que libera o CI (`test:critical`) eles não são executados e aparecem como **pulados**, com o título à vista — nunca como aprovados;
- corrigido o defeito, troca-se `knownDefect` por `it` e o teste vira uma garantia como as outras.

Cada um confere só um fato colhido antes, para que um erro de preparação não se confunda com o defeito. Eram três, todos em `test/critical/contact-scenarios-real-flow.test.ts`: um da AD-037 e dois da AD-038. **Em 09/10/2026 os três defeitos foram corrigidos** e os testes viraram testes normais, com as mesmas asserções. Hoje não há nenhum teste de defeito conhecido: `test:known-defects` não encontra nenhum. O comando e o helper continuam no repositório, para o próximo defeito que não couber corrigir na hora.

**Revisão de 08/10/2026:** a primeira versão desta decisão usava `it.fails`, que faz o teste contar como aprovado justamente enquanto o defeito existe. Foi abandonada por decisão do responsável pelo produto — uma falha não pode ser mascarada assim. `it.fails` não deve ser usado para este fim.

### 6. Dublês de provider nos testes críticos

`bootstrapTestApp({ overrides })` troca providers por dublês do próprio teste. Usado para roteirizar o provedor de IA e o classificador de Contact e para guardar em memória o job da fila de entrada — o resto do caminho continua real.

## O que o fluxo de Contact faz de verdade

`contact-scenarios-real-flow.test.ts` envia cada mensagem pelo webhook real e processa o job como o worker processa, contra o Postgres. Só a IA é roteirizada: o arquivo não prova o que o modelo real responderia, prova o que o backend faz com cada resposta possível.

**Garantias que valem hoje (testes normais):**
- contato novo sem nome nunca vira paciente, nada é marcado e o fluxo pede o nome;
- paciente cadastrado, reconhecido pelo telefone, não é cadastrado de novo quando a IA trata a mensagem como primeiro cadastro (D5b, no caminho que existe hoje);
- **Cenário 13:** paciente conhecido escrevendo de um número novo nunca é ligado ao cadastro, não é cadastrado de novo, nada é marcado, o fluxo pede confirmação e o Contact do número antigo fica intacto;
- ninguém é associado a um contato pelo nome dito na mensagem.

**O que não está ligado ao fluxo** (nenhuma destas chamadas existe fora da própria entidade):

| Capacidade do Aggregate | Quem chama |
|---|---|
| `Contact.identificar()` (guardar o nome) | ninguém |
| `Contact.vincularAPacienteExistente()` (Cenário 13, depois da confirmação) | ninguém |
| `Contact.createAlreadyLinked()` (Cenário 14) | ninguém |
| `Contact.arquivar()` | ninguém |

Consequências — as quatro primeiras observadas no teste, a quinta lida no código:

1. **Contato novo não consegue marcar a primeira consulta pelo WhatsApp.** A promoção exige o nome; o nome nunca é guardado; o fluxo pede o nome de novo a cada mensagem. O plano registrava esse caso como alcançado pela AD-018 — não está.
2. **Nenhuma associação Contact↔Paciente é criada pelo fluxo.** No teste, `ASSOCIAR` com o paciente da conversa conhecido termina sem associação nenhuma; pelo código, o motivo é que nenhum Contact sai de `Conversando` e a associação exige um Contact já qualificado. Os Cenários 11 e 12 existem no Aggregate e no roteador, não no caminho executado.
3. **Dois pacientes no mesmo número: a conversa é ligada, sem perguntar, ao mais antigo, e a consulta é marcada para ele** — mesmo quando quem escreve é o outro. É a heurística automática que a ADR-0046 rejeitou. O mecanismo (a busca por telefone devolve o cadastro mais antigo) é o mesmo para um casal e para dois filhos cadastrados com o telefone da mãe.
4. **Quando o classificador pede para confirmar a identidade, a ação é executada no mesmo turno.** O backend manda a IA perguntar e marca a consulta para o paciente da conversa.
5. O pedido de encaminhar a um humano vindo do eixo de Contact não é lido por ninguém (`ProcessarMensagemUseCase` usa do resultado só o paciente, a ação, o resumo e o pedido de confirmação).

Os itens 1, 3 e 4 têm, cada um, um teste de defeito conhecido que falha (decisão 5, acima). Nenhum foi corrigido: mudam o comportamento do pipeline de IA do WhatsApp, que é da Tarefa 03 e ainda não foi validado contra a Anthropic real. O que deve acontecer em cada caso foi decidido em 08/10/2026 e está na [ADR-0063](./ADR-0063-identidade-confirmada-no-whatsapp.md), com o item de backlog de cada defeito (AD-037 e AD-038).

**Atualização de 09/10/2026 (AD-037 e AD-038, [ADR-0063](./ADR-0063-identidade-confirmada-no-whatsapp.md)):** os itens 1, 3, 4 e 5 foram corrigidos — contato novo se cadastra com nome completo e confirmação explícita e marca a primeira consulta; com dois pacientes no mesmo número ninguém é escolhido e as ações ficam bloqueadas; nada é executado no turno em que a identidade está pendente; e o encaminhamento a um humano vira aviso interno à clínica. O item 2 mudou por decisão: a conversa continua sem criar associações — quem associa é o cadastro concluído pela própria pessoa ou a aprovação de um administrador no painel. Na tabela acima, `Contact.identificar()` e `Contact.vincularAPacienteExistente()` passaram a ter chamador; `createAlreadyLinked()` e `arquivar()` continuam sem.

## Data e fuso horário (levantamento, sem mudança de comportamento)

O que foi verificado no código:

- **Vencimento da cobrança.** O painel envia só a data (`AAAA-MM-DD`); a API grava meia-noite UTC desse dia. O painel mostra a data em UTC, então o dia exibido é o digitado, em qualquer fuso.
- **Em atraso.** A regra é `vencimento <= agora − 24h`. Com o vencimento gravado em meia-noite UTC, a cobrança passa a constar em atraso à meia-noite UTC do dia seguinte — **21h do próprio dia do vencimento, no horário de Brasília**. Entre 21h e meia-noite, a clínica vê em atraso uma cobrança que ainda vence hoje.
- **Disponibilidade.** O motor lê as janelas ("09:00–18:00") no fuso do processo (`getDay`, `setHours`). Nenhum Dockerfile nem compose de `infra/` define `TZ`; a imagem `node:20-bookworm-slim` roda em UTC. **Em homologação ou produção, como está, "09:00" seria 06:00 de Brasília.** Na máquina de desenvolvimento não aparece porque o processo roda em `America/Sao_Paulo`.
- **Resumo de agenda e textos ao paciente.** "Amanhã" nos resumos e os horários escritos nas respostas do WhatsApp (`toLocaleString('pt-BR')`) também seguem o fuso do processo.
- **Testes.** Os de ponta a ponta fixam `America/Sao_Paulo` no backend e no navegador. Todas as suítes rodaram também com o processo em UTC (o fuso do runner do CI), com o mesmo resultado — ver "Evidências".

Nada disso foi alterado. A regra pretendida foi decidida em 08/10/2026 e está na [ADR-0064](./ADR-0064-fuso-horario-por-clinica.md): fuso por clínica, vencimento pelo dia civil da clínica, nada dependente do contêiner. A implementação é a AD-039, pré-requisito do piloto de produção.

## Limitações conhecidas

- **O CI remoto rodou em 09/10/2026.** Com push autorizado, a execução 37977379502 do workflow `CI` executou o commit `1aa507c` no GitHub e passou nos seis jobs: lint, unitários (950 no backend e 180 no frontend), integração (23), críticos (440 aprovados, 4 pulados e 1 `todo`), ponta a ponta (20 de 20) e ensaio de deploy (68 de 68). Os commits da AD-037 e da AD-038, posteriores, **ainda não foram enviados**: para eles vale só a execução local, abaixo. **Atualização de 12/10/2026:** todos os commits da tarefa estão publicados; a execução remota do código final é a 38249354910, no commit `ad05a87` (ver "Fechamento").
- A IA dos testes de Contact é roteirizada. Entrada real da Meta e respostas reais da Anthropic continuam não validadas (Tarefa 03).
- Achados dos testes dos controllers, registrados e não corrigidos: uma cobrança pode ser criada para o paciente X com a sessão do paciente Y da mesma clínica; uma cobrança recusada por `SESSION_ALREADY_BILLED` ainda pode ficar gravada sem sessão; transição de estado inválida responde 500.
- Tela de Assinatura: se o cartão for recusado depois de a assinatura ser criada, repetir o envio responde 409 e a tela não oferece outro caminho para registrar o cartão. As mensagens de erro dessa tela são as cruas da API. Em Configurações, o perfil terapeuta vê os formulários que só o administrador pode salvar (a recusa aparece como "sem permissão").
- ~~`apps/frontend/test/lib/api-client.test.ts` tem 8 erros de tipo sob `tsc --noEmit`.~~ Corrigido na reconciliação final, junto com os 76 dos testes do backend; o CI passou a conferir os tipos dos testes (ver "Reconciliação final").
- `test/integration` continua com um único arquivo e o comentário desatualizado em `vitest.config.ts` (AD-011, não atribuída a esta tarefa). **Atualização de 12/10/2026:** hoje são três arquivos e 42 testes, executados no CI; o comentário desatualizado e o `passWithNoTests` continuam, e a AD-011 segue parcial só por essa formalização.
- O banco local de desenvolvimento ainda tem 32 clínicas de teste de execuções interrompidas em julho, anteriores ao padrão atual. Não foram removidas.

## Decisões tomadas depois desta tarefa (08/10/2026)

As seis questões que esta ADR deixou em aberto foram decididas pelo responsável pelo produto; as de Contact foram confirmadas e detalhadas em 09/10/2026. O texto de cada decisão está na ADR indicada e não é repetido aqui. **Atualização de 09/10/2026: as quatro de Contact foram implementadas (AD-037 e AD-038); as duas de fuso continuam com a implementação pendente (AD-039).**

| Questão levantada aqui | Onde está a decisão | Backlog |
|---|---|---|
| De onde vem o nome do contato novo e se ele é confirmado | ADR-0063, decisão 1 | AD-037 |
| Mais de um paciente no mesmo número | ADR-0063, decisão 2 | AD-038 |
| Ação executada no turno em que o sistema pede confirmação de identidade | ADR-0063, decisão 2 e regra geral da identidade pendente | AD-038 |
| Como a troca de número é confirmada (Cenário 13) | ADR-0063, decisão 3 — aprovação de um usuário autorizado da clínica, pelo painel; a confirmação de quem escreve não basta | AD-038 |
| Corte do atraso | ADR-0064, decisão 3 | AD-039 |
| Fuso dos contêineres | ADR-0064, decisões 1, 2 e 4 | AD-039 |

Cada uma das duas ADRs lista, em "Pontos a confirmar na implementação", o que a decisão não cobre.

## Evidências de validação

Tudo local, em 08/10/2026, no commit `4400c2a` (o último que altera código ou teste; depois dele só documentação). Nenhuma chamada a Meta, Anthropic ou Asaas, nenhum deploy, nenhum push.

| Verificação | Resultado |
|---|---|
| Backend — build e lint | limpos |
| Backend — unitários | 950 passaram (92 arquivos) |
| Backend — integração | 23 passaram |
| Backend — críticos | 442 passaram, 1 pulado e 1 `todo` (os dois anteriores a esta tarefa), em 44 arquivos. Dos 442, três eram `it.fails` (defeitos conhecidos de Contact) — deixaram de contar como aprovados depois, ver abaixo. |
| Frontend — testes, lint e build | 180 passaram (17 arquivos); lint limpo; build com as 14 rotas |
| Ponta a ponta | 20 de 20, pela pilha descartável; nenhum contêiner nem clínica de teste sobrou |
| Imagens e ensaio de deploy | as três imagens construíram com o lockfile novo; `infra/tests/rehearsal.sh` — 68 de 68 |
| As mesmas suítes com o processo em UTC | 950, 23, 442 (+1 pulado, +1 `todo`), 180 e 20 de 20 — iguais |

Antes da tarefa: 926 unitários, 23 de integração, 316 críticos, 155 no frontend, nenhum de ponta a ponta.

**Depois da revisão dos defeitos conhecidos (commit `adb5e85`, 08/10/2026):** os três testes deixaram de contar como aprovados e o cenário do contato novo ganhou uma garantia (só o nome, sem confirmação, não cadastra ninguém). A suíte crítica passou a **440 aprovados, 4 pulados (os três defeitos conhecidos e um anterior) e 1 `todo`**, em 445 testes — o mesmo com o processo em UTC. `test:known-defects` executa os três e **falha nos três**, como esperado. Unitários (950), build e lint do backend conferidos de novo; frontend e testes de ponta a ponta não foram tocados.

**Depois da AD-037 e da AD-038 (09/10/2026, commits `48837ad` (backend), `1794aa5` (painel) e `f8ec0ab` (ponta a ponta); execução local, sem push):** 1067 unitários (93 arquivos), 31 de integração e 474 críticos (1 pulado e 1 `todo`, os dois anteriores a estas tarefas; nenhum defeito conhecido) no backend; 189 no frontend (17 arquivos); 24 de ponta a ponta; build e lint limpos nos dois; as três imagens construídas e o ensaio de deploy em 68 de 68. A suíte crítica passou de 445 para 476 testes: os três defeitos conhecidos deixaram de ser pulados e passam, e o arquivo de Contact foi de 16 para 47 testes, agora com a fila e o worker reais em um Redis próprio (db 12), que termina vazio. Integração foi de 23 para 31. Cada regra nova foi desligada no código, uma por vez, para conferir que o arquivo de Contact falha (9 mutações, todas detectadas; código restaurado). Nenhuma chamada a Meta, Anthropic ou Asaas.

**Depois da correção de integridade da aprovação (09/10/2026, um commit local a mais; execução local, sem push):** 1088 unitários, 42 de integração e 505 críticos (1 pulado e 1 `todo`, os dois antigos; nenhum defeito conhecido) no backend; 189 no frontend; 24 de ponta a ponta; build e lint limpos nos dois; as três imagens construídas e o ensaio de deploy em 68 de 68. A revisão de pré-publicação tinha medido, em um clone descartável, que duas aprovações simultâneas do mesmo contato eram ambas aceitas (12 de 12 rodadas), que a auditoria era gravada fora da transação do vínculo e que uma mensagem concorrente podia desfazer a aprovação; os três pontos foram corrigidos (ADR-0063, "Integridade da aprovação"). Entraram um arquivo crítico de 31 testes (`contact-link-approval-integrity.test.ts`), 11 de integração para a unidade de trabalho e 21 unitários. A concorrência é produzida por sincronização — uma operação parada com a trava na mão até o banco informar que a outra está bloqueada por ela —, não por espera de tempo fixo. Oito proteções foram desligadas no código, uma por vez, e o arquivo falhou em todas (código restaurado). As asserções dos três ex-defeitos conhecidos não mudaram, e `test:known-defects` continua sem encontrar nenhum.

Repetição e isolamento: a suíte crítica inteira rodou duas vezes seguidas (uma em cada fuso) com o mesmo resultado; os testes de ponta a ponta, quando foram escritos, rodaram com 1 e com 4 processos, um arquivo sozinho, um teste sozinho e três vezes cada um (60 de 60), e no fim rodaram mais duas vezes completos; o arquivo de Contact rodou duas vezes sozinho e uma junto com os outros arquivos de WhatsApp, sem deixar nada no banco.

Fuso do contêiner, medido na imagem do backend construída nesta tarefa: o processo roda em `UTC` e a janela "09:00" do motor de disponibilidade cai em `09:00Z`, 06:00 de Brasília.

Segredos: os valores dos `.env` locais foram procurados nos 23 commits ainda não enviados, nos arquivos pendentes e nos relatórios dos testes de ponta a ponta — nenhuma ocorrência; nenhum `.env` é versionado. Um valor local (o token de verificação do webhook) apareceu nos logs de trabalho das suítes, fora do repositório: o teste da verificação do webhook manda o token na query string, como o protocolo da Meta exige, e o exportador de traces de console imprime `url.query` inteiro. Os logs foram limpos. **Fica o achado, não corrigido:** em produção, com traces por OTLP, a verificação do webhook levaria o token de verificação para o serviço de traces.

## Reconciliação final (11/10/2026)

**CI remoto.** Execução 38014320016, commit `9ea04a6`, seis jobs aprovados na primeira tentativa: lint; unitários (1088 no backend e 189 no painel); integração (42); críticos (505, 1 pulado e 1 `todo`); ponta a ponta (24 de 24); ensaio de deploy (68 de 68). O build do painel deixou de depender do Google Fonts (fontes no repositório); o `test-e2e` passou em um runner da mesma região em que tinha falhado. O CD nunca foi executado.

**Itens da tarefa, com o teste correspondente.**

| Item | Onde está o teste | Testes hoje |
|---|---|---|
| AD-012 | `apps/e2e/tests` (agenda, financeiro, sessão, vínculo do WhatsApp), job `test-e2e` | 27 |
| AD-022 | `test/critical/audit-log-read.test.ts` e o unitário do caso de uso | 20 no crítico |
| AD-031 | `apps/frontend/test` | 217, em 19 arquivos |
| AD-032 | `patients-controller`, `appointments-controller` e `cross-clinic-references` | 41, 45 e 5 |
| AD-035 | os quatro arquivos com a fixture dedicada (`clinic-holiday-persistence`, `recurring-block-persistence`, `-materialization`, `-management`) | 8, 3, 7 e 4; nenhuma clínica sobra no banco |
| Contact 11, 12 e 13; AD-037 e AD-038 | `contact-scenarios-real-flow`, `contact-link-approval-integrity` e `apps/e2e/tests/vinculo-whatsapp.spec.ts` | 47, 31 e 4 |

Os Cenários 11 e 12 não têm resolução dentro da conversa: o número compartilhado bloqueia as ações e a equipe atende, por decisão da ADR-0063. O Cenário 13 se resolve pela aprovação de um administrador. A IA de todos esses testes é roteirizada — nada aqui valida a Meta ou a Anthropic reais.

**Erros de tipo nos testes.** A limitação registrada acima falava em 8 erros em um arquivo do painel, e o CHANGELOG em 16 nos testes unitários do backend. A conferência da árvore inteira deu 76 no backend (21 arquivos de teste; nenhum em `src`), 8 no painel (1 arquivo) e nenhum nos testes de ponta a ponta. Eram dublês desatualizados em relação às portas e dublês de classe sem a conversão padrão do projeto; foram corrigidos sem `any`, sem `@ts-ignore`, sem excluir arquivo e sem tocar em asserção. O workflow ganhou o job `typecheck` (`pnpm typecheck`: backend com `src`, `test`, seed e configuração do Vitest; painel; ponta a ponta), que gera o cliente do Prisma antes de conferir. Uma regressão plantada em cada pacote fez o comando falhar.

**Isolamento entre duas sessões na mesma aba do painel.** O teste crítico de "isolamento de cache entre clínicas" segue pulado: trata de cache no servidor, que não existe (`src/infrastructure/cache` vazio; Redis só nas filas e na checagem de prontidão). O cache que existe é o do navegador, e três defeitos foram encontrados e corrigidos nele e no cliente de API:

| Defeito no código publicado | Depois |
|---|---|
| O cache só era limpo no "Sair". Com a sessão encerrada pelo servidor, quem entrasse em seguida recebia os dados da sessão anterior (medido: a clínica B vê os pacientes da clínica A) | O cache é esvaziado sempre que a sessão deixa de ser da mesma clínica, usuário e papel; renovar o token da mesma sessão não o esvazia |
| Uma requisição de A com 401 atrasado era refeita com o token de B | O 401 de uma requisição de outra sessão não renova nem repete nada; vai para quem chamou |
| Uma renovação de A que terminasse depois de A sair devolvia a sessão de A, ou trocava a de B; recusada, derrubava a de B | O resultado de uma renovação só vale se a sessão que a pediu ainda for a do painel |

Segunda linha de defesa: a identidade da sessão faz parte da chave interna de toda consulta do cache, definida em um lugar só (`createQueryClient`), sem alterar os hooks. A resposta de sucesso atrasada não precisou de correção — limpar o cache destrói as consultas — e passou a ter teste. Os testes usam o provider, o guard, o hook e o cliente reais e conferem o cache em si; três testes de ponta a ponta fazem o percurso com duas clínicas na mesma aba: saída pelo botão, sessão encerrada pelo servidor e resposta da primeira entregue só depois de a segunda entrar. Não foi testado: duas abas do mesmo navegador com sessões diferentes (os tokens ficam no `localStorage`, que as abas compartilham). A avaliar como reforço: a API não define `Cache-Control` nas respostas autenticadas — medido, elas levam só o `ETag` padrão do Express. Só o teste da saída pelo botão roda com o cache HTTP do navegador ligado; os outros dois interceptam a rede, e o Playwright desliga esse cache nesse caso.

**O `todo` do agendador.** `automations-scheduler-contract.test.ts` registra um defeito conhecido, não um teste por escrever: com a chave certa, as quatro rotas de automação respondem 500, porque nenhuma camada inicializa a clínica da requisição. Conferido de novo nas quatro. É da Tarefa 04 (`docs/07-Infra/AUTOMACOES_AGENDADOR.md`) e depende de decidir como a chamada identifica a clínica. Não faz parte dos critérios desta tarefa; é exigido antes do piloto se as automações forem usadas.

**Uma falha diagnosticada.** O primeiro teste de `disponibilidade.test.tsx` falhou uma vez em um clone frio, com a tela ainda em "Carregando..." ao fim da espera padrão de 1 s; todos os arquivos do painel levaram cerca de 1,5 vez o tempo habitual naquela execução. Trinta e três execuções seguintes passaram, nos dois commits, e a falha se reproduz fazendo a API responder em 1,5 s. A espera das consultas assíncronas dos testes do painel foi para 3 s; nenhuma asserção mudou.

**Evidências (local, 11/10/2026, commit `880dd4e`, clone limpo, sem `.env`, fuso UTC, na ordem dos jobs do CI).**

| Verificação | Resultado |
|---|---|
| Lint | limpo |
| Tipos (`pnpm typecheck`) | sem erros nos três pacotes |
| Backend — unitários, integração e críticos | 1088; 42; 505 (1 pulado e 1 `todo`, os descritos acima; nenhum defeito conhecido) |
| Painel | 217, em 19 arquivos |
| Ponta a ponta | 27 de 27; nenhum contêiner nem clínica de teste sobrou |
| Imagens e ensaio de deploy | três imagens construídas; 68 de 68 |

**Continua exigido antes do piloto:** AD-039; a execução das automações pelo agendador; as pendências da ADR-0063; a validação de Meta (entrada) e Anthropic reais; os textos de licença das fontes junto com o painel; o token de verificação do webhook nos traces; e os três achados dos controllers listados em "Limitações conhecidas".

## Fechamento (12/10/2026)

**Publicação.** Com push autorizado, os oito commits da reconciliação final foram enviados em 12/10/2026, em um push simples (`9ea04a6..ad05a87`), sem alterar o histórico publicado. A revisão de pré-publicação, só de leitura e sobre esse mesmo commit:
- não encontrou segredo nos oito commits — os valores dos `.env` locais foram comparados com os 46 objetos a enviar e com as mensagens, e gitleaks e trufflehog rodaram sem rede (o que eles apontam no histórico inteiro são valores de teste, já publicados antes);
- repetiu o CI em clone limpo, sem `.env` e em UTC, com as contagens da tabela abaixo;
- conferiu que um erro de tipo plantado em um teste de cada pacote faz o `pnpm typecheck` falhar, no pacote e pela raiz.

**CI remoto.** [Execução 38249354910](https://github.com/nxvzghost/luxora-app/actions/runs/38249354910) do workflow `CI`, commit `ad05a87`, sete jobs aprovados na primeira tentativa, 243 s no total.

| Job | Duração | Resultado |
|---|---|---|
| `lint` | 33 s | limpo |
| `typecheck` | 42 s | sem erros nos três pacotes (primeira execução do job no GitHub) |
| `test-unit` | 84 s | 1088 no backend e 217 no painel |
| `test-integration` | 80 s | 42 |
| `test-critical` | 156 s | 505 aprovados, 1 pulado e 1 `todo` |
| `test-e2e` | 132 s | 27 de 27 |
| `deploy-rehearsal` | 185 s | 68 de 68 |

As contagens são as mesmas da execução local. O CD nunca foi executado e o repositório não tem nenhum deployment. A branch `master` não tem proteção: o CI informa o resultado, não impede a publicação.

**Critérios da tarefa.** Os itens com teste correspondente são os da tabela de "Reconciliação final" e não mudaram: AD-012, AD-022, AD-031, AD-032, AD-035 e os Cenários 11, 12 e 13 de Contact, com a AD-037 e a AD-038. "Pelo menos 1 fluxo E2E real passando em CI": 27 de 27 no GitHub. Os erros de tipo dos testes e os três defeitos de isolamento entre sessões, encontrados na reconciliação, estão corrigidos e agora também executados no CI remoto. `test:known-defects` não encontra nenhum defeito conhecido.

**Pulado e `todo` que continuam abertos.**
- `cache-tenant-isolation.test.ts` (pulado): trata de cache no servidor, que não existe. Tirar o `skip` seria um sucesso artificial; o teste volta a valer se o backend ganhar cache.
- O `todo` de `automations-scheduler-contract.test.ts`: defeito registrado (as quatro rotas de automação respondem 500 com a chave certa), da Tarefa 04, à espera da decisão de como a chamada identifica a clínica.

**Observações da revisão de pré-publicação (registradas, sem mudança de código).**
- `fromAnotherSession`, no cliente de API, trata como a mesma sessão dois tokens diferentes quando algum deles não pode ser lido; o cache, na mesma dúvida, trata como sessões diferentes. Com tokens emitidos pelo backend, que sempre trazem usuário, clínica e papel, o caso não ocorre. Alinhar os dois é um reforço a avaliar.
- Uma requisição da sessão nova que receba 401 enquanto a renovação da sessão anterior ainda está a caminho compartilha essa renovação, que não vale para ela: recebe o 401, sem repetição. Nada de uma sessão chega à outra (há teste para isso); o custo é um erro pontual na tela.
- Duas abas do mesmo navegador com sessões diferentes continuam sem teste. Pela leitura do código, cada aba tem o seu cache em memória e o estado da sessão não é sincronizado entre abas; isso é leitura, não evidência de teste.

**O que a conclusão não significa.** A Tarefa 06 fecha as lacunas de teste que a auditoria listou. Ela não torna o produto pronto para produção, e nenhum dos pontos abaixo fica resolvido por teste com IA roteirizada ou provider simulado:
- **Antes do piloto:** AD-039 (fuso por clínica, ADR-0064); as automações que respondem 500 e a decisão de que dependem; o token de verificação do webhook nos traces; as pendências da ADR-0063 (desfazer um vínculo aprovado; número compartilhado só com atendimento humano; variações de nome e a inferência de que um cadastro existe; estado do paciente — inativo ou com alta — sem efeito sobre o vínculo; classificador de confirmação não exercitado com a Anthropic real); os textos de licença das fontes (`OFL.txt`) junto com o painel e a imagem, antes do primeiro deploy; os três achados dos controllers listados em "Limitações conhecidas".
- **Tarefa 03 (integrações externas), parcial:** entrada da Meta sem validação real; respostas reais da Anthropic não validadas; falha de envio do WhatsApp depois do enfileiramento, que não é tratada nem aparece no painel.
- **Tarefa 04 (deploy e operação), parcial:** sem homologação real nem provedor contratado; CD nunca executado; backup externo e alertas por fazer; branch `master` sem proteção.
- **Segurança, registrado:** tokens no `localStorage` (AD-028) e access token válido por até 15 minutos depois da saída ou da desativação (ADR-0056), riscos aceitos por decisão registrada; `Cache-Control` ausente nas respostas autenticadas, a avaliar; `pnpm audit --prod` com 1 alerta crítico (`proxy-addr`) e 1 alto (`source-map-js`), anteriores a esta tarefa e não corrigidos.

A Tarefa 07 (piloto e produção) não foi iniciada.

## Documentos relacionados

- [ADR-0063](./ADR-0063-identidade-confirmada-no-whatsapp.md) (identidade pelo WhatsApp) e [ADR-0064](./ADR-0064-fuso-horario-por-clinica.md) (fuso por clínica) — as decisões de produto sobre o que esta ADR levantou
- `docs/PLANO_DE_EXECUCAO.md` (Epic 9, Epic 13 e Epic 14 — AD-037, AD-038 e AD-039), `CHANGELOG.md` (Tarefa 06)
- ADR-0045, ADR-0046, ADR-0055 (Contact); ADR-0052 e ADR-0061 (financeiro e painel); ADR-0060 (deploy)
- `docs/04-API/01-Contratos-REST.md`, `docs/04-API/02-Contratos-de-Integracoes-Externas.md` (D5b)
- `docs/09-Testes/02-Dedicated-Fixtures.md`
