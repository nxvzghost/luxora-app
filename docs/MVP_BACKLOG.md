# MVP_BACKLOG — Proposta de backlog da primeira versão em uso real

> **PROPOSTA — NÃO APROVADA.** Derivada da especificação [`01-Domain/14-Especificacao-Funcional-do-Dominio.md`](./01-Domain/14-Especificacao-Funcional-do-Dominio.md) em 21/10/2026, no código de `2dd7934`. O backlog oficial continua sendo o [`PLANO_DE_EXECUCAO.md`](./PLANO_DE_EXECUCAO.md) (itens AD-001 a AD-039). Os itens abaixo usam a sigla **MVP-xx** e só ganham número AD depois de revisados e aprovados. Nenhum item começa sem autorização; cada commit, push e gate seguem o procedimento já usado no projeto.
>
> **Atualização de 21/10/2026 (continuação):** DP-01 a DP-04 receberam orientação do responsável (especificação, seção 4.1). A ficha do MVP-01 foi revista; as pendências que restam do ciclo da consulta viraram DP-22 a DP-25. No mesmo dia, o desenho técnico do MVP-01 foi proposto na [ADR-0069](./02-Arquitetura/ADRs/ADR-0069-ciclo-de-vida-da-consulta.md) (não aprovada), que abre DP-26 e DP-27.
>
> **Revisão de 21/10/2026:** DP-26 (aviso tardio) e DP-27 (sessões legadas) receberam orientação do responsável (especificação, seção 4.1; ADR-0069, seção 10.1). A ficha do MVP-01 foi atualizada. DP-22 a DP-25 continuam pendentes.
>
> **Revisão de 21/10/2026, rodada 5:** DP-22 a DP-25 e o K11 receberam decisão de produto (especificação, seção 4.1; ADR-0069, seção 10.1). A ADR-0069 continua em revisão, e o K2 continua bloqueador.
>
> **Revisão de 21/10/2026, rodada 2:** DP-26 detalhada (limite temporal, atuação da IA, horário do aviso) e DP-27 reafirmada. O responsável recusou corrigir o K2 (rollback que reabre cobrança do legado) depois da publicação. A ADR-0069 desenha a estratégia, e o **K2 é bloqueador** de qualquer liberação com dados de clínica até ser aprovado, implementado e provado. Na mesma data, o responsável aprovou a exceção à ADR-0060 só no escopo restrito (ADR-0069, seção 9.4); o K2 continua bloqueador até as provas.

## 1. O que "primeira versão em uso real" significa aqui

Uma clínica piloto, em homologação, operando o ciclo **agenda → atendimento → cobrança → pagamento → fechamento** sem planilha paralela, com o WhatsApp da própria clínica.

Bloqueadores **fora do domínio** que continuam valendo para qualquer uso real (Painel do Projeto, seção Bloqueadores):

| Bloqueador | Por que importa para este backlog |
|---|---|
| A-05 — entrada real da Meta nunca validada | Nenhuma mensagem real de paciente entrou no sistema |
| A-07 — sem modelos de mensagem aprovados pela Meta | Cobrança como primeira mensagem, lembrete e reiteração **não são entregues** fora da janela de 24 h sem modelo aprovado |
| A-12 — sem homologação, backup externo e alertas | Sem ambiente não há piloto |
| A-14 — governança dos dados aberta | Aviso ao paciente (D-H), termo com a clínica e questões J-1 a J-5 |

## 2. Priorização

| Prioridade | Item | Resolve | Depende de |
|---|---|---|---|
| **P0** | MVP-01 Desfecho da consulta: confirmada ≠ realizada; falta, abono, cancelamento fora do prazo, aviso tardio, histórico da remarcação e sessões legadas | AT-03, AT-05, AT-06, AT-07, AT-08, AT-13, AT-14, AT-15, CB-01 | DP-01 a DP-04, DP-26 e DP-27 (orientação registrada); DP-22 a DP-25 só para a parte financeira |
| **P0** | MVP-02 Valor aplicável com vigência | CB-03, FM-02 | DP-05, DP-06 |
| **P0** | MVP-03 Cobrança gerada a partir das sessões, conforme a política | CB-02, CB-05, CB-07 | MVP-01, MVP-02, DP-07 |
| **P0** | MVP-04 Conferência de pagamento e saldo por paciente | PG-02, PG-03, PG-05 | — |
| **P0** | MVP-05 Alerta de dívida em novo agendamento, sem bloqueio automático | CB-12 | DP-19 |
| **P0** | MVP-06 Fechamento mensal no painel | FM-01, FM-03 | MVP-01, MVP-02, DP-21 |
| **P0** | MVP-07 Aviso de atendimento automatizado (D-H) | MS-07 | DP-18; J-5 para uso com paciente real |
| P1 | MVP-08 Lista de pacientes sem retorno 30/60/90 | FU-01, FU-03 | DP-10 |
| P1 | MVP-09 Feriados, férias e reabertura pelo painel | AG-05, AG-06, AG-07 | — |
| P1 | MVP-10 Lembrete de consulta | MS-01 | A-07, A-19, DP-09 |
| P1 | MVP-11 Reiteração de cobrança configurável (e correção da régua) | MS-02, MS-03 | A-07, A-19, DP-08 |
| P1 | MVP-12 Consulta ao histórico das conversas no painel | CA-09 | DP-15 |
| P2 | MVP-13 Comprovante anexado ao pagamento | PG-04 | ADR-0013 (armazenamento), A-15 |
| P2 | MVP-14 Papéis de secretaria e financeiro | PE-01, PE-02 | DP-14 |
| P2 | MVP-15 Encaixe com autorização | AG-08 | DP-11 |
| P2 | MVP-16 Lista de espera e limite de remarcações | AT-09, AT-10 | DP-12 |
| P2 | MVP-17 Tom das mensagens por clínica | MS-05 | Revisão de texto |
| P2 | MVP-18 Recibos | PG-09 | DP-13 (descoberta) |
| P2 | MVP-19 Status do paciente só administrativo | Seção 2 da especificação | DP-20 |

**Por que esta ordem.** MVP-01 corrige uma divergência de significado: hoje confirmar a consulta já cria a sessão como "realizada". Tudo o que vem depois (cobrança, saldo, fechamento) depende de a sessão significar "aconteceu". MVP-02 e MVP-03 removem a digitação manual do valor. MVP-04 a MVP-06 fecham o ciclo financeiro descrito no levantamento como a capacidade número 1. MVP-07 é exigência do A-14 para falar com paciente real.

