# 06 — Lacunas, decisões e fechamento do A-14

> **PENDENTE DE APROVAÇÃO, COM DECISÕES DE PRODUTO REGISTRADAS.** Estado em 20/10/2026, no código publicado em `274151a`. O A-14 **continua aberto**. Em 20/10/2026, à noite, o responsável pelo produto aprovou a D-A, a D-G (opção C) e a D-H (como diretriz) e aprovou parte da D-F (seção 0). A D-A foi implementada em 21/10/2026, com testes, sem push; as outras não. As questões jurídicas e contratuais continuam em aberto, e as demais decisões abaixo não foram tomadas.

## Escopo considerado

O Vertex é administrativo: agenda (marcar, cancelar, remarcar, consultar horários), cobranças e pagamentos, e cadastro básico de pacientes (nome e contato). Não guarda prontuário, laudos, exames nem informação clínica — o banco não tem nenhum campo para isso — e o atendimento clínico é do profissional com o paciente. Cada clínica usa o próprio número de WhatsApp.

O único ponto em que informação de saúde pode entrar é o **texto livre** que o paciente decide escrever no WhatsApp da clínica: o produto não a pede nem a usa, mas o texto é guardado e vai à IA como está. As medidas abaixo são proporcionais a isso: dado administrativo, com esse texto livre como o ponto de atenção.

## 0. Decisões do responsável pelo produto (20/10/2026, noite)

Parecer dado no chat em 20/10/2026, depois da análise das quatro decisões. **Nenhuma está implementada.** O plano de implementação está no [documento 07](./07-Plano-de-Implementacao-das-Decisoes.md); cada etapa, commit e push depende de autorização própria. O que não está na coluna "Aprovado" continua em aberto.

| Decisão | Aprovado | Continua em aberto |
|---|---|---|
| **D-A** — histórico enviado à IA | As últimas **20 mensagens, desde que das últimas 72 horas**, iguais para todas as clínicas no início, ajustáveis por configuração | Nada de produto. **Implementada em 21/10/2026, sem push**; falta conferir com o modelo real |
| **D-F** — retenção | **Parcialmente.** **90 dias** para o texto das conversas e para os contatos que não viraram pacientes (arquivar e anonimizar) | Prazos de cadastro, agenda, cobranças e pagamentos e auditoria: revisão jurídica (J-4). Backups: dependem da hospedagem (A-12). Texto do registro de envios (`message_log`) e limpeza do cache de resposta (D-C): não citados no parecer, ficam a confirmar. Se os 90 dias contam por mensagem ou pela última mensagem da conversa: a confirmar (documento 07, seção 7) |
| **D-G** — exclusão a pedido | **Opção C:** anonimização por solicitação, executada por comando pela Luxora a pedido da clínica, sem tela e sem agendador, testada antes do piloto | Tratamento do número compartilhado por mais de um paciente ("precisa de tratamento cuidadoso"): regra a definir antes da implementação. Pessoa que volta a escrever depois de anonimizada: proposta registrada, a confirmar. Nome nos registros antigos da auditoria: depende da D-D |
| **D-H** — aviso de atendimento automatizado | **Como diretriz:** aviso fixo, enviado pelo código na primeira resposta a cada número, em nome da clínica, explicando o atendimento administrativo automatizado | Texto final e link do texto completo: pendentes de revisão (J-5, J-1, L8). Aviso quando o primeiro contato é uma cobrança enviada pela clínica: ligado ao A-07 |

## 1. Matriz de lacunas

