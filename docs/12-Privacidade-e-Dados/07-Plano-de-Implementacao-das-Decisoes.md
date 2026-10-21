# 07 — Plano de implementação das decisões do A-14

> **PLANO, NÃO INICIADO.** Preparado em 20/10/2026, à noite, no código de `274151a`, a partir do parecer do responsável pelo produto registrado no [documento 06](./06-Lacunas-Decisoes-e-Fechamento-do-A-14.md), seção 0. Nenhuma linha de código mudou. Cada etapa só começa com autorização; cada commit e cada push pedem autorização própria. O A-14 continua aberto e nenhum documento desta pasta declara conformidade com a LGPD.

## 1. Regras que valem para todas as etapas

- **Uma etapa por vez, na ordem da seção 2.** Cada uma termina num commit local revisado. Publicar exige o gate pré-push completo (réplica do CI em clone limpo, sem `.env`; varredura de segredos; imagens e ensaio de deploy) e autorização.
- **Teste afirma o comportamento correto e falha de verdade sem a mudança.** Cada etapa tem prova por mutação; defeito conhecido não é marcado como aprovado.
- **Nada apaga nem altera dado sem simulação antes e registro depois.** Não existe ambiente real nem clínica real (A-12, A-16): as rotinas rodam no banco de desenvolvimento, no CI e, depois, na homologação.
- **Nenhuma chamada paga sem autorização.** A conferência com o modelo real (etapas 1 e 2) é opcional e separada.
- **Escopo administrativo.** Nenhuma etapa lê, classifica ou filtra conteúdo de saúde; os textos não presumem especialidade (teste `L16 (A-14)`).

## 2. Ordem e dependências

| Etapa | Decisão | Tamanho | Precisa antes | Destrava |
|---|---|---|---|---|
| 1 | D-A — histórico enviado à IA | Pequena | Nada | A frase do aviso completo sobre o que a IA recebe |
| 2 | D-H — aviso de atendimento automatizado | Média (uma migração) | Onde fica o texto completo (link). O uso com paciente real precisa do texto revisado (J-5, J-1, L8) | — |
| 3 | D-G — anonimização por solicitação | Grande | Regra do número compartilhado. A parte da auditoria antiga depende da D-D | As transições de contato que a etapa 4 usa |
| 4 | D-F — retenção de 90 dias | Média | Leitura dos 90 dias (seção 7). Etapa 3, para os contatos já identificados | — |

## 3. Etapa 1 — D-A: 20 mensagens dentro de 72 horas

**Hoje.** `ProcessarMensagemWhatsAppUseCase` lê `findMessagesByConversationId` (sem limite) e manda o histórico inteiro, menos a mensagem atual, nas até três chamadas à IA. A conversa é uma por clínica e telefone, para sempre.

**Mudanças**
- Repositório de conversas: busca nova só para a IA, com corte por tempo (`created_at` maior ou igual a agora menos 72 h), as mais recentes primeiro, limite de 20 mais a mensagem atual, devolvida em ordem cronológica. A mensagem atual continua fora do histórico, como hoje.
- `processar-mensagem-whatsapp.use-case.ts` passa a usar a busca nova. `findMessagesByConversationId` fica como está para a regra de 6 horas da resposta a áudio e imagem (`receber-mensagem-whatsapp.use-case.ts`), que não muda.
- Configuração: `AI_HISTORY_MAX_MESSAGES` (padrão 20) e `AI_HISTORY_MAX_AGE_HOURS` (padrão 72), validadas em `src/shared/env.validation.ts` como inteiros positivos. Valor igual para todas as clínicas.
- Índice em `message (conversation_id, created_at)`: hoje não existe; entra numa migração só de índice, sem mudar dado.
- A janela é em horas absolutas e não depende do fuso da clínica.

**Testes**
- Unitários: corte por quantidade, por tempo e pelos dois; ordem cronológica; mensagem atual fora; conversa vazia; valores lidos da configuração.
- Integração com Postgres: a busca nova devolve exatamente as mensagens esperadas e respeita a RLS.
- Crítico, estendendo o teste `[A-14]` de `whatsapp-inbound-idempotency.test.ts`: conversa com 30 mensagens, cinco delas com mais de 72 h; as chamadas à Anthropic levam no máximo 20 mensagens anteriores e nenhuma com mais de 72 h.
- Crítico, em `contact-scenarios-real-flow.test.ts`: confirmação de cadastro de paciente novo dentro da janela confirma; fora da janela, o sistema pede a confirmação de novo, sem cadastrar.
- A regra de 6 horas da mídia continua igual (teste existente).
- Mutação: sem corte por tempo, sem corte por quantidade e com a ordem invertida, cada uma derruba um teste.

**Documentos depois:** D2 do documento de contratos e a nota de `05-IA/00` como implementadas; inventário (documento 01, seção da IA).

**Pronto quando:** testes e mutação verdes, regressão completa verde. Risco aceito: a IA pode perguntar de novo algo dito há mais de 72 horas.

## 4. Etapa 2 — D-H: aviso fixo na primeira resposta