---

## 3. Fichas dos itens prioritários

### MVP-01 — Desfecho da consulta: confirmada ≠ realizada; falta, abono, cancelamento fora do prazo, aviso tardio, histórico da remarcação e sessões legadas (P0)

Desenho técnico proposto: [ADR-0069](./02-Arquitetura/ADRs/ADR-0069-ciclo-de-vida-da-consulta.md) (não aprovada).

**Problema.**
- `ConfirmarConsultaUseCase` cria a sessão com estado `Realizada` no momento da confirmação, que pode ser dias antes do atendimento (o `completed_at` nem chega a ser gravado). A intenção `confirmar_presenca` do WhatsApp usa o mesmo caso de uso.
- Não existe falta nem falta abonada.
- A antecedência mínima de cancelamento (2 h no relato) é gravada (`cancellation_hours_limit`), mas não é aplicada.
- `reschedule` sobrescreve a data da consulta; o horário original se perde (AT-13).
- Uma consulta confirmada e depois cancelada já gerou sessão "realizada", que pode ser cobrada.
- Cancelar é aceito em qualquer momento, inclusive depois do início, sem registrar quando o aviso chegou.
- `POST /billings` aceita qualquer sessão da clínica, inclusive de outro paciente, e grava a cobrança antes do vínculo (ADR-0069, achado 5).
- O carimbo de tempo que a Meta envia no webhook não é lido nem guardado.
- O rollback pode voltar a qualquer versão, sem conferir compatibilidade com os dados (ADR-0069, achado 10).

**Regras de origem** (detalhe e origem de cada uma na especificação, seção 4.1):
- **Relatadas pela clínica:**
  - falta sem aviso é cobrada pelo valor aplicável, salvo exceção da pessoa responsável;
  - cancelar ou reagendar exige aviso de 2 h.
- **Orientação de produto:**
  - confirmação ≠ realização;
  - realização e falta só por registro de pessoa autorizada;
  - abono sempre humano;
  - cancelamento fora do prazo distinto de falta;
  - consequência configurável; sem política, decisão humana;
  - histórico da remarcação preservado;
  - aviso tardio (DP-26):
    - com horário real de recebimento vindo da integração, sem limite final;
    - nunca convertido em falta, cancelamento ou cobrança;
    - a IA só registra a comunicação e a possível intenção;
    - desfecho existente nunca sobrescrito;
    - horário alegado guardado à parte;
  - legado sem desfecho comprovado não é presumido (nem por data, confirmação ou cobrança) nem cobrado de novo; cobranças e pagamentos intactos; migração começa por `dry-run` (DP-27).
- **Proposta operacional a validar:**
  - equipe administrativa registra;
  - profissional registra ou corrige;
  - abono aprovado por pessoa autorizada.

**Comportamento esperado.**
- **Confirmar** só muda o estado da consulta, pelo painel ou pelo WhatsApp.
- **Realizada:** registrada por pessoa autorizada, depois do horário de início (fuso da clínica). Cria exatamente uma sessão faturável.
- **Falta sem aviso:** registrada por pessoa autorizada, depois do horário de início. O sistema mostra a consequência da política da clínica; a sessão faturável de falta só nasce quando a pessoa autorizada confirma a cobrança. Sem política configurada, fica "falta — aguardando decisão" e gera aviso à equipe.
- **Falta abonada:** decisão de pessoa autorizada sobre uma falta registrada; não gera sessão faturável. Nunca é automática.
- **Cancelada no prazo / fora do prazo:** todo cancelamento guarda o momento do aviso, a antecedência em horas (fuso da clínica), quem pediu (paciente, clínica ou profissional) e o canal. Fora do prazo nunca vira falta. A consequência segue a política da clínica; sem política, nada é cobrado e o caso vai para decisão humana.
- **Comunicações e aviso tardio (DP-26):**
  - **Comunicação como registro próprio.** Toda mensagem ou aviso sobre a consulta vira um registro de comunicação, somente de acréscimo, com:
    - intenção identificada e marca de ambiguidade;
    - classificação pelo início previsto da consulta, sem limite final;
    - horários separados: o da integração (carimbo da Meta ou recebimento no webhook), o de registro no sistema e o alegado, com origem e responsável.
  - **Nunca o horário de processamento** na fila; **nunca o horário alegado** como recebido.
  - **No início ou depois**, ou com ambiguidade ou atraso: a IA só registra a comunicação, a consulta não muda e a equipe é sinalizada.
  - **O aviso tardio como desfecho** é registrado por uma pessoa, com base nessas comunicações. Ele não gera sessão faturável; a consequência fica para decisão humana, salvo política da clínica.
  - **Com desfecho já registrado,** a comunicação vira evento adicional e não o sobrescreve.
  - **Correção** é sempre um novo registro.
- **Reagendada:** o horário original fica preservado e consultável; reagendamento fora do prazo também é marcado como tal.
- **Sem desfecho:** consulta cujo horário passou sem registro aparece numa lista de pendências da equipe; não é realizada, não é falta, não é cobrada.
- **Sessões legadas (DP-27):**
  - criadas na confirmação antes da mudança, nunca presumidas realizadas;
  - as de consulta cancelada ou futura, ainda não cobradas, são candidatas à anulação;
  - as de desfecho não verificável ficam identificadas à parte e não entram em cobrança nova;
  - cobranças e pagamentos existentes ficam intactos.

  A migração começa por `dry-run` por clínica e só é aplicada com autorização específica (ADR-0069, seção 6).

**Regras de negócio.**
1. Realização e falta só depois do início da consulta, no fuso da clínica; o horário passar não muda o estado.
2. Uma consulta gera no máximo uma sessão faturável (idempotente).
3. Sessão faturável nasce só de: realização registrada, ou falta sem aviso com cobrança confirmada por pessoa autorizada.
4. Falta abonada, cancelamento no prazo, cancelamento fora do prazo e aviso tardio sem decisão de cobrança não geram sessão faturável. Aviso fora do prazo ou tardio segue a DP-22: política por clínica (`nao_cobrar`, `decisao_humana` padrão, `sugerir_cobranca`), com configurações independentes. A cobrança só ocorre com confirmação humana e pelo valor integral aplicável. Cancelamento pedido pela clínica ou pelo profissional nunca gera cobrança ao paciente (DP-25).
5. Nenhum valor, limite ou política fixo no código: limite de antecedência, política de falta e política de cancelamento fora do prazo vêm da configuração da clínica (e do profissional, quando aplicável).
6. Corrigir um desfecho é possível conforme permissão e vai para a auditoria; se a sessão já estiver numa cobrança, a correção segue DP-06.
7. Todo registro, confirmação de cobrança, abono e correção vai para a auditoria com o autor.
8. A IA registra a comunicação e a possível intenção, e confirma presença.
   - Antes do início, só cancela ou remarca depois de **confirmação explícita** do paciente, identificando a consulta por data, horário e profissional (K11). A antecedência conta a partir da primeira mensagem, e a nova data também precisa de confirmação. Sem confirmação até o início, nada é executado e a equipe é sinalizada.
   - Depois do início, nunca muda a consulta.
   - Nunca registra realização, falta, aviso tardio como desfecho, abono, consequência ou cobrança.
