# 01 — Inventário e fluxo dos dados

> **PENDENTE DE APROVAÇÃO.** Levantamento feito no código do commit `8730a29` em 20/10/2026. Precisa ser revisado pelo responsável pelo produto e, na parte de papéis e bases legais, por avaliação jurídica. Nenhum dado real de paciente foi usado: só código, testes e documentos.

## 0. Escopo: dados administrativos e informação clínica

- **O que o produto usa:** nome e telefone de pacientes e contatos; agenda (horário, modalidade, estado); cobranças e pagamentos; as mensagens trocadas para marcar, remarcar, cancelar, confirmar e cobrar.
- **O que não faz parte do produto:** prontuário, laudos, exames, diagnósticos, anotações de sessão. O banco não tem campo para nada disso: `patient` guarda nome, telefone, estado e política de cobrança; `session` guarda só estado e data (`apps/backend/prisma/schema.prisma`).
- **Onde informação de saúde pode entrar:** só no texto livre que o paciente decide escrever no WhatsApp da clínica. O produto não a pede nem a usa, mas nada filtra o texto: ele é guardado e vai à IA como está (seções 3 e 4).
- **O que a IA recebe como instrução:** "nunca mencione dado clínico ou de prontuário" e encaminhar a um humano tudo o que fuja do administrativo ou seja emocionalmente delicado (`system-prompt.builder.ts`, `anthropic-ai.provider.ts`). São instruções ao modelo, não um filtro técnico.
- **Pressuposto fixo no código:** os três textos de instrução da IA descrevem toda clínica como "clínica de saúde mental" (`anthropic-ai.provider.ts`, `contact-intent-prompt-builder.ts`, `system-prompt.builder.ts`). Registrado como L16 no documento 06; não foi alterado.

## 1. Quem são os titulares

| Titular | Como entra no sistema |
|---|---|
| **Paciente** | Cadastrado pela clínica no painel, ou criado a partir de uma conversa no WhatsApp quando a pessoa informa o nome completo e confirma (ADR-0063). |
| **Contato** (quem escreve e ainda não é paciente, ou é responsável por um paciente) | Criado automaticamente a cada número novo que escreve à clínica no WhatsApp (`ReconhecerOuCriarContatoUseCase`). |
| **Terapeuta** | Cadastrado pela clínica. |
| **Usuário do painel** (administrador ou terapeuta da clínica) | Criado pela clínica, ou pelo `bootstrap-admin` no primeiro acesso. |
| **Responsável pela clínica, como cliente da Luxora** | Dados de cobrança da assinatura (nome, e-mail, CPF ou CNPJ). Na clínica piloto não há assinatura paga (A-16). |

## 2. O caminho de uma mensagem do paciente

1. **Meta → API.** A Meta chama `POST /api/v1/webhooks/whatsapp` com o número de quem escreveu, o identificador da mensagem (`wamid`, que embute o telefone) e o texto. A assinatura HMAC é conferida (`whatsapp-webhook.guard.ts`).
2. **Gravação síncrona.** `ReceberMensagemWhatsAppUseCase` grava a conversa (`conversation.phone_number`) e a mensagem com o **texto integral** (`message.content`). Áudio, imagem e figurinha não são baixados: ficam registrados sem conteúdo e a clínica recebe um aviso (A-15).
3. **Fila de entrada (Redis).** Job com `tenantId`, `conversationId`, `patientId`, o **texto** e o `wamid` (`whatsapp-inbound-queue.producer.ts`, `WhatsAppInboundJobData`).
4. **Identificação.** O worker reconhece ou cria o contato pelo telefone e resolve a quem o número pertence (`ResolverIdentidadeDoContatoUseCase`, ADR-0063; com e sem o nono dígito, A-09; paciente inativo não age, A-11).
5. **IA (Anthropic).** Até três chamadas por mensagem — interpretação da intenção, classificação do contato e resposta. Detalhe na seção 4.
6. **Ação.** Conforme a intenção: marcar, remarcar, cancelar, confirmar, consultar cobrança ou horários (`IntentActionRouter`), ou cadastrar o paciente novo (`ContactIntentActionRouter`).
7. **Resposta.** O texto da resposta é gravado em `message.content` e em `inbound_processing_inbox.result_payload` (com o telefone de destino), e enfileirado na fila de saída.
8. **Fila de saída (Redis) → Meta.** Job com o **telefone** e o **texto** (`message-queue.producer.ts`, `MessageJobData`); o worker grava `message_log` (telefone e texto integral) e envia à Meta.

Mensagens iniciadas pela clínica (cobrança e reenvio) seguem os passos 8 em diante. Resumo de agenda e régua de cobrança existem no código, mas as rotas de automação respondem 500 e não há agendador (A-19).

## 3. O que fica guardado no banco

Todas as tabelas com clínica têm RLS (`apps/backend/prisma/rls/enable-rls.sql`); a aplicação conecta com o papel `luxora_app`, sem privilégio de superusuário.

