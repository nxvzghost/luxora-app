# 08 — Contact: Identidade de Comunicação

**Status:** Documento Oficial — Marco 1 da Arquitetura do Vertex.
**Aggregate Root:** `Contact`. **Bounded Context:** Paciente (o mesmo de `Patient` — ver "Alternativas descartadas" abaixo).

---

## Por que Contact existe

`Patient` representa vínculo clínico — cobrança, histórico, estado de tratamento. Ele não deve, e estruturalmente não deveria, existir antes de haver um compromisso clínico real. Mas o primeiro evento da jornada do paciente agora é "um telefone desconhecido manda mensagem" — momento em que não há nome confirmado, não há intenção de tratamento confirmada, e a maioria dos contatos, na prática, nunca vira paciente (alguém perguntando se a clínica atende um convênio, por exemplo).

Transformar todo telefone em `Patient` corrompe métricas clínicas reais que a própria clínica usa todo dia (quantos pacientes ativos, indicadores financeiros por paciente). Esse foi o motivo concreto — não estético — que justificou `Contact` como um Aggregate próprio, pequeno, e não uma variação de `Patient`.

## O que Contact representa — e o que não representa

`Contact` é a identidade de **quem está conversando por um determinado canal**. Não é a identidade clínica da pessoa atendida — essas duas coisas podem ser a mesma pessoa (caso comum) ou pessoas diferentes (responsável falando por um dependente).

## Campos conceituais

- `id`, `tenantId`
- identidade de canal — Value Object com telefone normalizado (hoje só WhatsApp; nasce simples, deliberadamente, sem generalizar para outros canais ainda — ver `06-Decisoes-de-Dominio-WhatsApp.md`, "O que foi descartado")
- `nome` (opcional — só preenchido quando descoberto na conversa)
- `estado` (ver ciclo de vida abaixo)
- associações a um ou mais `Patient`, cada uma com um **papel** explícito (`proprio_paciente` ou `responsavel_por`) — nunca um vínculo único e implícito

O que **não** deve existir em Contact: qualquer dado clínico (billingPolicy, histórico, prontuário), e conteúdo de mensagens (isso pertence ao contexto vizinho de Comunicação, não a Contact).

## Ciclo de vida

```
Novo (só telefone)
   ↓ (primeira troca de mensagem)
Conversando
   ↓ (nome capturado)
Identificado
   ↓ ┬─ (reconhecido como já sendo/falando por Patient existente) → Vinculado
     └─ (evento: primeira consulta agendada) → Qualificado → Promovido
                                                                  ↓
                                          [Contact permanece ATIVO permanentemente
                                           como canal — a máquina de qualificação
                                           termina aqui, o Contact em si não]

Ramo paralelo, para quem nunca qualifica:
Novo/Conversando → (sem interação por período definido) → Arquivado → Descartado
```

**Ponto central, corrigido nesta fase**: `Promovido`/`Vinculado` não são estados terminais do Contact — são terminais apenas da fase de *qualificação*. O Contact continua existindo, permanentemente, como identidade de canal — necessário para reconhecer a mesma pessoa (ou o mesmo responsável) em interações futuras. `Arquivado`/`Descartado` são os únicos estados realmente terminais, e só se aplicam a quem nunca chegou a se associar a nenhum Patient.

## Relação Contact ↔ Patient

Não é 1:1. É uma associação explícita, N-para-N, com papel:

- Um `Contact` pode estar associado a mais de um `Patient` (casal com número compartilhado — cada um é um Patient distinto, o mesmo Contact atende aos dois).
- Um `Patient` pode ser alcançado por mais de um `Contact` ao longo do tempo (troca de número — o Contact antigo permanece no histórico, um novo é criado e associado ao mesmo Patient).
- O papel da associação distingue "é o próprio paciente falando" de "fala em nome de um paciente diferente" (responsável por um dependente).

Quando há ambiguidade real (mais de um Patient associado ao mesmo Contact, e a mensagem não deixa claro para quem é), a resolução nunca é automática — é resolvida por confirmação explícita antes de qualquer ação clínica (ADR-0046).

## Casos especiais