9. Identidade ambígua continua sem ação (ADR-0063).
10. Elegibilidade para cobrança, positiva e em falha fechada. Só entra em cobrança nova a sessão que:
    - tem tipo;
    - não está anulada;
    - está a faturar;
    - é do mesmo paciente e da mesma clínica.

    A regra vale na aplicação, com cobrança e vínculos numa única transação, e **no banco**, por restrições declarativas sem trigger. Uma versão anterior da aplicação, num rollback, não consegue criar cobrança nem vincular sessão inelegível (ADR-0069, seções 2.9, 3.7 e 9.4). Cobranças já existentes seguem o ciclo normal.

**Critérios de aceite.**
- [ ] Confirmar uma consulta (painel ou WhatsApp) não cria sessão.
- [ ] Nenhum estado muda só porque o horário passou; a consulta aparece como "sem desfecho registrado" e não entra em cobrança nem no fechamento como devido.
- [ ] Registrar realizada antes do horário de início é recusado; depois, cria exatamente uma sessão faturável; repetir não cria outra.
- [ ] Registrar falta sem aviso não cria sessão faturável sozinho; a confirmação da cobrança por pessoa autorizada cria uma, pelo valor aplicável (MVP-02), nunca por valor fixo.
- [ ] Falta sem aviso com a clínica sem política configurada fica aguardando decisão e gera aviso à equipe.
- [ ] Falta abonada não cria sessão faturável e registra quem abonou e o motivo (obrigatório); papel sem permissão de abono e `super_admin` são recusados (DP-23).
- [ ] Falta sem aviso nunca é registrada como realizada, e cancelamento fora do prazo nunca vira falta.
- [ ] Com limite de 2 h, cancelamento a 1 h do início fica "fora do prazo"; a 3 h, "no prazo"; com limite de 4 h configurado, o de 3 h fica fora do prazo (prova de que não está fixo).
- [ ] Cancelamento fora do prazo sem política configurada não cria cobrança e gera aviso à equipe.
- [ ] Remarcar preserva o horário original, consultável depois; remarcar a 1 h do início fica marcado fora do prazo.
- [ ] Cancelamento ou remarcação pela IA só acontece depois de confirmação explícita, em mensagem seguinte e antes do início. Registra a antecedência a partir da primeira mensagem e a origem; sem confirmação, nada é executado e a equipe é sinalizada (K11).
- [ ] Com `sugerir_cobranca`, nenhum aviso fora do prazo ou tardio é cobrado sem confirmação humana; a cobrança usa o valor integral aplicável (DP-22).
- [ ] Cancelamento pedido pela clínica ou pelo profissional nunca gera cobrança; quem solicitou, quem registrou e o horário ficam registrados à parte (DP-25).
- [ ] Reverter abono exige `admin` e motivo, e volta para decisão humana sem cobrar (DP-24a).
- [ ] Mensagem do paciente no início ou depois (inclusive horas depois do fim do horário) vira comunicação `depois_do_inicio` e **não muda a consulta**; a equipe é sinalizada.
- [ ] "Vou me atrasar" ou mensagem ambígua nunca vira ausência.
- [ ] Só uma pessoa leva a consulta a aviso tardio, com base em comunicação `depois_do_inicio`; sem sessão faturável e com decisão pendente; nunca vira falta nem cobrança sem ação humana.
- [ ] Pelo WhatsApp, o horário de referência vem da integração (carimbo da Meta válido, ou recebimento no webhook), nunca do processamento na fila.
- [ ] No painel, o horário de recebimento não pode ser informado nem sobrescrito. O horário alegado fica separado, com origem e responsável, e não muda a classificação oficial. Correção é novo registro.
- [ ] Comunicação que chega depois de um desfecho registrado não o altera e gera aviso à equipe.
- [ ] `POST /billings` recusa sessão anulada, sem tipo (legado), não a faturar ou de outro paciente; cobrança e vínculos gravados juntos (falha no vínculo não deixa cobrança).
- [ ] No banco: vínculo com sessão inelegível, de outro paciente ou de outra clínica é recusado, e cobrança sem a marca de conferência é recusada. Provado em teste de integração no PostgreSQL 16.
- [ ] No ensaio de deploy, a imagem da versão anterior contra o banco migrado não consegue criar cobrança nem deixa cobrança órfã; `deploy.sh` e `rollback.sh` recusam destino sem a capacidade de elegibilidade.
- [ ] O `dry-run` da migração do legado não deixa nada gravado além do registro da execução; as impressões digitais financeiras de antes e de depois coincidem; o `apply` exige `dry-run` aprovado e autorização específica, nunca muda o estado das consultas e nunca escreve em cobrança ou pagamento.
- [ ] Toda marcação, abono e correção aparece na Auditoria com o autor.
- [ ] Uma clínica não altera consulta de outra (RLS).

**Impacto.**
- **Dados** (detalhe na ADR-0069, seção 3). Migração aditiva:
  - desfecho da consulta em tabela própria (`appointment_outcome`), inclusive aviso tardio, sem ampliar o enum de estados. A consulta fica congelada por chave estrangeira composta, privilégios e política RLS restritiva, sem trigger (ADR-0069, seção 2.4);
  - classificação, horário real e horário de registro do aviso, antecedência, quem pediu e canal;
  - consulta anterior na remarcação;
  - tipo e anulação da sessão;
  - marcas de legado;
  - decisões pendentes;
  - políticas de falta, de aviso fora do prazo e de aviso tardio;
  - registro das execuções da migração do legado;
  - tabela de comunicações, com privilégio de atualização só nas colunas de revisão;
  - carimbo de tempo da Meta na mensagem;
  - elegibilidade na sessão, marca de conferência na cobrança, paciente no vínculo e chaves compostas;
  - exigência mínima de versão (`deployment_requirement`).