| Categoria | Tabela e campos | Observação |
|---|---|---|
| Identificação do paciente | `patient`: nome, telefone, estado (ativo, inativo, alta), política de cobrança | Exclusão só lógica (`deleted_at`); não há rota que apague. |
| Identificação do contato | `contact`: telefone, nome informado, estado; `contact_patient_association` | `Contact.anonimizar()` existe no domínio e **nada a chama**. |
| Conteúdo das conversas | `conversation.phone_number`; `message.content` (texto integral, entrada e saída) | **Pode conter informação de saúde que o próprio paciente decida escrever**: o produto não a pede nem a usa, mas nada filtra o texto. Nenhuma rota da API devolve esse conteúdo; só o banco. |
| Envios | `message_log`: telefone de destino e texto integral | Rastro de cada envio, com o status. |
| Cache de processamento | `inbound_processing_inbox.result_payload`: texto da resposta e telefone de destino | Cache técnico para retomar o despacho (ADR-0054), sem prazo de limpeza. |
| Agenda | `appointment`, `recurring_block`, `session` (horário, modalidade, estado) | `session` não tem campo de anotação clínica: só estado e data. |
| Financeiro | `billing`, `billing_session`, `payment` (valores, vencimentos, método) | Paciente não vai para a Asaas. |
| Configuração da clínica | `clinic_settings`: chave Pix, nome do recebedor, fuso | Vai no texto das cobranças. |
| Terapeutas | `therapist`: nome, especialidade, telefone | |
| Usuários | `user`: e-mail, hash da senha, papel | Exclusão lógica. |
| Avisos internos | `notification`: título e mensagem | Só os 4 últimos dígitos do número, nunca o texto da mensagem (A-08, A-15). |
| Auditoria | `audit_log`: ator, ação, entidade, `payload` | O evento `ContatoIdentificado` grava o **nome informado** no `payload`. A coluna `ip_address` existe e não é preenchida. Imutável **só na API** (nenhuma rota altera ou apaga, `audit-immutability.test.ts`); no banco o papel da aplicação tem `GRANT ALL` (`infra/docker/postgres-init/01-app-role.sql`). |
| Integração | `whatsapp_integration.access_token` | Cifrado em repouso (ADR-0049). |
| Assinatura da clínica | `clinic_subscription` (ids da Asaas, estado) | Número e CVV do cartão passam pelo backend e não são gravados (`card-data-exposure.test.ts`). |

## 4. O que vai para a Anthropic

**Quando:** a cada mensagem de texto recebida no WhatsApp, inclusive de quem ainda não é paciente. Não vai: áudio, imagem, mensagem de paciente inativo (A-11), mensagens iniciadas pela clínica.

**O quê, comprovado no código:**

- **A conversa inteira**, desde a primeira mensagem, sem limite de quantidade nem de tempo: `prisma-conversation.repository.ts` lê todas as mensagens da conversa (`findMany` ordenado, sem `take`), e `processar-mensagem-whatsapp.use-case.ts` passa o histórico às três chamadas. Inclui as respostas anteriores do agente.
- **O texto da mensagem atual.**
- **Nome da clínica e nomes de todos os terapeutas** (na instrução de `generateResponse`, `anthropic-ai.provider.ts` e `system-prompt.builder.ts`).
- **Resultados de ação**, como texto: horário marcado ou remarcado, valor e estado de uma cobrança, horários livres, e "Cadastro de *nome completo* realizado" quando um paciente novo é cadastrado pela conversa (`intent-action-router.ts`, `contact-intent-action-router.ts`).
- Estado do contato e quantidade de vínculos dele (classificador de contato).

**O que não vai, comprovado por teste:** o corpo de cada chamada tem só `model`, `max_tokens`, `system` e `messages`. Nenhum telefone, nome cadastrado do paciente reconhecido, id de clínica, paciente, contato ou conversa, nem o id do número da Meta — teste crítico `[A-14]` em `test/critical/whatsapp-inbound-idempotency.test.ts`, com prova por mutação. O teste cobre o caso do paciente reconhecido; o telefone, o nome ou qualquer outro dado que **a própria pessoa escrever** no texto vai junto, porque nada filtra o conteúdo.

**Contradição registrada:** [`05-IA/00-Provedor-e-Interface.md`](../05-IA/00-Provedor-e-Interface.md) dizia que o conteúdo enviado é "estritamente administrativo" por causa do Princípio 08. O Princípio 08 trata do que a plataforma armazena por iniciativa própria; não impede o paciente de escrever sobre a própria saúde, e esse texto vai à Anthropic e fica em `message.content`. O documento foi corrigido para apontar para este inventário.

**Não verificado:** as condições da conta da Anthropic usada (retenção de dados pela Anthropic, uso para treinamento, local de processamento). Não há registro disso no repositório. É dependente de terceiros.

## 5. O que vai para a Meta e para a Asaas

