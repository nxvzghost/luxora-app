# Sprint 0 — Entregável 6: Checklist de Início

## "Estamos realmente prontos para escrever a primeira linha de código?"

### Documentação
- [x] PRD completo e sem contradição interna (Auditoria Final)
- [x] Domain modelado, com Linguagem Ubíqua consolidada
- [x] Arquitetura documentada (23 Princípios, 21 ADRs)
- [x] Banco de dados modelado, com RLS e cobrança agregada corrigidos
- [x] API especificada (contratos REST completos para o MVP)
- [x] IA especificada (provedor, custo, tom de voz, critério de autonomia)
- [x] UX especificado para os fluxos críticos do MVP
- [x] Testes críticos definidos (16 cenários obrigatórios)

### Decisões de negócio necessárias para o M1-M8
- [x] Nome do produto (Luxora)
- [x] Modelo de precificação (Professional/Business/Enterprise — Starter descontinuado)
- [x] Modelo de cobrança (agregada, por paciente)
- [x] Provedor de IA e teto de custo
- [x] Provedor de infraestrutura (recomendação técnica fechada)

### Decisões de negócio que podem esperar (não bloqueiam M1)
- [ ] Nomenclatura final de sub-serviços — **resolvida nesta Sprint 0** (Entregável 2)
- [ ] Consolidação de 15→6 Serviços de Domínio — **resolvida nesta Sprint 0** (Entregável 2)
- [ ] Fluxo de migração de dados de sistema anterior — pode esperar até M5
- [ ] Validação jurídica de LGPD/Termos de Uso — pode esperar até o lançamento comercial
- [ ] Cotação oficial de infraestrutura — pode esperar até o primeiro deploy real

### Arquitetura física e stack
- [x] Estrutura de repositório definida (Entregável 3)
- [x] Stack tecnológica definida e justificada (Entregável 4)
- [x] Critérios de engenharia definidos (Entregável 5)

### Infraestrutura mínima para começar
- [ ] Repositório Git criado (ação: Pedro, antes do primeiro commit)
- [ ] Conta Railway (ou equivalente) criada em modo de teste
- [ ] Ambiente de CI configurado (GitHub Actions básico: lint + testes)
- [ ] Acesso de ambos (Frederico e Pedro) configurado no repositório

---

## Veredito

**Sim — estamos prontos para o Módulo 1.**

As únicas pendências reais (migração de dados, validação jurídica, cotação de infraestrutura) não bloqueiam nenhuma linha de código do Módulo 1 ao Módulo 8 — são decisões de negócio ou validações externas que rodam em paralelo à implementação técnica, não antes dela.

As duas pendências técnicas que existiam (nomenclatura de "Motor" e consolidação de serviços) foram fechadas dentro desta própria Sprint 0, no Entregável 2.

## Próximo passo

Aguardando autorização explícita de Frederico (e alinhamento com Pedro, como CTO) para iniciar o **Módulo 1 — Fundação Técnica**, seguindo exatamente a estrutura de repositório (Entregável 3), a stack (Entregável 4) e os critérios de engenharia (Entregável 5) definidos nesta Sprint 0.
