# ADR-0068 — Governança dos dados dos pacientes (A-14)

**Status:** PROPOSTA — pendente de decisão do responsável pelo produto e de avaliação jurídica. Nada aqui foi adotado como política. A única mudança de código desta revisão é um teste.
**Origem:** achado **A-14** da auditoria (governança dos dados de pacientes), aprofundado na auditoria dos bloqueadores de 20/10/2026 e revisto no código do commit `8730a29` em 20/10/2026.
**Documentos:** [`docs/12-Privacidade-e-Dados/`](../../12-Privacidade-e-Dados/README.md) — inventário, retenção, aviso ao paciente, responsabilidades, titulares e incidentes, lacunas e critérios de fechamento.

## Contexto

O Vertex trata dados de pacientes de clínicas de saúde mental: identificação, agenda, cobranças e o texto das conversas no WhatsApp, que o próprio paciente pode usar para falar da sua saúde. Os documentos de arquitetura falam em minimização, retenção e LGPD como intenção (`10-Armazenamento.md`, `12-Seguranca.md`, `13-Backup-e-Restore.md`, `08-Contact-e-Identidade-de-Comunicacao.md`), sem regra aplicada. A revisão de 20/10 confirmou no código, com evidência no [inventário](../../12-Privacidade-e-Dados/01-Inventario-e-Fluxo-dos-Dados.md):

- a conversa inteira vai à Anthropic a cada mensagem, sem limite;
- nenhum prazo de guarda existe fora das filas do Redis;
- não há exclusão, anonimização nem exportação por titular, e `Contact.anonimizar()` não tem chamador;
- o paciente não é informado de que fala com atendimento automatizado;
- a auditoria é imutável só na API e guarda o nome informado por contatos;
- o backup é só o `pg_dump` antes de cada deploy, no disco do servidor, sem rotação.

## Decisão (proposta)

1. **A governança fica em `docs/12-Privacidade-e-Dados/`**, separada dos documentos de princípio, com a regra de que cada afirmação cita o código ou o teste que a sustenta, e de que nada vira política sem aprovação.
2. **Nenhuma regra de retenção, exclusão automática, consentimento ou aviso entra no código antes da decisão correspondente** (documento 06, decisões D-A a D-I) e, onde marcado, da avaliação jurídica (J-1 a J-5). Uma obrigação jurídica incerta não vira regra arbitrária de código.
3. **O que o sistema já não envia à IA passa a ser protegido por teste.** Teste crítico `[A-14]` em `test/critical/whatsapp-inbound-idempotency.test.ts`: numa conversa de paciente reconhecido, com histórico, as três chamadas à Anthropic levam só `model`, `max_tokens`, `system` e `messages`, e nenhuma contém o telefone, o nome cadastrado, nem ids de clínica, paciente, contato, conversa ou número da Meta. Prova por mutação: campo extra no corpo, telefone no histórico e id da clínica na instrução derrubam o teste.
4. **A afirmação de `05-IA/00-Provedor-e-Interface.md` de que o conteúdo enviado à IA é "estritamente administrativo" foi corrigida.** O Princípio 08 trata do que a plataforma armazena por iniciativa própria; não impede o paciente de escrever sobre a própria saúde.

## Propostas técnicas que aguardam autorização

Cada uma só entra em código com autorização e teste; nenhuma apaga dado de produção por conta própria.

| Proposta | Depende de |
|---|---|
| Limitar o histórico enviado à IA por quantidade e tempo | D-A |
| Enviar só o primeiro nome no resultado do cadastro feito pela conversa | D-B |
| Apagar `result_payload` quando a entrada chega a `dispatched` | D-C |
| Tirar o nome do `payload` de `ContatoIdentificado`; tornar `audit_log` imutável no banco | D-D |
| Rotina de anonimização de contato e de paciente, sem agendador | D-F, D-G |
| Registro dos pedidos de titular | D-G |
| Aviso de atendimento automatizado na primeira mensagem | D-H, J-5 |
| Backup externo cifrado com prazo | A-12, D-F |

## Alternativas consideradas

- **Escrever a política de retenção com prazos de mercado** (por exemplo, 90 dias para conversas). Rejeitada: prazos sem finalidade decidida nem avaliação jurídica seriam regra arbitrária.
- **Filtrar dado de saúde do texto antes de enviar à IA.** Não proposta agora: detectar conteúdo clínico em texto livre é impreciso, e um filtro que falha em silêncio dá falsa segurança. Limitar o histórico reduz a exposição de forma verificável.
- **Implementar a exclusão física em cascata.** Rejeitada como primeira opção: quebra a contabilidade e a trilha de auditoria; a anonimização preserva as duas.

## Consequências

- O A-14 continua aberto. Os critérios de fechamento estão no documento 06 e exigem decisões, textos aprovados, controles implementados e testados e o termo com a clínica.
- O piloto com clínica real continua bloqueado por este achado.
- O teste `[A-14]` passa a falhar se alguém acrescentar telefone, nome cadastrado ou identificador interno ao que vai para a IA.

## Verificação desta revisão

- Teste `[A-14]`: verde; três mutações, cada uma restaurada, derrubam o teste.
- Suíte crítica, unitários, integração, tipos e lint: ver o CHANGELOG da data.
