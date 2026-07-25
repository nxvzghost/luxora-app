# 12 — Catálogo de Domain Events (Fase WhatsApp/Contact)

**Status:** Documento Oficial — Marco 1 da Arquitetura do Vertex.
**Regra já existente, reafirmada** (`05-Linguagem-Ubiqua.md`): nenhum evento novo entra em código sem entrada correspondente na Linguagem Ubíqua. Os eventos abaixo são a extensão oficial dessa tabela para esta fase.

| Evento | Aggregate | Significado |
|---|---|---|
| `ContatoCriado` | Contact | Primeiro contato de um telefone desconhecido |
| `ContatoInteragiu` | Contact | Nova mensagem trocada, sem avanço de qualificação |
| `ContatoIdentificado` | Contact | Nome capturado |
| `ContatoAssociadoAPaciente` | Contact | Associação com papel criada (próprio paciente ou responsável por outro) |
| `ContatoPromovidoParaPaciente` | Contact | Evento de promoção — disparado por "primeira consulta agendada" |
| `ContatoVinculadoAPacienteExistente` | Contact | Reconhecido, após confirmação, como novo canal de um Patient já existente (troca de número) |
| `ContatoReconciliadoComPacienteExistente` | Contact | Telefone bate direto com Patient já cadastrado pelo painel — pula qualificação |
| `ContatoArquivado` | Contact | Sem interação além do prazo de retenção, nunca qualificado |
| `ContatoAnonimizado` | Contact | Expurgo de dado pessoal aplicado após arquivamento |
| `PacienteReativado` | Patient | Contact conhecido interage novamente com Patient em estado Inativo |
| `ConsultaAgendada` | Appointment | Já existente — sem alteração de significado nesta fase |
| `ConsultaConfirmada` | Appointment | Já existente |
| `ConsultaRemarcada` | Appointment | Já existente |
| `ConsultaCancelada` | Appointment | Já existente |
| `SessaoCriada` | Session | Já existente |
| `CobrancaGerada` | Billing | Já existente |
| `CobrancaQuitada` | Billing | Já existente |
| `PagamentoRegistrado` | Payment | Já existente |

Eventos marcados "já existente" não são redefinidos aqui — continuam com o significado já registrado em `04-Eventos-de-Dominio.txt`; estão listados apenas para mostrar onde se conectam ao fluxo desta fase (ver `07-Event-Storming-WhatsApp.md`).

## Documentos relacionados

- `07-Event-Storming-WhatsApp.md` (onde cada evento aparece no fluxo)
- `04-Eventos-de-Dominio.txt` (catálogo geral, anterior a esta fase)
- `05-Linguagem-Ubiqua.md` (regra de nomenclatura)