**Hoje.** Nenhuma mensagem diz que o atendimento é automático. A conversa nasce na primeira mensagem do número (`isNewConversation` em `receber-mensagem-whatsapp.use-case.ts`). As saídas para quem escreve são: a resposta da IA, incluindo a de paciente inativo (`processar-mensagem-whatsapp.use-case.ts`), e a resposta fixa a áudio e imagem (`receber-mensagem-whatsapp.use-case.ts`).

**Mudanças**
- Migração: `conversation.notice_sent_at` (data, nula). O envio fica registrado na conversa, não deduzido do histórico, que a retenção vai apagar.
- Texto num só lugar, por exemplo `use-cases/communication/templates/automated-service-notice.template.ts`, com o nome da clínica e o link. O texto do documento 03 é proposta e muda depois da revisão sem mexer na regra.
- Composição: na primeira saída de uma conversa com `notice_sent_at` nulo, o aviso vai no início da mesma mensagem. `notice_sent_at` é gravado na mesma transação que grava a saída.
- O registro de envios (`message_log`) guarda o texto completo enviado; a mensagem da conversa guarda só a resposta, para o aviso não entrar no histórico da IA.
- O aviso entra antes de a resposta ir para o cache de retomada (`result_payload`), para a retomada do despacho não mandar outro.
- Link: **pendente de revisão**. Se a decisão for uma página por clínica, um campo nas configurações da clínica; se for uma página única, uma variável de ambiente.
- Saída iniciada pela clínica (cobrança e reenvio): fora desta etapa, até a decisão ligada ao A-07.

**Testes**
- Unitários do texto: nome da clínica e link presentes; nenhum termo de especialidade (lista de `support/specialty-terms.ts`); nenhuma promessa que o sistema não cumpre (por exemplo, "a equipe lê todas as mensagens").
- Críticos pelo webhook real, com fila e worker:
  - a primeira mensagem do número leva o aviso e a segunda não;
  - a reentrega da Meta e a retomada do despacho não repetem o aviso;
  - áudio como primeira mensagem leva o aviso junto da resposta fixa, e paciente inativo também;
  - o histórico enviado à Anthropic não contém o aviso;
  - uma clínica nunca marca a conversa de outra.
- Mutação: sem a marcação, o aviso se repete e o teste falha; com a marcação gravada fora da transação, o teste de falha no envio pega.

**Documentos depois:** documento 03 (implementado; texto ainda pendente de revisão), inventário, ADR-0068.

**Uso com paciente real:** só depois da revisão do texto e do link (J-5, J-1, L8) e do fechamento do A-14.

## 5. Etapa 3 — D-G: anonimização por solicitação

**Hoje.** Não há rota de exclusão; o paciente tem só exclusão lógica; nenhuma relação do banco apaga em cascata. `Contact.anonimizar()` só alcança contatos que passaram por `Arquivado`, que só vem de `Novo` e `Conversando`. Paciente não tem anonimização; `patient.phone` e `conversation.phone_number` são obrigatórios no banco.

**Antes de começar:** definir a regra do número compartilhado por mais de um paciente (responsável e dependente, ADR-0063). A conversa desse número tem o texto de mais de uma pessoa. A proposta registrada (apagar o texto da conversa só quando quem pede é o dono do número) não foi aprovada.

**Mudanças**
- **Domínio do contato:** caminho de anonimização a pedido a partir de `Identificado`, `Vinculado` e `Promovido`, separado do caminho de retenção (`Arquivado` → `Descartado`). Atualiza o ciclo de vida em `docs/01-Domain/08-Contact-e-Identidade-de-Comunicacao.md`.
- **Domínio do paciente:** operação nova de anonimização. O nome vira um marcador, e o telefone um marcador que nunca tem formato de telefone. O estado não muda e a exclusão lógica é marcada. Consultas, sessões, cobranças e pagamentos continuam ligados ao mesmo registro, com valores e datas intactos.
- **Caso de uso,** numa única transação, dentro da clínica (RLS):
  - pacientes do pedido;
  - contatos do número, com e sem o nono dígito (A-09);
  - telefone da conversa trocado por um marcador único;
  - texto das mensagens apagado, com as linhas mantidas para contagem e para a idempotência da Meta;
  - no registro de envios, telefone mascarado e texto apagado;
  - cache de resposta limpo;
  - registro novo de auditoria só com identificadores.
- **Registro dos pedidos:** tabela nova com RLS (quem pediu, quando, o que foi feito, quem executou), sem dado pessoal. Serve para reaplicar a anonimização se um backup antigo for restaurado.
- **Comando,** no modelo de `src/cli/provisionar-clinica-piloto.ts`: `--simular` mostra as contagens por tabela sem alterar nada, e a execução exige confirmação explícita. Roda pela Luxora, a pedido da clínica; não há tela no painel.
- **Auditoria antiga:** o nome gravado no `payload` de `ContatoIdentificado` depende da D-D. Até lá, o comando não toca a auditoria antiga e diz isso no resultado.
- **Fora do alcance do comando:** os jobs do Redis expiram em até 14 dias; os backups saem quando vencerem. Os dois ficam no procedimento do documento 05.

