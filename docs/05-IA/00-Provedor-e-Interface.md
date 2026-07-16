# 00 - Provedor de IA, Interface Técnica e Orçamento

## Status: Decisão fechada para o MVP.

Este documento substitui a versão anterior (que definia apenas a interface, sem provedor nem orçamento). Com os planos de precificação confirmados (`CEO/07 - Planos e precificação`) e o preço de mercado atual dos modelos de IA, foi possível calcular um teto de custo real e escolher o modelo do MVP.

---

# Decisão

**Modelo recomendado para o MVP: Claude Haiku 4.5 (Anthropic API).**

Justificativa técnica:

- É o modelo mais barato de última geração da Anthropic ($1,00 / milhão de tokens de entrada, $5,00 / milhão de saída), com qualidade de instrução comparável a modelos de categoria intermediária de gerações anteriores — adequado para interpretação de intenção em mensagens curtas de WhatsApp (agendar, cancelar, confirmar, dúvida administrativa), que é exatamente o escopo definido em RN-018 e Princípio 22 (IA nunca decide, só interpreta).
- Latência baixa (otimizado para aplicações em tempo real como chat), relevante para manter a sensação de conversa natural no WhatsApp, não de "chatbot lento".
- Acessado sempre através da interface `IAIProvider` já definida abaixo — trocar de modelo (para Sonnet em casos que exijam mais raciocínio, ou para outro provedor) não exige alterar nenhuma regra de negócio, conforme Princípio 13 (Independência Tecnológica).

**Nota de dado sensível:** como o Princípio 08 (`00-Principios-Arquiteturais.md`) já proíbe que qualquer dado clínico seja armazenado ou processado pela plataforma, o conteúdo enviado ao provedor de IA é estritamente administrativo (nome, horário, valor, status) — isso simplifica a avaliação de LGPD em relação a um cenário que envolvesse dado de saúde propriamente dito, mas não a elimina; revisão jurídica do contrato com o provedor continua recomendada antes do lançamento comercial.

---

# Cálculo do orçamento por conversa

## Premissas

- Clínica típica no plano Professional: ~60–80 pacientes ativos/mês (dentro da faixa do ICP, RF do PRD).
- Estimativa de ~3 interações mediadas por IA por paciente/mês (agendamento, confirmação, e uma consulta administrativa adicional) → **~200–250 conversas/mês por clínica**.
- Meta de orçamento de IA: até **10% do MRR do plano**, mantendo espaço para os demais custos (infraestrutura, já orçada em `07-Infra/00-Provedor-e-Custos.md`, e margem saudável).

## Teto de custo por plano (RNF-021)

| Plano | Preço | Orçamento de IA (10% MRR) | Conversas/mês estimadas | Teto por conversa |
|---|---|---|---|---|
| **Professional** (flagship, plano de entrada) | R$ 597 | R$ 59,70 | ~200–250 | ~R$ 0,24–0,30 |
| Business | R$ 997 | R$ 99,70 | ~300–400 (equipe/multiunidade) | ~R$ 0,25–0,33 |
| Enterprise | R$ 2.990+ | R$ 299+ | Variável, com "Configuração da IA para a clínica" incluída no serviço | Sem teto rígido — acompanhado na consultoria semanal |

**Teto de referência unificado para RNF-021: R$ 0,25 por conversa**, aplicado como alerta automático (não bloqueio) em `02-Arquitetura/11-Monitoramento.md`.

## Custo real estimado do Haiku 4.5

Uma interação típica (contexto da clínica + histórico curto + mensagem do paciente ≈ 500 tokens de entrada; resposta interpretada ≈ 150 tokens de saída):

```
Entrada: 500 tokens × ($1,00 / 1.000.000) = $0,0005
Saída:   150 tokens × ($5,00 / 1.000.000) = $0,00075
Total por turno: ≈ $0,00125 (≈ R$ 0,007, câmbio de referência R$ 5,50)
```

Uma conversa completa (2–3 turnos até resolver a intenção) fica em torno de **$0,003–0,004 (≈ R$ 0,02)** — bem abaixo do teto de R$ 0,25 definido acima, mesmo sem aplicar prompt caching (que reduziria ainda mais o custo de contexto repetido, como as configurações da clínica).

**Margem de segurança: o teto tem folga de aproximadamente 10x sobre o custo real estimado** — espaço confortável para conversas mais longas que o esperado, escalonamentos, ou eventual necessidade de usar um modelo mais caro (Sonnet) em casos específicos, sem estourar o orçamento por clínica.

---

# Interface `IAIProvider`

Todo provedor de IA utilizado pela Luxora deve implementar o mesmo contrato, independentemente do fornecedor:

```typescript
interface IAIProvider {
  interpretIntent(input: ConversationInput): Promise<IntentResult>;
  generateResponse(context: ConversationContext): Promise<AIResponse>;
  getUsage(requestId: string): Promise<UsageMetrics>;
}

interface IntentResult {
  intent: string;              // ex: "agendar_consulta", "cancelar_consulta"
  confidence: number;
  entities: Record<string, unknown>;
  requiresEscalation: boolean; // true quando o caso foge do padrão "tudo ok" (ver critério de autonomia abaixo)
  escalationReason?: string;   // motivo da consulta de segurança, quando requiresEscalation = true — nunca deixado em branco quando a flag é true
}

interface UsageMetrics {
  inputTokens: number;
  outputTokens: number;
  costEstimate: number;        // em centavos de real, na moeda de referência
  latencyMs: number;
}
```

