# ADR-0061 — Painel operável: proteção de rota sem middleware, leitura aditiva na API e estado financeiro fiel ao pagamento

**Status:** ADOTADO
**Origem:** Tarefa 05 da auditoria técnica de 04/10/2026 (Frontend operável; Epic 10, AD-020 e AD-028).
**Data:** 8 de outubro de 2026

## Objetivo

Uma clínica piloto percorre o ciclo principal — configurar, agendar, cobrar, receber, estornar — pelo painel, sem chamar a API à mão, e sem que a tela mostre um estado financeiro ou operacional que não é verdade.

## Auditoria prévia (achados confirmados)

- **O painel não fechava o ciclo.** Havia login, listas, cadastro de paciente e de terapeuta, configurações da clínica, assinatura e quatro ações sobre agenda e cobrança (confirmar e cancelar consulta, enviar cobrança, registrar pagamento). Não havia como sair, definir disponibilidade, marcar ou remarcar consulta, criar cobrança, estornar, gerenciar usuários, conectar o WhatsApp nem ler notificações.
- **Duas ações eram impossíveis por falta de leitura na API**, não de tela: não existia rota para descobrir as sessões a cobrar nem para chegar ao pagamento de uma cobrança (registrado em `billing.hooks.ts` desde 13/08/2026).
- **Sessão encerrada pelo servidor caía no login sem explicação**, e não havia botão de sair.
- **Não existe `middleware.ts`** (AD-028). A proteção de rota do painel é o `AuthGuard`, no cliente.

Achados que só apareceram ao percorrer o painel contra a API real, todos corrigidos nesta tarefa:

1. Pagar uma cobrança já enviada respondia 500 e deixava um pagamento confirmado sem cobrança quitada: a máquina de estados não previa `Enviada → Quitada`.
2. Sem WhatsApp conectado, enviar a cobrança a marcava como `Enviada`; o envio só falhava depois, no worker da fila, em definitivo e sem aviso. Como `Enviada` não volta para `Criada`, aquela cobrança não podia mais ser enviada.
3. Depois de um estorno, o painel continuava somando o valor como recebido.
4. `GET /patients` e `GET /billings` devolvem 20 itens por página e o painel pedia só a primeira: o 21º paciente não aparecia nos seletores, e os totais do Financeiro somavam só as 20 cobranças mais recentes.
5. A tela de disponibilidade acusava "alterações não salvas" logo depois de salvar: comparava o JSON enviado com o lido, e o Postgres (`jsonb`) devolve as chaves em outra ordem.

## Decisão

**Sem `middleware.ts`.** Os tokens ficam no `localStorage` (AD-013), que um middleware do Next não lê — ele roda no servidor e só enxerga cookies. Implementá-lo exigiria mover a sessão para cookie e o backend passar a emiti-lo, com proteção contra CSRF: uma mudança na arquitetura de autenticação, fora do que esta tarefa justifica. A proteção fica em duas camadas que já existiam: a API recusa toda requisição sem access token válido (`JwtAuthGuard`), e o `AuthGuard` do painel manda ao login quem não tem sessão. O critério original da AD-028 ("`middleware.ts` bloqueia rota protegida sem token válido") continua **não atendido como foi escrito**; o que ele protegeria — dado da clínica — nunca sai da API sem token válido.

**Sessão.** Um 401 em requisição autenticada dispara uma única renovação, compartilhada por todas as requisições em voo, e cada uma é repetida uma vez (ADR-0056). Quando o servidor recusa a renovação, a sessão local é encerrada e o login explica que ela foi encerrada. "Sair" encerra a sessão local primeiro e depois pede a revogação ao servidor; falha de rede nessa segunda parte não mantém ninguém logado. Só os dois tokens são persistidos.

**O papel na interface é conveniência; a autoridade é a API.** O painel lê o papel do access token para esconder o que aquele perfil não pode fazer. Nenhuma regra de acesso foi movida para o cliente e nenhuma rota foi afrouxada.

**Leitura aditiva na API, só onde o painel não tinha como operar.** Nenhuma rota existente mudou de forma:

| Rota | Para quê |
|---|---|
| `GET /sessions?state=&patientId=&limit=` | Descobrir as sessões a cobrar |
| `GET /billings/:id/payments` | Chegar ao pagamento de uma cobrança (estado e estorno) |
| `GET /therapists/:id/availability/calendar` | Ler janelas e exceções gravadas, para editar |
| `GET /billings` — campo novo `paymentState` | Mostrar que o pagamento foi estornado ou está divergente |

