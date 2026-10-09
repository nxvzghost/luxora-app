# ADR-0063 — Identidade pelo WhatsApp: cadastro novo só com nome completo e confirmação, número novo só vinculado com aprovação da clínica, número compartilhado nunca resolvido por suposição

**Status:** APROVADA E IMPLEMENTADA (AD-037 e AD-038) em 9 de outubro de 2026, com as limitações listadas em "O que continua pendente". No mesmo dia, antes de qualquer publicação, a aprovação de vínculo recebeu uma correção de integridade — concorrência e atomicidade —, descrita em "Integridade da aprovação". Decisão de produto de 8 de outubro de 2026, confirmada e detalhada em 9 de outubro de 2026 (ver "Histórico").
**Origem:** complemento da Tarefa 06 da auditoria. Os defeitos que motivaram a decisão estão descritos, com a evidência, na [ADR-0062](./ADR-0062-fechamento-dos-testes.md) ("O que o fluxo de Contact faz de verdade") e não são repetidos aqui.
**Relação com as anteriores:** aplica ao fluxo real o princípio da ADR-0046 (ambiguidade resolvida antes de qualquer ação clínica) e completa as ADR-0045 e ADR-0055, que deixaram em aberto de onde vem o nome do contato e como um vínculo é confirmado.
**O que esta ADR não prova:** o comportamento do modelo real. Tudo aqui foi verificado com a IA roteirizada; entrada real da Meta e respostas reais da Anthropic continuam não validadas (Tarefa 03).

## Decisão

### 1. Identificação e cadastro (AD-037)

- Um número associado inequivocamente a **um** paciente da clínica pode continuar reconhecendo esse paciente, **sem pedir o nome completo a cada mensagem**.
- O nome de perfil do WhatsApp **não é prova de identidade**.
- A **criação de um paciente novo** exige **nome completo e confirmação explícita**.
- Nenhum cadastro duplicado; nenhum paciente criado ou vinculado antes da confirmação exigida.

### 2. Identidade ambígua (AD-038)

- Se um número corresponder a **dois ou mais pacientes**, as ações clínicas e financeiras que dependem dessa identidade são **bloqueadas**, e o caso é **encaminhado para resolução humana**.
- **Nunca** escolhe automaticamente o cadastro mais antigo.
- **Nunca** revela nomes, consultas, cobranças ou outras informações dos candidatos durante a resolução.

### 3. Vinculação de número novo (AD-038)

- Vincular um número novo a um paciente existente exige **aprovação explícita de um administrador da clínica**, com **registro de quem aprovou e quando**.
- O vínculo **não existe antes da aprovação**; a confirmação do próprio interlocutor **não basta**.
- **Nenhuma informação do paciente** é revelada antes da aprovação, e uma clínica nunca alcança contato ou paciente de outra.

Vale para os três casos a regra de 8 de outubro: enquanto a identidade estiver pendente, nenhuma ação clínica ou financeira que dependa dela é executada.

## Como foi implementado

### Quem está falando: uma regra só, calculada a cada mensagem

`ResolverIdentidadeDoContatoUseCase` é o único lugar que diz a quem um número pertence. Um número identifica um paciente por dois caminhos, e só por eles:

1. o **telefone do cadastro do paciente** (gravado pela clínica, ou pelo cadastro feito no WhatsApp depois do nome completo e da confirmação);
2. um **vínculo aprovado por um administrador** no painel (Contact em `Vinculado`).

Somados os dois caminhos: nenhum paciente → **desconhecido**; exatamente um → **reconhecido**; dois ou mais → **ambíguo**, e nenhum identificador de candidato sai do caso de uso. Nada é guardado: se a clínica cadastra uma segunda pessoa com o mesmo número, a mensagem seguinte já é tratada como ambígua, mesmo em uma conversa aberta antes. A ligação conversa↔paciente (`Conversation.patientId`) e o `patientId` do job deixaram de identificar alguém. O nome de perfil do WhatsApp, o nome dito na conversa e a confirmação de quem escreve não identificam ninguém.

