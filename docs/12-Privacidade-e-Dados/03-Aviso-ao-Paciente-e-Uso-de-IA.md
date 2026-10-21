# 03 — Aviso ao paciente e uso de IA

> **DIRETRIZ APROVADA; TEXTO E LINK PENDENTES DE REVISÃO.** Em 20/10/2026 o responsável pelo produto aprovou a D-H como diretriz: aviso fixo, enviado pelo código na primeira resposta a cada número, em nome da clínica, explicando o atendimento administrativo automatizado. Os textos abaixo são propostas: não estão publicados, não aparecem para nenhum paciente e não devem ser usados com paciente real antes da revisão (J-5), da definição do responsável (J-1) e da verificação dos fornecedores (L8). Os trechos entre colchetes dependem de decisão. O texto descreve só o comportamento comprovado no inventário ([01](./01-Inventario-e-Fluxo-dos-Dados.md)) ou já decidido; quando a política mudar, o aviso muda junto.

## 1. O que falta hoje

- A secretária virtual se apresenta como "agente de recepção" da clínica (`system-prompt.builder.ts`). Nenhuma mensagem diz que o atendimento é automatizado, que usa IA de um fornecedor externo, nem onde ler mais.
- O painel não tem política de privacidade nem termo.
- Não existe página pública da clínica ou da Luxora com essas informações.

## 2. Decisões que este aviso precisa

1. **Quem fala com o paciente:** o aviso é da clínica (que atende o paciente) com informação sobre o fornecedor, ou da Luxora? Depende dos papéis definidos no [documento 04](./04-Responsabilidades-Clinica-e-Fornecedor.md).
2. **Onde aparece:** só na primeira mensagem de cada contato; em toda conversa nova depois de um intervalo; ou só por link.
3. **Onde fica o texto completo:** página da clínica, página da Luxora ou documento enviado pela clínica.
4. **Se o paciente pode optar por falar só com a equipe**, e como o sistema obedece (hoje não existe essa opção).

**Decidido em 20/10/2026 (diretriz):** (1) o aviso é em nome da clínica, que é dona do número; o papel jurídico de cada uma continua com o J-1. (2) Vai uma única vez por número, na primeira resposta, e o envio fica registrado na conversa, não deduzido do histórico (que a retenção vai apagar). (3) Onde fica o texto completo: **pendente de revisão**. (4) A opção de falar só com a equipe fica fora do piloto. Em aberto: o aviso quando o primeiro contato é uma cobrança enviada pela clínica (ligado ao A-07).

## 3. Proposta — mensagem curta no WhatsApp

Vai uma única vez por número, no início da primeira resposta enviada (resposta da secretária, resposta a áudio ou imagem, ou resposta a paciente inativo), na mesma mensagem. Não pode prometer o que o sistema não faz. Texto pendente de revisão; a versão anterior deste rascunho fica no histórico do Git.

> Olá! Você está falando com o atendimento automático da [nome da clínica], para agendamentos e pagamentos, com apoio de inteligência artificial. Assuntos de saúde são tratados diretamente com o profissional: por favor, não envie esse tipo de informação por aqui. Quando necessário, a equipe da clínica assume a conversa. Como tratamos seus dados: [link]

Notas:
- "A equipe acompanha e assume quando necessário" é verdade hoje: casos delicados, ambíguos ou fora do administrativo são encaminhados à clínica com aviso no painel. A frase **não** pode dizer que a equipe lê todas as mensagens, porque o painel não mostra o conteúdo das conversas.
- A opção EQUIPE ficou fora do piloto (D-H); por isso não aparece no texto.

## 4. Rascunho — texto completo (para o link)

> **Como seus dados são tratados no atendimento por WhatsApp da [nome da clínica]**
>
> **O que é este atendimento.** Este número é o canal administrativo da [nome da clínica] para marcar, remarcar, cancelar e consultar horários, e para cobranças e pagamentos. Não é atendimento de saúde: o seu atendimento clínico é com o profissional.
>
> **Quem é responsável.** [A definir: a clínica, como responsável pelo atendimento; a Luxora, fornecedora do sistema Vertex, conforme o papel que a avaliação jurídica definir.]
>
> **O que é guardado.** Seu número de telefone, o nome que você informar, as mensagens que você troca com este número, suas consultas marcadas e as cobranças das sessões. O sistema é administrativo: não guarda prontuário, laudos, exames nem informação clínica, e o seu atendimento clínico é com o profissional. Não pedimos informações sobre sua saúde por este canal; se você escrever algo assim, essa mensagem também é guardada e processada como as demais.
>
> **Atendimento automático.** As mensagens de texto são lidas por um assistente com inteligência artificial fornecida pela Anthropic. Para responder, o assistente recebe as últimas 20 mensagens desta conversa trocadas nas últimas 72 horas (decisão D-A, implementada em 21/10/2026), o nome da clínica e dos profissionais e o resultado das ações que fizer (por exemplo, o horário marcado). Ele não recebe seu número de telefone. Áudios, fotos e figurinhas não são lidos pelo assistente: a clínica é avisada e responde depois.
>
> **Outros serviços.** As mensagens passam pelo WhatsApp, da Meta. [Condições da Meta e da Anthropic sobre guarda e uso dos dados: a preencher depois de verificadas nos contratos das contas usadas.] [Local de processamento: a verificar.]
>
> **Por quanto tempo.** As mensagens são guardadas como histórico administrativo da clínica [prazo e condições a definir com avaliação jurídica, J-2 e J-4], e o contato de quem não chegou a ser paciente é anonimizado depois de 90 dias sem conversa. O cadastro, as consultas e as cobranças ficam pelo prazo que a clínica precisa manter [a definir com avaliação jurídica, J-4]. *(O rascunho de 20/10/2026 dizia que o texto seria apagado em 90 dias; a decisão foi revista em 21/10/2026 e o histórico é preservado. O prazo dos contatos ainda não está aplicado: esta frase só pode ser publicada quando a rotina estiver em uso.)*
>
> **Seus direitos.** Você pode pedir acesso, correção ou exclusão dos seus dados [pelo canal: a definir]. A exclusão é feita por anonimização: o nome e o telefone saem, e os registros de consultas e pagamentos que a clínica precisa manter ficam sem identificação. [Prazo de resposta: a definir com avaliação jurídica.] Alguns registros podem precisar ser mantidos por obrigação da clínica [a confirmar quais].
>
> **Contato.** [Encarregado ou responsável: a definir.]

## 5. O que este aviso não pode dizer sem prova

- Que os dados não são usados para treinar modelos, ou que a Anthropic ou a Meta apagam os dados em determinado prazo: depende das condições das contas, não verificadas.
- Que os dados ficam no Brasil.
- Que as mensagens são apagadas depois de um prazo: o histórico é preservado, sem exclusão automática (revisão de 21/10/2026). A exclusão só acontece a pedido, por anonimização (D-G), ainda não implementada.
- Que a equipe revisa as respostas antes do envio: não revisa.
