# 06 — Lacunas, decisões e fechamento do A-14

> **PENDENTE DE APROVAÇÃO.** Estado em 20/10/2026, commit `8730a29` mais as alterações locais desta revisão. O A-14 **continua aberto**.

## 1. Matriz de lacunas

| # | Lacuna | Evidência | Risco | Estado |
|---|---|---|---|---|
| L1 | Histórico inteiro da conversa vai à Anthropic a cada mensagem, sem limite | `prisma-conversation.repository.ts` (sem `take`), `processar-mensagem-whatsapp.use-case.ts` | Exposição maior que a necessária; custo cresce com a conversa | Pendente de decisão (D2) |
| L2 | Texto das conversas pode conter dado de saúde e não tem prazo | `message.content`; nada filtra | Guarda indefinida de dado possivelmente sensível | Pendente de decisão |
| L3 | Nenhum prazo de guarda aplicado fora do Redis | Documento 02 | Acúmulo sem finalidade | Pendente de decisão |
| L4 | Sem exclusão, anonimização ou exportação por titular | Nenhuma rota `DELETE`; `anonimizar()` sem chamador | Pedido de titular só atendível no banco, à mão | Pendente de decisão |
| L5 | Paciente não é informado de atendimento automatizado nem do fornecedor de IA | `system-prompt.builder.ts` | Falta de transparência | Pendente de decisão + jurídico |
| L6 | Painel sem política de privacidade nem termo | Busca no painel | Clínica sem informação formal | Dependente de terceiros (jurídico) |
| L7 | Papéis e responsabilidades não formalizados | Documento 04 | Responsabilidade indefinida | Dependente de terceiros (jurídico) |
| L8 | Condições de dados da Anthropic e da Meta não verificadas | Nada no repositório | Afirmações sem base no aviso e no termo | Dependente de terceiros |
| L9 | Auditoria imutável só na API; `payload` guarda nome informado | `audit-immutability.test.ts`; `01-app-role.sql`; `ContactIdentifiedEvent` | Trilha alterável por quem tem o banco; dado pessoal numa tabela que não se apaga | Pendente de decisão |
| L10 | `result_payload` guarda texto e telefone sem limpeza | `prisma-inbox.repository.ts` | Cópia redundante | Pendente de autorização (limpeza técnica) |
| L11 | Backups no disco do servidor, sem rotação nem cópia externa | `deploy.sh`, ADR-0060 | Dado apagado sobrevive; perda do servidor perde tudo | Dependente de A-12 |
| L12 | Terapeuta vê todos os pacientes da clínica | `GET /patients` sem restrição | Acesso acima do necessário, se a clínica não quiser assim | Pendente de decisão |
| L13 | Sem registro de leitura de dados (painel e banco) | Auditoria só registra ações | Sem rastreio de acesso indevido | Pendente de decisão |
| L14 | Documento de IA afirmava conteúdo "estritamente administrativo" | `05-IA/00-Provedor-e-Interface.md` | Premissa falsa para a avaliação jurídica | **Corrigido** nesta revisão (documento) |
| L15 | Afirmação "telefone e ids não vão à IA" sem teste | — | Regressão silenciosa | **Implementado e testado** nesta revisão (teste `[A-14]`) |

## 2. Decisões que dependem do responsável pelo produto

### Técnicas

**D-A — Quanto da conversa vai para a IA (L1, D2 do documento de contratos)**
- Hoje: a conversa inteira.
- Alternativas: (1) últimas N mensagens; (2) mensagens das últimas X horas; (3) as duas combinadas; (4) resumo da conversa (mais uma chamada de IA, risco de distorcer).
- Riscos: cortar demais faz a secretária "esquecer" o que foi dito (por exemplo, o nome completo pedido duas mensagens antes).
- **Recomendação:** (3), N e X decididos com teste de conversa real na homologação; é a recomendação técnica já registrada em `02-Contratos-de-Integracoes-Externas.md`. Mudança pequena e testável.

**D-B — Nome do paciente nas mensagens à IA**
- Hoje: o nome completo vai no resultado do cadastro feito pela conversa; o nome do paciente reconhecido **não** vai (provado pelo teste `[A-14]`). O padrão de conversa 1 pede usar o primeiro nome "quando conhecido".
- Alternativas: manter; trocar o resultado do cadastro por "Cadastro realizado"; enviar só o primeiro nome.
- **Recomendação:** enviar só o primeiro nome no resultado do cadastro. Atende o tom de voz com menos dado.

