# 13 — Process Managers (Processos de Longa Duração)

**Status:** Documento Oficial — Marco 1 da Arquitetura do Vertex.
**Critério usado**: um Process Manager só foi declarado onde há coordenação real ao longo do tempo (múltiplos passos, espera, possível timeout) — não em toda política reativa simples, para não inflar o modelo artificialmente.

## 1. Processo de Qualificação do Contato

- **Inicia**: `ContatoCriado` (primeiro contato).
- **Coordena**: a progressão Novo → Conversando → Identificado → (Qualificado/Vinculado) → Promovido, incluindo os desvios de desambiguação (responsável falando por outro, casal com número compartilhado, troca de número exigindo confirmação).
- **Termina** em um de dois destinos: `ContatoPromovidoParaPaciente`/`ContatoVinculadoAPacienteExistente` (sucesso), ou é assumido pelo Processo de Retenção/Expurgo (nunca qualificou).

## 2. Processo de Fechamento de Ciclo Financeiro

- **Inicia**: primeira `SessaoCriada` de um novo ciclo de cobrança do paciente.
- **Coordena**: acúmulo de sessões ao longo do período definido pela política de cobrança do paciente (por sessão, semanal ou mensal), até o fechamento do ciclo.
- **Termina**: `CobrancaGerada` → mensagem enviada → `PagamentoRegistrado`/`CobrancaQuitada`, ou desvia para a régua de inadimplência (já existente antes desta fase) se o pagamento não chegar.

## 3. Processo de Retenção/Expurgo de Contato

- **Inicia**: Contact permanece em `Novo`/`Conversando` sem nunca avançar.
- **Coordena**: é o único processo desta fase orientado a **tempo** (timer), não a ação de um ator — dispara `ContatoArquivado` após o primeiro prazo de inatividade, depois `ContatoAnonimizado` após o prazo de expurgo (prazos exatos são decisão operacional, não definida nesta fase — ver `08-Contact-e-Identidade-de-Comunicacao.md`, seção LGPD).
- **Termina**: `ContatoAnonimizado` — estado terminal.

## O que deliberadamente NÃO foi modelado como Process Manager

- Reativação de paciente inativo (Cenário 10) — é uma política reativa de um único passo, não uma coordenação multi-etapa.
- Desambiguação de falante em número compartilhado (Cenário 12) — resolvida por turno de conversa, sem estado persistente próprio.

## Documentos relacionados

- `07-Event-Storming-WhatsApp.md`, `08-Contact-e-Identidade-de-Comunicacao.md`
