# PD-004 — Análise de Valor Comercial: qual integração justifica o Enterprise?

## Origem e método

Complementa `01-Analise-Arquitetural.md` (que respondeu "o que é mais
simples e seguro"). Esta análise responde uma pergunta diferente: **o que
faz um cliente contratar ou permanecer no Enterprise?** — decisão de
produto, não de engenharia.

Antes de avaliar cada candidato, li o que a própria Luxora já documentou
sobre seu cliente e seus concorrentes, para não especular:
`01 - CEO/04 - ICP/MODELO.md`, `01 - CEO/07 - Planos e precificacao/PROCESSO.md`,
`01 - CEO/11 - Concorrentes/03-Concorrentes-Diretos.md` e
`04-Concorrentes-Indiretos.md`.

## Duas evidências que mudam a pergunta

Antes da matriz, dois achados reais que preciso reportar com honestidade,
porque afetam a confiabilidade de qualquer recomendação abaixo:

### 1. O ICP documentado não é "rede de clínicas"

`04 - ICP/MODELO.md` remete ao PRD técnico: **"perfil de terapeuta
autônomo/clínica pequena"**. O próprio Enterprise (PD-005/plan-benefits)
foi desenhado como "até 5 terapeutas, por clínica" — não como um plano de
grande rede. Isso importa porque ERP, CRM e BI corporativos são
tipicamente ferramentas de organizações maiores do que o perfil real hoje
documentado como cliente-alvo da Luxora. Não invalida a pergunta, mas
significa que a resposta mais provável não é "qual ERP gigante a Luxora
precisa alimentar" — é "qual ferramenta pessoal/pequena o terapeuta
autônomo ou pequena equipe já usa e não quer abandonar".

### 2. A própria Luxora já documentou o que vende o Enterprise — e não é uma feature técnica

`07 - Planos e precificacao/PROCESSO.md`, seção "Por que R$ 2.990" (hoje
R$ 2.490), é explícito: *"Você não está vendendo software. Você está
vendendo tempo do fundador."* O valor declarado do Enterprise é
implantação personalizada, consultoria semanal, atenção — não uma lista de
integrações técnicas. **Preciso ser honesto sobre isso:** nenhum endpoint
de API, por si só, é o que a própria liderança já registrou como a razão
de alguém pagar Enterprise. O que esta análise pode responder é qual
integração **reforça** essa proposta (ou a contradiz, entregando de graça
por API algo que deveria vir dentro do serviço de alto contato).

### 3. Nenhum concorrente pesquisado usa API pública como diferencial de venda

Nenhum dos 5 concorrentes diretos documentados (PsicoManager, ElloTools,
GestorPsi, Clínica Ágil, Amplimed) menciona API de integração como parte
do posicionamento comercial deles. O que a pesquisa de concorrência
identifica como diferencial real da Luxora é **IA conversacional como
interface central** e o **Motor Operacional configurável por política de
clínica** — nenhum dos dois é "ter uma API". Isso não desqualifica a
iniciativa, mas significa que o valor competitivo de expor um endpoint
está em **quanto ele carrega esse diferencial junto** (dado já validado
pelo Motor, por exemplo), não no fato de existir uma API.

## Candidatos — valor comercial, perfil, frequência, impacto financeiro, diferencial

### Agenda

- **Valor comercial:** médio-alto. Elimina redigitar horários manualmente em outra ferramenta (Google Calendar pessoal, agenda de papel, planilha — exatamente os "concorrentes indiretos" documentados como o hábito real que a Luxora precisa vencer). Tempo economizado: baixo-médio por evento, mas frequente.
- **Perfil do cliente:** terapeuta autônomo ou pequena equipe que já usa uma agenda própria (Google Calendar) e quer parar de manter duas agendas manualmente; secundariamente, automações internas (n8n) para lembretes customizados.
- **Frequência de uso:** diária.
- **Impacto financeiro:** reduz trabalho manual (real). Reduzir faltas via API é um ganho **marginal** — a Luxora já envia lembrete via WhatsApp nativamente, sem precisar de API nenhuma; o ganho incremental de expor Agenda por API sobre isso é pequeno.
- **Diferencial competitivo:** médio — o dado em si (agenda) é trivial para qualquer concorrente exportar. O que **não é trivial** é que essa agenda já vem validada pelo Motor de Disponibilidade (feriados, exceções, recorrência, conflito) — nenhum concorrente pesquisado tem esse conceito. Um sistema externo lendo a agenda da Luxora recebe dado **garantidamente consistente**, não bruto.

### Financeiro (segmentação de inadimplência)

- **Valor comercial:** médio, com uma ressalva comercial importante (ver abaixo).
- **Perfil do cliente:** BI/planilha executiva, equipe administrativa/financeira.
- **Frequência de uso:** semanal/ocasional — não é dado que muda a cada minuto.
- **Impacto financeiro:** pode ajudar a diminuir inadimplência indiretamente (visibilidade mais rápida) — mas a régua de inadimplência automática (`ExecutarReguaInadimplenciaUseCase`) já age sozinha sobre esse mesmo dado, sem precisar de API. O ganho incremental de expor isso externamente, sobre o que o produto já faz, é limitado.
- **Diferencial competitivo:** baixo — é uma leitura filtrada por data, replicável por qualquer concorrente com uma query simples.
- **Ressalva comercial real:** "visão executiva consolidada" é literalmente a descrição do benefício **Dashboard executivo**, já prometido (e ainda não entregue) como parte do Enterprise. Entregar essa mesma informação por API, de graça, antes do Dashboard existir, corre o risco de **canibalizar** um benefício que deveria ser uma experiência própria dentro do produto — o cliente Enterprise pagando por "tempo do fundador" e "dashboard executivo" não deveria precisar montar o próprio dashboard puxando dado bruto por API.

### Cobranças / Pagamentos

- **Valor comercial:** alto — é o impacto financeiro mais tangível e mensurável de toda a lista: elimina exportação manual de cobrança para o contador/ERP financeiro.
- **Perfil do cliente:** contabilidade externa, ERP financeiro — mas o ICP documentado (autônomo/pequena clínica) tipicamente usa um contador que acessa extrato/Asaas diretamente, não uma integração API própria. Esse perfil de consumidor é mais realista para uma **rede de clínicas**, que não é o ICP central hoje.
- **Frequência de uso:** semanal/mensal (ciclo de fechamento financeiro, não diário).
- **Impacto financeiro:** reduz trabalho manual de conciliação de forma real e mensurável — o mais forte de todos os candidatos neste critério específico.
- **Diferencial competitivo:** baixo — dado financeiro cru (cobrança, pagamento) é o tipo de coisa que qualquer concorrente com CRUD básico entrega igual. O modelo de cobrança agregada (semanal/mensal, por política da clínica) é uma regra de negócio própria da Luxora, mas o valor disso está em a Luxora calcular certo — não em expor o resultado por API.
- **Risco:** o mais alto de todos (dinheiro de verdade) — já registrado na análise técnica.

### Pacientes

- **Valor comercial:** médio — útil para um CRM de relacionamento, mas o "CRM" nesse domínio (saúde mental) tem barreira ética que um CRM de vendas comum não tem; não é uma automação de marketing/funil como em outros setores.
- **Perfil do cliente:** CRM, mas de uso restrito; equipe administrativa de uma clínica com mais de um profissional.
- **Frequência de uso:** ocasional — cadastro de paciente não muda com frequência.
- **Impacto financeiro:** reduz trabalho manual de recadastro; não tem caminho direto para aumentar receita ou reduzir inadimplência.
- **Diferencial competitivo:** baixo — CRUD básico de nome/telefone/status, qualquer concorrente replica.

### Sessões, Mensagens, Eventos, Webhooks, IA, Dashboard

Mantêm, sob a lente comercial, a mesma conclusão da análise técnica: valor
comercial real existe (especialmente em IA — é o diferencial mais forte
segundo a pesquisa de concorrência), mas nenhum tem hoje o par
"maturidade técnica + caso de uso validado" para ser o primeiro. Eventos e
Webhooks são "plumbing" — não são, isoladamente, o que fecha ou retém uma
venda Enterprise. Dashboard segue desqualificado (não existe).

## Matriz

| Endpoint | Valor Comercial | Valor Técnico | Complexidade | Diferencial | Prioridade |
|---|---|---|---|---|---|
| Agenda | Médio-Alto | Alto (Motor já valida) | Baixa | Médio (dado validado, não bruto) | 1 |
| Cobranças/Pagamentos | Alto | Médio | Baixa (técnica) / Alto risco | Baixo | 2 |
| Financeiro (segmentação) | Médio (risco de canibalizar Dashboard) | Médio | Baixa-Média | Baixo | 3 |
| Pacientes | Médio | Médio | Baixa (técnica) / risco LGPD | Baixo | 4 |
| IA | Alto (maior diferencial teórico) | Baixo (não pronto) | Alta | Alto | 5 (não agora) |
| Mensagens | Médio | Baixo | Média-Alta | Médio | 6 |
| Sessões | Baixo-Médio | Baixo | Média | Baixo | 7 |
| Eventos | Baixo | Alto (pronto) | Baixíssima | Baixo | 8 |
| Webhooks | Médio (a médio prazo) | Nenhum (não existe) | Alta | Baixo (genérico) | 9 |
| Dashboard | — | — | N/A | — | Desqualificado |

## Recomendação final

**Mantenho Agenda como recomendação**, mas com uma justificativa diferente
da análise puramente técnica: não é "o mais fácil", é **o único candidato
em que o diferencial competitivo real da Luxora (Motor de Disponibilidade)
está embutido no próprio dado exposto**. Um ERP ou automação externa que lê
a agenda da Luxora recebe algo que nenhum concorrente pesquisado consegue
oferecer no mesmo nível — disponibilidade já validada contra feriado,
exceção, recorrência e conflito, sem o sistema externo precisar reimplementar
nenhuma dessas regras.

**Honestidade necessária, que a análise técnica sozinha não capturava:**
nenhum candidato tem hoje evidência de demanda real e validada — não
encontrei, em nenhum documento do CEO, um pedido real de cliente por
integração de API. A própria Luxora documentou que o Enterprise se vende
por atenção do fundador, não por feature técnica. Isso significa que esta
recomendação é a **melhor aposta com a informação disponível**, não uma
certeza validada — e é exatamente por isso que o próximo passo (abaixo)
não é "implementar", é "validar com um cliente ou prospect real antes de
comprometer esforço de engenharia".

**Por que não Cobranças, apesar do maior impacto financeiro isolado:**
dinheiro é o pior lugar para o primeiro teste de uma superfície pública
nova, e o perfil de consumidor real (ERP financeiro de rede) não bate com
o ICP documentado hoje.

**Por que não Financeiro:** risco real de canibalizar o Dashboard
executivo, um benefício Enterprise já prometido e ainda não construído —
entregar o dado bruto por API antes da experiência própria existir manda
a mensagem errada sobre o que o Enterprise paga.

**Por que não IA, apesar do maior diferencial teórico:** é exatamente por
ser o diferencial mais forte que expor errado (sem desenho de escopo e
custo pensado para uso externo) é mais arriscado que não expor — a Luxora
usaria seu próprio maior trunfo de forma descontrolada.

## Próximos passos sugeridos (ordem de prioridade)

1. **Validação comercial real antes de qualquer código** — conversar com pelo menos 1 cliente Enterprise real (ou prospect qualificado) perguntando especificamente: "se pudesse puxar um dado da Luxora para outro sistema, qual seria?" Sem isso, tanto esta análise quanto a anterior continuam sendo julgamento informado, não fato validado — o próprio princípio fundador da Luxora ("não criamos produtos por ideia, criamos a partir de dor real ouvida pessoalmente") pede isso antes de comprometer engenharia.
2. Se a validação confirmar Agenda (ou reposicionar outro candidato): aí sim abrir o plano de implementação técnica já esboçado na análise anterior.
3. Se a validação apontar outro candidato, refazer o ranking com o dado novo — não forçar a recomendação técnica contra um sinal real de cliente.

---

## Decisão oficial (2026-07-18) — PD-004 encerrado, superfície pública congelada

**Nenhum endpoint público será implementado neste momento.** A conclusão
principal desta análise não é "qual endpoint" — é que **não existe ainda
evidência de que um cliente real esteja demandando uma API**. Nenhum
documento do CEO registra esse pedido; a própria Luxora já documentou que
o Enterprise se vende por atenção do fundador, não por feature técnica; e
nenhum concorrente pesquisado usa API pública como diferencial.

**O que permanece pronto e aprovado, sem uso ainda:** toda a infraestrutura
de autenticação por API key entregue no PD-003 (`TenantApiKey`,
`TenantApiKeyGuard`, `GerarApiKeyUseCase`, `POST /subscription/api-key`).
Não é revertida, não é removida — fica pronta para o dia em que a
superfície pública for descongelada.

**Regra vigente a partir de agora:** nenhum novo endpoint de negócio deve
ser conectado a `TenantApiKeyGuard` sem antes atualizar este documento com
a evidência de validação comercial real (conversa com cliente/prospect,
não suposição) que motivou a mudança. Isso vale mesmo que a implementação
técnica pareça trivial — a barreira aqui é de produto, não de engenharia.

**Como descongelar no futuro:** repetir o passo 1 de "Próximos passos"
acima (validação real), documentar o resultado como um adendo a este
arquivo, e só então abrir um novo ciclo de implementação com plano e
aprovação explícita — mesmo processo de sempre.