### Cadastro de quem ainda não é paciente (AD-037)

Em dois tempos, **em mensagens diferentes**:

1. a pessoa informa o nome completo → o nome é guardado no Contact (`Identificado`) e ela é perguntada, com todas as letras, se confirma o nome e o cadastro;
2. ela confirma explicitamente → só então o paciente é criado, com esse nome e o número de onde escreve.

- Nome e confirmação na mesma mensagem **não** cadastram: a confirmação só conta se o nome já estava guardado antes. Enquanto não confirmar, a pergunta é refeita; a pessoa pode corrigir o nome, e a confirmação é pedida de novo.
- "Nome completo" é uma regra do backend, não um julgamento da IA: pelo menos duas palavras, cada uma com duas letras ou mais (letras, hífen e apóstrofo).
- O nome de perfil do WhatsApp não é lido em nenhum ponto do código.
- A confirmação chega por um campo novo e opcional do classificador de Contact (`explicitConfirmation`); o texto do pedido ao modelo foi atualizado. Se o modelo não mandar o campo, ninguém é cadastrado — o erro possível é para o lado seguro.

**Sem duplicidade.** A promoção recusa, **antes de gravar qualquer coisa**: contato sem nome guardado em mensagem anterior; número que já consta no cadastro de algum paciente (a lacuna D5b); e nome igual ao de um paciente da clínica (comparação sem acento, caixa e espaços a mais). No último caso pode ser um paciente em número novo: a conversa vai para a clínica (aviso "possível cadastro duplicado"). Um número que já identifica um paciente nunca abre outro cadastro, classifique a IA como classificar.

**O que a recusa por nome revela — e o que não revela.** O motivo nunca é dito a quem escreve: a frase é a mesma de todo encaminhamento, e nenhum texto que segue para a conversa (nem o do próprio erro interno) afirma que existe outro cadastro; o que distingue o caso é só um código interno, usado para escolher o aviso à equipe. **Mas o desfecho é observável:** um cadastro recusado é diferente de um cadastro aceito. Quem tentar se cadastrar com o nome completo exato de um paciente recebe o encaminhamento em vez da confirmação e, comparando com outra tentativa, pode inferir que existe um cadastro com aquele nome naquela clínica. A versão anterior desta ADR dizia que a pessoa "não fica sabendo que o outro cadastro existe" — era forte demais. Eliminar a inferência exigiria aceitar cadastros duplicados ou nunca confirmar um cadastro na própria conversa; as duas mudam regra de produto e não foram feitas (ver "O que continua pendente", item 9). A comparação é só por **nome idêntico** (sem acento, caixa e espaços a mais): uma variante do nome não é barrada.

### Número de mais de um paciente (AD-038)

- A conversa não é ligada a ninguém e nenhum paciente é entregue ao provedor de IA — nem para interpretar a mensagem, nem para responder.
- O classificador de identidade não é consultado: com o número ambíguo, a regra é uma só.
- Marcar, cancelar, confirmar presença, remarcar e consultar cobrança ficam bloqueados. Consultar horários livres e tirar dúvidas gerais continuam funcionando — não dependem de saber quem é.
- A clínica recebe um aviso interno ("número de mais de um paciente"), que traz só os quatro últimos dígitos do número. Um aviso por contato e por motivo enquanto o anterior não for lido.
- Quem escreve ouve uma única frase, a mesma em todos os casos de encaminhamento: a equipe da clínica vai continuar o atendimento e nada foi alterado. Ela não diz se o número é de mais de uma pessoa, se existe paciente com aquele nome, nem coisa alguma de cadastro, consulta ou cobrança.

### Ação só com identidade resolvida, e só sobre o que é do paciente

