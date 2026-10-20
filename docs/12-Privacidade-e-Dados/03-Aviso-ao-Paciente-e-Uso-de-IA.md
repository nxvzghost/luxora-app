# 03 — Aviso ao paciente e uso de IA

> **PENDENTE DE APROVAÇÃO E DE AVALIAÇÃO JURÍDICA.** Rascunho de texto. Não está publicado, não aparece para nenhum paciente e não deve ser usado antes da aprovação. Os trechos entre colchetes dependem de decisão. O texto descreve só o comportamento comprovado no inventário ([01](./01-Inventario-e-Fluxo-dos-Dados.md)); quando a política mudar, o aviso muda junto.

## 1. O que falta hoje

- A secretária virtual se apresenta como "agente de recepção" da clínica (`system-prompt.builder.ts`). Nenhuma mensagem diz que o atendimento é automatizado, que usa IA de um fornecedor externo, nem onde ler mais.
- O painel não tem política de privacidade nem termo.
- Não existe página pública da clínica ou da Luxora com essas informações.

## 2. Decisões que este aviso precisa

1. **Quem fala com o paciente:** o aviso é da clínica (que atende o paciente) com informação sobre o fornecedor, ou da Luxora? Depende dos papéis definidos no [documento 04](./04-Responsabilidades-Clinica-e-Fornecedor.md).
2. **Onde aparece:** só na primeira mensagem de cada contato; em toda conversa nova depois de um intervalo; ou só por link.
3. **Onde fica o texto completo:** página da clínica, página da Luxora ou documento enviado pela clínica.
4. **Se o paciente pode optar por falar só com a equipe**, e como o sistema obedece (hoje não existe essa opção).

## 3. Rascunho — mensagem curta no WhatsApp

Para a primeira mensagem de cada contato, antes da resposta da secretária. Precisa caber numa mensagem e não pode prometer o que o sistema não faz.

> Olá! Aqui é o atendimento da [nome da clínica]. As mensagens deste número são respondidas por um assistente automático, com inteligência artificial, que ajuda a marcar consultas e tirar dúvidas administrativas. A equipe da clínica acompanha e assume quando necessário. [Se preferir falar só com a equipe, responda EQUIPE.] Saiba como seus dados são tratados: [link].

Notas:
- "A equipe acompanha e assume quando necessário" é verdade hoje: casos delicados, ambíguos ou fora do administrativo são encaminhados à clínica com aviso no painel. A frase **não** pode dizer que a equipe lê todas as mensagens, porque o painel não mostra o conteúdo das conversas.
- O trecho entre colchetes sobre EQUIPE só entra se a opção for implementada.

## 4. Rascunho — texto completo (para o link)

> **Como seus dados são tratados no atendimento por WhatsApp da [nome da clínica]**
>
> **Quem é responsável.** [A definir: a clínica, como responsável pelo atendimento; a Luxora, fornecedora do sistema Vertex, conforme o papel que a avaliação jurídica definir.]
>
> **O que é guardado.** Seu número de telefone, o nome que você informar, as mensagens que você troca com este número, suas consultas marcadas e as cobranças das sessões. Não pedimos informações sobre sua saúde por este canal; se você escrever algo assim, essa mensagem também é guardada e processada como as demais.
>
> **Atendimento automático.** As mensagens de texto são lidas por um assistente com inteligência artificial fornecida pela Anthropic. Para responder, o assistente recebe a conversa deste número com a clínica [inteira / das últimas N mensagens — a decidir], o nome da clínica e dos terapeutas e o resultado das ações que fizer (por exemplo, o horário marcado). Ele não recebe seu número de telefone. Áudios, fotos e figurinhas não são lidos pelo assistente: a clínica é avisada e responde depois.
>
> **Outros serviços.** As mensagens passam pelo WhatsApp, da Meta. [Condições da Meta e da Anthropic sobre guarda e uso dos dados: a preencher depois de verificadas nos contratos das contas usadas.] [Local de processamento: a verificar.]
>
> **Por quanto tempo.** [A definir pela política de retenção, documento 02.]
>
> **Seus direitos.** Você pode pedir acesso, correção ou exclusão dos seus dados [pelo canal: a definir]. [Prazo de resposta: a definir com avaliação jurídica.] Alguns registros podem precisar ser mantidos por obrigação da clínica [a confirmar quais].
>
> **Contato.** [Encarregado ou responsável: a definir.]

## 5. O que este aviso não pode dizer sem prova

- Que os dados não são usados para treinar modelos, ou que a Anthropic ou a Meta apagam os dados em determinado prazo: depende das condições das contas, não verificadas.
- Que os dados ficam no Brasil.
- Que as mensagens são apagadas depois de um prazo: não há prazo aplicado.
- Que a equipe revisa as respostas antes do envio: não revisa.