| # | Lacuna | Evidência | Risco | Estado |
|---|---|---|---|---|
| L1 | Histórico inteiro da conversa vai à Anthropic a cada mensagem, sem limite | `prisma-conversation.repository.ts` (sem `take`), `processar-mensagem-whatsapp.use-case.ts` | Exposição maior que a necessária; custo cresce com a conversa | Implementado e testado (D-A, 21/10/2026), sem push |
| L2 | O texto das conversas não tem prazo e pode conter informação de saúde que o paciente decida escrever | `message.content`; nada filtra | Guarda indefinida de texto que o produto não precisa depois do atendimento | Decidido (D-F, 90 dias), não implementado |
| L3 | Nenhum prazo de guarda aplicado fora do Redis | Documento 02 | Acúmulo sem finalidade | Parcialmente decidido (D-F): conversas e contatos sim; cadastro, agenda, financeiro e auditoria dependem do J-4; backups, do A-12 |
| L4 | Sem exclusão, anonimização ou exportação por titular | Nenhuma rota `DELETE`; `anonimizar()` sem chamador | Pedido de titular só atendível no banco, à mão | Decidido (D-G, opção C), não implementado; número compartilhado a definir |
| L5 | Paciente não é informado de atendimento automatizado nem do fornecedor de IA | `system-prompt.builder.ts` | Falta de transparência | Diretriz decidida (D-H), não implementada; texto e link dependem de revisão (J-5) |
| L6 | Painel sem política de privacidade nem termo | Busca no painel | Clínica sem informação formal | Dependente de terceiros (J-5) |
| L7 | Papéis e responsabilidades não formalizados | Documento 04 | Responsabilidade indefinida | Dependente de terceiros (J-1) |
| L8 | Condições de dados da Anthropic e da Meta não verificadas | Nada no repositório | Afirmações sem base no aviso e no termo | Dependente de terceiros |
| L9 | Auditoria imutável só na API; `payload` guarda nome informado | `audit-immutability.test.ts`; `01-app-role.sql`; `ContactIdentifiedEvent` | Trilha alterável por quem tem o banco; dado pessoal numa tabela que não se apaga | Tarefa técnica (D-D) |
| L10 | `result_payload` guarda texto e telefone sem limpeza | `prisma-inbox.repository.ts` | Cópia redundante | Tarefa técnica (D-C) |
| L11 | Backups no disco do servidor, sem rotação nem cópia externa | `deploy.sh`, ADR-0060 | Dado apagado sobrevive; perda do servidor perde tudo | Dependente de A-12 |
| L12 | Terapeuta vê todos os pacientes da clínica | `GET /patients` sem restrição | Acesso a nome e contato acima do necessário, se a clínica não quiser assim | Pode esperar (D-E) |
| L13 | Sem registro de leitura de dados (painel e banco) | Auditoria só registra ações | Sem rastreio de acesso indevido | Pode esperar |
| L14 | Documento de IA afirmava conteúdo "estritamente administrativo" | `05-IA/00-Provedor-e-Interface.md` | Premissa falsa para a avaliação jurídica | **Corrigido** (documento) |
| L15 | Afirmação "telefone e ids não vão à IA" sem teste | — | Regressão silenciosa | **Implementado e testado** (teste `[A-14]`) |
| L16 | Os textos fixos da IA diziam que toda clínica é "de saúde mental" | `anthropic-ai.provider.ts`, `contact-intent-prompt-builder.ts`, `system-prompt.builder.ts` | Pressuposto fora do escopo de clínicas e consultórios em geral | **Implementado e testado** (20/10/2026, sem push; teste `L16 (A-14)`) |

## 2. Pendências, no escopo administrativo

### Decisões de produto necessárias para operar

**D-A — Quanto da conversa vai para a IA (L1, D2 de `02-Contratos-de-Integracoes-Externas.md`).** Hoje vai a conversa inteira. Alternativas: (1) últimas N mensagens; (2) últimas X horas; (3) as duas; (4) resumo. **Recomendação:** (3), com N e X fixados por teste de conversa real na homologação. O corte fica no caso de uso da IA: o repositório também serve à regra da resposta a áudio e imagem (`receber-mensagem-whatsapp.use-case.ts`). **Aprovado em 20/10/2026:** 20 mensagens dentro de 72 horas, iguais para todas as clínicas no início. **Implementado em 21/10/2026** (documento 07, etapa 1). Pendências: conferir com o modelo real; mensagens seguidas do mesmo papel, que já existiam; ordem de mensagens gravadas no mesmo instante.