- **Infra:** rótulo de capacidade na imagem (`build-images.sh`); `deploy.sh` e `rollback.sh` leem a exigência e recusam destino incompatível; teste de compatibilidade da versão anterior no ensaio de deploy.
- **Backend:**
  - casos de uso de realização, falta, aviso tardio, cobrança de falta, abono, correção e decisão de consequência;
  - `ConfirmarConsultaUseCase` deixa de criar sessão;
  - cancelar e remarcar passam a classificar o aviso e guardar a origem;
  - a remarcação cria uma ocorrência nova em vez de apagar o horário anterior;
  - guarda em `POST /billings`;
  - comando de classificação do legado com `dry-run`.
- **Permissões:** com os papéis atuais (`admin`, `therapist`), "equipe administrativa" é o `admin`. Não há papel de secretaria nem permissão separada de abono (lacunas, sem alteração nesta etapa; DP-14, DP-23).
- **Frontend:** ações de desfecho na Agenda; lista de consultas sem desfecho e de decisões pendentes; Financeiro lista só sessões faturáveis.

**Testes.**
- Unitários da máquina de estados da consulta e da sessão.
- Críticos pelo HTTP, com Postgres e RLS reais, para cada critério acima.
- Crítico pelo webhook (fila e worker reais):
  - `confirmar_presenca` não cria sessão;
  - `cancelar_consulta` guarda antecedência e origem;
  - depois do início, só registra a comunicação, com o horário da integração, sem mudar a consulta.
- Testes de integração de cada restrição do banco.
- Teste de compatibilidade de versões no ensaio de deploy (K2).
- Testes da migração com uma fixture de cada categoria do legado.
- Ajuste dos testes críticos e de ponta a ponta que hoje assumem "confirmar → sessão".
- Prova por mutação; cada mutação abaixo derruba um teste:
  - confirmar voltando a criar sessão;
  - horário passado mudando o estado;
  - desfecho antes do horário aceito;
  - falta cobrada sem confirmação humana;
  - aviso tardio virando falta ou criando sessão;
  - cancelamento fora do prazo convertido em falta;
  - limite de cancelamento fixo;
  - remarcação apagando o horário original;
  - `POST /billings` aceitando sessão sem tipo;
  - `dry-run` deixando escrita gravada;
  - IA mudando a consulta depois do início;
  - horário alegado usado como recebido;
  - comunicação sobrescrevendo desfecho;
  - elegibilidade ignorando o paciente;
  - cobrança gravada antes do vínculo;
  - rollback ignorando a exigência de versão.

  Lista completa na ADR-0069, seção 8.

**Efeito nos outros itens** (o que eles passam a exigir do MVP-01):

| Item | Dependência |
|---|---|
| MVP-02 Valor aplicável | A sessão de falta usa o mesmo preço aplicável do paciente na data (regra relatada); preço diferente para falta não foi pedido |
| MVP-03 Cobrança a partir das sessões | Entram só sessões faturáveis (realizada, ou falta com cobrança confirmada). Nunca entram: falta aguardando decisão, falta abonada, cancelamento, aviso tardio sem decisão de cobrança, consulta sem desfecho e sessão legada sem desfecho comprovado. A mensagem identifica a falta com linguagem neutra, data e valor (DP-24b); fora da janela de 24 h, depende de modelo aprovado (A-07) |
| MVP-04 Conferência de pagamento | Sem dependência direta |
| MVP-05 Alerta de dívida | A falta só vira pendência financeira depois de cobrada; falta aguardando decisão não conta como dívida |
| MVP-06 Fechamento mensal | Separa realizadas, faltas cobradas, faltas abonadas (quantidade, sem valor), cancelamentos fora do prazo e avisos tardios. Mostra à parte, sem somar no devido nem como atendimento: as consultas sem desfecho, as decisões pendentes e as sessões legadas (inclusive as já cobradas, cuja cobrança é preservada). Data de referência da falta (horário marcado) segue DP-21 |
| MVP-08 Sem retorno | "Última sessão" é a última realizada, não a última confirmada nem falta |
| MVP-10 Lembrete | Só para consulta confirmada, não cancelada; a remarcação lembra o horário novo |

**Dependências e riscos.**
- DP-01 a DP-04, DP-26 e DP-27 têm orientação registrada (especificação, seção 4.1).
- **Desenho técnico proposto (não aprovado): [ADR-0069](./02-Arquitetura/ADRs/ADR-0069-ciclo-de-vida-da-consulta.md).** Ela recomenda:
  - remarcação como nova ocorrência ligada;
  - comunicações como registro próprio e aviso tardio só por pessoa;
  - um item faturável reaproveitável por ocorrência;
  - elegibilidade para cobrança garantida na aplicação e no banco;
  - auditoria na mesma transação;
  - migração do legado com `dry-run` em transação desfeita, sem tocar cobrança nem pagamento;
  - estratégia de lançamento e rollback para o K2.

  Registra também dez achados de leitura, entre eles:
  - reconfirmar depois de remarcar com provável erro interno;
  - `session.completed_at` nunca gravado;
  - agendamento aceito no passado;
  - rollback sem conferência de compatibilidade.
- **K2 — bloqueador.** Um rollback para versão sem a regra de elegibilidade reabriria a cobrança do legado e de sessões de outro paciente. O responsável recusou corrigir depois da publicação. A estratégia proposta (ADR-0069, seção 9.4) combina:
  - restrições declarativas no banco, que deixam qualquer versão antiga sem conseguir cobrar;
  - exigência mínima de versão nos scripts de deploy e de rollback;
  - cobrança atômica;
  - teste de compatibilidade no ensaio de deploy.

  A **exceção à ADR-0060 foi aprovada em 21/10/2026, só no escopo restrito**:
  - versões antigas operam em modo degradado, sem criar cobrança nem vínculo;
  - a agenda segue a alternativa (b): desfecho em estrutura própria (tabela `appointment_outcome`), sem ampliar o enum de estados. **Nenhuma liberação em ambiente com dados de clínica antes de a estratégia ser aprovada, implementada e provada.**
- Pontos a confirmar ou validar antes da implementação (ADR-0069, seção 10.3):
  - provas do K2 (testes das restrições no PostgreSQL 16 e ensaios de deploy, rollback e restauração);
  - semântica do carimbo da Meta;
  - restrição do terapeuta às próprias consultas;
  - agendamento no passado;
  - comportamento das intenções novas com o modelo real (chamada paga, a autorizar).