- No turno em que o sistema pede nome, confirmação ou esclarecimento, ou entrega a conversa à clínica, **nenhuma ação que dependa da identidade é executada** (`IntentActionRouter`).
- Cancelar, confirmar e remarcar conferem se a consulta é do paciente da conversa; consultar cobrança confere o dono da cobrança. A recusa de um registro alheio é igual à de um registro inexistente — não confirma a ninguém que aquele identificador existe.

### Vínculo de número novo: aprovação do administrador (AD-038)

- Quando a mensagem trata de um paciente que o número não identifica (a própria pessoa em número novo, ou um terceiro), **o pipeline não associa nem vincula nada**: avisa a clínica ("número novo aguardando vínculo") e diz a frase neutra a quem escreve. Isso vale por mais que a pessoa insista ou confirme.
- **`GET /api/v1/contacts/pending`** (só `admin`): os números que escreveram para a clínica e não identificam nenhum paciente, com o nome que a pessoa informou, se informou.
- **`POST /api/v1/contacts/{id}/link`** com `{ "patientId" }` (só `admin`): aprova o vínculo. Responde `201` com `contactId`, `patientId`, `state: "Vinculado"`, `approvedByUserId` e `approvedAt`.
- **Quem aprovou e quando** ficam no evento `ContatoVinculadoAPacienteExistente`, gravado na trilha de auditoria, que não pode ser alterada. O aprovador vem da sessão autenticada, nunca do corpo da requisição. Não houve migration. O domínio recusa um vínculo sem aprovação completa.
- **O vínculo e o seu registro são inseparáveis:** a mudança do contato, o vínculo e os registros de auditoria são confirmados na mesma transação do banco. Se a gravação da auditoria falhar, o vínculo não existe (ver "Integridade da aprovação").
- Recusas, sem gravar nada: sem sessão (401); perfil terapeuta (403); identificador malformado ou corpo inválido (400); contato ou paciente inexistente **ou de outra clínica** (404, pela RLS); contato que já tem paciente — inclusive quando outra aprovação do mesmo contato chegou no mesmo instante — ou número que já consta no cadastro de alguém (409).
- **O telefone do cadastro do paciente não é alterado** pela aprovação. O número novo passa a ser reconhecido nas mensagens que chegam; lembretes e cobranças continuam saindo para o telefone do cadastro, até a clínica alterá-lo.
- **No painel:** em Pacientes, a seção "Números aguardando vínculo", visível só para o administrador. Escolher o paciente e clicar em "Vincular" abre uma confirmação que diz o que muda e que a aprovação fica registrada no usuário; só a confirmação envia.

### Integridade da aprovação: uma transação, com o contato travado

Correção feita em 9 de outubro de 2026, antes de qualquer publicação, a partir do que a revisão de pré-publicação mediu.

**O que estava errado (medido, não suposto).**

- Duas aprovações do mesmo contato ao mesmo tempo passavam as duas. Em 12 rodadas de 12, com pacientes diferentes: `201` + `201`, o contato com dois pacientes e dois registros de aprovação; o número passava a ser tratado como ambíguo e só o banco resolvia. Com o mesmo paciente: `201` + `201`, um vínculo e dois registros de aprovação.
- O registro de auditoria era gravado depois do vínculo, em outra transação: se falhasse, o vínculo existia sem dizer quem o aprovou.
- Toda mensagem recebida regravava o contato inteiro com o estado que tinha lido. Uma mensagem que chegasse durante a aprovação devolvia o contato ao estado anterior, e a aprovação se perdia com o vínculo órfão no banco. O mesmo valia para um nome informado ou um cadastro confirmado no mesmo instante.

**A causa.** Cada chamada de repositório abria a sua transação, e o caso de uso lia, conferia e só depois gravava — sem nada que impedisse outra operação de fazer o mesmo entre a leitura e a gravação.

**A correção.**

