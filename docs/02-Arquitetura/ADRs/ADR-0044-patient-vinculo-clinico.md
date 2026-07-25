# ADR-0044 — Patient representa vínculo clínico

**Status:** Aprovada como decisão de arquitetura — Marco 1 (Arquitetura de Domínio) desta fase.
**Origem:** consequência direta da ADR-0043.
**Data:** Julho de 2026

## Contexto

Com a introdução do Aggregate `Contact` (ADR-0043), era necessário reafirmar explicitamente o que `Patient` **não** passa a absorver, para não haver ambiguidade de responsabilidade entre os dois Aggregates na implementação futura.

## Problema

Há um risco real de, durante a implementação, `Patient` acabar herdando responsabilidades de identidade de comunicação por conveniência (ex.: usar `Patient.phone` como chave de busca principal) — o que já foi tentado e revertido durante esta análise de domínio (ver Consequências).

## Alternativas avaliadas

- **Fundir os dois conceitos permanentemente após a promoção** (Contact "vira" Patient e deixa de existir): considerada na primeira versão desta análise, e **revertida** depois de testada contra cenários reais — quebra explicitamente quando quem fala (Contact) e quem é atendido (Patient) são pessoas diferentes (responsável por dependente), e quando um número serve mais de uma pessoa (casal). Ver ADR-0045.

## Decisão

`Patient` continua representando exclusivamente vínculo clínico: estado de tratamento (máquina de estados já existente, sem alteração), cobrança, histórico de sessões. Nunca representa identidade de comunicação. `Patient.id` é a única identidade estável do sistema — telefone nunca é usado como chave de busca de identidade permanente.

## Consequências

- Nenhuma alteração na máquina de estados de `Patient` já documentada em `01-Domain/03-Maquina-de-Estados.md`.
- Qualquer necessidade de reconhecer "quem está falando" passa exclusivamente por `Contact`, nunca por um atributo de `Patient`.
- Corrige uma suposição intermediária desta mesma análise de domínio (usar `Patient.phone` como âncora de busca), documentada como decisão descartada em `docs/01-Domain/06-Decisoes-de-Dominio-WhatsApp.md`.

## Documentos relacionados

- `docs/01-Domain/08-Contact-e-Identidade-de-Comunicacao.md`, `09-Jornada-do-Paciente-e-do-Contato.md`
- ADR-0043, ADR-0045
