# PD-001 — Motor de Disponibilidade Inteligente (Availability Engine)

**Status:** Documentação completa — implementação NÃO iniciada, aguardando aprovação explícita.
**Categoria:** Product Decision (PD) — decisão de produto com impacto arquitetural direto, categoria nova neste projeto. Diferente de um ADR (que registra uma decisão técnica pontual), uma PD registra uma decisão de produto que se torna arquitetura obrigatória — normalmente gera um ou mais ADRs como consequência.
**Origem:** Diretriz recebida, tratada com o princípio "Compreender antes de implementar."
**Data:** Julho de 2026

## Índice desta pasta

1. `01-Decisao-Oficial.md` — registro estruturado da decisão recebida, preservado como fonte.
2. `02-Analise-Arquitetural.md` — o que existe hoje vs. o que o PD-001 exige, com as violações reais já encontradas no código.
3. `03-Impacto-em-Modulos-Existentes.md` — módulo por módulo, o que muda.
4. `04-Bounded-Context-e-Dominio.md` — a decisão de modelagem de domínio (novo Bounded Context).
5. `05-Plano-de-Implementacao.md` — plano faseado, nada implementado ainda.
6. `06-Dependencias.md` — o que depende do quê, ordem obrigatória.
7. `07-Riscos.md` — riscos técnicos e de produto, incluindo os que a diretriz não menciona explicitamente.
8. `Diagramas/fluxo-motor-disponibilidade.md` — fluxo oficial atualizado.

## Resumo executivo (para quem só vai ler isto)

O sistema hoje já tem disponibilidade (Módulo 07) — mas é **descentralizada**: `AgendarConsultaUseCase` cria um agendamento direto no banco, protegido só por uma constraint de unicidade, **sem nunca consultar** `ConsultarDisponibilidadeUseCase` antes. A IA (Módulo 12) chama esse mesmo Use Case direto. Isso é exatamente a violação que o PD-001 aponta — cada módulo decide sozinho, não existe uma autoridade central.

A boa notícia: já existe uma base sólida pra virar o Motor — `ScheduleSlot` (Value Object com máquina de estados) e `ConsultarDisponibilidadeUseCase` (já combina disponibilidade semanal + duração de sessão + agendamentos ativos corretamente). O trabalho não é começar do zero — é **promover** essa lógica pra um Bounded Context próprio e **obrigar** todos os módulos a passarem por ele, inclusive os que já existem.

Recomendação de modelagem (detalhada no doc 4): **sim, o Motor de Disponibilidade deve virar um Bounded Context novo**, com `Therapist.availability` migrando pra lá — é uma mudança de estrutura real, não cosmética.

Escopo que o PD-001 pede e que é maior que "só o motor": assistente de configuração na implantação, importação de agenda externa (Google/Apple/Outlook/ICS/CSV/Excel), monitoramento proativo da IA sobre a agenda. Recomendo fasear — ver `05-Plano-de-Implementacao.md`.