**D-F — Retenção, reduzida ao que tem volume (L2, L3).** Decidir finalidade e fim (apagar ou anonimizar) de três categorias: texto das conversas, contatos que nunca viraram pacientes e backups. Agenda, financeiro e auditoria esperam o J-4. Não há agendador: no piloto a rotina seria manual, com simulação antes. **Recomendação:** o texto das conversas serve ao agendamento e à cobrança; um prazo curto depois da última mensagem é proporcional, com o prazo decidido por você. **Aprovado em parte em 20/10/2026:** 90 dias para o texto das conversas e para os contatos que não viraram pacientes; agenda, financeiro e auditoria esperam o J-4, e os backups, a hospedagem (A-12). Não implementado (documento 07, etapa 4).

**D-G — Exclusão a pedido no piloto (L4).** (a) piloto sem exclusão, informado no termo e no aviso; (b) anonimização a pedido, testada antes do piloto. **Recomendação:** (b). Correção desta revisão: `Contact.anonimizar()` só alcança contatos em `Novo` ou `Conversando` (passando por `Arquivado`); contatos `Identificado`, `Vinculado` e `Promovido` precisam de transições novas, e paciente não tem anonimização. Agenda e financeiro ficam, ligados ao registro anonimizado. **Aprovado em 20/10/2026:** anonimização por solicitação, executada por comando e testada antes do piloto (opção C da análise). O número compartilhado precisa de regra própria antes da implementação. Não implementado (documento 07, etapa 3).

**D-H — Aviso ao paciente (L5).** Quem avisa (a clínica, conforme o J-1), quando (primeira mensagem de cada contato) e onde fica o texto completo. **Recomendação:** aviso da clínica na primeira mensagem, dizendo que o canal é administrativo e automatizado e pedindo que não se envie informação de saúde, com link. É resposta a mensagem recebida, então não precisa de template da Meta. **Aprovado como diretriz em 20/10/2026:** aviso fixo na primeira resposta, em nome da clínica; texto final e link pendentes de revisão. Não implementado (documento 07, etapa 2).

**Termo com a clínica (documento 04).** Decisões comerciais que entram no termo: métricas que a Luxora faz por conta própria (item 2); devolução, exportação e exclusão no fim do contrato (item 6); duração e fim da cortesia do piloto (item 11; A-16); em que situações a Luxora acessa dados (item 9, D-I); titular da conta na Meta (A-07).

**Textos fixos da IA (L16) — resolvido.** Decidido pelo responsável pelo produto em 20/10/2026: o Vertex atende clínicas e consultórios em geral, e os textos fixos não presumem especialidade. Os três textos passaram a dizer "clínica ou consultório" e "profissionais desta clínica"; o princípio de acolhimento ficou ("pode estar passando por um momento delicado"), sem citar saúde mental. Intents, critério de escalonamento e as regras de agenda, cancelamento, remarcação e cobrança não mudaram. Testes unitários `L16 (A-14)` verificam os três textos contra uma lista de termos de especialidade (`test/unit/use-cases/ai/support/specialty-terms.ts`); voltar qualquer um dos textos antigos derruba o teste. Falta validar o comportamento com o modelo real (chamada com custo, só com autorização).

### Tarefas técnicas

Nenhuma começa sem a sua autorização; as marcadas "depois de" esperam a decisão.

- **D-B — Primeiro nome no resultado do cadastro.** Hoje vai o nome completo ("Cadastro de *nome* realizado"). Troca pequena, com teste crítico.
- **D-C — Limpar o `result_payload`.** Correção desta revisão: `tryClaim` devolve `resume_dispatch` com esse cache também para entradas já `dispatched`, quando o mesmo job chega de novo; apagar só o cache faria o worker falhar. A tarefa é limpar ao despachar **e** tratar a entrada despachada como concluída, com teste de idempotência.
- **D-D — Auditoria protegida no banco e sem nome no `payload` (L9).** Revogar `UPDATE` e `DELETE` em `audit_log` do papel da aplicação; o evento `ContatoIdentificado` passa a referenciar o contato. A tela de Auditoria mostra o `payload` e muda. Decidir o que fazer com os registros antigos.
- **Depois de D-A, D-F, D-G e D-H:** implementar cada uma, com teste crítico e prova por mutação.
- **L11 — Backup externo cifrado com prazo**, depois do provedor (A-12).

