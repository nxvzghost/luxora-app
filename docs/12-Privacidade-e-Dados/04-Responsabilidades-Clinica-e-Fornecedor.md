# 04 — Responsabilidades entre a clínica e o fornecedor

> **PENDENTE DE APROVAÇÃO E DE AVALIAÇÃO JURÍDICA.** Isto não é contrato nem minuta. É o roteiro dos pontos que o termo entre a clínica e a Luxora precisa cobrir, com o fato técnico que sustenta cada um. Os papéis na LGPD (controlador, operador) **não** estão definidos aqui: são a primeira pergunta para a avaliação jurídica.

## 1. Fatos técnicos que o termo precisa refletir

| Fato | Evidência |
|---|---|
| A clínica decide quem é paciente, marca, cobra e dá alta. | Telas e rotas do painel |
| O sistema da Luxora responde sozinho às mensagens de texto, com IA de terceiro, e age (marca, remarca, cancela, cadastra paciente novo com confirmação). | `IntentActionRouter`, `ContactIntentActionRouter`, ADR-0063 |
| Cada clínica usa o próprio número de WhatsApp e o próprio token da Meta. | `whatsapp_integration`, ADR-0049 |
| A conta da Anthropic é da Luxora, uma só para todas as clínicas. | Variável `ANTHROPIC_API_KEY` única no ambiente |
| Os dados de todas as clínicas ficam no mesmo banco, separados por RLS. | [`07-Multitenancy.md`](../02-Arquitetura/07-Multitenancy.md), testes de isolamento |
| Quem administra o servidor da Luxora tem acesso técnico a todos os dados, inclusive ao texto das conversas. | Inventário, seção 7 |
| Não existe hoje exclusão, exportação nem prazo de guarda aplicados. | Documento 02 |

## 2. Pontos que o termo precisa cobrir

1. **Papéis e finalidades:** quem determina as finalidades e os meios de cada operação (atendimento, cobrança, uso da IA, métricas da Luxora). — *Avaliação jurídica.*
2. **Instruções da clínica:** o que a Luxora faz com os dados só por instrução da clínica, e o que faz por conta própria (por exemplo, métricas de uso e custo). — *Decisão + jurídico.*
3. **Suboperadores:** Anthropic (IA), Meta (canal), provedor de hospedagem e de backup (a contratar, A-12). Como a clínica é informada de troca. — *Depende das condições de cada fornecedor.*
4. **Transferência internacional:** se Anthropic e Meta processam fora do Brasil, em que condições. — *Jurídico + verificação das contas.*
5. **Segurança:** o que a Luxora garante (isolamento, cifragem do token, logs sem dado pessoal, backup — quando existir) e o que não garante ainda. — *Decisão; os itens devem ser só os comprovados.*
6. **Retenção e devolução no fim do contrato:** o que acontece com os dados da clínica quando ela sai; prazo de devolução ou exclusão. — *Decisão + jurídico.* Hoje não há rotina para isso.
7. **Pedidos de titulares:** quem recebe, quem executa, em quanto tempo ([documento 05](./05-Solicitacoes-de-Titulares-e-Incidentes.md)). — *Decisão + jurídico.*
8. **Incidentes:** quem avisa quem, em quanto tempo, com que informação. — *Jurídico.*
9. **Acesso da Luxora aos dados:** em que situações a equipe da Luxora pode olhar dados de pacientes (suporte, investigação de falha) e como isso fica registrado. — *Decisão.* Hoje não há registro.
10. **Uso de IA:** a clínica concorda que as mensagens sejam processadas por IA de terceiro e informa o paciente (documento 03). — *Decisão + jurídico.*
11. **Piloto de cortesia:** condições do piloto sem cobrança (A-16), prazo e o que acontece no fim. — *Decisão comercial.*

## 3. Condições dos fornecedores a verificar antes do termo

Nenhuma destas está registrada no repositório; precisam ser lidas nos termos das contas efetivamente usadas:

- **Anthropic:** retenção dos dados enviados pela API, uso para treinamento, local de processamento, disponibilidade de acordo de tratamento de dados.
- **Meta:** condições de dados da WhatsApp Business Platform para a conta de cada clínica; quem é o titular da conta (a clínica ou a Luxora) — ligado à decisão de modelo de contas do A-07.
- **Provedor de hospedagem e de backup:** a escolher (A-12); local dos dados e condições.
