# Sprint 0 — Entregável 1: Auditoria Final

## Metodologia

Esta auditoria revisa criticamente toda a documentação da Luxora (91→110 arquivos técnicos em `CTO/clinicos/docs`, 1.373 arquivos institucionais em `CEO`) no estado atual, após todas as correções realizadas ao longo do processo de análise e refinamento. Toda alteração proposta aqui vem acompanhada de justificativa — nenhuma mudança cosmética sem motivo técnico ou de negócio.

---

## 1. Inconsistências — status: resolvidas

| Inconsistência original | Resolução | Onde |
|---|---|---|
| Nome do produto (ClinicOS vs. Luxora) | Unificado como Luxora em toda a documentação técnica e institucional | Todos os documentos |
| Relação Sessão↔Cobrança (1:1 vs. agregada) | Corrigida para N:N via `billing_session`, suportando cobrança diária/semanal/mensal | `03-Database/03-Relacionamentos.md` |
| Política de cobrança fixa por clínica | Corrigida para política por paciente com herança do padrão da clínica | `03-Database/02-Tabelas.md`, `06-UX/01-Fluxo-Configuracao-Clinica.md` |
| `08-Auditoria.md` duplicado de `10-Views.md` | Reescrito com especificação real de `audit_log` | `03-Database/08-Auditoria.md` |
| Bugs de formatação (Princípios Arquiteturais, ADR-0004) | Reescritos preservando 100% do conteúdo original | `02-Arquitetura/00-Principios-Arquiteturais.md`, `ADR-0004.md` |
| 4 categorias do CEO com subpastas trocadas (25-28) | Reconstruídas com conteúdo correto (Financeiro, Operações, Customer Success, RH) | `CEO/25` a `CEO/28` |
| 12 subpastas de Offboarding com conteúdo de Investidores | Reescritas do zero com conteúdo correto de desligamento | `CEO/17 - Recrutamento/12 - Offboarding` |
| Pasta "08 - Novos Segmentos" duplicada dentro de Expansão | Identificada como "Novos Produtos" mal nomeada; renomeada e corrigida | `CEO/19 - Expansao/08 - Novos Produtos` |
| 71 READMEs institucionais substituídos por resumos genéricos | Conteúdo original real recuperado e incorporado | Diversas pastas do CEO |
| 123 documentos da árvore profunda de Expansão perdidos | Reconstruídos com fidelidade total ao original | `CEO/19 - Expansao` (completo) |

## 2. Conflitos — status: resolvidos

| Conflito | Resolução |
|---|---|
| Domain definia "Sessão" única; Database tinha `session` e `appointment` separados | Resolvido em `01-Domain/05-Linguagem-Ubiqua.md`: `appointment` = reserva de horário, `session` = atendimento realizado |
| Nomenclatura "Motor" usada para o núcleo e para sub-serviços | Ainda **pendente de decisão** — ver seção 4 |
| Multi-tenancy sem defesa em profundidade no banco | Resolvido com Row-Level Security nativa do PostgreSQL | `03-Database/09-Multi-Tenant.md` |

## 3. Lacunas — status: fechadas

| Lacuna original | Fechada com |
|---|---|
| Pastas `04-API`, `05-IA`, `06-UX`, `07-Infra`, `09-Testes` vazias | Todas escritas com conteúdo técnico completo |
| Ausência de régua de comunicação de inadimplência | `05-IA/03-Gestao-de-Inadimplencia.md`, com limiares reais (7 e 40 dias) |
| Ausência de fronteira Motor Operacional ↔ n8n | ADR-0021 |
| Ausência de tom de voz/estilo conversacional do agente de IA | `05-IA/01-Tom-de-Voz-e-Estilo-Conversacional.md`, calibrado com conversa real |
| Ausência de rotina de controle de agenda para o terapeuta | `05-IA/02-Rotina-de-Controle-de-Agenda.md` |
| Ausência de fechamento financeiro mensal formal | `06-UX/05-Fluxo-Fechamento-Mensal.md` |
| Pesquisa de concorrentes inexistente | `CEO/11 - Concorrentes`, pesquisa pública real com fonte |

## 4. Decisões pendentes reais (não fechadas nesta auditoria — exigem input humano)

Estas são as únicas pendências genuínas que restam. Nenhuma delas bloqueia o início do Módulo 1, mas todas devem ser resolvidas antes do módulo específico que dependem:

| # | Decisão pendente | Bloqueia qual módulo | Recomendação |
|---|---|---|---|
| 1 | Nomenclatura "Motor Operacional" vs. "Motor Financeiro/Agenda/Cobrança" (sub-serviços) | Módulo 4 (Motor Operacional) | Renomear sub-serviços para "Serviço de Domínio X" (ex: `PaymentDomainService`), reservando "Motor" exclusivamente para o núcleo (ADR-0001) |
| 2 | Consolidação dos 15 Serviços de Domínio em 5-6 para o MVP | Módulos 5-9 | Já recomendado no relatório de arquitetura original — decisão de escopo, não técnica; sugiro validar com Pedro (CTO) antes do Módulo 5 |
| 3 | Fluxo de onboarding/migração de dados de sistema anterior | Módulo 5 (Cadastros) | Ainda não especificado — recomendo especificar antes do primeiro cliente real, não antes do Módulo 1 |
| 4 | Provedor de nuvem definitivo (Railway confirmado como recomendação técnica, mas sem cotação oficial da conta) | Módulo 1 (Fundação) | Validar com conta de teste real antes do primeiro deploy — não bloqueia o código, bloqueia o primeiro deploy |
| 5 | Validação de LGPD/regulatório por advogado especializado | Lançamento comercial | Não bloqueia nenhum módulo técnico — bloqueia venda ao primeiro cliente pagante |

## 5. Oportunidades de simplificação

| Oportunidade | Justificativa |
|---|---|
| Remover arquivos `.docx` originais das pastas do CEO já convertidas para `.md` | Reduz duplicação e ambiguidade sobre qual é a fonte da verdade — o `.md` é agora a fonte oficial |
| Consolidar `08-Comercial`/`23-Comercial` e `09-Marketing`/`24-Marketing` sob um único índice cruzado explícito | Já são complementares (tático vs. estratégico), mas a navegação entre as duas pode confundir um novo colaborador — um README de nível superior explicando a relação ajudaria |
| Reduzir os 15 Serviços de Domínio para 5-6 no MVP | Ver item 2 da seção anterior — over-engineering para o estágio atual |
| Arquivar (não deletar) a categoria `20 - Anotações do CEO` fora do escopo de engenharia | É conteúdo pessoal do CEO, não deveria estar no mesmo repositório que documentação técnica de produto — mover para um espaço separado reduz ruído para a equipe de engenharia |

## Parecer final da auditoria

A documentação está **tecnicamente pronta para iniciar o Módulo 1**. As 5 pendências da seção 4 são reais, mas nenhuma delas impede a Fundação Técnica, o Domain Core ou a estrutura de Auth/Multitenancy — os três primeiros módulos do plano. A pendência mais próxima de virar bloqueio é a #1 (nomenclatura "Motor"), que deve ser resolvida antes do Módulo 4.

Recomendo tratar a decisão #1 e #2 nesta própria Sprint 0, junto com Pedro, antes de fechar o Plano Técnico Definitivo (Entregável 2) — resolvo isso a seguir.