### Verificações externas

- **L8 — Condições de dados da Anthropic e da Meta:** ler os termos das contas em uso e registrar no documento 04, seção 3, com fonte e data. Sem custo; pré-requisito do J-3 e do aviso.

### Podem esperar (não impedem operar)

- **D-E — Acesso do terapeuta (L12):** os dados são nome e contato; manter como está, com o modelo descrito no termo, e revisar se a clínica pedir.
- **D-I e L13 — Acesso da Luxora e registro de leitura:** no piloto, acesso só para suporte pedido pela clínica, com registro manual; registro automático depois.
- **Opção "falar só com a equipe"** (documento 03): fora do piloto.

### Questões que dependem de avaliação jurídica

- **J-1** Papéis de clínica e Luxora na LGPD e base legal de cada operação.
- **J-2** Se o cadastro administrativo de pacientes de uma clínica de saúde (nome, contato, agenda) e o texto livre em que o paciente eventualmente mencione saúde exigem o tratamento de dado sensível, e quais medidas são proporcionais.
- **J-3** Transferência internacional (Anthropic, Meta), depois da verificação do L8.
- **J-4** Prazo mínimo de guarda dos registros administrativos e financeiros da clínica que ficam no Vertex (agenda, cobranças, pagamentos). O Vertex não guarda prontuário.
- **J-5** Texto do aviso ao paciente e do termo com a clínica; prazos de resposta a titulares e de comunicação de incidentes; política no painel (L6).

## 3. Critérios para encerrar o A-14

Proposta revista em 20/10/2026 para o escopo administrativo; substitui a lista do commit `884c82f`, que continua no histórico. O A-14 só fecha quando **todos** estiverem em "Concluído". Documento escrito não basta.

| Critério | Estado em 20/10/2026 |
|---|---|
| Inventário dos dados revisado e aceito pelo responsável pelo produto | Implementado, não aprovado (documento 01) |
| Termo com a clínica revisado (J-1, J-5) e assinado, com as decisões comerciais tomadas | Dependente de terceiros e de decisão |
| Aviso ao paciente aprovado e enviado na primeira mensagem (D-H, J-5) | Diretriz decidida; texto e link pendentes de revisão; não implementado |
| Limite do que vai à IA implementado e testado (D-A, D-B) | D-A implementada e testada (21/10/2026, sem push); D-B pendente |
| Corpo da chamada à IA sem telefone e sem identificadores internos | Implementado e testado; falta aprovação do inventário |
| Retenção de conversas, contatos e backups decidida e aplicada (D-F; J-4 para o resto) | Conversas e contatos decididos (90 dias), não aplicados; backups dependem do A-12 |
| Pedido de exclusão atendível sem operação manual no banco (D-G) | Decidido (comando), não implementado |
| Procedimento de titulares e incidentes aprovado, com responsáveis nomeados (documento 05) | Implementado, não aprovado |
| Condições da Anthropic e da Meta registradas e refletidas no aviso e no termo (L8, J-3) | Dependente de terceiros |
| Auditoria protegida no banco e sem nome no `payload` (D-D) | Tarefa técnica pendente |
| Backup externo com prazo definido (L11, A-12) | Dependente de A-12 |

## 4. Impacto nos outros bloqueadores

- **A-12 (homologação):** o provedor escolhido define local dos dados, backup e logs; entra no termo como suboperador. O backup externo é critério deste A-14.
- **A-05 (entrada real da Meta):** o teste com números de teste não exige o A-14 fechado; com paciente real, sim.
- **A-07 (templates da Meta):** o titular da conta da Meta (clínica ou Luxora) muda os papéis do documento 04; o aviso ao paciente, se for enviado como resposta à primeira mensagem, fica dentro da janela de 24 h e não precisa de template; enviado fora dela, precisa.
- **A-16 (entrada da clínica piloto):** o roteiro já cita o aceite de governança como pré-requisito; o termo do documento 04 é esse aceite.
