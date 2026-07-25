# Portfólio de Produtos — Luxora

## O que é a Luxora

A Luxora não é um único software. É uma empresa de produtos SaaS que usa IA para eliminar
trabalho intelectual repetitivo, construída produto por produto.

### Filosofia

Não criamos produtos por ideias. Criamos produtos a partir de problemas reais, ouvidos
pessoalmente de profissionais. Toda decisão arquitetural — em qualquer produto — deve
preservar essa filosofia.

O ciclo é sempre:

1. ouvir uma dor real;
2. validar a dor;
3. construir uma solução excepcional;
4. repetir.

A Luxora não quer ser uma software house (não constrói sob encomenda para terceiros). Quer
ser uma empresa de produtos SaaS de alto nível.

### Regra de foco

Nenhum novo produto pode tirar foco do produto em desenvolvimento ativo. Novos produtos
podem ser **registrados** (documentados) a qualquer momento — a dor real pode surgir em
qualquer conversa — mas só entram em pesquisa de arquitetura ou desenvolvimento quando
explicitamente autorizado, e nunca à custa do produto em foco.

---

## Produto 01 — Sistema de Clínica (em desenvolvimento — foco total)

Software de gestão para clínicas de saúde mental (multi-tenant). É o produto principal da
Luxora hoje: todo o esforço de engenharia está nele. Deve ser extremamente profissional,
escalável e pronto para empresas antes de qualquer outro produto começar.

Documentação técnica: ver o restante de `docs/` (arquitetura, domínio, decisões de produto
em `docs/11-Product-Decisions/`).

---

## Produto 02 — Luxora Mail Intelligence (apenas registrado — não iniciado)

**Status: documentado apenas. Sem pesquisa de arquitetura, sem desenvolvimento.**

### Origem

Uma paciente da clínica (Produto 01), dona de um dos maiores escritórios de advocacia da
região, comentou que seu maior sonho seria abrir a caixa de entrada e não encontrar mais de
15 mil e-mails acumulados.

### O problema

O problema não é ler e-mails. É separar automaticamente:

- o que realmente importa;
- negociações importantes;
- clientes VIP;
- oportunidades financeiras;
- documentos críticos;
- spam;
- newsletters;
- e-mails descartáveis.

A IA deveria aprender continuamente com as decisões do usuário.

### Escopo desta entrada

Este produto existe, por enquanto, apenas como visão de longo prazo. Nenhuma arquitetura,
stack ou plano de implementação foi definido. Não iniciar pesquisa técnica nem
desenvolvimento sem autorização explícita — e apenas depois do Produto 01 atingir o nível de
maturidade esperado.
