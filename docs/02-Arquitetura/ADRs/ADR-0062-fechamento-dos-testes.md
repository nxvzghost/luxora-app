# ADR-0062 — Fechamento dos testes: ponta a ponta em pilha descartável, referências entre clínicas recusadas e defeitos conhecidos presos por teste

**Status:** ADOTADO
**Origem:** Tarefa 06 da auditoria técnica de 04/10/2026 (Fechamento dos testes; Epic 13 — AD-012, AD-022, AD-031, AD-032, AD-035 — e os Cenários 11, 12 e 13 de Contact, do Epic 9).
**Data:** 8 de outubro de 2026
**Veredito da Tarefa 06: PARCIAL.** Faltam a execução no CI remoto (depende de um push autorizado) e o tratamento das pendências reais que a tarefa revelou — AD-037 e AD-038 (Contact) e, antes do piloto de produção, AD-039 (fuso). As decisões de produto sobre elas foram tomadas em 08/10/2026 (ADR-0063 e ADR-0064); registrar a decisão não conclui a tarefa.

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

Cada um confere só um fato colhido antes, para que um erro de preparação não se confunda com o defeito. Hoje são três, todos em `test/critical/contact-scenarios-real-flow.test.ts`: um da AD-037 e dois da AD-038.

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

## Data e fuso horário (levantamento, sem mudança de comportamento)

O que foi verificado no código:

- **Vencimento da cobrança.** O painel envia só a data (`AAAA-MM-DD`); a API grava meia-noite UTC desse dia. O painel mostra a data em UTC, então o dia exibido é o digitado, em qualquer fuso.
- **Em atraso.** A regra é `vencimento <= agora − 24h`. Com o vencimento gravado em meia-noite UTC, a cobrança passa a constar em atraso à meia-noite UTC do dia seguinte — **21h do próprio dia do vencimento, no horário de Brasília**. Entre 21h e meia-noite, a clínica vê em atraso uma cobrança que ainda vence hoje.
- **Disponibilidade.** O motor lê as janelas ("09:00–18:00") no fuso do processo (`getDay`, `setHours`). Nenhum Dockerfile nem compose de `infra/` define `TZ`; a imagem `node:20-bookworm-slim` roda em UTC. **Em homologação ou produção, como está, "09:00" seria 06:00 de Brasília.** Na máquina de desenvolvimento não aparece porque o processo roda em `America/Sao_Paulo`.
- **Resumo de agenda e textos ao paciente.** "Amanhã" nos resumos e os horários escritos nas respostas do WhatsApp (`toLocaleString('pt-BR')`) também seguem o fuso do processo.
- **Testes.** Os de ponta a ponta fixam `America/Sao_Paulo` no backend e no navegador. Todas as suítes rodaram também com o processo em UTC (o fuso do runner do CI), com o mesmo resultado — ver "Evidências".

Nada disso foi alterado. A regra pretendida foi decidida em 08/10/2026 e está na [ADR-0064](./ADR-0064-fuso-horario-por-clinica.md): fuso por clínica, vencimento pelo dia civil da clínica, nada dependente do contêiner. A implementação é a AD-039, pré-requisito do piloto de produção.

## Limitações conhecidas