## Regras

- Nenhum Caso de Uso do Backend chama o SDK da Anthropic diretamente — sempre através de `IAIProvider`.
- `interpretIntent` **nunca** executa uma ação — apenas identifica a intenção. A execução segue o fluxo já definido: IA → Motor Operacional → Caso de Uso (ADR-0006).
- Todo agente configurado por Tenant (personalidade, tom, mensagens padrão — já definido em `07-Multitenancy.md`) é resolvido **antes** da chamada ao provedor, idealmente aproveitando prompt caching para o bloco de configuração da clínica, que se repete em toda conversa daquele Tenant.
- Todo `UsageMetrics` retornado é registrado em auditoria (`03-Database/08-Auditoria.md`, `actor_type = ai_agent`), incluindo `costEstimate`, permitindo acompanhar consumo real por Tenant frente ao teto definido acima.

## Critério de autonomia vs. escalonamento (confirmado pela liderança)

A linha entre o que a IA resolve sozinha e o que precisa de consulta humana foi definida com precisão:

**A IA decide sozinha (autônoma) apenas quando o caso é linear e sem anomalia** — os três exemplos confirmados:
- Agenda: horário consultado, disponível, agendado — sem conflito.
- Consulta/atendimento: aconteceu conforme esperado, sem intercorrência relatada pelo paciente.
- Pagamento: cobrança gerada, comprovante recebido, valor confere — sem divergência.

Em resumo: quando a IA identifica que **está tudo dentro do esperado** ("está tudo ok"), ela resolve e confirma sozinha, sem precisar de intervenção.

**Qualquer coisa mais complexa aciona uma consulta de segurança** — não é apenas "escalar e sumir da conversa", é um mecanismo ativo de checagem: diante de uma situação fora do padrão (ex: valor de comprovante não bate, paciente relata algo emocionalmente delicado, pedido ambíguo que não se encaixa em nenhum Caso de Uso claro, conflito real de agenda sem solução óbvia), o agente não tenta resolver por conta própria nem apenas transfere silenciosamente — ele aciona o mecanismo de consulta para que a situação seja resolvida de forma rápida e eficiente, com decisão humana.

**Implicação técnica:** `requiresEscalation` deve ser tratado como um mecanismo de **consulta ativa**, não apenas uma bandeira passiva de "fora de escopo". Isso reforça diretamente o Princípio 03 (IA nunca decide sozinha) no ponto mais sensível do produto: dificuldade financeira ou qualquer situação atípica pode estar diretamente ligada ao próprio motivo que trouxe a pessoa à terapia — a decisão de como conduzir isso é sempre humana, e o sistema precisa tornar essa consulta rápida, não burocrática.

---

# Avaliação de qualidade do agente

Além de custo, todo agente deve ser avaliado por:

- Taxa de acerto de intenção (`confidence` médio e taxa de reclassificação manual).
- Taxa de escalonamento correto (`requiresEscalation` disparado nos casos certos — nem de menos, nem de mais) — calibrado especificamente pelo critério "tudo ok = autônomo, qualquer anomalia = consulta" definido acima.
- Tempo de resposta da consulta de segurança quando acionada — deve ser rápido, já que o objetivo é resolver "rápido e eficiente", não travar o atendimento ao paciente.
- Custo médio por conversa frente ao teto de R$ 0,25 (alerta se ultrapassar 70% do teto de forma sustentada).

---

# Segurança e escopo do agente

Reforçando regras já definidas em RN-018, RN-019 (PRD) e Princípio 22 (Arquitetura):

- O agente nunca recebe mais contexto do que o necessário para a tarefa em execução.
- O agente nunca tem acesso a dados de outro Tenant — `IAIProvider` sempre recebe o `TenantContext` já resolvido (mesmo mecanismo de `07-Multitenancy.md`).
- Nenhum dado clínico (Princípio 08) é enviado ao provedor de IA sob nenhuma circunstância — validado na camada de montagem do contexto, antes da chamada.

---

# Validação recomendada antes do lançamento comercial

Mesmo com o modelo e o orçamento já decididos, recomendo validar com um piloto real de 2–3 semanas usando conversas de WhatsApp reais (ou simuladas a partir de RF-061 a RF-070 do PRD) antes do lançamento comercial, para confirmar taxa de acerto de intenção na prática — a decisão de provedor e orçamento acima não depende dessa validação (a margem de 10x cobre variações razoáveis), mas a qualidade da experiência do usuário se beneficia de ajuste fino de prompt com dado real.

---

# Documentos Relacionados

- 02-Arquitetura/00-Principios-Arquiteturais.md (Princípio 08, 13, 22)
- 02-Arquitetura/ADRs/ADR-0006.md (IA como Interface Conversacional)
- 03-Database/08-Auditoria.md
- 03-Database/09-Multi-Tenant.md
- 02-Arquitetura/11-Monitoramento.md
- 07-Infra/00-Provedor-e-Custos.md
