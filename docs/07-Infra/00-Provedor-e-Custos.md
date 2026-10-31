# 00 - Provedor de Infraestrutura e Orçamento

## Status (31/10/2026): escolha do provedor EM ABERTO — nada contratado, nenhuma cotação feita. A recomendação por Railway abaixo é histórica; ver a atualização logo a seguir. Checkpoint de reavaliação definido para a Fase 3.

Este documento substitui a versão anterior (que apresentava apenas recomendação genérica sem provedor nomeado nem números). Os valores abaixo foram levantados a partir de preços de mercado praticados por Railway e Render em 2026, comparados com o desenho de infraestrutura já definido em `02-Arquitetura/13-Deploy.md`.

---

# Atualização de 31/10/2026 — estado técnico atual e escolha em aberto

> **Nenhum provedor foi contratado e nenhuma cotação foi feita.** A "decisão" registrada abaixo (Railway) é de antes da infraestrutura de `infra/` ser construída; **a escolha do provedor está em aberto e é do responsável pela Luxora**. Esta seção só registra o que a infraestrutura pronta exige de um provedor e compara as alternativas com base nisso. **Não há aqui nenhum preço atual**: os valores das seções seguintes são estimativas antigas e não foram revalidados.

## O que o repositório já assume de um provedor

O que foi construído (E1 a E5 do backup, deploy, rollback, Caddy, CD por SSH) pressupõe **um servidor Linux com acesso de administrador**, não uma plataforma gerenciada:

| Exigência técnica | Por quê |
|---|---|
| Ubuntu 24.04 LTS com `root`/`sudo` e SSH por chave | checklist de [PREPARACAO_SERVIDOR_HOMOLOGACAO.md](PREPARACAO_SERVIDOR_HOMOLOGACAO.md); o CD roda `deploy.sh` por SSH |
| Docker Engine + plugin compose | a pilha (`infra/staging/docker-compose.yml`): backend, frontend, Postgres 16, Redis, Caddy |
| Criar usuários Linux e pastas em `/etc`, `/opt`, `/var/lib` | usuário `deploy` e usuário `luxora-backup`, com permissões distintas ([BACKUP_ISOLADO.md](BACKUP_ISOLADO.md)) |
| systemd | timers do backup diário e da verificação horária |
| Porta do Postgres no loopback do host (`127.0.0.1:15432`) | o `pg_dump` roda no host, sem Docker, como `luxora-backup` |
| IPv4 público, portas 22/80/443 e DNS de dois nomes | Caddy com Let's Encrypt; `PUBLIC_API_HOST` e `PUBLIC_PANEL_HOST` |
| Saída HTTPS para um armazenamento S3 | backup externo cifrado (R2 é candidato; nada foi testado contra um armazenamento real) |

**Dimensionamento não medido.** CPU, memória e disco necessários não foram medidos neste repositório (as imagens têm cerca de 0,5 GB a 1,5 GB; o consumo da pilha rodando não foi medido). Meça com `docker stats` no ensaio antes de escolher o plano. O banco gerenciado exigiria também decidir o `max_connections` (ver DEPLOY_RUNBOOK, "Pontos de atenção para dimensionar").

## Comparação (técnica, sem preços)

| Alternativa | Encaixe com o que existe | Observação |
|---|---|---|
| **Railway** (decisão antiga deste documento) | **Baixo.** Plataforma gerenciada: não há `root`, systemd, usuários Linux nem porta de loopback do host. O backup isolado desenhado (host + systemd + `luxora-backup`) **não se aplica**; seria preciso outro caminho (backup nativo do provedor ou `pg_dump` por rede a partir de um job) e outro desenho de segredos. O CD por SSH e o Caddy do compose não se usam | O mapeamento em DEPLOY_RUNBOOK ("Se o provedor for o Railway") nunca foi validado. Nenhuma conta foi criada |
| **Render** (reserva deste documento) | **Baixo**, pelos mesmos motivos (plataforma gerenciada) | Idem |
| **Vultr** (citado pelo responsável; não constava neste documento) | **Alto**, se o plano for uma VPS comum (Linux com `root`): o roteiro de `infra/` e do BACKUP_ISOLADO.md vale sem adaptação | Uma consulta de 31/10/2026 indicou, de forma indireta, região em São Paulo e cobrança por hora; **não conferi plano, valor, impostos nem condições**. Cotar na página oficial |
| **Meteor Cloud** (citado pelo responsável; não constava neste documento) | **Não avaliável.** Uma busca de 31/10/2026 não encontrou informação verificável sobre esse provedor | Precisa da página oficial: tipo de produto (VPS com `root`?), regiões, planos, forma de pagamento, suporte |
| VPS de outro provedor, com `root` e Ubuntu 24.04 | **Alto** (mesmo critério) | Qualquer um que cumpra a tabela de exigências acima |

## Recomendação (técnica; a contratação é sua)

1. **Para o que já foi construído, o caminho de menor risco e menor retrabalho é uma VPS Linux com acesso `root`**, não uma plataforma gerenciada. Dos três nomes pedidos, **só a Vultr pôde ser identificada como VPS** nesta verificação; a Meteor Cloud precisa ser avaliada pela página oficial antes de entrar na comparação. Isso é uma recomendação de **encaixe técnico**, não de custo.
2. Manter o Railway/Render como opção só se você decidir abrir mão do desenho atual do backup e do CD por SSH: isso reabre trabalho (backup, segredos, deploy) que está pronto para o servidor próprio.
3. Antes de contratar, **cotar** (página oficial, valor na moeda de cobrança, impostos, IOF/câmbio do cartão internacional): plano com a memória/CPU/disco medidos no ensaio, IPv4, tráfego incluído, snapshots do provedor (**não substituem** o backup externo cifrado), região, suporte e forma de pagamento.
4. **Região e LGPD.** Os dados são de saúde (dados pessoais sensíveis). Hospedar ou guardar backup fora do Brasil exige conferir a base legal e as cláusulas aplicáveis; isso não é decidido aqui nem é aconselhamento jurídico. Região em São Paulo, se houver, simplifica a conversa.
5. **Custos além do servidor** (todos sem valor confirmado): armazenamento S3 do backup (o R2 é candidato; a exigência de forma de pagamento para ativá-lo não foi verificada), domínio, canal de alerta e notificador, monitor externo (o UptimeRobot foi consultado em 28/10/2026, ver DEPLOY_RUNBOOK) e o tempo de operação.
6. Conferir depois da contratação, no servidor real, o que só ele prova (lista em BACKUP_ISOLADO.md, "O que foi provado e o que depende da VPS").

**Decisão de contratação:** pendente, sua. Nada foi comprado, reservado ou criado.

---

# Decisão (registro histórico — anterior à infraestrutura de `infra/`)

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
