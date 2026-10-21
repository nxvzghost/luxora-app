# 02 — Retenção, exclusão e backups

> **APROVADO EM PARTE, NÃO IMPLEMENTADO.** Em 20/10/2026 o responsável pelo produto aprovou 90 dias para o texto das conversas e para os contatos que não viraram pacientes (seção 5). Em 21/10/2026 revisou a parte das conversas: o histórico é preservado como registro administrativo, sem exclusão automática por prazo; os 90 dias continuam só para os contatos (seção 5). As seções 1 a 4 continuam descrevendo o que o sistema faz hoje e as opções que levaram à decisão. Cadastro, agenda, financeiro e auditoria dependem de avaliação jurídica (J-4); backups, da hospedagem (A-12). Nenhuma exclusão automática roda antes da implementação aprovada e testada.

## 1. O que é guardado hoje, e por quanto tempo

| Categoria | Onde | Prazo aplicado hoje | Como sai hoje |
|---|---|---|---|
| Texto das conversas | `message.content`, `conversation` | Indefinido | Só por comando direto no banco |
| Envios (telefone e texto) | `message_log` | Indefinido | Só pelo banco |
| Cache de resposta (texto e telefone) | `inbound_processing_inbox.result_payload` | Indefinido | Só pelo banco |
| Contatos nunca qualificados | `contact` | Indefinido | `Contact.anonimizar()` existe e nada a chama |
| Pacientes | `patient` | Indefinido | Só inativar ou dar alta; exclusão lógica |
| Agenda e sessões | `appointment`, `session`, `recurring_block` | Indefinido | Só pelo banco |
| Financeiro | `billing`, `payment` | Indefinido | Só pelo banco |
| Avisos internos | `notification` | Indefinido | Só pelo banco |
| Auditoria (inclui nome informado por contatos) | `audit_log` | Indefinido | Nenhuma rota apaga; o banco permite |
| Usuários | `user` | Indefinido | Exclusão lógica |
| Filas | Redis | 24 h (concluídos); 7 dias (entrada, falhados); 14 dias (saída, falhados) | Automático (`queue-retention.ts`) |
| Cache de sessão | Redis | 60 s | Automático |
| Logs da aplicação | Saída padrão do contêiner | Depende do servidor | Não configurado |
| Traces | Coletor OTLP, se houver | Depende do destino | Não configurado |
| Backups antes de deploy | Disco do servidor, `$STATE_DIR/backups` | Indefinido, sem rotação | Manual |
| Backup externo | — | Não existe (A-12) | — |

## 2. O que precisa ser decidido, categoria por categoria

No escopo administrativo, a decisão necessária para operar cobre as categorias de maior volume — texto das conversas, contatos que nunca viraram pacientes e backups (D-F no documento 06). As demais esperam a avaliação jurídica (J-4).

Para cada categoria, a decisão tem três partes: **por que se guarda** (finalidade), **por quanto tempo** e **o que acontece no fim** (apagar, anonimizar ou arquivar). Os prazos não estão aqui de propósito: dependem da finalidade decidida e, em parte, de avaliação jurídica.

| Categoria | Pergunta a decidir | Ponto que depende de avaliação jurídica |
|---|---|---|
| Texto das conversas | A clínica precisa do texto integral depois que o atendimento foi resolvido? Por quanto tempo? | O texto serve ao agendamento e à cobrança. O produto não pede informação de saúde, mas o texto livre pode trazê-la: se isso muda o tratamento exigido (J-2). O Vertex não é prontuário (Princípio 08). |
| Envios (`message_log`) | O rastro precisa do texto, ou basta data, destinatário mascarado e status? | Prova de cobrança enviada, se a clínica quiser essa prova. |
| Cache de resposta | Pode ser limpo depois do despacho? | Nenhum: é técnico. |
| Contatos nunca qualificados | Prazo sem interação até anonimizar (o domínio recomenda 90 a 180 dias, sem decisão) | Base legal para guardar contato que nunca virou paciente. |
| Pacientes inativos ou com alta | Quanto tempo depois da alta os dados de identificação ficam? | Prazo mínimo de guarda de registros administrativos da clínica (J-4). O cadastro do Vertex é só nome e contato, sem conteúdo de prontuário; a "exigência regulatória de prontuário" citada no documento de domínio não foi validada e não descreve o que o Vertex guarda. |
| Financeiro | Quanto tempo os registros de cobrança e pagamento ficam? | Obrigações fiscais e contábeis da clínica. |
| Auditoria | Quanto tempo; e como conciliar a imutabilidade com a exclusão de dado pessoal no `payload` | O documento `08-Auditoria.md` pede "no mínimo o prazo legal", sem dizer qual. |
| Logs e traces | Prazo no destino escolhido (A-12) | — |
| Backups | Prazo da cópia; o que fazer com um dado apagado que ainda está num backup | Se basta deixar o backup expirar no prazo, com registro do pedido. |

## 3. Opções técnicas, sem prazos

**Para conversas e envios**

- **A. Apagar o texto depois de N dias**, mantendo a conversa, a data e a direção. Menor exposição; a clínica perde o histórico escrito.
- **B. Anonimizar a conversa inteira** depois de N dias da última mensagem (telefone e texto removidos). Mantém contagens para métrica.
- **C. Guardar enquanto o paciente existir** e apagar junto com o paciente. Mais simples; maior exposição.

**Para o fim da vida de um paciente**

