# ADR-0045 — Primeiro agendamento promove Contact para Patient

**Status:** Aprovada como decisão de arquitetura — Marco 1 (Arquitetura de Domínio) desta fase.
**Origem:** análise de domínio, corrigida após teste adversarial contra 7 cenários reais de operação clínica.
**Data:** Julho de 2026

## Contexto

Definido que `Contact` (ADR-0043) e `Patient` (ADR-0044) são Aggregates distintos, era necessário um critério objetivo para o momento em que um `Contact` passa a ter relevância clínica real.

## Problema

Um critério vago como "cadastro mínimo confirmado" não tem base objetiva no comportamento do sistema, e uma promoção 1:1 automática (Contact se transformando em Patient) quebra em cenários reais e comuns de clínica.

## Alternativas avaliadas

- **Promoção por tempo de conversa ou quantidade de mensagens trocadas**: rejeitada — critério arbitrário, sem relação com compromisso clínico real.
- **Promoção 1:1 automática, com o Contact deixando de existir/participar depois**: testada e **revertida** nesta mesma análise, após comprovação de falha em três cenários reais: (a) responsável falando por um dependente — quem fala não é quem é atendido; (b) casal com telefone compartilhado — um telefone precisa apontar para mais de um Patient; (c) paciente trocando de número — a identidade não pode depender do telefone permanecer o mesmo.
- **Promoção manual, exigindo confirmação da equipe da clínica a cada caso**: rejeitada — adiciona fricção desnecessária a um evento que já é inequívoco por si só (agendar uma consulta é, estruturalmente, um compromisso real).

## Decisão

O evento de negócio **"primeira consulta agendada"** promove `Contact` para vínculo com `Patient`. O critério não é arbitrário: `Appointment` já exige um `Patient` real para existir — no momento em que um Contact tenta agendar de fato, o sistema precisa, nesse exato ponto, de um Patient para anexar o agendamento.

A promoção **não é uma transformação** (Contact virando Patient e desaparecendo) — é a criação de uma **associação explícita, com papel**, entre o Contact que conversa e o Patient que recebe o cuidado (que podem ser a mesma pessoa, ou não). O `Contact` permanece ativo, permanentemente, como identidade de canal, mesmo depois da promoção.

## Consequências

- Nenhuma mudança na exigência já existente de `Appointment.patientId` como referência obrigatória.
- A relação Contact↔Patient é modelada como associação N-para-N com papel (`proprio_paciente` \| `responsavel_por`), não como uma FK única — suporta responsável/dependente e casal com telefone compartilhado.
- `Contact` nunca é descartado no momento da promoção — só a sua máquina de *qualificação* termina ali; ele continua sendo consultado indefinidamente como canal de comunicação (lembretes, cobranças, reengajamento).

## Documentos relacionados

- `docs/01-Domain/08-Contact-e-Identidade-de-Comunicacao.md`, `09-Jornada-do-Paciente-e-do-Contato.md`, `07-Event-Storming-WhatsApp.md`
- ADR-0043, ADR-0044, ADR-0046