- DP-22 a DP-25 e K11 **decididos** em 21/10 (especificação, seção 4.1). Dependências que ainda impedem implementar partes deles:
  - abono pelo profissional só depois da restrição do terapeuta às próprias consultas, implementada e verificada (DP-23);
  - valor aplicável depende do MVP-02 (DP-22);
  - falta identificada na mensagem depende do MVP-03 e, fora da janela de 24 h, de modelo aprovado pela Meta, A-07 (DP-24b);
  - confirmação em duas etapas pela IA não validada com o modelo real, chamada paga a autorizar (K11).
- Depende de MVP-02 para o valor da falta. Até lá, a confirmação da cobrança da falta não pode inventar valor: fica pendente de valor (regra 3 do MVP-02).
- **Risco:** muda o significado de dados já existentes (sessões criadas na confirmação). Tratado pela DP-27 e pela ADR-0069, seção 6. O sistema não permite recuperar se esses atendimentos aconteceram, o horário original das remarcações antigas, nem quem pediu os cancelamentos.
- **Risco:** uma versão antiga no ar depois da migration não consegue criar cobranças. É falha fechada intencional, ligada ao K2; agenda, pagamentos e reenvio continuam.
- **Limitação:** o sistema não guarda comprovantes (MVP-13 não implementado); a preservação de comprovantes da DP-27 vale para o que existir fora dele.

### MVP-02 — Valor aplicável com vigência (P0)

**Problema.** O valor da cobrança é digitado a cada vez (`CreateBillingDto.amount`). Não há preço por clínica, terapeuta ou paciente, nem reajuste com data. O levantamento proíbe fixar o valor histórico (R$ 400) e pede preços diferentes por período ou paciente.

**Comportamento esperado.**
- Tabela de preço com vigência em três níveis: padrão da clínica, terapeuta e paciente (o mais específico vale).
- A sessão guarda o valor aplicado no momento em que nasce.
- A cobrança soma os valores das sessões.

**Regras de negócio.**
1. Reajuste vale só para sessões a partir da data de vigência.
2. O valor guardado na sessão nunca muda por reajuste posterior.
3. Sessão sem preço configurado não recebe valor inventado: fica sinalizada para a equipe.
4. Ajuste manual do valor segue DP-06; se permitido, exige motivo e vai para a auditoria.

**Critérios de aceite.**
- [ ] Paciente com preço próprio usa esse preço; sem ele, vale o do terapeuta; sem ele, o da clínica.
- [ ] Reajuste em 01/07 não altera sessões de junho.
- [ ] Cobrança de 3 sessões de valores diferentes soma corretamente.
- [ ] Sessão sem preço configurado aparece como pendente de valor e não entra em cobrança automática.

**Impacto.**
- **Dados:** tabela de preços com vigência; valor e moeda na sessão.
- **Backend:** resolução do preço ao criar a sessão.
- **Frontend:** preços em Configurações, Terapeutas e Pacientes; valor sugerido em Financeiro.

**Testes.** Unitários da resolução de preço; críticos de vigência, isolamento e soma; mutação na ordem de precedência e na data de vigência.

**Dependências e riscos.**
- Depende de DP-05 e DP-06.
- **Risco:** escopo de "preço por modalidade ou duração" (a confirmar dentro de DP-05).

### MVP-03 — Cobrança gerada a partir das sessões, conforme a política (P0)

**Problema.** A cobrança é montada à mão pelo administrador. A política "por sessão, semanal ou mensal" é gravada mas não usada. A mensagem de cobrança não lista as datas das sessões, que o levantamento pede.

**Comportamento esperado.**
- **Por sessão:** cada sessão faturável gera uma cobrança no estado "criada".
- **Mensal:** as sessões faturáveis do mês do paciente formam uma cobrança no dia configurado.
- O envio continua sendo uma ação separada, a menos que a clínica configure envio automático (DP-07).
- A mensagem lista as datas, a quantidade, o valor unitário (ou os valores, se diferentes), o total, o Pix e o recebedor, e pede o comprovante se o pagamento já foi feito.

**Regras de negócio.**
1. Toda sessão faturável entra em exatamente uma cobrança (a regra `UNIQUE(session_id)` já existe).
2. A política do paciente prevalece sobre a da clínica.
3. A cobrança pode ser a primeira mensagem para o paciente; a ausência de conversa nunca a bloqueia. A entrega fora da janela de 24 h depende do A-07.
4. Cobrança enviada não muda de valor; a correção segue DP-06.

**Critérios de aceite.**
- [ ] Com política por sessão, marcar realizada cria uma cobrança com o valor da sessão.
- [ ] Com política mensal, no dia configurado, todas as sessões faturáveis do mês do paciente entram numa cobrança; nenhuma fica de fora.
- [ ] Nenhuma sessão aparece em duas cobranças.
- [ ] A mensagem mostra as datas no fuso da clínica e o total igual à soma.
- [ ] Paciente sem conversa anterior recebe a cobrança (ou a clínica recebe o aviso de falha, A-08).

**Impacto.**
- **Dados:** dia de fechamento da cobrança mensal na configuração.
- **Backend:** geração por política; o modelo de mensagem passa a receber as datas.
- **Frontend:** Financeiro mostra a origem de cada cobrança.
- **Agendador:** a geração mensal precisa de um gatilho. No piloto, pode ser um comando manual até o A-19.

**Testes.** Críticos das duas políticas, da precedência paciente × clínica e da ausência de dupla cobrança; unitário do texto da mensagem; mutação.

**Dependências e riscos.**
- Depende de MVP-01, MVP-02, DP-07 e do A-19 para a geração automática mensal.
- Do MVP-01: só sessões faturáveis entram (realizada, ou falta com cobrança confirmada por pessoa autorizada); falta aguardando decisão, abonada, cancelamento e consulta sem desfecho nunca entram. Cobrança de aviso fora do prazo ou tardio segue a DP-22 (só com confirmação humana, valor integral aplicável); a falta é identificada na mensagem com linguagem neutra (DP-24b).
- O envio real fora da janela de 24 h depende do A-07.

### MVP-04 — Conferência de pagamento e saldo por paciente (P0)

**Problema.**
- O relato descreve pagamentos "incertos" (`???`) que precisam de conferência.
- O estado `em_conferencia` existe, mas nenhum fluxo o usa: a conciliação é automática por valor.
- Não há visão de saldo por paciente no painel.