1. **Unidade de trabalho.** `UnitOfWork` (porta) e `PrismaService.inUnitOfWork()` (implementação): uma transação para tudo o que os repositórios e o `AuditService` gravarem lá dentro. Os repositórios não mudaram — continuam chamando `forTenant()`, que entra na transação aberta em vez de abrir a sua. É opcional e explícita: nenhum fluxo que não a chame muda de comportamento. A auditoria continua passando só pelo `AuditService`; não foi criado caminho paralelo.
2. **Trava de linha.** A aprovação começa lendo o contato com `SELECT ... FOR UPDATE` (`ContactRepository.findByIdForUpdate()`). A segunda aprovação do mesmo contato espera a primeira confirmar, lê o vínculo que já existe e é recusada com `409`. As conferências são refeitas com a linha travada. É o mesmo recurso já usado no provisionamento do primeiro administrador.
3. **Tudo ou nada.** A mudança do contato, o vínculo e os registros de auditoria são confirmados juntos. Uma falha em qualquer gravação — a do vínculo ou a da auditoria, antes ou depois do `INSERT` — desfaz tudo, e o contato continua podendo ser aprovado depois.
4. **A mesma trava para o que o WhatsApp faz com o contato.** Guardar o nome, concluir o cadastro e a primeira interação de um contato existente passam pela mesma trava, na mesma unidade de trabalho. A operação que chegar depois lê o que a anterior confirmou e é recusada pelo próprio domínio quando já não cabe. De quebra, o cadastro pelo WhatsApp ficou atômico (paciente, contato, associação e auditoria), e duas confirmações simultâneas da mesma pessoa não criam dois pacientes.
5. **Uma mensagem não regrava o contato.** Para um contato que já conversa — quase toda mensagem —, só a atividade é registrada (`touch`), sem tocar em estado nem em nome.

**Por que não uma migration ou uma restrição no banco.** O modelo permite, de propósito, mais de um paciente por contato (casal, responsável e dependente — `docs/01-Domain/08-Contact-e-Identidade-de-Comunicacao.md`, "Relação Contact ↔ Patient"); uma restrição de unicidade por contato seria incompatível com ele. A garantia exigida — no máximo um paciente **por este fluxo** — é dada pela trava e pela rechecagem dentro da transação, sem mudar o esquema nem o nível de isolamento.

**O horário da aprovação.** É um só, tomado uma vez, dentro da transação e depois de a aprovação obter a trava: é o que vai na resposta e no registro de auditoria. Uma aprovação que esperou por outra não carrega o horário de quando começou a esperar. Ele vem do relógio da aplicação, e não do banco, por uma razão medida: é o Prisma, na aplicação, que preenche `created_at` em toda a base — numa transação aberta havia 500 ms, a linha inserida pelo Prisma recebeu +509 ms, e uma inserida por SQL com o `DEFAULT` do banco, +0 ms (o início da transação). Usar o relógio do banco para a aprovação criaria dois relógios nos mesmos registros. O vínculo e os registros de auditoria são gravados em seguida, na mesma transação e pelo mesmo relógio; a prova de que pertencem à mesma transação é o identificador de transação do banco (`xmin`), igual em todas essas linhas — não a coincidência de horários.

**Entre clínicas.** A trava respeita a RLS: o contato de outra clínica não é devolvido nem travado, e quem o pede recebe `404` na hora, sem esperar — mesmo com a aprovação legítima em andamento. Um repositório de outra clínica que tente entrar em uma unidade de trabalho aberta é recusado.

**O que isto custa.** A aprovação passa a depender da auditoria: se o registro não puder ser gravado, a aprovação falha (`500`) e nada muda — é o comportamento pedido. Uma operação que espera por outra consome o tempo da própria transação (o limite padrão do Prisma, 5 s); na prática a espera é de milissegundos.

### O que mudou em relação ao que havia

