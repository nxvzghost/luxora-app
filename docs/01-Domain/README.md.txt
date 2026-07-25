# Luxora

# Domain Layer

## README

**Versão:** 1.0

**Status:** Documento Oficial

---

# Objetivo

A pasta **01-Domain** contém a definição oficial do domínio de negócio da Luxora.

O domínio representa o conhecimento da empresa sobre como uma clínica de saúde mental funciona administrativamente.

Nenhuma tecnologia, framework ou linguagem de programação deve influenciar estes documentos.

Eles existem para representar o negócio, não a implementação.

---

# Propósito

Toda regra importante da Luxora nasce nesta pasta.

O Backend, Frontend, Banco de Dados, APIs, Agentes de IA e Automação deverão seguir as definições descritas aqui.

Caso exista conflito entre o código e a documentação do domínio, a documentação deverá ser considerada a fonte oficial até que uma revisão seja realizada.

---

# Estrutura

Esta pasta é composta pelos seguintes documentos:

## 01 – Entidades

Define todas as entidades existentes no sistema.

Exemplos:

* Clínica
* Terapeuta
* Paciente
* Sessão
* Agenda
* Cobrança
* Pagamento
* Mensagem
* Regra
* Follow-up

---

## 02 – Relacionamentos

Define como as entidades se conectam.

Exemplo:

Clínica → Terapeuta → Paciente → Sessão → Cobrança → Pagamento

---

## 03 – Máquina de Estados

Define todos os estados possíveis de cada entidade.

Exemplo:

Paciente

* Novo
* Ativo
* Agendado
* Confirmado
* Inativo
* Alta

---

## 04 – Eventos de Domínio

Define todos os acontecimentos importantes que ocorrem dentro do sistema.

Exemplos:

* SessaoCriada
* SessaoConfirmada
* CobrancaCriada
* PagamentoConfirmado
* FollowUpIniciado

Os eventos poderão ser utilizados por automações, notificações, integrações e agentes de IA.

---

## 05 – Linguagem Ubíqua

Definirá o vocabulário oficial utilizado em toda a empresa.

Todos os documentos, códigos, APIs e agentes deverão utilizar exatamente os mesmos termos.

Exemplos:

* Sessão
* Agendamento
* Follow-up
* Cobrança
* Pagamento
* Agenda
* Horário
* Estado
* Evento

---

## Marco 1 — WhatsApp como Interface Oficial do Paciente

A partir da decisão de que o WhatsApp é a jornada oficial do paciente (ADR-0041), a pasta ganhou uma extensão dedicada, documentando a Arquitetura de Domínio dessa fase — congelada, qualquer mudança exige nova ADR.

## 06 – Decisões de Domínio: WhatsApp

Síntese executiva do que foi decidido e do que foi descartado nesta fase.

## 07 – Event Storming: WhatsApp

Fluxo completo de Comandos, Aggregates, Eventos, Políticas e Process Managers da jornada do paciente pelo WhatsApp, incluindo os 15 cenários validados (primeiro contato, agendamento, reagendamento, cancelamento, cobrança, pagamento, reativação, responsável falando por dependente, casal com telefone compartilhado, troca de número, cadastro pelo painel, contato que nunca qualificou).

## 08 – Contact e Identidade de Comunicação

Define o Aggregate `Contact` — identidade de quem conversa, distinta de `Patient` — seu ciclo de vida, os casos especiais e a política de LGPD/retenção.

## 09 – Jornada do Paciente e do Contato

As duas jornadas lado a lado, e o evento que as conecta (promoção).

## 10 – Arquitetura WhatsApp e Painel

Princípio conceitual de que painel e WhatsApp compartilham o mesmo backend e domínio — sem entrar em infraestrutura.

## 11 – Aggregates e Limites

## 12 – Domain Events (extensão desta fase)

## 13 – Process Managers

---

# Regras Gerais

1. O domínio não depende de tecnologia.

2. O domínio não conhece banco de dados.

3. O domínio não conhece interface gráfica.

4. O domínio não conhece APIs.

5. O domínio representa exclusivamente o negócio.

---

# Relação com outras camadas

A pasta **01-Domain** serve como base para:

* PRD
* Arquitetura
* Banco de Dados
* APIs
* Agentes de IA
* Frontend
* Backend
* Testes
* Dashboard
* Integrações

Nenhuma dessas camadas poderá alterar as regras do domínio.

---

# Evolução

Sempre que uma nova funcionalidade alterar o funcionamento do negócio, os documentos desta pasta deverão ser atualizados antes da implementação.

A documentação do domínio é considerada a principal referência técnica da Luxora.

---

# Princípios

O domínio deve permanecer:

* Simples
* Consistente
* Independente de tecnologia
* Auditável
* Configurável por clínica
* Escalável

---

# Fonte da Verdade

A pasta **01-Domain** é a fonte oficial das regras do negócio.

Toda implementação da Luxora deverá refletir fielmente o conteúdo aqui definido.

Quando houver divergência entre implementação e domínio, a documentação deverá ser revisada e atualizada antes de novas alterações no código.

---

# Histórico de Versões

**v1.0**

* Criação da estrutura inicial do domínio.
* Definição dos documentos fundamentais.
* Estabelecimento das responsabilidades da camada de domínio.

**v1.1**

* Marco 1 — Arquitetura de Domínio do WhatsApp como interface oficial do paciente.
* Adição do Aggregate `Contact` (documentos 06 a 13).
* Extensão da Linguagem Ubíqua (05) com os termos Contato, Identidade de Canal, Papel, Promoção, Qualificação.
* ADR-0041 a ADR-0046 registradas em `02-Arquitetura/ADRs/`.
