# 00 - Estratégia de Testes

## Objetivo

Definir a pirâmide de testes da Luxora e as ferramentas já estabelecidas em `02-Arquitetura/03-Backend.md` (Vitest).

---

# Pirâmide de testes

```
        /\
       /  \      E2E (poucos, fluxos críticos completos)
      /----\
     /      \    Integração (Casos de Uso + Repository + Banco real de teste)
    /--------\
   /          \  Unitário (Domínio puro — Entidades, State Machines, Serviços de Domínio)
  /____________\
```

## Unitário

- Escopo: Entidades, Value Objects, State Machines (`01-Domain/03-Maquina-de-Estados.md`), Serviços de Domínio.
- Sem acesso a banco, rede ou infraestrutura — testam apenas a lógica pura de negócio.
- Todo Caso de Uso listado em `02-Arquitetura/03-Backend.md` e `04-API/01-Contratos-REST.md` possui teste unitário do seu comportamento de decisão (não do I/O).

## Integração

- Escopo: Caso de Uso completo, incluindo Repository e banco de dados real de teste (nunca mock de banco — para validar Constraints e RLS reais, ver `03-Database/09-Multi-Tenant.md`).
- Todo endpoint de `04-API/01-Contratos-REST.md` possui ao menos um teste de integração cobrindo o caminho feliz e um caminho de erro de negócio.

## E2E (fim a fim)

- Escopo reduzido, apenas para os fluxos críticos listados em `01-Testes-Criticos.md`.
- Executados contra ambiente de Staging (`02-Arquitetura/13-Deploy.md`), não em todo commit.

---

# Critério de cobertura

Cobertura percentual isolada não é o critério principal — é possível ter 100% de cobertura de linha sem testar a regra de negócio corretamente. O critério real é: **todo RF e toda RN do PRD que descreve uma decisão (não apenas um CRUD) possui teste correspondente rastreável pelo código do requisito** (ex: um teste que valida RF-044 "detectar conflito" referencia esse código no nome ou comentário do teste).

---

# Dados de teste

Seeds de teste (`03-Database/07-Seeds.md`) incluem múltiplos Tenants desde o início, mesmo em ambiente de desenvolvimento — nenhum teste deve ser escrito assumindo "só existe uma clínica no banco", justamente para forçar que testes de isolamento multi-tenant sejam a regra, não a exceção.

---

# Documentos Relacionados

- 02-Arquitetura/03-Backend.md
- 03-Database/07-Seeds.md
- 03-Database/09-Multi-Tenant.md
- 01 - Testes Críticos