| Serviço | Dados | Finalidade |
|---|---|---|
| **Meta (WhatsApp Cloud API)** | Recebe de volta: telefone do destinatário e texto de cada mensagem enviada (respostas do agente, cobranças com valor e chave Pix, avisos ao paciente). Envia ao sistema: telefone, `wamid`, texto e status de entrega. | Canal de comunicação com pacientes e contatos. Cada clínica usa o próprio número e o próprio token. |
| **Asaas** | Nome, e-mail e CPF ou CNPJ do responsável pela clínica; dados do cartão, repassados sem gravação (`asaas-payment.provider.ts`). | Cobrança da assinatura da clínica. **Nenhum dado de paciente.** A clínica piloto não usa (A-16). |

## 6. Logs, traces, filas e cache

| Lugar | O que contém | Prova |
|---|---|---|
| Logs da aplicação | Ids internos, correlationId, referência opaca do job (`ref:` + hash). Nem telefone, nem `wamid`, nem texto. Mensagens de exceção do código não interpolam nome, telefone ou texto (busca no código). | `whatsapp-inbound-idempotency.test.ts` (A-18), testes dos workers; `logReference` |
| Logs de erro | `LuxoraExceptionFilter` registra a pilha da exceção. Erro de biblioteca de terceiro pode trazer conteúdo não previsto. | Não comprovado para todo erro possível. |
| Traces (OTLP, se houver coletor) | HTTP com query string redigida, Redis com nome do comando e quantidade de argumentos. Sem cabeçalhos, sem corpo, sem instrumentação de banco. | `instrumentations.ts`, `trace-redaction.ts`, `trace-no-secrets.test.ts`, ensaio de deploy |
| Filas (Redis) | Entrada: texto e `wamid`. Saída: telefone e texto. | Concluídos apagados em 24 h; falhados em 7 dias (entrada) e 14 dias (saída) (`queue-retention.ts`, ADR-0058). |
| Cache de sessão (Redis) | `versão:papel` por usuário, 60 s. | ADR-0067 |
| Métricas | Contadores sem dado pessoal. | `metrics.service.ts` |
| Painel (navegador) | Só os tokens no `localStorage`; dados da tela ficam em memória (React Query sem persistência). | `auth.store.ts` (`partialize`) |

## 7. Acesso

- **Autenticação:** JWT com versão de sessão conferida a cada requisição (ADR-0056, ADR-0067); limite de tentativas no login (ADR-0050).
- **Isolamento entre clínicas:** RLS em todas as tabelas com clínica, testado em banco real (`multi-tenant-isolation.test.ts`, `tenant-isolation-r6.test.ts`, `cross-clinic-references.test.ts`).
- **Papéis:** administrador e terapeuta. O terapeuta **vê todos os pacientes da clínica**, não só os seus (`GET /patients` não restringe papel nem terapeuta). Auditoria só para o administrador.
- **Conteúdo das conversas:** nenhuma rota da API devolve `message.content`. Quem lê as conversas hoje é quem tem acesso ao banco.
- **Acesso da Luxora:** o papel `super_admin` existe para operação e passa por cima do RBAC dentro da clínica do token. Quem administra o servidor e o banco tem acesso a tudo, inclusive ao conteúdo das conversas. Não há registro de quem lê dados direto no banco.

## 8. Backups e cópias

- **Antes de cada deploy**, `deploy.sh` grava um `pg_dump` completo no disco do próprio servidor (`$STATE_DIR/backups`, permissão 700). Não há rotação: os arquivos se acumulam (ADR-0060, `DEPLOY_RUNBOOK.md`).
- **Backup externo e agendado:** não existe (A-12). A tabela de retenção de [`13-Backup-e-Restore.md`](../03-Database/13-Backup-e-Restore.md) (30 dias, 12 semanas, 12 meses) é intenção, não está aplicada.
- **Consequência:** dado apagado ou anonimizado no banco continua em todo dump feito antes, pelo tempo que o dump existir.
- **Redis:** guarda filas por até 14 dias (falhados) e o cache de sessão; a persistência em disco do Redis depende da configuração do servidor, não verificada.

## 9. Resumo: comprovado, documentado e ausente

| Controle | Estado |
|---|---|
| Isolamento entre clínicas (RLS) | Concluído (testado) |
| Token da Meta cifrado em repouso | Concluído (testado) |
| Logs e traces sem telefone, texto ou token | Implementado, testado nos caminhos do WhatsApp |
| Corpo da chamada à Anthropic sem telefone e sem identificadores internos | Implementado, testado (A-14, 20/10) |
| Retenção das filas no Redis | Implementado (24 h / 7 d / 14 d) |
| Limite do histórico enviado à IA | Ausente — pendente de decisão (D2) |
| Retenção de conversas, envios, contatos, avisos, auditoria, backups | Ausente — pendente de decisão |
| Exclusão, correção e exportação a pedido do titular | Ausente (só pelo banco) |
| Aviso ao paciente sobre atendimento automatizado e IA | Ausente |
| Política de privacidade e termo no painel | Ausente |
| Imutabilidade da auditoria no banco | Não validado (só na API) |
| Registro de quem leu dado de paciente | Ausente |
| Condições de dados da Anthropic e da Meta | Dependente de terceiros, não verificado |
