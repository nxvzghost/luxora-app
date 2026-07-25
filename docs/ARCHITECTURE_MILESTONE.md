# ARCHITECTURE_MILESTONE — Marco 1: Arquitetura de Domínio do Vertex (WhatsApp/Contact)

**Status:** Fase encerrada. Decisões congeladas — qualquer alteração exige uma nova ADR.
**Data:** Julho de 2026.
**Natureza deste documento:** encerramento formal de uma fase de arquitetura de domínio. Nenhum código foi escrito durante esta fase — o produto entra agora na fase de implementação, guiada pelo que está registrado aqui.

---

## Objetivo da fase

Definir o modelo de domínio necessário para que o WhatsApp deixasse de ser tratado como canal periférico e passasse a ser, de fato, a interface oficial do paciente — sem quebrar nenhuma garantia já existente no domínio clínico e financeiro da Luxora, e sem introduzir complexidade além da estritamente necessária.

## Principais problemas resolvidos

1. **O domínio presumia que todo `Patient` já existe antes de qualquer interação.** Isso deixou de ser verdade no momento em que o primeiro evento do sistema passou a ser "telefone desconhecido inicia contato" — resolvido com a introdução do Aggregate `Contact`.
2. **Uma primeira proposta de solução (Contact promovido 1:1 a Patient) foi testada contra cenários reais de clínica e comprovadamente quebrou** em três deles — responsável falando por dependente, casal com telefone compartilhado, paciente trocando de número. Corrigida antes de qualquer implementação começar.
3. **Telefone estava sendo tratado, implicitamente, como identidade permanente de uma pessoa.** Corrigido: `Patient.id` é a única identidade estável do sistema; telefone é um atributo mutável de `Contact`.
4. **Ausência de critério objetivo para quando um contato se torna clinicamente relevante.** Resolvido com um evento de negócio concreto ("primeira consulta agendada"), não um limiar arbitrário.
5. **Ausência de uma política declarada de retenção/LGPD para contatos que nunca se tornam pacientes.**

## Decisões tomadas

Ver `docs/01-Domain/06-Decisoes-de-Dominio-WhatsApp.md` para a síntese completa, e ADR-0041 a ADR-0046 para o registro formal individual. Resumo:

- WhatsApp é a interface oficial do paciente; painel web é a interface oficial da clínica (ADR-0041, ADR-0042).
- `Contact` (identidade de comunicação) e `Patient` (vínculo clínico) são Aggregates distintos, no mesmo Bounded Context (ADR-0043, ADR-0044).
- A associação entre eles é N-para-N, com papel explícito, nunca uma transformação 1:1 — disparada pelo evento "primeira consulta agendada" (ADR-0045).
- Ambiguidade de identidade nunca é resolvida por suposição automática — sempre por confirmação antes de qualquer ação clínica (ADR-0046).
- Event Storming completo da jornada do paciente, cobrindo 15 cenários reais, incluindo os que quebraram a primeira versão da modelagem (`docs/01-Domain/07-Event-Storming-WhatsApp.md`).

## Decisões descartadas

- Transformar qualquer telefone diretamente em `Patient`.
- Promoção 1:1 rígida entre Contact e Patient, com Contact deixando de existir após a promoção.
- `Patient.phone` como âncora de identidade permanente para reconhecimento de retorno.
- Bounded Context próprio e isolado para identidade/engajamento (avaliado, rejeitado por escopo desnecessário).
- Modelo de identidade multicanal genérico (Telegram/Instagram/e-mail) desde o primeiro dia — generalização prematura, não solicitada pela visão de produto atual.
- Resolução automática de ambiguidade de identidade por heurística (ex.: "assumir o paciente mais recentemente ativo").

Justificativa detalhada de cada descarte está registrada nos próprios documentos e ADRs — nenhuma foi removida silenciosamente do histórico.

## Riscos conhecidos