**Comportamento esperado.**
- **Pagamento informado:** a equipe registra o que o paciente diz ter pago. Ele fica "em conferência" e não quita a cobrança.
- **Conferência:** a equipe confirma (o pagamento quita a cobrança) ou marca como divergente (gera aviso).
- **Saldo por paciente:** devido, pago, em conferência e vencido, com as sessões de origem.

**Regras de negócio.**
1. Pagamento em conferência nunca é tratado como confirmado.
2. Só pagamento confirmado quita a cobrança.
3. Quem confirmou fica na auditoria.
4. Valor diferente do devido continua indo para divergente, com aviso.

**Critérios de aceite.**
- [ ] Registrar como "em conferência" não muda a cobrança.
- [ ] Confirmar quita; marcar divergente não quita e gera aviso.
- [ ] O saldo por paciente bate com a soma das cobranças e dos pagamentos.
- [ ] O autor da confirmação aparece na Auditoria.

**Impacto.**
- **Backend:** chamador para `em_conferencia` e ação de confirmação manual; consulta de saldo.
- **Frontend:** estado e ação no Financeiro; saldo na ficha do paciente.
- **Dados:** sem mudança de esquema prevista.

**Testes.** Críticos de cada transição e do saldo; mutação "em conferência quita".

**Dependências e riscos.** Comprovante anexado fica para o MVP-13. Até lá, o comprovante recebido no WhatsApp gera o aviso de mídia (A-15) e a equipe confere fora do sistema.

### MVP-05 — Alerta de dívida em novo agendamento, sem bloqueio automático (P0)

**Problema.** O levantamento exige que a clínica decida se libera um novo atendimento quando há cobrança em aberto: o sistema alerta o financeiro, não bloqueia e não libera automaticamente. Hoje o agendamento não consulta cobranças: não bloqueia (correto), mas também não alerta. Pelo WhatsApp, a IA reserva o horário sozinha (estado `Reservada`, `agendar-consulta.use-case.ts`), sem consultar ninguém, o que equivale a "liberar automaticamente".

**Comportamento esperado.**
- **Pelo painel:** quem está agendando vê o aviso de pendência (valores e datas) e decide. A ação continua possível.
- **Pelo WhatsApp:** com pendência, a IA **não confirma** o horário. Ela registra o pedido para a equipe, avisa o financeiro com as pendências e responde ao paciente com uma mensagem neutra, que não fala da dívida (DP-19). A equipe decide e conclui o agendamento.
- **Sem pendência:** o fluxo é exatamente o atual.

**Regras de negócio.**
1. "Pendência" segue DP-19 (vencida ou qualquer em aberto).
2. Nenhuma regra bloqueia ou libera só pela existência de dívida: a decisão é humana nos dois canais.
3. O aviso ao financeiro tem as cobranças de origem.
4. A mensagem ao paciente não expõe valores sem decisão da clínica.

**Critérios de aceite.**
- [ ] Paciente sem pendência: comportamento idêntico ao atual, pelo painel e pelo WhatsApp.
- [ ] Paciente com pendência, pelo WhatsApp: nenhuma consulta confirmada, aviso criado com valores e datas, resposta neutra.
- [ ] Paciente com pendência, pelo painel: aviso exibido, agendamento possível, decisão na auditoria.
- [ ] Identidade ambígua continua sem ação (ADR-0063).

**Impacto.**
- **Backend:** consulta de pendência no agendamento; tipo de aviso novo; ramo novo na IA; pedido de agendamento pendente de decisão (reaproveitar o estado `Reservada` ou criar um, DP-19).
- **Frontend:** aviso na Agenda e na lista de avisos.
- **Dados:** possivelmente um tipo de aviso e um estado.

**Testes.** Críticos pelo webhook, com fila e worker reais, nos dois casos; teste do painel; mutação "agenda automaticamente com dívida".

**Dependências e riscos.**
- Depende de DP-19.
- **Risco de experiência:** a resposta neutra precisa de revisão de tom (MS-05).

### MVP-06 — Fechamento mensal no painel (P0)

**Problema.**
- `gerar-fechamento-mensal.use-case.ts` não filtra o mês.
- Só é chamado pela rota de automação, que responde 500.
- Não há tela.

O relato descreve a soma manual de atendimentos, faturamento e atrasos, com estados incertos no meio.

**Comportamento esperado.** Tela de fechamento por mês, no fuso da clínica, com:
- sessões realizadas e faltas cobradas;
- valor aplicado;
- total faturado, recebido, em conferência, pendente e em atraso;
- detalhe por paciente.

Sem dupla contagem quando várias sessões estão numa cobrança.

**Regras de negócio.**
1. A base do mês (data da sessão ou data do pagamento) segue DP-21.
2. "Em conferência" aparece separado de "recebido".
3. Os valores vêm das sessões (MVP-02), nunca de um preço fixo.
4. Do MVP-01: realizadas, faltas cobradas, faltas abonadas (quantidade, sem valor) e cancelamentos fora do prazo aparecem separados; consultas sem desfecho e decisões pendentes aparecem à parte e nunca somam no devido nem no faturado.

**Critérios de aceite.**
- [ ] O exemplo do relato é reproduzido como teste com dados próprios: 52 sessões a R$ 400 dão R$ 20.800 faturados, e as pendências somam o valor esperado, sem o preço fixo no código.
- [ ] A soma por paciente bate com o total.
- [ ] Uma cobrança com 4 sessões conta as 4 sessões uma vez.
- [ ] O mês respeita o fuso da clínica (sessão às 23h de 31/07 em São Paulo conta em julho).

**Impacto.**
- **Backend:** caso de uso por mês e rota de leitura (fora das rotas de automação).
- **Frontend:** tela nova.
- **Dados:** sem mudança.

**Testes.** Críticos com fixture do exemplo; borda de fuso; mutação na dupla contagem.

**Dependências e riscos.** Depende de MVP-01, MVP-02 e DP-21.

### MVP-07 — Aviso de atendimento automatizado (D-H) (P0)

Plano já escrito no [documento 07 de `12-Privacidade-e-Dados`](./12-Privacidade-e-Dados/07-Plano-de-Implementacao-das-Decisoes.md), etapa 2. O levantamento acrescenta três pontos:
- a página é **de cada clínica**, com o endereço nas configurações;
- o WhatsApp não deveria ser ligado sem esse endereço;
- a cobrança pode ser a primeira mensagem, e o aviso continua previsto para a primeira resposta (DP-18).

O texto final continua sujeito a J-5, J-1 e L8. **Não pode ser usado com paciente real antes da revisão.**

### Itens P1 — resumo