| Antes (ADR-0062) | Agora | Backlog |
|---|---|---|
| Paciente cadastrado, sozinho no número: reconhecido pelo telefone e atendido sem que o nome seja pedido. | Igual. | — |
| Nenhum código guardava o nome do contato; contato novo nunca virava paciente e não marcava a primeira consulta. | Nome completo, confirmação explícita em outra mensagem, cadastro e primeira consulta. | AD-037 |
| Se houvesse nome, a promoção criaria o cadastro direto, sem confirmação. | Sem confirmação explícita, nenhum cadastro — nem com nome e "confirmo" juntos. | AD-037 |
| A promoção não considerava o paciente já reconhecido pelo telefone (D5b) e criava o paciente antes de conferir o estado do contato. | Número já cadastrado ou nome já existente: nenhum cadastro; todas as conferências antes de gravar. | AD-037 |
| Dois ou mais pacientes no mesmo número: a conversa era ligada ao mais antigo e a ação era executada para ele, com o identificador dele entregue ao provedor de IA. | Ninguém é escolhido, nenhum paciente vai ao provedor de IA, as ações ficam bloqueadas e a clínica é avisada. | AD-038 |
| Quando o classificador pedia confirmação de identidade, a ação era executada no mesmo turno. | Identidade pendente bloqueia a ação. | AD-038 |
| O pedido de encaminhar a um humano vindo do eixo de Contact não era lido por ninguém. | Vira um aviso interno à clínica e a frase neutra a quem escreve. | AD-038 |
| Número novo de paciente conhecido (Cenário 13): nada era vinculado, e não havia como concluir. | Continua sem vínculo automático; a clínica aprova pelo painel, com registro de quem e quando. | AD-038 |
| Cancelar, confirmar, remarcar e consultar cobrança não conferiam se o registro era do paciente da conversa. | Conferem. | AD-038 |

## Critérios de aceite — todos com teste no fluxo real

**AD-037 — identificação e cadastro**

- Paciente cujo número identifica exatamente um cadastro continua reconhecido e atendido sem que o nome seja pedido.
- Contato novo, depois de informar o nome completo **e** confirmar explicitamente, vira paciente e consegue marcar a primeira consulta; a mensagem seguinte já o reconhece.
- Só o nome, uma resposta que não confirma, ou nome e confirmação na mesma mensagem não cadastram ninguém.
- O nome de perfil do WhatsApp nunca é usado como nome do cadastro nem do contato.
- Quem já é paciente e é reconhecido pelo telefone nunca é cadastrado de novo.

**AD-038 — identidade ambígua e vínculo de número novo**

- Com dois ou mais pacientes no mesmo número, nenhuma consulta é marcada ou cancelada e nenhuma cobrança é informada; nenhum paciente é entregue ao provedor de IA; nada do que é dito traz nome, identificador ou valor de um deles; a clínica recebe um aviso, e só um.
- Um número que passa a ser de dois pacientes com a conversa já aberta é tratado como ambíguo na mensagem seguinte.
- No turno em que o sistema pede confirmação de identidade, nenhuma ação é executada.
- Número novo que diz ser de paciente conhecido: nada é vinculado, ninguém é cadastrado de novo, nada é marcado e nada do paciente é revelado — nem com a insistência e a confirmação de quem escreve. A clínica é avisada.
- A aprovação é só do administrador, exige sessão, grava quem aprovou e quando, não pode ser repetida e não muda o telefone do cadastro. Depois dela, o número novo reconhece o paciente; o contato do número antigo permanece intacto.
- Uma clínica não vê nem vincula contato ou paciente de outra; o vínculo aprovado em uma clínica não identifica ninguém na outra.
- Em nome de um paciente reconhecido, consulta e cobrança de **outro** paciente da mesma clínica não são canceladas, confirmadas, remarcadas nem informadas.
- Duas aprovações simultâneas do mesmo contato — para pacientes diferentes ou para o mesmo — resultam em uma aceita (`201`) e uma recusada (`409`), um vínculo e um registro de aprovação.
- Falha na gravação da auditoria ou do vínculo: nada fica gravado, e a mesma aprovação passa depois.
- Uma mensagem, um nome informado ou um cadastro confirmado no mesmo instante da aprovação não a desfazem nem a duplicam.