- **Exclusão lógica (hoje)** não remove nada. Exclusão física em cascata atravessa agenda, financeiro e auditoria; anonimização (trocar nome e telefone por um marcador) preserva a contabilidade e a trilha. A anonimização é a opção técnica menos destrutiva e a única compatível com uma auditoria que não se apaga.

**Para a auditoria**

- Tirar dado pessoal do `payload` daqui em diante (o nome informado no evento `ContatoIdentificado` pode virar referência ao contato), e decidir o que fazer com os registros antigos. Tornar a tabela imutável no banco também (revogar `UPDATE` e `DELETE` do papel da aplicação, ou gatilho) — hoje a imutabilidade só existe na API.

**Para backups**

- Backup externo cifrado, com prazo fixo (A-12). Pedido de exclusão: o dado sai do banco na hora e dos backups quando eles vencerem; o pedido e a data ficam registrados. Restaurar um backup exige reaplicar as exclusões registradas depois da data dele.

## 4. O que pode ser implementado sem esperar a política

Nada que apague ou altere dado de produção. Pode ser preparado, desligado por padrão, com teste:

- a rotina de anonimização de contato (`Contact.anonimizar()` já existe), sem agendador e sem prazo;
- a limpeza do `result_payload` depois do despacho;
- o registro dos pedidos de exclusão (quem pediu, quando, o que foi feito), que serve a qualquer política.

Cada um desses itens fica proposto na ADR-0068 e só entra em código com a autorização correspondente.

## 5. Decisão do responsável pelo produto (20/10/2026, noite)

Aprovada em parte. **Nada disto está implementado**; a rotina está no [documento 07](./07-Plano-de-Implementacao-das-Decisoes.md), etapa 4. Os 90 dias são decisão de produto, com a finalidade explícita abaixo; não são prazo legal.

| Categoria | Decisão | Finalidade e fim |
|---|---|---|
| Texto das conversas (`message.content`) | ~~**90 dias**~~ **Preservado, sem exclusão automática** (revisão de 21/10/2026) | Decisão de 20/10/2026, revista: o texto serve ao agendamento e à cobrança do momento; o painel não mostra conversas e, com a D-A (implementada e publicada em 21/10/2026, `6d307e0`), a IA só recebe as últimas 20 mensagens das últimas 72 horas. No fim, o texto é apagado; a linha fica com data, direção e status. **Desde 21/10/2026:** o histórico é registro administrativo da clínica, guardado sem prazo automático (ver abaixo) |
| Contatos que nunca viraram pacientes | **90 dias sem interação** | Arquivar e anonimizar (`Contact.arquivar()` e `anonimizar()` já existem para `Novo` e `Conversando`) |
| Registro de envios (`message_log`) | **Preservado, sem exclusão automática** (revisão de 21/10/2026) | Proposta anterior da análise, superada: o texto sairia no mesmo prazo, ficando data, status e o final do número. Os registros disponíveis de envio e entrega ficam com o histórico |
| Cache de resposta (`result_payload`) | A confirmar | Proposta técnica (D-C): limpar ao despachar, com a correção da retomada. Não citado no parecer |
| Cadastro, agenda, cobranças e pagamentos | **Pendente de revisão jurídica (J-4)** | Nada é apagado nem anonimizado por prazo até a resposta |
| Auditoria | **Pendente de revisão jurídica (J-4)** | Idem; o nome no `payload` depende da D-D |
| Backups | **Depende da hospedagem (A-12)** | Rotação dos backups antes do deploy e backup externo ficam para a escolha do provedor |
| Filas do Redis e cache de sessão | Já aplicados no código | 24 h, 7 e 14 dias; 60 s |

~~A confirmar antes da implementação: se os 90 dias do texto contam **por mensagem** (o texto de cada mensagem sai 90 dias depois de enviado) ou **pela última mensagem da conversa** (o texto inteiro sai 90 dias depois da última troca). Na segunda leitura, uma conversa ativa guarda todo o texto antigo; a recomendação técnica é a primeira.~~ Pergunta superada pela revisão abaixo.

**Revisão de 21/10/2026 (D-F, histórico das conversas).** O responsável pelo produto decidiu preservar o histórico das conversas de WhatsApp sobre agendamentos, cancelamentos, remarcações e cobranças como registro administrativo da clínica, para consultar o que aconteceu, esclarecer divergências e manter registros que possam servir de evidência. Nenhuma mensagem ou conversa é apagada automaticamente por ter completado 90 dias, e não haverá rotina de exclusão automática do histórico. Ficam preservados datas, horários, a origem (direção) das mensagens e os registros disponíveis de envio e entrega. A consulta segue as permissões da clínica: a decisão não autoriza acesso irrestrito nem muda as permissões existentes, e hoje o painel não mostra o conteúdo das conversas (uma tela de consulta seria implementação nova, ainda não autorizada). A D-A não muda: a IA continua recebendo no máximo 20 mensagens, contando a atual, das últimas 72 horas (`6d307e0`); guardar o histórico não é enviá-lo à IA. Continuam como estavam os 90 dias para os contatos que não viraram pacientes e a anonimização a pedido (D-G). Não é aprovação jurídica: se a guarda sem prazo automático do texto livre, que pode conter informação de saúde escrita pelo paciente, é adequada, e por quanto tempo a clínica deve ou pode guardar esse histórico, dependem de avaliação jurídica (J-2, J-4).
