# Testes

## Luxora — Documentação Oficial

Esta pasta define a estratégia de testes da plataforma, operacionalizando a exigência já feita em `02-Arquitetura/03-Backend.md` ("Todo Caso de Uso deverá possuir: Teste unitário, Teste de integração") e RNF-020 (PRD).

---

# Objetivo

Garantir que toda regra de negócio documentada no PRD e no Domain tenha cobertura de teste equivalente, e que os pontos de maior risco identificados na análise de arquitetura (isolamento multi-tenant, modelo de cobrança agregada, idempotência de pagamento) tenham testes específicos e obrigatórios — não apenas cobertura genérica.

---

# Estrutura

- **00 - Estrategia-de-Testes.md** — pirâmide de testes, ferramentas, critério de cobertura.
- **01 - Testes-Criticos.md** — lista específica de cenários que não podem faltar, derivados diretamente dos riscos identificados no relatório de arquitetura.
- **02 - Dedicated-Fixtures.md** — arquitetura oficial de criação/limpeza de dado de teste na Suíte Crítica (Tenant/Therapist/Patient dedicados), referência obrigatória para qualquer novo Teste Crítico.

---

# Relação com outras camadas

Depende de todas as demais — testes são consequência do Domain, da Arquitetura, do Database e da API, nunca definidos isoladamente.

---

# Observações

Este documento não substitui a necessidade de revisão de código humana — define o mínimo automatizado obrigatório, complementado pelo processo de Code Review já previsto em `02-Arquitetura/03-Backend.md` ("Como Desenvolvemos").
