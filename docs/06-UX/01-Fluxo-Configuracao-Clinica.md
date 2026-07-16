# 01 - Fluxo: Configuração da Clínica

## Objetivo

Este é o fluxo apontado como o mais crítico e o menos detalhado na análise de arquitetura original — a experiência de configurar as políticas da clínica é central à proposta de valor ("Configuração acima de Programação", Princípio 11), mas até esta versão não existia especificação de tela alguma para ela.

O usuário deste fluxo é o próprio ICP definido em `CEO/04 - ICP`: um profissional não-técnico, sem equipe administrativa.

---

# Momento de uso

1. **Onboarding inicial** — obrigatório antes do primeiro uso operacional da plataforma.
2. **Ajuste posterior** — a qualquer momento, via tela de Configurações (já prevista em `02-Arquitetura/04-Frontend.md`, módulo "Configurações").

---

# Estrutura do fluxo (onboarding inicial)

```
1. Dados básicos da Clínica (RF-001 a RF-009)
   ↓
2. Política Financeira (RF-010)
   ↓
3. Política de Cancelamento e Remarcação (RF-011, RF-012)
   ↓
4. Duração padrão de sessão e formas de pagamento (RF-013, RF-014)
   ↓
5. Cadastro do primeiro Terapeuta (RF-015 a RF-025)
   ↓
6. Confirmação e resumo
```

Cada etapa é apresentada isoladamente (wizard), nunca como um formulário único longo — reduz a carga cognitiva para um usuário não-técnico, alinhado a RNF-007 (Usabilidade).

---

# Etapa 2 — Política Financeira (detalhamento)

Esta etapa merece atenção especial por resolver, na interface, a ambiguidade de cobrança já corrigida em `03-Database/03-Relacionamentos.md`.

**Correção importante confirmada pela liderança, a partir de anos de prática real:** a política de cobrança não é fixa para toda a clínica — ela é **configurada por padrão no nível da clínica, mas pode ser sobrescrita individualmente por paciente**. Na prática observada, a maioria dos pacientes segue o padrão normal (por sessão, antes ou depois da consulta), mas pacientes fixos de longa data frequentemente preferem consolidar o pagamento semanal ou mensalmente, por conveniência. É comum, na mesma clínica, coexistirem pacientes com políticas diferentes ao mesmo tempo — ex: um paciente mensal, outro semanal, outro por sessão, todos atendidos pelo mesmo terapeuta.

**Pergunta ao usuário na configuração da clínica, em linguagem simples:**

> "Qual é a forma de cobrança que você mais usa? (você poderá ajustar individualmente para pacientes específicos depois)"

Opções apresentadas como cards, não como dropdown técnico:

- **Por sessão** — "Cobro antes ou depois de cada consulta" → gera 1 `billing` por `session` (caso N=1 do modelo `billing_session`). **Este é o padrão mais comum e a opção pré-selecionada por padrão.**
- **Semanal** — "Cobro no fim de cada semana, juntando as sessões" → gera 1 `billing` agregando as `sessions` da semana.
- **Mensal** — "Cobro uma vez por mês" → gera 1 `billing` agregando as `sessions` do mês.

Sub-pergunta condicional (apenas se "Por sessão"): "Antes ou depois da consulta?" — mapeia diretamente para o momento de disparo do Caso de Uso `GerarCobranca` (`04-API/01-Contratos-REST.md`).

Esta escolha define o **valor padrão** (`clinic.default_billing_policy`) aplicado a todo paciente novo — não é mais uma regra única e imutável para toda a clínica.

## Ajuste individual por paciente

Na tela de cadastro/edição de cada paciente (`04-API/01-Contratos-REST.md`, seção Pacientes), existe um campo opcional "Forma de cobrança deste paciente", com as mesmas 3 opções acima, mais uma quarta opção "Usar o padrão da clínica" (valor default). Exemplo real de como isso se aplica na prática, com pacientes fictícios:

```
Frederico — Mensal
Pedro — Semanal
João — Por sessão (padrão da clínica)
```

O terapeuta ajusta isso caso a caso, sem precisar reconfigurar a clínica inteira — a maioria dos pacientes simplesmente herda o padrão, e só os casos específicos (geralmente pacientes fixos de longa data que preferem consolidar o pagamento) recebem o ajuste individual.

---

# Etapa 3 — Política de Cancelamento e Remarcação

**Pergunta:** "Com quanto tempo de antecedência um paciente pode cancelar sem cobrança?"

Campo numérico com unidade (horas/dias) + explicação inline do que acontece quando a antecedência não é respeitada, para que o usuário entenda a consequência antes de salvar.

---

# Validação e reversibilidade

Toda configuração salva nesta etapa pode ser alterada depois, sem necessidade de suporte (reforça Princípio 11). A tela de Configurações reaproveita exatamente os mesmos componentes deste wizard, evitando duas implementações divergentes da mesma lógica de apresentação.

---

# O que este fluxo nunca faz

- Nunca expõe o nome técnico das tabelas ou campos (`tenant_id`, `billing_session` etc.) — linguagem sempre de negócio, refletindo a Linguagem Ubíqua em português (`01-Domain/05-Linguagem-Ubiqua.md`).
- Nunca bloqueia o uso do restante do sistema aguardando "configuração perfeita" — valores padrão sensatos são pré-selecionados (ex: cobrança por sessão, após a consulta, como padrão inicial, dado que é a política predominante segundo o PRD).

---

# Documentos Relacionados

- 00-Principios-Arquiteturais.md (Princípio 11)
- 03-Database/03-Relacionamentos.md
- 04-API/01-Contratos-REST.md (Clínica, Política)
- 01-Domain/05-Linguagem-Ubiqua.md