| Item | Comportamento esperado | Critério de aceite principal | Impacto | Dependências |
|---|---|---|---|---|
| MVP-08 Sem retorno 30/60/90 | Lista no painel de pacientes ativos sem sessão há mais de 30, 60 ou 90 dias, com data da última sessão e da próxima consulta; registro de "follow-up pedido pela terapeuta" com prazo | A lista bate com as sessões; **nenhuma mensagem sai sozinha** | Consulta e tela; registro de pedido | DP-10 |
| MVP-09 Feriados e férias | Cadastro de feriado da clínica e de período de ausência do terapeuta, com data de retorno; a disponibilidade já respeita os dois | Horário em feriado ou férias nunca é oferecido, pelo painel e pela IA | Rota e tela para `clinic_holiday`; período nas exceções | Aviso aos pacientes depende de A-07 |
| MVP-10 Lembrete de consulta | Lembrete no dia, no horário configurado pela clínica, só para consulta confirmada e não cancelada | Um lembrete por consulta, idempotente, no fuso da clínica | Caso de uso, modelo de mensagem e gatilho | A-07 (modelo aprovado), A-19 (agendador), DP-09 |
| MVP-11 Reiteração de cobrança | Cadência configurável (ex.: semanal) e mensagem de pendências com datas e valores após N dias; limite de tentativas; parada registrada com motivo; corrigir a régua, que hoje lê `atrasada` (nunca alcançado) | Pagamento confirmado para a cadência; nunca passa do limite | Configuração, caso de uso, correção da régua | A-07, A-19, DP-08 |
| MVP-12 Histórico das conversas no painel | Leitura do histórico de um número, conforme permissão | Só quem a permissão autoriza vê; leitura registrada na auditoria | Rota e tela; registro de leitura | DP-15; A-14 (L13) |

---

## 4. Decisões pendentes

**Do responsável pelo produto:**

| ID | Pergunta | Bloqueia |
|---|---|---|
| DP-01 | O que é sessão realizada, sessão faturável e falta abonada (lacuna 9). **Orientação registrada em 21/10** (especificação 4.1): ciclo com 8 situações; realizada só por registro humano após o atendimento; abono sempre humano | MVP-01 (orientado) |
| DP-02 | Quem marca realizada e falta. **Proposta operacional registrada em 21/10, a validar:** equipe administrativa registra, profissional registra ou corrige, abono por pessoa autorizada; sem marcação automática. Lacuna: não há papel de secretaria nem permissão de abono (DP-14, DP-23) | MVP-01 (orientado) |
| DP-03 | Falta sem aviso. **Regra relatada:** cobrada pelo valor aplicável, salvo exceção da pessoa responsável. **Orientação:** política configurável por clínica; cobrança só depois do registro humano | MVP-01 (orientado) |
| DP-04 | Cancelamento com menos de 2 h. **Relatado:** aviso mínimo de 2 h. **Não confirmado:** cobrança automática. **Orientação:** ocorrência distinta de falta, consequência configurável, sem política → decisão humana | MVP-01 (orientado); consequência em DP-22 |
| DP-05 | Níveis de preço (clínica, terapeuta, paciente) e se o preço varia por modalidade ou duração | MVP-02 |
| DP-06 | Cobrança enviada pode ser corrigida? Como (cancelar e refazer, ajuste com motivo)? (lacuna 8) | MVP-02, MVP-03 |
| DP-07 | Política padrão (por sessão ou mensal), se "semanal" é usada, e se o envio da cobrança é automático ou sempre confirmado pela equipe | MVP-03 |
| DP-08 | Cadência de reiteração: "toda sexta" e "30 dias" são política ou exemplo? Qual o limite? (lacuna 12) | MVP-11 |
| DP-09 | Lembrete: horário padrão, se vai também na véspera, e quem pode desligar por paciente | MVP-10 |
| DP-10 | Follow-up: só a lista, ou também mensagem? Quem dispara? O que é a "janela de uma semana"? (lacuna 11) | MVP-08 |
| DP-11 | Encaixe: quem aprova cada tipo (lacuna 6) | MVP-15 |
| DP-12 | Lista de espera e limite de remarcações entram no MVP? (lacunas 4 e 5) | MVP-16 |
| DP-13 | Como a clínica faz recibos hoje (lacuna 7) | MVP-18 |
| DP-14 | Secretaria e financeiro são papéis diferentes? A terapeuta vê o financeiro? (lacuna 2) | MVP-14 |
| DP-15 | Quem pode ler o histórico das conversas no painel | MVP-12 |
| DP-16 | Qual é a grade horária correta da clínica piloto (lacuna 3) | Configuração do piloto (não é código) |
| DP-17 | D-G formal: confirmar a direção do levantamento (preservar a conversa de número compartilhado; anonimizar só identificadores) e o que exatamente é anonimizado | Etapa 3 do plano do A-14 |
| DP-18 | D-H formal: página por clínica (direção do levantamento); o aviso vai também na primeira cobrança ou só na primeira resposta? | MVP-07 |
| DP-19 | Alerta de dívida: o que conta como pendência (vencida ou qualquer em aberto); o que a IA responde ao paciente; o pedido fica como consulta reservada ou como pedido à parte | MVP-05 |
| DP-20 | Status do paciente só administrativo (ativo, inativo, alta) | MVP-19 |
| DP-21 | Fechamento por data da sessão (competência) ou por data do pagamento (caixa), ou os dois | MVP-06 |
| DP-22 | Consequência do aviso fora do prazo e do aviso tardio. **Decidido em 21/10, opção C:** política por clínica (`nao_cobrar`, `decisao_humana` padrão, `sugerir_cobranca`), com configurações independentes; cobrança só com confirmação humana, pelo valor integral aplicável, sem taxa | Parte financeira do MVP-01; MVP-02 (valor); MVP-03 |
| DP-23 | Quem aprova falta abonada. **Decidido em 21/10, opção B:** padrão `admin`; `super_admin` nunca; motivo obrigatório; profissional responsável só depois da restrição às próprias consultas, implementada e verificada | Permissão de abono no MVP-01 (não existe no código); restrição de acesso |
| DP-24 | **Decidido em 21/10:** (a) opção B, o `admin` reverte com motivo e o caso volta para decisão humana, sem cobrança automática; (b) opção A, a cobrança identifica a falta com linguagem neutra, data e valor | MVP-01; MVP-03 (mensagem); A-07 (modelo aprovado fora da janela de 24 h) |
| DP-25 | Cancelamento por iniciativa da clínica ou do profissional. **Decidido em 21/10, opção A:** não gera cobrança ao paciente; registrar à parte quem solicitou, quem registrou e o horário; motivo opcional | MVP-01 |
| DP-26 | Aviso dado depois do horário de início. **Orientação registrada em 21/10, em duas rodadas** (especificação, regras 26.1 a 26.12):<br>• é **aviso tardio**, distinto de falta sem aviso;<br>• vale mesmo depois do fim do horário, classificado pelo início previsto;<br>• nunca é convertido em falta, cancelamento ou cobrança; sem política, decisão humana;<br>• desfecho existente não é sobrescrito: a comunicação vira evento adicional e a equipe é sinalizada;<br>• a IA só registra a mensagem e a possível intenção; atraso ou ambiguidade vão à análise humana;<br>• o horário de recebimento vem da integração e não é sobrescrito; o horário alegado fica separado, com origem e responsável, e nunca vale como recebido;<br>• a realização nunca é inferida pelo tempo ou por confirmação.<br>Antes do início, a IA só cancela ou remarca com confirmação explícita do paciente (K11, decidido em 21/10) | MVP-01 (orientado) |
| DP-27 | Sessões legadas criadas na confirmação. **Orientação registrada em 21/10 e reafirmada na rodada 2**, equivalente à opção O1 (O2 e O4 descartadas, O3 não adotada): nada presumido (nem por data, nem por confirmação, nem por cobrança existente); cobranças, pagamentos e comprovantes preservados, sem perda, duplicação ou alteração; desfecho não verificável identificado à parte; candidatas à anulação (consulta cancelada ou futura, não cobradas) só anuladas por migração autorizada; nenhuma cobrança nova de sessão sem desfecho comprovado; `dry-run` por clínica com comparação financeira; inconsistência interrompe (ADR-0069, seção 6) | Migração do legado do MVP-01 (orientada) |

