# ADR-0046 — Ambiguidades devem ser resolvidas antes de executar qualquer ação clínica

**Status:** Aprovada como decisão de arquitetura — Marco 1 (Arquitetura de Domínio) desta fase.
**Origem:** teste adversarial da modelagem de `Contact`/`Patient` contra 7 cenários reais de operação clínica.
**Data:** Julho de 2026

## Contexto

A associação N-para-N com papel entre `Contact` e `Patient` (ADR-0045) resolve responsável/dependente e casal com telefone compartilhado estruturalmente — mas abre a pergunta operacional de como o sistema decide, em tempo real, para qual `Patient` uma mensagem específica se refere quando há mais de uma associação possível.

## Problema

Resolver essa ambiguidade automaticamente, por suposição (ex.: assumir o Patient mais recentemente ativo, ou o primeiro associado), arrisca lançar sessão, cobrança ou ação clínica na identidade errada — um erro silencioso, sem sinal de alerta para a clínica ou para o paciente.

## Alternativas avaliadas

- **Heurística automática de desambiguação** (ex.: assumir sempre o Patient mais recentemente ativo): rejeitada — risco real e silencioso de ação na identidade errada, sem possibilidade de auditoria do motivo da escolha.
- **Proibir múltiplas associações por Contact**, forçando um número de telefone por pessoa: rejeitada — não reflete a realidade operacional de uma clínica (famílias e casais legitimamente compartilham número).

## Decisão

Sempre que houver ambiguidade real de identidade — um `Contact` com mais de um `Patient` associado sem que a mensagem deixe claro para quem é, ou uma reivindicação de identidade não verificável (número novo alegando ser paciente já conhecido) — o sistema deve **confirmar explicitamente antes de agir**, nunca assumir silenciosamente.

Esta decisão estende, para a identidade do próprio interlocutor, uma regra de segurança que já existia no domínio para entidades de ação ausentes (`IntentActionRouter`: "a IA nunca adivinha um ID de agendamento ou terapeuta faltante").

## Consequências

- Todo fluxo de IA que envolva um `Contact` com mais de uma associação precisa de um passo de desambiguação antes de rotear qualquer ação clínica.
- Vínculos de troca de número (`ContatoVinculadoAPacienteExistente`) exigem confirmação — nunca são automáticos, mesmo quando o texto da mensagem parece convincente.
- Reforça, em nível de domínio, o mesmo princípio já estabelecido pela ADR-0006 (IA nunca decide sozinha) — agora aplicado também à resolução de identidade, não só à execução de ações.

## Documentos relacionados

- `docs/01-Domain/08-Contact-e-Identidade-de-Comunicacao.md`, `07-Event-Storming-WhatsApp.md` (Cenários 11, 12, 13)
- ADR-0006, ADR-0045
