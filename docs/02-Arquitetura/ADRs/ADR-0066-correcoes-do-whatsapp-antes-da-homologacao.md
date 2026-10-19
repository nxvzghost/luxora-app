# ADR-0066 — Correções do WhatsApp antes da homologação

**Status:** ADOTADA — implementada em 19 de outubro de 2026, com autorização do responsável pelo produto para seguir de forma automatizada. As decisões pequenas registradas abaixo foram tomadas na opção mais conservadora e podem ser revistas pelo responsável pelo produto; nenhuma apaga dado nem muda o que já estava gravado. **Não autoriza o piloto**, não fez deploy e não acionou o CD.
**Origem:** auditoria de 12 e 13 de outubro de 2026 (Painel do Projeto), achados **A-13, A-18, A-15, A-08 e A-10** — o passo 4 da rota mínima até o piloto ("correções do WhatsApp"), começando pelo que não dependia de decisão de produto.
**Antecedentes:** [ADR-0063](./ADR-0063-identidade-confirmada-no-whatsapp.md) (identidade e vínculo de número), [ADR-0065](./ADR-0065-preparacao-para-o-piloto-fase-1.md) (fase 1 da Tarefa 07 e bloqueadores).

## Contexto: os testes externos de 18 e 19 de outubro

- **Meta, saída:** 5 de 5 no commit `faecd7b` (18/10).
- **Asaas, sandbox:** 5 de 5 no commit `faecd7b` (19/10).
- **Anthropic:** em 19/10, com uma chave nova da organização que tem créditos, o modelo real respondeu pela primeira vez. A resposta ao paciente funcionou; a intenção e o classificador de contato vinham com o JSON certo, mas entre cercas de código Markdown, e os dois leitores caíam no ramo de segurança (escalar / `HUMANO`) em toda mensagem. O teste do classificador aceitava `HUMANO`, que é o valor de falha, e passava com o defeito. Corrigido no commit `6b79b1c` (entrada "IA — leitura do JSON do modelo real" do CHANGELOG): 3 de 3 depois da correção, publicado com o CI verde (execução 39298246192).

## A-13 — Dependências

`proxy-addr` 2.0.7 → 2.0.8 (crítica, GHSA-jqcg-44mw-7w3h) e `source-map-js` 1.2.1 → 1.2.2 (alta, GHSA-68fv-2mgg-jv7q), por dois `overrides` no `package.json`; o lockfile muda só nesses dois pacotes. `pnpm audit --prod` passa a mostrar só 3 moderadas (`file-type` 20 e `@nestjs/core` 10), que só têm correção nas próximas versões maiores do NestJS e ficam abertas.

## A-18 — Dado pessoal em log

**Decisão:** o id de job das filas do WhatsApp sai do log. Na entrada ele é o identificador da mensagem na Meta (wamid), que embute o telefone de quem escreveu; na saída é a chave de idempotência, que carrega o mesmo wamid. No lugar vai uma referência opaca e estável (`logReference`: `ref:` e 12 caracteres de um SHA-256). Para achar um job no log, calcula-se a referência do id conhecido. Não é anonimização forte — quem já tem o id confirma a referência —, é só não escrever o telefone.

**Decisão:** o cabeçalho `X-Correlation-Id` só é aceito com 1 a 64 caracteres de `[A-Za-z0-9._:-]`. Qualquer outra coisa (texto longo, espaço, quebra de linha, acento, `]`) é trocada por um UUID gerado — nunca cortada nem "limpa". O valor ia sem limite para logs, filas e cabeçalho da resposta.

## A-15 — Mensagem que não é texto

Áudio, imagem, figurinha, vídeo, documento, localização e contato eram descartados sem rastro (um teste crítico afirmava isso). **Decisão:**

- a mensagem **não passa pela IA**, que não lê esses formatos;
- fica registrada na conversa como um marcador curto (`[áudio — não lido: o atendimento automático só lê texto]`);
- a clínica recebe um aviso no painel pelo mesmo recurso da escalada para humano (motivo novo `unsupported_media`, um aviso por contato enquanto não for lido);
- a pessoa recebe uma resposta fixa, sem dado de paciente, pedindo que escreva. Ela está sempre dentro da janela de 24 horas, porque responde a uma mensagem que acabou de chegar;
- vários áudios seguidos recebem **uma** resposta: ela não se repete na mesma conversa dentro de 6 horas;
- reação (emoji sobre uma mensagem) e aviso de sistema da Meta continuam ignorados;
- a reentrega da Meta não repete nada: o envio usa uma chave de idempotência derivada do wamid, e o aviso não duplica enquanto não for lido.

## A-08 — Falha de envio e de entrega

Uma mensagem que a fila de saída não conseguia enviar só deixava um aviso no log do servidor, e o status `failed` da Meta (mensagem aceita, mas não entregue — o caso típico é a janela de 24 horas, A-07) era ignorado. A cobrança passava a `Enviada` ao entrar na fila e a clínica acreditava ter cobrado. **Decisão:**