**Testes** (críticos, com Postgres e RLS reais)
- Depois do comando, nenhuma coluna de texto da clínica contém o nome ou o telefone, com e sem o nono dígito (varredura em todas as tabelas).
- A mesma pessoa cadastrada em outra clínica fica intacta.
- Totais de cobranças e pagamentos e a agenda iguais antes e depois.
- Rodar duas vezes não muda nada; a simulação não altera nada; uma falha no meio não deixa anonimização parcial.
- Uma reentrega da Meta de mensagem antiga não recria dado; uma mensagem nova do mesmo número cria um contato novo, sem vínculo com o anterior.
- Número compartilhado: conforme a regra aprovada antes da etapa.
- Mutação em cada tabela coberta.

**Documentos depois:** documento 05 (procedimento real), 02, 01, `08-Contact`, roteiro de operação em `docs/07-Infra/`, ADR-0068.

## 6. Etapa 4 — D-F: 90 dias para conversas e contatos

**Hoje.** Os únicos prazos aplicados são os do Redis (24 horas, 7 e 14 dias; cache de sessão de 60 segundos). Não há agendador (A-19).

**Mudanças**
- Comando de retenção por clínica, com `--simular`, que faz duas coisas:
  - apaga o texto das conversas vencidas, conforme a leitura dos 90 dias confirmada (seção 7), mantendo data, direção e status;
  - arquiva e anonimiza os contatos que não viraram pacientes depois de 90 dias sem interação (já existe para `Novo` e `Conversando`; para `Identificado` nunca vinculado, usa o caminho da etapa 3).
- Cada execução fica registrada (quando, quem, contagens por tabela).
- **Fora do comando:**
  - cadastro, agenda, cobranças e pagamentos e auditoria (J-4);
  - backups (A-12);
  - o texto do registro de envios e o cache de resposta (D-C), até a confirmação de cada um.
- No piloto, a execução é manual e mensal, com a simulação antes; o agendador fica para o A-19.

**Testes** (críticos, com relógio controlado)
- Só o que passou de 90 dias é tocado; a conversa ativa segue a leitura confirmada.
- O contato que virou paciente nunca é tocado; financeiro e agenda intactos.
- Isolamento entre clínicas; rodar duas vezes não muda nada; a simulação não altera nada.
- A regra de 6 horas da mídia continua funcionando.
- Mutação: prazo trocado, filtro de clínica removido e estado de contato errado, cada uma derruba um teste.

**Documentos depois:** documento 02 (implementado), 01, 03 (a frase do prazo pode ser publicada), roteiro de operação.

## 7. Pendências que precisam de resposta, e em que etapa

| Pendência | Quem decide | Bloqueia |
|---|---|---|
| Os 90 dias do texto contam **por mensagem** (o texto de cada mensagem sai 90 dias depois de enviado) ou **pela última mensagem da conversa** (sai tudo 90 dias depois da última troca)? Na segunda leitura, uma conversa ativa guarda todo o texto antigo. Recomendação técnica: por mensagem | Responsável pelo produto | Etapa 4 |
| Texto do registro de envios (`message_log`) no mesmo prazo, ficando data, status e final do número | Responsável pelo produto | Parte da etapa 4 |
| Limpeza do cache de resposta (D-C), com a correção da retomada | Responsável pelo produto (tarefa técnica) | Parte da etapa 4 |
| Regra do número compartilhado | Responsável pelo produto | Etapa 3 |
| Pessoa que volta a escrever depois de anonimizada entra como contato novo | Responsável pelo produto | Etapa 3 |
| Nome nos registros antigos da auditoria | D-D | Parte da etapa 3 |
| Onde fica o texto completo do aviso (link) | Responsável pelo produto | Etapa 2 |
| Aviso quando o primeiro contato é uma cobrança enviada pela clínica | Responsável pelo produto, com o A-07 | Fora da etapa 2 |
| Texto final do aviso e do texto completo | Avaliação jurídica (J-5); responsável (J-1); fornecedores (L8) | Uso com paciente real |
| Prazos de cadastro, agenda, financeiro e auditoria | Avaliação jurídica (J-4) | Nenhuma etapa |
| Backups (rotação e cópia externa) | Escolha da hospedagem (A-12) | Nenhuma etapa |

## 8. O que este plano não cobre

D-B, D-D (só a dependência citada), D-E, D-I, L13, a opção "falar só com a equipe", filtragem de conteúdo de saúde (não proposta), agendador (A-19) e templates da Meta (A-07).

## 9. Efeito no fechamento do A-14

Cumprir as quatro etapas atende, no documento 06, seção 3, os critérios do limite do que vai à IA (com a D-B ainda pendente), do aviso enviado (com o texto ainda dependente do J-5), da retenção de conversas e contatos e da exclusão sem operação manual no banco. O A-14 só fecha com os demais critérios: termo com a clínica, textos aprovados pelo jurídico, condições dos fornecedores (L8), auditoria protegida (D-D) e backup externo (A-12).