**Cobrança enviada pode ser quitada.** `Enviada → Quitada` entrou na máquina de estados da cobrança. É o caminho normal pela tela: gerar, enviar, receber.

**Enviar exige canal conectado.** `EnviarCobrancaUseCase` consulta se a clínica tem WhatsApp conectado e ativo antes de enfileirar; sem canal, responde 409 `WHATSAPP_NOT_CONNECTED` e a cobrança continua em `Criada`. É a mesma condição que o provider aplica na hora do envio, verificada antes. Nenhuma chamada externa é feita para isso, e a credencial não é testada.

**O estorno não reabre a cobrança — e a tela não esconde isso.** A [ADR-0052](./ADR-0052-fechamento-ciclo-financeiro-sessao-faturada-recebida.md) deixou a reversão financeira fora de escopo, como decisão de produto própria; isso não mudou. O que mudou é a leitura: com `paymentState` na lista, o painel mostra "Pagamento estornado" no lugar de "Quitada" e não soma o valor como recebido.

**O painel busca a lista inteira.** Pacientes e cobranças são lidos página a página, pelo cursor que a API já oferecia, até vir uma página incompleta. Uma falha no meio rejeita a busca em vez de entregar uma lista parcial.

**Ação que não se desfaz pede um segundo passo.** Cancelar consulta, enviar cobrança, estornar, registrar pagamento de valor diferente do cobrado, desativar usuário e remover exceção de disponibilidade passam por confirmação com o efeito escrito por extenso.

## Alternativas descartadas

- **Sessão em cookie `httpOnly` com `middleware.ts`.** É a forma de atender a AD-028 como escrita e reduz a exposição do token a XSS. Muda login, renovação, CORS e exige defesa contra CSRF. Fica como decisão de segurança própria, não como efeito colateral de uma tarefa de interface.
- **Reabrir a cobrança no estorno.** Mexe em `Billing`, `Payment` e `Session` juntos e depende de regra de produto (a sessão volta a ser cobrável? a cobrança volta a `Pendente`?). Excluída explicitamente pela ADR-0052.
- **Buscar o pagamento de cada cobrança pelo painel** (uma requisição por cobrança quitada). Funcionaria sem tocar a API, ao custo de dezenas de requisições por abertura da tela.
- **Avisar no painel quando o envio falha depois de enfileirado** (token recusado pela Meta, por exemplo). O ponto certo é o worker da fila de saída, que pertence à Tarefa 03 e só pode ser validado com a integração real. Registrado como pendência dela.

## Limitações conhecidas

Do backend, não resolvidas aqui:

- **Nenhum fluxo marca uma cobrança como `Atrasada`.** O estado existe na máquina de estados, e tanto o Financeiro quanto `GET /dashboard/summary` contam "cobranças em atraso" por ele (regra de `06-UX/02-Fluxo-Dashboard.md`, travada pelo teste crítico `dashboard-summary.test.ts`). Mas nenhum caso de uso faz essa transição quando o vencimento passa: **os dois contadores ficam sempre em zero**, mesmo com cobranças vencidas. Corrigir é decidir como uma cobrança vence — um job que muda o estado, ou uma contagem derivada do vencimento — e mexe num contrato coberto por teste. Achado desta tarefa; registrado, não corrigido.
- **Falha de envio depois do enfileiramento não aparece no painel.** Com canal conectado, se a Meta recusar o envio, a cobrança continua `Enviada` e o único rastro é o job falhado no Redis (já descrito em `04-API/02-Contratos-de-Integracoes-Externas.md`). Pendência da Tarefa 03.
- **O estorno é um fim de linha.** A cobrança estornada não aceita outro pagamento (`payment.billing_id` é único) e a sessão não volta a ser cobrável. Cobrar de novo depende da decisão de produto da ADR-0052.
- **Pagamento divergente não tem correção.** A máquina de estados prevê a reconferência (`Divergente → Confirmado`), mas nenhuma rota a executa. A cobrança fica em aberto e não aceita outro pagamento. O painel pede confirmação antes de registrar um valor diferente e avisa disso.
- **Conectar o WhatsApp não confere a credencial com a Meta**, e não há rota que diga se a clínica já está conectada: a tela de Configurações não consegue mostrar o estado do canal.
- **Feriados da clínica não têm rota.** São descontados dos horários livres, mas não podem ser cadastrados pelo painel.
- **O access token já emitido vale até expirar** (15 minutos por padrão) depois de sair ou de o usuário ser desativado (ADR-0056). A tela de desativação informa isso.
- **Usuário desativado recebe "Credenciais inválidas" ao tentar entrar**, a mesma resposta de senha errada. É como a API responde; não foi alterado.
- **Transição de estado inválida responde 500**, não 409, e `EnviarCobrancaUseCase` enfileira a mensagem antes de validar a transição: chamar o envio pela API numa cobrança que não está em `Criada` enfileira e depois falha. O painel só oferece o envio em `Criada`.
- **Registrar pagamento não é atômico**: o pagamento é gravado antes da quitação da cobrança (sem unidade de trabalho).

