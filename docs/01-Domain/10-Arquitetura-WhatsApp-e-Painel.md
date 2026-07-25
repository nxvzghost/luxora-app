# 10 — Arquitetura Conceitual: WhatsApp e Painel Web

**Status:** Documento Oficial — Marco 1 da Arquitetura do Vertex.
**Nível:** conceitual/domínio — este documento não descreve webhook, API ou infraestrutura (isso pertence à fase de implementação); descreve o princípio arquitetural que a implementação deverá respeitar.

## Princípio

> "O painel web é a interface da clínica. O WhatsApp é a interface oficial do paciente."

Painel e WhatsApp **não são dois produtos, nem dois backends, nem dois domínios** — são duas superfícies de entrada para o mesmo sistema. Um terapeuta que confirma uma consulta pelo painel e um paciente que confirma pelo WhatsApp disparam exatamente o mesmo Comando (`ConfirmarConsulta`), no mesmo Aggregate (`Appointment`), produzindo o mesmo Evento de domínio (`ConsultaConfirmada`). O canal de entrada nunca aparece como uma condição dentro do domínio.

## O que isso implica para os Aggregates já existentes

`Appointment`, `Billing`, `Payment`, `Session` — todos já existentes antes desta fase — não precisam de nenhuma alteração de significado. Eles continuam representando exatamente o que representavam. A única mudança real é **quem/o quê está autorizado a disparar os Comandos que os afetam**: antes, presumia-se implicitamente que só a equipe da clínica (via painel) iniciava essas ações; agora, o próprio paciente, pelo WhatsApp, intermediado pelo Agente de IA, também pode.

## Onde a IA entra

O Agente de IA nunca é um Aggregate, nem decide sozinho (princípio já estabelecido antes desta fase). Ele interpreta linguagem natural e traduz para os mesmos Comandos que o painel já usa — a mesma fronteira de tradução intent→Comando que já existia continua sendo o único ponto de entrada da IA no domínio.

## Onde Contact entra

`Contact` é a única peça genuinamente nova introduzida por essa mudança de visão de produto (ver `08-Contact-e-Identidade-de-Comunicacao.md`). Ele existe porque o WhatsApp, ao contrário do painel, recebe mensagens de identidades ainda não confirmadas — o painel nunca teve esse problema, porque toda ação ali já parte de um usuário autenticado e de um Patient já cadastrado.

## O que isto não é

Este documento não define arquitetura técnica de integração (webhook, filas, providers) — isso é responsabilidade da fase de implementação, guiada pelas decisões aqui registradas, não o contrário. Nenhuma decisão de infraestrutura foi tomada nesta fase.

## Documentos relacionados

- `06-Decisoes-de-Dominio-WhatsApp.md`, `09-Jornada-do-Paciente-e-do-Contato.md`
- ADR-0041 (WhatsApp como interface oficial do paciente), ADR-0042 (Painel como interface oficial da clínica)