## Testes

- **Fluxo real** — `apps/backend/test/critical/contact-scenarios-real-flow.test.ts`, 47 testes. Cada mensagem entra pelo webhook assinado, vai para a fila e é processada pelo worker real, contra o Postgres com RLS; a aprovação é feita pela rota do painel, com login. Só a IA é roteirizada, e o roteiro inclui as respostas que tentam forçar uma ação indevida. Fila e worker rodam em um Redis próprio do arquivo (db 12); nenhuma chamada de rede sai dele.
- **Os três defeitos conhecidos** (um da AD-037, dois da AD-038) viraram testes normais desse arquivo, **com as mesmas asserções**, e passam. Não há mais teste de defeito conhecido: `test:known-defects` não encontra nenhum. A convenção da ADR-0062 continua valendo para o próximo defeito que não couber corrigir na hora.
- **Prova de que os testes pegam o defeito:** cada regra foi desligada no código, uma por vez (escolher o mais antigo; agir no turno da confirmação; cadastrar sem confirmação; cadastrar com nome e confirmação juntos; cadastrar com nome já existente; terapeuta aprovando vínculo; ação e cobrança sem conferir o dono; pedido de vínculo sem encaminhar), e em todas o arquivo falhou. O código foi restaurado depois de cada rodada.
- **Integridade da aprovação** — `apps/backend/test/critical/contact-link-approval-integrity.test.ts`, 31 testes, pela rota real, contra o Postgres com RLS. A concorrência é produzida sem esperas de tempo fixo: a primeira operação que trava o contato fica parada com a trava na mão; o teste espera o **banco** informar que outra sessão está bloqueada por ela (`pg_blocking_pids`) e só então a libera. Cobre: duas aprovações simultâneas para pacientes diferentes (5 rodadas) e para o mesmo paciente (3 rodadas); repetição de uma aprovação concluída; falha da auditoria antes e depois do `INSERT`, inclusive do primeiro registro; falha do vínculo antes e depois do `INSERT`; tentativa entre clínicas, sozinha e durante a aprovação legítima; mensagem, nome e cadastro concorrentes, nas duas ordens; duas confirmações do mesmo cadastro; e a prova, pelo `xmin`, de que contato, vínculo e auditoria foram gravados pela mesma transação. Em todos confere o código HTTP, o estado gravado e os registros de auditoria.
- **Prova de que esses testes pegam o defeito:** oito proteções desligadas no código, uma por vez (sem a trava; repositórios fora da transação; aprovação, nome e cadastro lendo sem travar; mensagem regravando o contato; auditoria fora da transação; horário tomado antes da trava) — em todas o arquivo falhou. Código restaurado depois de cada rodada.
- **Repositório, contra Postgres real e RLS** (`test/integration`): a unidade de trabalho (confirma junto, desfaz junto, invisível de fora até confirmar, RLS dentro dela, recusa de outra clínica), a trava de linha e o registro de atividade; e o comportamento de `created_at` que o desenho pressupõe, para avisar se um dia mudar. Além disso: todos os pacientes de um número, do mais antigo para o mais novo; busca por nome sem acento, caixa e espaços; contatos pendentes; isolamento entre clínicas nos três.
- **Unitários:** a regra de identidade, o roteador de Contact, a promoção, a aprovação do vínculo, o aviso à clínica e a conferência de dono.
- **Painel:** 9 testes da seção de aprovação (o que cada perfil vê, a confirmação, o envio, as recusas, o botão travado) e 4 testes de ponta a ponta, pelo navegador contra a API e o banco reais — inclusive o registro de quem aprovou, lido do banco e da tela de Auditoria, e o isolamento entre clínicas.

## Escolhas de implementação que as decisões não fixavam

Tomadas para caber nas três decisões sem inventar regra de produto; qualquer uma pode ser revista.