Rotas que a API tem e o painel ainda não usa: `PATCH /users/:id` (trocar papel), `PATCH /therapists/:id`, `PATCH /patients/:id` e inativar, reativar e dar alta a paciente, `POST /appointments/recurring` (os horários fixos, por `recurring-blocks`, estão na tela), `PATCH /clinic`. A criação da clínica e do primeiro administrador (`POST /users/bootstrap-admin`) continua sendo passo de operador.

Do painel:

- Os totais do Financeiro são somados no navegador, sobre a lista inteira; a busca para em 10.000 itens.
- A tela de Notificações mostra as 50 mais recentes, sem paginação.
- Não há teste de ponta a ponta em navegador automatizado; isso é da Tarefa 06.
- `test/lib/api-client.test.ts` tem 8 erros de tipo antigos (`error` como `unknown`), que nenhum script verifica.

## Evidências de validação

**Percurso pelo painel, contra a API e o Postgres locais** (07 e 08/10/2026; backend e painel em portas próprias, Redis em banco lógico separado, chaves da Anthropic e da Asaas vazias no processo; nenhuma chamada externa, nenhum custo):

- Entrar como administrador e como terapeuta; menu e ações conforme o papel; `/usuarios` recusado ao terapeuta.
- Disponibilidade: gravar um horário de atendimento e ver os horários livres resultantes.
- Agenda: marcar, remarcar, confirmar e cancelar; horário ocupado não é oferecido.
- Financeiro: criar cobrança a partir da sessão, enviar, registrar pagamento (cobrança quitada), estornar em dois passos; pagamento de valor diferente fica divergente e gera notificação.
- Notificações: lista, contador e "marcar como lida".
- Usuários: criar, desativar e reativar.
- WhatsApp: identificador inválido barrado na tela; conexão gravada com dados fictícios (o registro foi removido em seguida).
- Sessão: com o access token invalidado, quatro requisições receberam 401, houve uma renovação e as quatro foram repetidas com sucesso. Depois de "Sair", o refresh token antigo passou a ser recusado. Com o usuário desativado, a renovação foi recusada e o painel foi ao login com o aviso de sessão encerrada; a tentativa de entrar foi recusada; reativado, voltou a entrar.
- Depois das correções: cobrança estornada aparece como "Pagamento estornado" e sai do recebido; envio sem canal é recusado e a cobrança continua `Criada`; a paginação por cursor da API foi conferida com páginas de 2 itens.

Não foram percorridos ao vivo, só em teste automatizado: o segundo passo do pagamento divergente, a criação de exceção e de horário fixo, e listas com mais de 100 itens.

**Testes automatizados.** Números no `CHANGELOG.md`, entrada da Tarefa 05.

## Documentos relacionados

- `docs/PLANO_DE_EXECUCAO.md` — Epic 10 (AD-020, AD-028).
- [ADR-0052](./ADR-0052-fechamento-ciclo-financeiro-sessao-faturada-recebida.md) — ciclo financeiro; reversão fora de escopo.
- [ADR-0056](./ADR-0056-sessao-revogavel-token-version.md) — sessão revogável e renovação.
- `docs/04-API/01-Contratos-REST.md` — rotas e campos acrescentados.
- `docs/04-API/02-Contratos-de-Integracoes-Externas.md` — fila de saída do WhatsApp e seus limites.
