# 04 - Fluxo: Financeiro (Cobrança e Pagamento)

## Objetivo

Detalhar a experiência de cobrança e pagamento (RF-071 a RF-080, JP-008/JP-009), refletindo o modelo de cobrança agregada corrigido em `03-Database/03-Relacionamentos.md`.

---

# Tela de Cobranças — visão por ciclo, não por sessão isolada

Como uma `billing` pode agregar N sessões (política semanal/mensal, definida em `06-UX/01-Fluxo-Configuracao-Clinica.md`), a listagem principal exibe **cobranças**, com expansão opcional mostrando as sessões agregadas — nunca uma sessão listada como se sempre gerasse uma cobrança isolada, o que confundiria o usuário nas clínicas com política mensal/semanal.

```
Cobrança #123 — Maria Silva — R$ 480,00 — Vencimento 05/08
  └ 4 sessões incluídas (expandir)
```

---

# Registro de pagamento

Fluxo curto, otimizado para uso frequente entre atendimentos:

```
1. Buscar cobrança (por paciente ou lista de pendentes)
   ↓
2. Confirmar valor recebido
   ↓
3. Selecionar forma de pagamento (PIX, cartão, dinheiro, transferência — RF-014)
   ↓
4. Anexar comprovante (opcional, RF-072)
   ↓
5. Salvar (POST /payments, com Idempotency-Key)
```

A etapa 5 nunca permite duplo clique gerar dois pagamentos — o botão de salvar é desabilitado imediatamente após o primeiro clique, e o `Idempotency-Key` já garante proteção no Backend mesmo em caso de reenvio de rede (`04-API/00-Principios-da-API.md`).

---

# Pipeline financeiro completo (confirmado pela liderança)

Consolidação de ponta a ponta do ciclo financeiro — cada passo já mapeado a um estado existente na máquina de estados (`01-Domain/03-Maquina-de-Estados.md`) ou a um Caso de Uso já definido:

| # | Passo | Estado / Caso de Uso técnico |
|---|---|---|
| 1 | **Cobra** | `billing.status`: Criada → Enviada (`GerarCobranca`, `EnviarCobranca`) |
| 2 | **Recebe** | `payment.status`: Recebido (comprovante/PIX identificado) |
| 3 | **Confirma** | `payment.status`: Em Conferência → Confirmado (`RegistrarPagamento`) |
| 4 | **Dá baixa** | `billing.status`: Confirmado → **Quitada** — a confirmação do pagamento baixa automaticamente a cobrança correspondente, nunca uma ação manual separada |
| 5 | **Contabiliza por paciente** | View `patient_financial_segment` (`03-Database/10-Views.md`) — quantidade de consultas, quanto deve, quanto pagou, por paciente |
| 6 | **Fechamento geral de fim de mês** | `GerarFechamentoMensal` (`06-UX/05-Fluxo-Fechamento-Mensal.md`) |
| 7 | **Balanço** | Documento formal consolidado — ver formato profissional detalhado em `06-UX/05-Fluxo-Fechamento-Mensal.md` |
| 8 | **Entrega ao terapeuta/cliente** | Envio automatizado do fechamento (`POST /api/v1/reports/monthly-closing/send`) |

**Regra central do passo 4 (dar baixa):** nunca existe uma cobrança "Confirmada" sem a baixa correspondente acontecer no mesmo momento — os dois são a mesma transação vista de dois ângulos (pagamento confirmado = cobrança quitada), nunca dois passos que podem ficar dessincronizados.

---



Prática validada há 3 anos: cobrar sempre antes ou depois da própria sessão (nunca acumulado à parte) educa o paciente a já agendar sabendo que vai pagar — o que resolve pagamento e continuidade de tratamento na mesma interação. A interface do agente de IA (ver `05-IA/01-Tom-de-Voz-e-Estilo-Conversacional.md`, seção "Jornada completa") já reflete isso: o fechamento do ciclo de cobrança oferece proativamente o próximo agendamento, não trata as duas coisas como fluxos separados. O Frontend deve seguir o mesmo princípio quando o registro de pagamento for feito manualmente pelo terapeuta — sugerir a criação do próximo agendamento na mesma tela de confirmação de pagamento, não como ação isolada em outro lugar do sistema.

---

# Segmentação de pacientes por status financeiro

Nova visão dentro da tela de Cobranças: filtros/cartões para **Pacientes em dia**, **Pacientes semanais**, **Pacientes mensais**, **Pacientes em atraso** (até 7 dias) e **Pacientes inadimplentes** (acima de 40 dias) — alimentados pela view `patient_financial_segment` (`03-Database/10-Views.md`). Ver o princípio ético e a régua de comunicação completa em `05-IA/03-Gestao-de-Inadimplencia.md`: o terapeuta nunca abandona o atendimento por inadimplência, e nenhuma mensagem automática do sistema menciona suspensão — a segmentação existe para dar visibilidade, não para acionar corte de atendimento.

---

# Inadimplência

A listagem de cobranças em atraso é a mesma exibida no Dashboard (`06-UX/02-Fluxo-Dashboard.md`), reaproveitando o componente — nunca duas implementações divergentes da mesma lista.

---

# Documentos Relacionados

- 03-Database/03-Relacionamentos.md
- 04-API/01-Contratos-REST.md (Financeiro)
- 06-UX/01-Fluxo-Configuracao-Clinica.md
- 06-UX/02-Fluxo-Dashboard.md
