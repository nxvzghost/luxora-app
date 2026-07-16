# 00 - Princípios de UX

## Objetivo

Definir critérios gerais que toda tela da Luxora deve seguir, operacionalizando a filosofia já declarada em `02-Arquitetura/04-Frontend.md` ("Centro de Operações").

---

# Critério de cada tela

Toda tela deve responder, em até 3 segundos de leitura, à pergunta: **"o que eu preciso fazer agora?"** — não apenas "o que existe no sistema".

---

# Estados obrigatórios

Já definidos em `02-Arquitetura/04-Frontend.md` — Loading, Empty State, Success, Warning, Error, Offline. Reforço aqui: o **Empty State** de cada módulo deve orientar a próxima ação (ex: agenda vazia → botão direto para "Agendar primeira consulta"), nunca apenas informar ausência de dados.

---

# Ambiente principal: desktop, com atenção ao uso no celular

O documento `02-Arquitetura/04-Frontend.md` já define desktop como ambiente principal de uso administrativo. Esta seção reforça um ponto de atenção identificado na análise de arquitetura: o canal primário de contato com o paciente é WhatsApp, e o ICP descrito em `CEO/04 - ICP` usa WhatsApp diariamente e de forma predominantemente mobile.

**Recomendação de UX:** as ações de maior frequência durante o expediente entre atendimentos (confirmar consulta, ver próximo paciente, checar pagamento pendente) devem funcionar plenamente em viewport mobile mesmo que o desktop continue sendo o ambiente de configuração e visão consolidada. Essa divisão deve ser validada com o time de produto antes do desenho definitivo de cada tela.

---

# Feedback de ação

Toda ação do usuário produz feedback imediato (já exigido em `02-Arquitetura/04-Frontend.md`). Adicionalmente:

- Ações que dependem de validação do Backend (ex: agendar, cobrar) mostram estado "processando" — nunca fecham a interação antes da confirmação do servidor, para evitar a sensação de sucesso falso em caso de erro de rede.
- Erros de regra de negócio (`business_rule`, ver `04-API/00-Principios-da-API.md`) são exibidos com linguagem humana, nunca o `code` técnico bruto.

---

# Configuração acima de programação, também na interface

Reflexo direto do Princípio 11 (`02-Arquitetura/00-Principios-Arquiteturais.md`): toda política configurável pela clínica deve ter uma tela correspondente — nunca exigir suporte técnico ou alteração de código para ajustar comportamento já previsto como configurável.

---

# Documentos Relacionados

- 02-Arquitetura/04-Frontend.md
- 04-API/00-Principios-da-API.md
- 00-Principios-Arquiteturais.md (Princípio 11)
