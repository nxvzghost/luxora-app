# 00 - Provedor de Infraestrutura e Orçamento

## Status: Decisão fechada para as Fases 1 e 2. Checkpoint de reavaliação definido para a Fase 3.

Este documento substitui a versão anterior (que apresentava apenas recomendação genérica sem provedor nomeado nem números). Os valores abaixo foram levantados a partir de preços de mercado praticados por Railway e Render em 2026, comparados com o desenho de infraestrutura já definido em `02-Arquitetura/13-Deploy.md`.

---

# Decisão

**Provedor recomendado para as Fases 1 e 2: Railway.**

Justificativa técnica:

- Cobrança por segundo de uso real (não por plano fixo) — para uma plataforma com zero ou poucos clientes pagantes, isso significa custo próximo de zero enquanto não há tráfego, em vez de pagar por capacidade ociosa.
- PostgreSQL, Redis e containers de Backend/Frontend gerenciados na mesma plataforma, sem configuração de rede (VPC, subnets, security groups) — reduz carga operacional para uma equipe pequena, que é exatamente a realidade da Luxora nesta fase.
- Migração para fora do Railway não exige reescrever nada do domínio ou da arquitetura (Princípio 13 — Independência Tecnológica já garante isso): é só um `pg_dump`/restore de banco e redeploy de containers.

**Alternativa de reserva, caso o time prefira previsibilidade de custo desde já: Render.** Mais caro em repouso (planos fixos a partir de US$ 7/serviço/mês), porém mais previsível sob carga estável — vale reconsiderar a partir do momento em que o tráfego deixar de ser esporádico (ver checkpoint na Fase 3, abaixo).

---

# Estimativa de custo — Fase 1 (MVP / dogfooding, 0 clientes pagantes)

| Componente | Custo estimado (Railway, 2026) |
|---|---|
| PostgreSQL (instância pequena, baixo tráfego) | < US$ 1/mês (uso medido real de instância pequena fica bem abaixo de US$ 1/mês) |
| Redis (instância pequena) | poucos dólares/mês |
| Backend (1 container, sempre ativo) | ~US$ 30/mês (1 vCPU / 1GB rodando 24h — é o item de maior peso do orçamento) |
| Frontend (Next.js) | Pode rodar na Vercel (tier gratuito cobre esse estágio) em vez de Railway, reduzindo o total |
| **Total estimado Fase 1** | **~US$ 30–40/mês** (≈ R$ 165–220/mês, câmbio de referência R$ 5,50 — confirmar câmbio real no momento da contratação) |

O plano Hobby do Railway (US$ 5/mês de base, já incluindo créditos de uso) cobre boa parte disso; o item que realmente pesa é o container do Backend rodando continuamente.

---

# Estimativa de custo — Fase 2 (primeiros 10 clientes piloto)

| Componente | Custo estimado |
|---|---|
| Mesma stack, upgrade de plano/recursos | US$ 40–80/mês, conforme relatos de mercado para stacks Node.js + Postgres + Redis com tráfego leve/moderado |

Ainda uma ordem de grandeza baixa o suficiente para **não ser fator limitante da validação comercial** — o orçamento de infraestrutura não deve travar a decisão de aceitar o piloto.

---

# Checkpoint de reavaliação — Fase 3 (≈100 clientes ativos)

Relatos de mercado indicam que, em Railway, esse volume de uso pode elevar o custo para a faixa de **US$ 130 a US$ 300+/mês**, dependendo de tráfego real. Neste ponto — não antes — a equipe deve reavaliar:

1. Migrar para o plano Pro/Enterprise do Railway (ainda a mesma plataforma, menos retrabalho).
2. Migrar para Render com planos fixos, se o padrão de tráfego já estiver estável e prevísivel.
3. Migrar para infraestrutura própria em AWS/GCP (RDS + ECS/Fargate), se a essa altura já houver equipe de DevOps dedicada.

Recomendo que essa decisão seja tomada com dados reais de uso da Fase 2, não estimada antecipadamente — é o mesmo princípio de "medir antes de otimizar" já definido na Filosofia de Engenharia da empresa (`CEO/00 - BEM VINDO A LUXORA`, "06 - Filosofia de Engenharia").

---

# O que NÃO fazer nas Fases 1 e 2

- Kubernetes dedicado.
- Multi-região / multi-cloud.
- Banco de dados dedicado por Tenant (`03-Database/09-Multi-Tenant.md` já prevê isso como evolução futura, não ponto de partida).

Qualquer um desses itens, adotado prematuramente, custaria mais em tempo de engenharia do que o dinheiro que economizaria em infraestrutura nesta fase.

---

# Relação com precificação

Com os números acima, o custo de infraestrutura por tenant nas Fases 1–2 é baixo o suficiente (dividido entre 10 clientes piloto, algo como US$ 4–8/cliente/mês) para não ser o fator determinante do preço de assinatura definido pelo CEO em `CEO/07 - Planos e precificação` — a margem, nesta fase, é dominada por outros custos (ex: IA, se o teto definido em `05-IA/00-Provedor-e-Interface.md` for maior que isso).

---

# Nota de precisão

Os valores acima são estimativas baseadas em relatos de mercado de 2026 para stacks comparáveis (Node.js/NestJS + PostgreSQL + Redis), não uma cotação oficial da Railway para a conta específica da Luxora. Recomendo validar com uma conta de teste real antes de comprometer orçamento — é rápido de fazer (Railway não exige cartão para o trial) e elimina qualquer margem de erro desta estimativa.

---

# Documentos Relacionados

- 02-Arquitetura/13-Deploy.md
- 02-Arquitetura/15-Escalabilidade.md
- 03-Database/09-Multi-Tenant.md
- 05-IA/00-Provedor-e-Interface.md