- **falha definitiva na fila** (credencial recusada, WhatsApp desconectado, 3 tentativas esgotadas): aviso no painel, criado no contexto da clínica do job. Se o próprio aviso falhar, fica só o registro no log; o worker não cai;
- **status `failed` da Meta:** o registro do envio (`message_log`) passa a `failed` e a clínica recebe um aviso, uma vez; status repetido não faz nada;
- o aviso diz **do que se tratava** (lido da chave de idempotência: a cobrança, o lembrete de atraso, o resumo da agenda, uma resposta automática), o **final do número** e o **motivo** em linguagem da clínica (códigos conhecidos da Meta, como 131047 e 131026; credencial; conexão; tentativas). Nunca o texto da mensagem nem dado de paciente; para respostas automáticas, a referência é opaca (A-18);
- um aviso por assunto enquanto o anterior não for lido;
- **o estado da cobrança não muda**: o aviso diz que ela continua como `Enviada` no painel. Dar à cobrança um estado próprio de falha de envio é decisão de produto em aberto (abaixo).

## A-10 — Desfazer um vínculo aprovado

Não havia como desfazer o vínculo de um número aprovado pela clínica (ADR-0063, pendência 2). **Decisão:**

- só o **administrador** desfaz, como só ele aprova; o id de quem desfez vem da sessão;
- só o **vínculo aprovado**: o número que está no cadastro do próprio paciente é o cadastro que identifica, e a rota responde `409` mandando alterar o cadastro;
- a mesma disciplina da aprovação: uma unidade de trabalho, com o contato travado antes de qualquer conferência; o vínculo apagado, o contato e o registro de auditoria (`ContatoDesvinculadoDePaciente`, com quem desfez e quando) são confirmados juntos, ou nada fica gravado;
- sem outro vínculo, o contato **volta a `Identificado`**, mantém o nome e reaparece entre os números aguardando vínculo; a conversa não é apagada. `Contact.desfazerVinculo` é a única saída de `Vinculado`, e é explícita: a tabela de transições continua tratando `Vinculado` como terminal, para nenhum outro caminho tirá-lo de lá sem querer;
- no painel, a seção **"Números vinculados"** (só administrador) em Pacientes, com "Desfazer vínculo" atrás de uma confirmação que diz o que muda.

Rotas: `GET /contacts/linked` e `POST /contacts/{id}/unlink` (ver `docs/04-API/01-Contratos-REST.md`).

## Verificação

- **Regressão local** no commit `e952fcc`: lint e tipos sem erro; 1.279 testes unitários do backend (eram 1.204), 56 de integração, 580 críticos com 1 pulado e 1 pendente (eram 567), 279 do painel (eram 274) e 33 de 33 de ponta a ponta (eram 32).
- **Prova por mutação**, item a item, desligando a correção: A-18 (a referência opaca e a validação do cabeçalho), A-15 (o descarte silencioso e a resposta a cada áudio), A-08 (o aviso da fila e o tratamento do status) e A-10 (a remoção do vínculo e a recusa do número do cadastro). Em todos os casos os testes novos falharam, e o código foi restaurado byte a byte.
- Os testes críticos rodam contra Postgres e Redis reais: os logs dos dois workers capturados linha a linha, a fila de saída real, a RLS do `message_log` (busca por id da Meta incluída) e uma transação só no desfazer (provado por `xmin`).

## O que fica para decisão do responsável pelo produto

- **A-09** nono dígito; **A-11** paciente inativo ou com alta continua reconhecido; **A-16** entrada da clínica piloto; **A-14** governança dos dados; **A-17** sessão para o piloto.
- **A-07** mensagem fora da janela de 24 horas só com template aprovado: depende da conta da Meta e da aprovação dos textos.
- **A-12** homologação, CD, backup externo e alerta: tem custo.
- **Cobrança com falha de envio.** Se ela deve ganhar um estado próprio. Hoje também não existe reenvio de uma cobrança já `Enviada` (a transição `Enviada → Enviada` não existe), e a fila ignora um job novo com o id de um job que ela ainda guarda — os falhos ficam 14 dias.

## Limitações

- Os status `delivered` e `read` continuam sem uso; o `message_log` só passa de `sent` a `failed`.
- O formato do status `failed` foi testado com o corpo documentado pela Meta, não com um recebido de verdade: a entrada da Meta ainda não tem URL pública (A-05).
- Dois avisos de assunto igual (por exemplo, a cobrança e o lembrete de atraso da mesma cobrança) viram um só enquanto o primeiro não for lido.
- O texto da resposta fixa a mídia e o dos avisos são do agente; podem ser revistos sem mudar a regra.

## Documentos relacionados

- `CHANGELOG.md` — entradas de 19/10/2026
- `docs/04-API/01-Contratos-REST.md` — rotas `/contacts`; `docs/02-Arquitetura/16-Politica-RBAC.md` — papéis
- [ADR-0063](./ADR-0063-identidade-confirmada-no-whatsapp.md) — pendências 2 e 7 atualizadas
