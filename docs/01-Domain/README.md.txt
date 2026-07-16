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