**Avaliação jurídica ou informação externa** (sem mudança): J-1 a J-5 do A-14; L8; A-07 (regras da Meta para modelos, inclusive link e cobrança); A-12 (hospedagem).

---

## 5. Divergências entre o domínio levantado e o sistema atual

| # | Domínio levantado | Sistema em `2dd7934` | Gravidade | Item |
|---|---|---|---|---|
| 1 | Confirmar ≠ realizar | Confirmar cria sessão "Realizada" com a data da confirmação | **Alta** | MVP-01 |
| 2 | Falta sem aviso é cobrada | Não existe falta | **Alta** | MVP-01 |
| 3 | Antecedência mínima de 2 h | Limite gravado, nunca aplicado | Média | MVP-01 |
| 4 | Valor por clínica, terapeuta, paciente e período | Valor digitado a cada cobrança | **Alta** | MVP-02 |
| 5 | Cobrança nasce da sessão, conforme regra da clínica | Cobrança manual; política gravada sem efeito | **Alta** | MVP-03 |
| 6 | Mensagem de cobrança com as datas | Sem as datas | Média | MVP-03 |
| 7 | Pagamento incerto exige conferência | `em_conferencia` sem chamador; conciliação automática por valor | **Alta** | MVP-04 |
| 8 | Dívida + novo pedido: alertar, não bloquear, não liberar sozinho | Não alerta; pelo WhatsApp a IA reserva o horário sem consultar | **Alta** | MVP-05 |
| 9 | Fechamento mensal automático | Caso de uso sem filtro de mês, atrás de rota que responde 500, sem tela | **Alta** | MVP-06 |
| 10 | Lembrete no dia | Não existe | Média (depende de A-07) | MVP-10 |
| 11 | Reiteração semanal e após ~30 dias | Régua D+1/D+7 inalcançável (estado `atrasada`) | Média | MVP-11 |
| 12 | Lista 30/60/90 | Não existe | Média | MVP-08 |
| 13 | Feriados e férias | Respeitados na disponibilidade; feriado sem cadastro | Média | MVP-09 |
| 14 | Histórico consultável | Preservado, mas invisível no painel | Média | MVP-12 |
| 15 | Comprovante | Imagem vira aviso de mídia não lida | Baixa no MVP | MVP-13 |
| 16 | Status administrativo do paciente | Máquina com 12 estados, a maioria sem uso | Baixa | MVP-19 |
| 17 | Número compartilhado: preservar conversa | Proteção de identidade existe; regra de anonimização não decidida | Média | DP-17 |
| 18 | Reagendar preserva o histórico do horário anterior | `reschedule` sobrescreve a data; a auditoria guarda só os estados | Média | MVP-01 |

**O que já está alinhado** (não precisa de backlog):
- conflito de agenda e concorrência;
- horários fixos;
- modalidade;
- consolidação sem dupla cobrança;
- estados separados de sessão, cobrança e pagamento;
- atraso pelo vencimento;
- histórico preservado sem exclusão;
- D-A;
- identidade ambígua;
- vínculo com aprovação;
- inativo e alta;
- isolamento por clínica;
- auditoria de ações;
- nenhum dado clínico.

---

## 6. Recomendação da próxima etapa

1. **DP-01 a DP-04 têm orientação registrada** (21/10, especificação 4.1). Revisar a seção 4.1 e a ficha revista do MVP-01; DP-22 a DP-25 podem ser respondidas em paralelo, porque o MVP-01 funciona sem elas ("sem política → decisão humana").
2. **Concluir a revisão do desenho do MVP-01** ([ADR-0069](./02-Arquitetura/ADRs/ADR-0069-ciclo-de-vida-da-consulta.md), proposta em revisão). DP-26 e DP-27 já têm orientação. Faltam:
   - concluir as provas do **K2** (a exceção à ADR-0060 já foi aprovada no escopo restrito);
   - as demais validações da seção 10.3 da ADR;
   - a aprovação.

   Depois, **implementar** em fases (ADR-0069, seção 9.1), com gate e autorização próprios em cada uma. A **fase K2** é obrigatória antes de qualquer ambiente com dados de clínica. A migração do legado exige ainda `dry-run` revisado e autorização específica. Ele corrige a divergência de maior gravidade (#1, #2 e #18) e é pré-requisito de MVP-03 e MVP-06.
3. Em paralelo às respostas, decidir **DP-05 a DP-07** para que MVP-02 e MVP-03 venham logo depois.
4. Manter separado o caminho dos bloqueadores externos (A-05, A-07, A-12, A-14). Sem o A-07, cobrança como primeira mensagem, lembrete e reiteração não são entregues fora da janela de 24 h, por mais completos que estejam no código.