**D-C — Limpeza do cache de resposta (L10)**
- **Recomendação:** apagar `result_payload` quando a entrada chega a `dispatched`. É cache técnico (ADR-0054); não muda nada que a clínica veja. Precisa de autorização por mexer no fluxo de idempotência.

**D-D — Auditoria (L9)**
- Alternativas: (1) tornar `audit_log` imutável no banco (revogar `UPDATE` e `DELETE` do papel da aplicação); (2) parar de gravar nome no `payload` (referência ao contato); (3) as duas.
- **Recomendação:** (3). Mas a (1) torna impossível anonimizar registros antigos sem superusuário: decidir junto com a política de exclusão.

**D-E — Acesso do terapeuta (L12)**
- Alternativas: manter todos os pacientes da clínica; restringir aos pacientes com consulta com ele.
- **Recomendação:** perguntar à clínica piloto como trabalha. Restringir muda telas e testes; não é necessário para o piloto se a clínica aceitar o modelo atual por escrito.

### De produto e comerciais

**D-F — Retenção por categoria (L2, L3)** — documento 02, seção 2. **Recomendação:** decidir primeiro conversas, contatos nunca qualificados e backups, que são as categorias de maior volume e sem obrigação aparente; financeiro e auditoria esperam a avaliação jurídica.

**D-G — Exclusão no piloto (L4)** — (a) piloto sem exclusão, informado no termo e no aviso; (b) rotina de anonimização testada antes do piloto. **Recomendação:** (b) para contatos nunca qualificados e para paciente a pedido, sem agendador; o código de anonimização do contato já existe.

**D-H — Transparência ao paciente (L5)** — onde e quando o aviso aparece (documento 03, seção 2). **Recomendação:** mensagem curta na primeira mensagem de cada contato, com link; depende do texto aprovado pelo jurídico.

**D-I — Acesso da Luxora aos dados** — em que situações a equipe da Luxora pode olhar dados de pacientes e como registrar. **Recomendação:** só para suporte pedido pela clínica, com registro manual até existir registro automático.

### Jurídicas (dependem de avaliação externa)

- **J-1** Papéis de clínica e Luxora na LGPD e base legal de cada operação.
- **J-2** Se o fato de alguém ser paciente de clínica de saúde mental, e o texto das conversas, são dado sensível, e o que isso exige.
- **J-3** Transferência internacional (Anthropic, Meta).
- **J-4** Deveres de guarda da clínica que alcancem agenda, financeiro, conversas e auditoria.
- **J-5** Texto do aviso ao paciente, do termo com a clínica e prazos de resposta a titulares e de comunicação de incidentes.

## 3. Critérios para encerrar o A-14

O A-14 só fecha quando **todos** os itens estiverem em "Concluído". Documento escrito não basta.

| Critério | Estado em 20/10/2026 |
|---|---|
| Inventário dos dados revisado e aceito pelo responsável pelo produto | Implementado, não aprovado (documento 01) |
| Papéis e finalidades formalizados (J-1) | Dependente de terceiros |
| Política de retenção e exclusão aprovada (D-F, D-G, J-4) | Pendente de decisão |
| Controles de retenção e exclusão implementados e testados conforme a política | Não iniciado (depende da política) |
| Limite do que vai à IA decidido e implementado (D-A, D-B) | Pendente de decisão |
| Corpo da chamada à IA sem telefone e sem identificadores internos | Implementado e testado; falta aprovação do inventário |
| Aviso ao paciente aprovado e exibido (D-H, J-5) | Pendente de decisão + jurídico |
| Termo entre clínica e Luxora revisado e assinado (J-1 a J-5) | Dependente de terceiros |
| Condições da Anthropic e da Meta verificadas e refletidas no aviso e no termo (L8) | Dependente de terceiros |
| Procedimento de titulares e incidentes aprovado, com responsáveis nomeados | Implementado, não aprovado (documento 05) |
| Backup externo com prazo definido (A-12) | Dependente de A-12 |
| Auditoria: decisão D-D aplicada | Pendente de decisão |

## 4. Impacto nos outros bloqueadores

- **A-12 (homologação):** o provedor escolhido define local dos dados, backup e logs; entra no termo como suboperador. O backup externo é critério deste A-14.
- **A-05 (entrada real da Meta):** o teste com números de teste não exige o A-14 fechado; com paciente real, sim.
- **A-07 (templates da Meta):** o modelo de contas da Meta (da clínica ou da Luxora) muda os papéis do documento 04; o aviso curto ao paciente, se for enviado fora da janela de 24 h, também precisa de template.
- **A-16 (entrada da clínica piloto):** o roteiro já cita o aceite de governança como pré-requisito; o termo do documento 04 é esse aceite.
