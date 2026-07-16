# 02 - Fluxo: Dashboard

## Objetivo

Detalhar a tela inicial da plataforma, já descrita em princípio em `02-Arquitetura/04-Frontend.md` ("O Dashboard será a primeira tela do sistema").

---

# Perguntas que a tela deve responder sem interação (RF-081 a RF-090)

Organizadas por prioridade visual (topo da tela = maior urgência):

1. Quem precisa de confirmação hoje? (sessões não confirmadas do dia)
2. Quem está em atraso de pagamento? (`billing` em estado `Atrasada`, ver `01-Domain/03-Maquina-de-Estados.md`)
3. Quais sessões ocorrem hoje, em ordem cronológica?
4. Quanto já foi recebido hoje/na semana? Quanto falta receber?
5. Existe algum conflito de agenda a resolver?
6. Quem está em follow-up pendente?

---

# Layout

Segue o layout geral já definido em `02-Arquitetura/04-Frontend.md` (Header + Sidebar + Conteúdo Principal). Dentro do conteúdo principal, cartões de indicador (não tabelas densas) para os itens 1, 2, 4 e 6 acima — a tabela cronológica do dia (item 3) ocupa a maior área da tela, por ser a informação mais consultada segundo o próprio PRD (RF-081).

---

# Origem dos dados

Consome exclusivamente `GET /api/v1/dashboard/summary`, `financial` e `occupancy` (`04-API/01-Contratos-REST.md`) — o Dashboard nunca agrega dados no Frontend a partir de múltiplas chamadas a outros módulos, evitando lógica de negócio duplicada na interface (mesmo princípio já aplicado às Views do banco em `03-Database/10-Views.md`).

---

# Atualização em tempo real

Conforme já exigido em `02-Arquitetura/04-Frontend.md`: novo pagamento, nova mensagem, novo agendamento, cancelamento e confirmação atualizam o Dashboard sem exigir reload manual da página.

---

# Documentos Relacionados

- 02-Arquitetura/04-Frontend.md
- 04-API/01-Contratos-REST.md (Dashboard)
- 01-Domain/03-Maquina-de-Estados.md