- **O CI remoto não rodou com estas mudanças.** O job `test-e2e` foi escrito e validado localmente (o mesmo script, `actionlint` e `shellcheck` limpos); a execução no GitHub depende de um push, que não foi autorizado nesta tarefa.
- A IA dos testes de Contact é roteirizada. Entrada real da Meta e respostas reais da Anthropic continuam não validadas (Tarefa 03).
- Achados dos testes dos controllers, registrados e não corrigidos: uma cobrança pode ser criada para o paciente X com a sessão do paciente Y da mesma clínica; uma cobrança recusada por `SESSION_ALREADY_BILLED` ainda pode ficar gravada sem sessão; transição de estado inválida responde 500.
- Tela de Assinatura: se o cartão for recusado depois de a assinatura ser criada, repetir o envio responde 409 e a tela não oferece outro caminho para registrar o cartão. As mensagens de erro dessa tela são as cruas da API. Em Configurações, o perfil terapeuta vê os formulários que só o administrador pode salvar (a recusa aparece como "sem permissão").
- `apps/frontend/test/lib/api-client.test.ts` tem 8 erros de tipo sob `tsc --noEmit` (anteriores a esta tarefa; nenhum job roda esse comando e os testes passam).
- `test/integration` continua com um único arquivo e o comentário desatualizado em `vitest.config.ts` (AD-011, não atribuída a esta tarefa).
- O banco local de desenvolvimento ainda tem 32 clínicas de teste de execuções interrompidas em julho, anteriores ao padrão atual. Não foram removidas.

## Decisões tomadas depois desta tarefa (08/10/2026)

As seis questões que esta ADR deixou em aberto foram decididas pelo responsável pelo produto. O texto de cada decisão está na ADR indicada e não é repetido aqui. **Todas estão com a implementação pendente.**

| Questão levantada aqui | Onde está a decisão | Backlog |
|---|---|---|
| De onde vem o nome do contato novo e se ele é confirmado | ADR-0063, decisão 1 | AD-037 |
| Mais de um paciente no mesmo número | ADR-0063, decisão 2 | AD-038 |
| Ação executada no turno em que o sistema pede confirmação de identidade | ADR-0063, decisões 1 e 2 | AD-038 |
| Como a troca de número é confirmada (Cenário 13) | ADR-0063, decisão 1 — com um ponto ainda a confirmar (o que basta como confirmação) | AD-038 |
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

Repetição e isolamento: a suíte crítica inteira rodou duas vezes seguidas (uma em cada fuso) com o mesmo resultado; os testes de ponta a ponta, quando foram escritos, rodaram com 1 e com 4 processos, um arquivo sozinho, um teste sozinho e três vezes cada um (60 de 60), e no fim rodaram mais duas vezes completos; o arquivo de Contact rodou duas vezes sozinho e uma junto com os outros arquivos de WhatsApp, sem deixar nada no banco.

Fuso do contêiner, medido na imagem do backend construída nesta tarefa: o processo roda em `UTC` e a janela "09:00" do motor de disponibilidade cai em `09:00Z`, 06:00 de Brasília.

Segredos: os valores dos `.env` locais foram procurados nos 23 commits ainda não enviados, nos arquivos pendentes e nos relatórios dos testes de ponta a ponta — nenhuma ocorrência; nenhum `.env` é versionado. Um valor local (o token de verificação do webhook) apareceu nos logs de trabalho das suítes, fora do repositório: o teste da verificação do webhook manda o token na query string, como o protocolo da Meta exige, e o exportador de traces de console imprime `url.query` inteiro. Os logs foram limpos. **Fica o achado, não corrigido:** em produção, com traces por OTLP, a verificação do webhook levaria o token de verificação para o serviço de traces.

## Documentos relacionados

- [ADR-0063](./ADR-0063-identidade-confirmada-no-whatsapp.md) (identidade pelo WhatsApp) e [ADR-0064](./ADR-0064-fuso-horario-por-clinica.md) (fuso por clínica) — as decisões de produto sobre o que esta ADR levantou
- `docs/PLANO_DE_EXECUCAO.md` (Epic 9, Epic 13 e Epic 14 — AD-037, AD-038 e AD-039), `CHANGELOG.md` (Tarefa 06)
- ADR-0045, ADR-0046, ADR-0055 (Contact); ADR-0052 e ADR-0061 (financeiro e painel); ADR-0060 (deploy)
- `docs/04-API/01-Contratos-REST.md`, `docs/04-API/02-Contratos-de-Integracoes-Externas.md` (D5b)
- `docs/09-Testes/02-Dedicated-Fixtures.md`