1. **Encaminhamento humano = notificação interna do painel.** Não existe fila de atendimento humano. O aviso tem quatro tipos (`whatsapp_shared_number`, `whatsapp_link_request`, `whatsapp_possible_duplicate`, `whatsapp_human_review`) e é lido por administradores e terapeutas, como as demais notificações; por isso traz só o final do número.
2. **A secretária não é silenciada.** Depois do encaminhamento ela continua respondendo; o que fica suspenso são as ações que dependem da identidade. O sistema não tem hoje como pausar uma conversa.
3. **`ASSOCIAR` nunca age.** Antes podia associar um contato a um paciente por nome mencionado; agora sempre encaminha. `AssociarContatoUseCase` continua no código, sem chamador no fluxo.
4. **Vínculo só de contato sem paciente.** A aprovação é recusada se o contato já tem paciente ou se o número já consta no cadastro de alguém.
5. **O painel não pede nem guarda como a identidade foi conferida.** A confirmação lembra que a conferência é da clínica, por outro meio, e o sistema grava só quem aprovou e quando.
6. **Unidade de trabalho só onde foi pedida.** A aprovação de vínculo e as mudanças de estado de um contato existente. O restante da aplicação continua no padrão anterior — cada repositório na sua transação, a auditoria gravada em seguida —, que não foi revisto aqui.
7. **A segunda aprovação recebe `409`, também para o mesmo paciente.** Não é tratada como repetição idempotente: quem aprovou foi a primeira, e só ela fica registrada.

## O que continua pendente

Nada disto é defeito mascarado: são comportamentos que as decisões não definem, ou que dependem de validação externa.

1. **Número legitimamente compartilhado** (responsável e dependente, casal — Cenários 11 e 12). Enquanto dois ou mais pacientes tiverem o mesmo número no cadastro, esse número **não marca, não cancela e não consulta cobrança pelo WhatsApp**: o atendimento é da equipe. Não há hoje como a pessoa dizer, na conversa, para qual paciente é o pedido — falta decidir como conferir essa resposta sem listar os pacientes do número e por quanto tempo ela vale.
2. **Desfazer um vínculo aprovado.** Não há rota nem tela. Um vínculo aprovado por engano dá ao número acesso às ações em nome do paciente até ser removido direto no banco. **Recomendado antes do piloto.**
3. **Registro da verificação.** Se a clínica deve informar, e o sistema guardar, como a identidade foi conferida.
4. **Telefone do cadastro depois do vínculo.** Lembretes e cobranças continuam indo para o número antigo; atualizar o cadastro é um passo manual à parte.
5. **Homônimos.** Duas pessoas diferentes com o mesmo nome completo: a segunda não consegue se cadastrar pelo WhatsApp e é encaminhada à clínica, que a cadastra pelo painel.
6. **Cenário 14** (paciente cadastrado pelo painel nascer com o Contact vinculado): não implementado e não necessário para a regra — o telefone do cadastro já identifica o paciente. `Contact.createAlreadyLinked()` continua sem chamador.
7. **Modelo real.** O campo `explicitConfirmation` e o novo texto do classificador não foram exercitados contra a Anthropic. O backend não depende de o modelo acertar para ser seguro, mas a taxa de cadastros concluídos depende. Fica com a validação externa da Tarefa 03.
8. **Fuso horário** (AD-039, ADR-0064): não tocado aqui.
9. **A recusa por nome permite inferir que o nome existe** (ver "Sem duplicidade"). Não há como fechar isso sem mudar a regra de produto: ou o cadastro com nome já existente passa a ser aceito (duplicando), ou nenhum cadastro é confirmado na própria conversa.
10. **Variantes de nome não são barradas.** Só o nome idêntico (sem acento, caixa e espaços) é recusado; "Maria Silva" e "Maria da Silva" viram dois cadastros, sem aviso à clínica. Correspondência aproximada não foi implementada: precisa de regra de produto e de testes próprios.
11. **Estado do paciente (inativo, alta).** Ver "Revisão: pacientes inativos ou com alta", abaixo. Nada foi alterado.

