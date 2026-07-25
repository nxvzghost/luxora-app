# ADR-0043 — Contact representa identidade de comunicação

**Status:** Aprovada como decisão de arquitetura — Marco 1 (Arquitetura de Domínio) desta fase.
**Origem:** análise de domínio conduzida nesta fase, incluindo teste adversarial contra 7 cenários reais de operação clínica.
**Data:** Julho de 2026

## Contexto

A ADR-0041 estabelece que o primeiro evento do sistema passa a ser "um telefone desconhecido inicia contato", não "paciente existente age". O domínio, até esta fase, presumia implicitamente que todo `Patient` já existe antes de qualquer interação — `PatientProps` exige `name` e `phone` desde a criação, mesmo no estado inicial `Novo`.

## Problema

Transformar diretamente qualquer telefone em `Patient` corrompe indicadores clínicos e financeiros reais que a clínica usa no painel (quantos pacientes ativos, métricas por paciente) — a maioria dos primeiros contatos nunca chega a se tornar paciente.

## Alternativas avaliadas

- **Relaxar `Patient.name` para opcional, sem criar nenhum conceito novo**: rejeitada. Tecnicamente resolveria a instanciação, mas misturaria identidade de comunicação (ainda não confirmada) com vínculo clínico no mesmo Aggregate, contaminando permanentemente as métricas de "quantos pacientes a clínica tem" com contatos que nunca converteram.
- **Bounded Context próprio para identidade/engajamento** (cogitado inicialmente nesta análise): rejeitada. A linguagem ubíqua de "contato" e "paciente" não diverge o suficiente através dessa fronteira para justificar um contexto separado — ambos pertencem ao vocabulário natural da mesma operação de recepção.
- **Modelar como Process Manager/Saga transitório, sem persistência própria**: rejeitada. O mesmo número pode voltar a escrever meses depois e precisa ser reconhecido — exige persistência real, não um processo que se descarta ao terminar.

## Decisão

Criar o Aggregate `Contact`, no mesmo Bounded Context de `Patient`, representando exclusivamente identidade de comunicação — quem está conversando por um canal, nunca dado clínico. `Contact` não é 1:1 com `Patient` (ver ADR-0045).

## Consequências

- Novo Aggregate a implementar, com ciclo de vida próprio (`Novo → Conversando → Identificado → Qualificado/Vinculado → Promovido`, com ramo paralelo de arquivamento).
- Exige Value Object de identidade de canal (telefone normalizado) e política de retenção/LGPD própria, distinta da retenção de `Patient` (ver `docs/01-Domain/08-Contact-e-Identidade-de-Comunicacao.md`).
- `Patient` permanece inalterado em significado (ver ADR-0044).

## Documentos relacionados

- `docs/01-Domain/08-Contact-e-Identidade-de-Comunicacao.md`, `11-Aggregates-e-Limites.md`
- ADR-0041, ADR-0044, ADR-0045
