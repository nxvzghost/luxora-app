# 00 - Princípios da API

## Objetivo

Definir as regras estruturais obrigatórias para toda API da plataforma Luxora, complementando o já definido em `02-Arquitetura/03-Backend.md` (seção Versionamento) e ADR-0011 (API First).

---

# Formato

- REST sobre HTTP/JSON.
- Especificação gerada em OpenAPI (Swagger), já definida como stack oficial em `02-Arquitetura/03-Backend.md`.
- Toda API é versionada por caminho: `/api/v1/...`. Mudanças que quebram compatibilidade exigem nova versão (`/api/v2`), nunca alteração retroativa de uma versão publicada.

---

# Autenticação e contexto de Tenant

Toda requisição autenticada carrega:

- **Authorization: Bearer `<access_token>`** — JWT emitido conforme `02-Arquitetura/06-Autenticacao.md`.
- O `tenant_id` **nunca** é enviado como parâmetro pelo cliente — é extraído exclusivamente do JWT e aplicado automaticamente pelo Backend (mesmo princípio de `07-Multitenancy.md` e da política de RLS em `03-Database/09-Multi-Tenant.md`). Qualquer endpoint que aceite `tenant_id` como parâmetro de entrada é considerado falha de segurança.

---

# Estrutura de um endpoint

Todo endpoint segue o fluxo já definido em `02-Arquitetura/03-Backend.md` ("Fluxo de Requisição"):

```
Cliente → Controller → DTO → Caso de Uso → Motor Operacional → Domínio → Repository → Banco → Resposta
```

Cada endpoint mapeia para exatamente um Caso de Uso. Não existem endpoints que orquestram múltiplos Casos de Uso diretamente no Controller — orquestração de múltiplas ações pertence ao Motor Operacional, nunca à camada de API.

---

# Convenção de rotas

```
/api/v1/{recurso}              GET (listar), POST (criar)
/api/v1/{recurso}/{id}         GET (detalhar), PATCH (atualizar), DELETE (remover/soft delete)
/api/v1/{recurso}/{id}/{acao}  POST (ação de negócio que não é CRUD simples, ex: /sessions/{id}/confirm)
```

Recursos no plural, em inglês, alinhados à Linguagem Ubíqua (`01-Domain/05-Linguagem-Ubiqua.md`): `/patients`, `/therapists`, `/sessions`, `/appointments`, `/billings`, `/payments`.

---

# Formato de erro padronizado

Conforme já exigido em `02-Arquitetura/03-Backend.md` ("Tratamento de Erros"):

```json
{
  "error": {
    "code": "SESSION_CONFLICT",
    "message": "O horário selecionado já está reservado.",
    "category": "business_rule",
    "timestamp": "2026-07-13T10:00:00Z"
  }
}
```

- `code`: identificador estável, usado por Frontend e agentes de IA para tratamento programático — nunca parseado a partir de `message`.
- `category`: `validation | business_rule | authorization | not_found | system`.
- Stack trace nunca é retornado ao cliente, mesmo em ambiente de desenvolvimento (aplica-se apenas a logs internos, ver `02-Arquitetura/11-Monitoramento.md`).

---

# Paginação

Endpoints de listagem usam paginação por cursor (mais estável sob escrita concorrente que paginação por offset, relevante para listagens como agenda e dashboard que mudam com frequência):

```
GET /api/v1/patients?cursor=<opaco>&limit=20
```

Resposta:

```json
{
  "data": [...],
  "next_cursor": "opaco-ou-null"
}
```

---

# Idempotência

Endpoints que representam ações de negócio sensíveis a duplicação (criar cobrança, registrar pagamento, enviar mensagem) devem aceitar um cabeçalho `Idempotency-Key`, seguindo o mesmo princípio já definido para Filas em `02-Arquitetura/09-Filas.md`. Requisições repetidas com a mesma chave retornam o resultado da primeira execução, sem duplicar o efeito.

---

# Rate limiting

Aplicado no API Gateway (já definido como componente em `02-Arquitetura/02-Arquitetura-Geral.md`), por Tenant e por usuário — nunca de forma global, para que um Tenant com alto volume não afete a disponibilidade da API para os demais.

---

# Documentos Relacionados

- 02-Arquitetura/03-Backend.md
- 02-Arquitetura/06-Autenticacao.md
- 02-Arquitetura/07-Multitenancy.md
- 02-Arquitetura/09-Filas.md
- 02-Arquitetura/ADRs/ADR-0011.md (API First)
- 01-Domain/05-Linguagem-Ubiqua.md
