# API

## Luxora — Documentação Oficial

Esta pasta reúne a documentação da camada de API da plataforma Luxora — a interface pública através da qual Frontend, agentes de IA e automações (n8n) se comunicam com o Backend.

---

# Objetivo

Definir os contratos de comunicação entre clientes (Frontend, IA, integrações externas) e o Backend, garantindo que toda comunicação siga um padrão único, versionado e documentado.

Nenhum cliente da plataforma — Frontend, agente de IA ou automação n8n — acessa o Banco de Dados diretamente. Todos passam pela API (Princípio 02-Arquitetura/02-Arquitetura-Geral.md, seção "Comunicação entre Componentes").

---

# Estrutura

- **00 - Principios-da-API.md** — regras gerais de contrato, versionamento, autenticação, formato de erro.
- **01 - Contratos-REST.md** — endpoints por módulo, mapeados diretamente aos Casos de Uso já definidos em `02-Arquitetura/03-Backend.md`.

---

# Relação com outras camadas

Esta documentação depende de:

- `01-Domain` (entidades e regras que os contratos expõem)
- `02-Arquitetura/03-Backend.md` (Casos de Uso, DTOs)
- `02-Arquitetura/06-Autenticacao.md` (JWT, perfis de usuário)
- `02-Arquitetura/07-Multitenancy.md` (Tenant Context)

Serve de base para:

- `02-Arquitetura/04-Frontend.md`
- `05-IA/00-Provedor-e-Interface.md`
- `02-Arquitetura/ADRs/ADR-0021.md` (n8n como cliente da API)

---

# Observações

Assim como todas as demais camadas, a API é consequência do Domínio — nenhum endpoint deve existir sem representar um Caso de Uso já definido. Endpoints novos exigem, antes, um Caso de Uso documentado em `02-Arquitetura/03-Backend.md`.