- **Colisão de nome entre estados de `Contact` e estados pré-existentes de `Patient`.** Encontrada na revisão final desta fase: `Contact` usa `Novo`/`Identificado` como nomes de estado — os mesmos dois nomes já existiam como estados válidos de `Patient` antes desta fase (`docs/01-Domain/03-Maquina-de-Estados.md`). Pela lógica desta fase (ADR-0045), `Patient` nunca deveria mais nascer nesses dois estados — mas corrigir a máquina de estados de `Patient` está fora do escopo desta análise (seria redesenhar domínio já congelado antes dela começar). Registrado como pendência explícita, não corrigida — ver `docs/01-Domain/09-Jornada-do-Paciente-e-do-Contato.md`, seção "Nota de compatibilidade".
- **Prazos exatos de retenção/expurgo de Contact não foram definidos** — é uma decisão operacional, não arquitetural, deliberadamente deixada em aberto (`docs/01-Domain/08-Contact-e-Identidade-de-Comunicacao.md`, seção LGPD). Precisa ser resolvida antes da implementação do processo de expurgo automático.
- **Normalização de telefone é uma dependência crítica não detalhada nesta fase** — a reconciliação entre Contact e Patient cadastrado via painel só funciona se o telefone estiver normalizado de forma consistente; o desenho do Value Object correspondente é trabalho de implementação, não coberto aqui.
- **A cobertura de intents do `IntentActionRouter` hoje é parcial** frente à jornada mínima obrigatória desta fase (reagendamento e consulta exploratória de horários não estão roteados) — gap de implementação já identificado, não de domínio.

## Pendências futuras (fora do escopo desta fase, deliberadamente)

- Desenho técnico do webhook de recepção de mensagens do WhatsApp.
- Schema de banco de dados para `Contact` e a associação Contact↔Patient.
- Casos de uso e endpoints correspondentes.
- Prazos operacionais de retenção/expurgo.
- Extensão futura para canais além do WhatsApp (deliberadamente não modelada agora).

## Próximos passos

1. Implementação, na ordem já registrada em `docs/01-Domain/08-Contact-e-Identidade-de-Comunicacao.md` (banco → domínio → repositórios → casos de uso → API → frontend → WhatsApp → testes) — reaproveitada como sequência oficial desta fase.
2. Testes críticos mínimos de aceite: os cenários que quebraram a primeira versão do modelo (responsável/dependente, casal com telefone compartilhado, troca de número) devem ter teste crítico dedicado contra Postgres real antes de a modelagem ser considerada implementada corretamente — não apenas aprovada no papel.
3. Definição operacional dos prazos de retenção de Contact, junto ao time responsável por LGPD/compliance.

## Critérios que definem esta fase como concluída

- [x] Visão de produto (WhatsApp como interface oficial do paciente) traduzida em decisão de domínio explícita.
- [x] Modelo capaz de responder aos 15 cenários do Event Storming, incluindo os 3 que quebraram a primeira versão.
- [x] Nenhuma contradição entre Aggregates, Domain Events e Event Storming (ver Tarefa de Revisão Final, abaixo).
- [x] Toda decisão relevante registrada em ADR, rastreável, sem depender da memória de nenhuma conversa.
- [x] Nenhuma decisão de implementação (banco, API, código) tomada nesta fase — limite respeitado.

---

## Resumo executivo — entrega para a equipe de engenharia

A fase de Arquitetura de Domínio do Marco 1 do Vertex está encerrada. O modelo entregue introduz um único Aggregate novo, `Contact`, no mesmo Bounded Context já existente de Paciente — não um novo Bounded Context, não uma reescrita do domínio existente. `Patient`, `Appointment`, `Billing`, `Payment`, `Session` continuam exatamente como eram antes desta fase, em significado e em limite de consistência.

O modelo foi deliberadamente testado para quebrar antes de ser aprovado: a primeira versão (promoção 1:1, telefone como identidade) falhou contra três cenários reais e comuns de operação clínica, e foi corrigida antes de qualquer linha de código ser escrita. Isso está documentado, não escondido — as decisões descartadas fazem parte do registro oficial tanto quanto as aprovadas.

A engenharia pode iniciar a implementação com uma base estável: os Aggregates, seus limites, os eventos de domínio, as políticas reativas e os três Process Managers necessários já estão definidos. O que falta é puramente técnico (schema, repositórios, endpoints, webhook) — nenhuma decisão de negócio em aberto deveria bloquear o início da implementação. As únicas pendências reais e assumidas são operacionais (prazos de retenção) e já estão nomeadas, não escondidas.

**A fase de Arquitetura de Domínio do Vertex está formalmente concluída.**
