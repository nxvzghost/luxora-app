# 06 — Decisões de Domínio: WhatsApp como Interface Oficial do Paciente

**Status:** Documento Oficial — Marco 1 da Arquitetura do Vertex.
**Origem:** decisão de produto, formalizada nesta fase de Arquitetura de Domínio (ver ADR-0041 a ADR-0046).
**Escopo:** este documento consolida e resume o que foi decidido; o detalhe de cada peça vive nos documentos 07-13 desta mesma pasta.

---

## Visão do produto

> "O painel web é a interface da clínica. O WhatsApp é a interface oficial do paciente."

Toda a jornada de relacionamento do paciente com a clínica — desde o primeiro contato até o encerramento — acontece dentro do WhatsApp. A equipe da clínica opera pelo painel web: agenda, pacientes, financeiro, indicadores, terapeutas, configurações, auditoria, supervisão do agente de IA.

Os dois lados **não são produtos diferentes** — são a mesma plataforma, o mesmo backend, o mesmo domínio, vistos por ângulos diferentes (ver `10-Arquitetura-WhatsApp-e-Painel.md`).

## Visão do domínio

O evento fundador do relacionamento com um paciente deixou de ser "paciente existente envia mensagem" e passou a ser **"um número de telefone desconhecido inicia contato com a clínica"**. Isso exigiu revisar uma suposição estrutural que o domínio já carregava: a de que todo `Patient` já existe antes de qualquer interação.

## O que foi decidido

1. **`Patient` continua representando exclusivamente vínculo clínico** — não muda de significado, não perde nem ganha responsabilidade. (ADR-0044)
2. **Existe uma fase anterior ao vínculo clínico**, representada por um Aggregate novo e pequeno, `Contact` — identidade de comunicação, não identidade clínica. (ADR-0043)
3. **`Contact` e `Patient` vivem no mesmo Bounded Context** (Paciente) — não foi criado um Bounded Context novo. A tentativa inicial de isolar isso num contexto próprio ("Identity"/"Engagement") foi avaliada e descartada por escopo desnecessário (ver `08-Contact-e-Identidade-de-Comunicacao.md`, seção "Alternativas descartadas").
4. **O evento "primeira consulta agendada" promove `Contact` para `Patient`** — não por transformação (Contact deixando de existir), mas por associação explícita e permanente, com papel. (ADR-0045)
5. **Toda ambiguidade sobre identidade (quem fala, para quem é a ação) deve ser resolvida por confirmação antes de qualquer ação clínica** — nunca assumida silenciosamente. (ADR-0046)
6. **Telefone nunca é usado como identidade permanente de uma pessoa** — é um atributo mutável de contato, associado a um `Contact`. A identidade estável do sistema é sempre `Patient.id`.

## O que foi descartado

- **Transformar qualquer telefone diretamente em `Patient`** — corrompe indicadores clínicos com contatos que nunca viraram pacientes (ver Event Storming, Cenário "contato que nunca qualificou").
- **Promoção 1:1 rígida entre Contact e Patient** — quebra em pelo menos três cenários reais e comuns de clínica (responsável falando por dependente; casal com número compartilhado; paciente trocando de número). Corrigido para associação N-para-N com papel.
- **`Patient.phone` como âncora de identidade permanente** — quebra exatamente pelos mesmos três cenários acima. Corrigido: `Patient.id` é a única identidade estável.
- **Bounded Context novo dedicado a identidade/engajamento** — avaliado e rejeitado por escopo desnecessário; a linguagem ubíqua de "contato" e "paciente" não diverge o suficiente para justificar uma fronteira de contexto própria.
- **Modelo de identidade multicanal genérico (Telegram/Instagram/e-mail) desde o dia 1** — generalização prematura; o Value Object de canal nasce simples (hoje só WhatsApp), extensível depois sem reescrita.

## Documentos desta fase

| Documento | Conteúdo |
|---|---|
| `07-Event-Storming-WhatsApp.md` | Fluxo completo de eventos, comandos, políticas e processos de longa duração da jornada do paciente |
| `08-Contact-e-Identidade-de-Comunicacao.md` | Modelo do Aggregate `Contact`, ciclo de vida, casos especiais, LGPD/retenção |
| `09-Jornada-do-Paciente-e-do-Contato.md` | As duas jornadas (Contact e Patient), lado a lado |
| `10-Arquitetura-WhatsApp-e-Painel.md` | Como painel web e WhatsApp compartilham o mesmo backend e domínio |
| `11-Aggregates-e-Limites.md` | Limites de consistência de cada Aggregate relevante a esta fase |
| `12-Domain-Events.md` | Catálogo de eventos de domínio desta fase |
| `13-Process-Managers.md` | Processos de longa duração identificados |

ADRs correspondentes: `ADR-0041` a `ADR-0046`, em `docs/02-Arquitetura/ADRs/`.

## Relação com Product Decisions já existentes (encontrado na revisão final)

`docs/11-Product-Decisions/PD-007-Identificacao-do-Tenant-via-WhatsApp/` resolve uma pergunta diferente e anterior a esta: qual **clínica** (Tenant) recebeu a mensagem, via `phoneNumberId` da integração do WhatsApp Business. `Contact` resolve a pergunta seguinte: dentro de um Tenant já identificado, qual **pessoa** está conversando. As duas não se sobrepõem nem se contradizem — `Contact` pressupõe que o Tenant já foi resolvido. `docs/11-Product-Decisions/PD-008-Dominio-Conversacional/` trata de endereçamento de mensagem por canal, em nível mais técnico; complementar, não redundante, com a identidade de canal descrita em `08-Contact-e-Identidade-de-Comunicacao.md`.

## Congelamento

A partir deste marco, as decisões acima estão **congeladas**. Qualquer alteração exige uma nova ADR — não uma edição silenciosa deste ou de qualquer outro documento desta fase.