### Responsável falando por paciente
A pessoa que conversa (o Contact) não é necessariamente quem recebe o tratamento. A IA precisa identificar isso na conversa e criar a associação com papel `responsavel_por`, apontando para um `Patient` diferente do Contact — nunca presumir que "quem fala" é "quem é atendido".

### Casal compartilhando telefone
Um único Contact, duas associações (`proprio_paciente` para cada cônjuge). Antes de agir (agendar, confirmar, cobrar), a IA precisa desambiguar qual dos Patients associados é o assunto da conversa — nunca adivinhar.

### Troca de número
A identidade estável é `Patient.id`, nunca o telefone. Quando um número novo se apresenta como um paciente já conhecido, o sistema **não vincula automaticamente** — telefone é um dado mutável, não prova de identidade suficiente sozinho. A vinculação exige confirmação (da equipe da clínica, ou de um passo adicional de verificação). O Contact do número antigo nunca é apagado — permanece como parte do histórico do relacionamento.

### Paciente cadastrado pelo painel, primeira mensagem meses depois
Quando o telefone normalizado do Contact bate diretamente com um `Patient` já existente (cadastrado manualmente, com telefone preenchido corretamente), a fase de qualificação inteira é pulada — o Contact nasce já `Vinculado`. Esse caminho depende inteiramente de o telefone estar normalizado da mesma forma nos dois lugares (mesmo formato de DDI/nono dígito) — uma responsabilidade explícita do Value Object de telefone, não deixada para verificação manual.

### Contato que nunca virou paciente
É o caso mais comum na prática (alguém pergunta algo e nunca mais responde). Não deve ser tratado como paciente em nenhuma métrica clínica. Está sujeito à política de retenção curta descrita abaixo — não é mantido indefinidamente.

## LGPD, retenção e anonimização

Dois relógios de retenção diferentes, não um só:

- **Contact nunca qualificado** (nunca associado a nenhum Patient): base legal de retenção fraca. Política recomendada: expurgo automático após um período curto sem interação (ex.: 90-180 dias em `Novo`/`Conversando`) — preferindo **anonimização** (remover nome/telefone, manter contador agregado para métrica de funil) a exclusão pura, para preservar indicador sem reter dado pessoal identificável.
- **Contact associado a um Patient**: a retenção passa a seguir a do próprio Patient — muito mais longa, por exigência regulatória de prontuário de saúde. Nunca deve ser excluído enquanto o Patient existir, porque é o canal de reengajamento futuro (reativação após meses de inatividade depende disso).

Este documento registra a política recomendada; a decisão final de prazos exatos (quantos dias) é operacional, não arquitetural, e cabe à Luxora definir antes da implementação do expurgo automático.

## Alternativas descartadas

- **Bounded Context próprio para Contact** (ex.: "Identity"/"Engagement"): avaliado e rejeitado. A linguagem ubíqua de "contato" e "paciente" não diverge o suficiente para justificar uma fronteira de contexto separada — ambos pertencem ao vocabulário natural da mesma operação de recepção da clínica. `Contact` vive no Bounded Context de Paciente, como um segundo Aggregate.
- **Promoção 1:1 (Contact vira Patient, deixa de existir)**: quebrou em três cenários reais (responsável/dependente, casal/número compartilhado, troca de número) — corrigido para associação N-para-N com papel, Contact permanecendo vivo.
- **`Patient.phone` como identidade permanente de busca**: quebrou pelos mesmos três cenários — corrigido: telefone é atributo mutável de Contact, nunca a chave de identidade do sistema.
- **Value Object de canal multicanal (Telegram/Instagram/e-mail) desde o início**: generalização prematura, não solicitada pela visão de produto atual (só WhatsApp). Extensível depois sem redesenho.

## Documentos relacionados

- `06-Decisoes-de-Dominio-WhatsApp.md`, `07-Event-Storming-WhatsApp.md`, `09-Jornada-do-Paciente-e-do-Contato.md`, `11-Aggregates-e-Limites.md`
- ADR-0043 (Contact representa identidade de comunicação), ADR-0045 (promoção), ADR-0046 (ambiguidades)
