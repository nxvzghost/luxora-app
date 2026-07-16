# UX

## Luxora — Documentação Oficial

Esta pasta reúne a documentação de experiência do usuário da plataforma Luxora, complementando os princípios já definidos em `02-Arquitetura/04-Frontend.md`.

---

# Objetivo

Detalhar os fluxos de tela dos módulos críticos do MVP, servindo de referência para o desenvolvimento do Frontend antes que ele comece — conforme a filosofia de engenharia da empresa ("primeiro compreender, depois projetar").

---

# Estrutura

- **00 - Principios-de-UX.md** — critérios gerais aplicáveis a toda tela.
- **01 - Fluxo-Configuracao-Clinica.md** — o fluxo mais crítico e ainda não detalhado em nenhum outro documento: como uma clínica configura suas políticas.
- **02 - Fluxo-Dashboard.md** — a tela inicial do sistema.
- **03 - Fluxo-Agendamento.md** — o fluxo operacional mais frequente do produto.
- **04 - Fluxo-Financeiro.md** — cobrança e pagamento.
- **05 - Fluxo-Fechamento-Mensal.md** — balanço financeiro mensal entregue a cada clínica.

---

# Relação com outras camadas

Depende de:

- `02-Arquitetura/04-Frontend.md`
- `01-Domain` (estados e regras que a interface representa)
- `04-API/01-Contratos-REST.md` (os fluxos abaixo consomem exatamente esses endpoints)

---

# Observações

O Frontend nunca implementa regra de negócio (Princípio 02-Arquitetura/04-Frontend.md). Os fluxos aqui descritos representam apenas a experiência de interação — toda validação de negócio (conflito de agenda, duplicidade de cobrança etc.) é responsabilidade do Backend, e a interface apenas exibe o resultado.
