# Privacidade e dados — Vertex

> **PENDENTE DE APROVAÇÃO.** Nada nesta pasta é política adotada, aviso publicado ou contrato. São rascunhos preparados para resolver o bloqueador **A-14** (governança dos dados de pacientes) antes do piloto. Cada texto depende de decisão do responsável pelo produto e, nos pontos marcados, de avaliação jurídica. Nenhum documento daqui declara conformidade com a LGPD.

**Origem:** achado A-14 da auditoria de 13/10/2026, aprofundado na auditoria dos bloqueadores de 20/10/2026 (Painel do Projeto, seção "Auditoria 20 out") e verificado de novo no código em 20/10/2026, no commit `8730a29`.
**Decisão de arquitetura correspondente:** [ADR-0068](../02-Arquitetura/ADRs/ADR-0068-governanca-dos-dados-a-14.md) (proposta).

## Escopo do produto

O Vertex é administrativo: agenda (marcar, cancelar, remarcar, consultar horários), cobranças e pagamentos, e cadastro básico de pacientes (nome e contato). Não guarda prontuário, laudos, exames nem informação clínica, e o atendimento clínico é do profissional com o paciente. Cada clínica usa o próprio número de WhatsApp. O único caminho por onde informação de saúde pode entrar é o texto livre que o paciente decide escrever: o produto não a pede nem a usa. As medidas destes documentos são proporcionais a esse escopo.

## Regra desta pasta

Os documentos descrevem o que o sistema **faz hoje**, com o arquivo e o teste que sustentam cada afirmação. Intenção escrita em outro documento não conta como controle implementado. Onde não há prova, o texto diz "não comprovado". Prazos, bases legais, papéis na LGPD e compromissos de fornecedor **não** são afirmados aqui: aparecem como pergunta em aberto.

## Documentos

| # | Documento | Para quê | Estado |
|---|---|---|---|
| 01 | [Inventário e fluxo dos dados](./01-Inventario-e-Fluxo-dos-Dados.md) | Que dado entra, onde fica, para onde sai, quem acessa | Levantado no código; precisa de revisão |
| 02 | [Retenção, exclusão e backups](./02-Retencao-Exclusao-e-Backups.md) | O que hoje é guardado e por quanto tempo, e as opções de política | Sem política decidida |
| 03 | [Aviso ao paciente e uso de IA](./03-Aviso-ao-Paciente-e-Uso-de-IA.md) | Rascunho do texto ao paciente | Rascunho, sem aprovação jurídica |
| 04 | [Responsabilidades entre clínica e fornecedor](./04-Responsabilidades-Clinica-e-Fornecedor.md) | Roteiro do termo entre a clínica e a Luxora | Roteiro, sem aprovação jurídica |
| 05 | [Solicitações de titulares e incidentes](./05-Solicitacoes-de-Titulares-e-Incidentes.md) | Como atender acesso, correção, exclusão e incidente com o que existe hoje | Procedimento provisório |
| 06 | [Lacunas, decisões e fechamento do A-14](./06-Lacunas-Decisoes-e-Fechamento-do-A-14.md) | Lacunas, pendências separadas em decisões de produto, tarefas técnicas e questões jurídicas, e critérios para encerrar o A-14, no escopo administrativo | Aguarda decisões |

## Legenda de estado usada em todos os documentos

- **Concluído:** implementado, testado e aprovado.
- **Implementado, não aprovado:** existe no código e tem teste, mas a política que o justifica não foi aprovada.
- **Pendente de decisão:** depende do responsável pelo produto.
- **Dependente de terceiros:** depende de avaliação jurídica, de contrato ou das condições de um fornecedor (Meta, Anthropic, Asaas, provedor de hospedagem).
- **Não validado:** existe só em documento, ou existe no código sem teste que o prove.

## Relação com documentos anteriores

Estes documentos não substituem os princípios em [`00-Principios-Arquiteturais.md`](../02-Arquitetura/00-Principios-Arquiteturais.md), [`10-Armazenamento.md`](../02-Arquitetura/10-Armazenamento.md), [`12-Seguranca.md`](../02-Arquitetura/12-Seguranca.md), [`13-Backup-e-Restore.md`](../03-Database/13-Backup-e-Restore.md) e [`08-Contact-e-Identidade-de-Comunicacao.md`](../01-Domain/08-Contact-e-Identidade-de-Comunicacao.md). Aqueles documentos dizem o que **deverá** existir; esta pasta compara isso com o que existe, e propõe o que falta.