## Revisão: pacientes inativos ou com alta

O que o domínio define hoje, lido no código:

- A máquina de estados do paciente tem `Inativo → Ativo` (reativação) e `Alta` como estado **terminal**, com a nota "reingresso exige novo cadastro, não reabertura".
- **Nenhuma regra usa o estado do paciente para permitir ou negar uma ação.** Marcar consulta só confere se o paciente existe; nada em casos de uso, controllers ou repositórios lê `Inativo` ou `Alta` para decidir. As únicas operações que tocam o estado são as do próprio cadastro (inativar, reativar, dar alta).

Consequências para este fluxo, todas coerentes com o resto do sistema e **nenhuma alterada**:

- o número de um paciente inativo ou com alta continua identificando esse paciente, e ele continua podendo marcar pelo WhatsApp;
- a aprovação de vínculo aceita um paciente em qualquer estado — recusar só aqui criaria uma regra que nenhuma outra parte do sistema tem;
- a conferência de nome já existente conta também pacientes com alta: quem teve alta e volta de um número novo é encaminhado à clínica, e não cadastrado de novo pelo WhatsApp, embora o domínio diga que o reingresso é por novo cadastro. Quem faz esse novo cadastro, hoje, é a clínica, pelo painel.

Se paciente com alta (ou inativo) deve deixar de ser reconhecido, de marcar ou de receber vínculo é decisão de produto, que vale para o sistema inteiro e não só para este fluxo. Fica registrada como pendência (item 11).

## Histórico

- **8 de outubro de 2026** — primeira versão: nome completo e confirmação explícita antes de criar ou vincular um cadastro; número compartilhado nunca resolvido por suposição. Dois pontos ficaram a confirmar: se o paciente já reconhecido pelo telefone continuava dispensado de informar o nome, e o que bastava como confirmação para vincular um número novo.
- **9 de outubro de 2026** — confirmação do responsável pelo produto, que resolve os dois pontos: o número vinculado a exatamente um paciente continua reconhecendo esse paciente; o vínculo de um número novo passa a depender de aprovação da clínica pelo painel, e a confirmação de quem escreve deixa de bastar; na ambiguidade, o sistema pode pedir esclarecimento ou encaminhar a um humano, sem revelar dados de pacientes.
- **9 de outubro de 2026** — implementação (AD-037 e AD-038). O pedido de execução fixou dois pontos que estavam em aberto: quem aprova o vínculo é um **administrador** da clínica, e a aprovação registra **responsável e horário**. Os demais pontos em aberto da versão anterior estão em "Escolhas de implementação" (os que foram resolvidos) e em "O que continua pendente" (os que não foram).
- **9 de outubro de 2026** — correção de integridade da aprovação, antes de publicar. A revisão de pré-publicação mediu que duas aprovações simultâneas eram ambas aceitas, que a auditoria ficava fora da transação do vínculo e que uma mensagem concorrente podia desfazer a aprovação; os três pontos foram corrigidos ("Integridade da aprovação"). Corrigido também o texto que dizia que a pessoa "não fica sabendo" da existência de outro cadastro, e registrada a revisão sobre pacientes inativos ou com alta.

## Documentos relacionados

- [ADR-0062](./ADR-0062-fechamento-dos-testes.md) — achados e evidência; ADR-0045, ADR-0046 e ADR-0055 — modelo de Contact
- `docs/PLANO_DE_EXECUCAO.md` — AD-037 e AD-038 (Epic 9)
- `docs/04-API/01-Contratos-REST.md` — rotas `/contacts`; `docs/02-Arquitetura/16-Politica-RBAC.md` — papéis
- `docs/04-API/02-Contratos-de-Integracoes-Externas.md` — D5b
- `docs/01-Domain/07-Event-Storming-WhatsApp.md` — Cenários 11 a 14
