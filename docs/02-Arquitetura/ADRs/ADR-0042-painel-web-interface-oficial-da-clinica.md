# ADR-0042 — Painel Web é a interface oficial da clínica

**Status:** Aprovada como decisão de arquitetura — Marco 1 (Arquitetura de Domínio) desta fase.
**Origem:** decisão de produto formalizada como decisão de arquitetura de domínio.
**Data:** Julho de 2026

## Contexto

Simétrico à ADR-0041: assim como o paciente precisa de um canal oficial declarado, a equipe da clínica precisa da mesma clareza.

## Problema

Sem uma declaração explícita, corre-se o risco de duplicar funcionalidade entre painel e WhatsApp para a equipe da clínica, ou de deixar ambíguo onde cada ação administrativa deve acontecer.

## Alternativas avaliadas

- **Expor as mesmas ações também via WhatsApp para a equipe da clínica**: rejeitada — a equipe já opera autenticada e com identidade confirmada; não existe, para ela, a ambiguidade de identidade que motivou o Aggregate `Contact` (ADR-0043). Duplicar a superfície de interação sem necessidade real só aumentaria a complexidade.

## Decisão

O painel web é a interface oficial da equipe da clínica: acompanhar agenda, pacientes, financeiro, indicadores, administrar terapeutas, configurar regras, acompanhar auditoria e supervisionar o Agente de IA.

## Consequências

- Nenhuma mudança estrutural no painel web já existente.
- Reforça que o painel não precisa replicar a complexidade de identidade de comunicação (`Contact`) — toda ação ali já parte de um usuário autenticado e de um `Patient` já existente ou sendo cadastrado diretamente.
- Estabelece, junto com a ADR-0041, o princípio central desta fase: "painel serve à clínica, WhatsApp serve ao paciente, mesmo backend, mesmo domínio" (`docs/01-Domain/10-Arquitetura-WhatsApp-e-Painel.md`).

## Documentos relacionados

- `docs/01-Domain/10-Arquitetura-WhatsApp-e-Painel.md`
- ADR-0041
