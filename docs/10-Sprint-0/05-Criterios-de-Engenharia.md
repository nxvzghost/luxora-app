# Sprint 0 — Entregável 5: Critérios de Engenharia

Padrões obrigatórios durante todo o desenvolvimento — não são sugestão, são requisito de revisão de código.

---

## Convenções de código

- **Lint/Format:** ESLint + Prettier, configuração compartilhada em `packages/config`, aplicada via pre-commit hook (Husky) — nenhum código chega ao PR sem passar localmente.
- **Nomenclatura:** segue rigorosamente `01-Domain/05-Linguagem-Ubiqua.md` — nome de classe, variável e endpoint usa os termos já definidos ali (ex: `session` nunca vira `consultation` ou `appointment` de forma intercambiável).
- **Nenhum `any` em TypeScript** sem comentário justificando explicitamente por que a tipagem não é possível naquele ponto.
- **Regra de dependência arquitetural** (`domain/` nunca importa de `infrastructure/`) enforçada por lint estrutural, não apenas por revisão humana.

## Estrutura de commits

- **Conventional Commits** obrigatório: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- Todo commit que implementa um Caso de Uso referencia o RF ou RN correspondente do PRD no corpo da mensagem (ex: `feat(billing): implementa GerarCobranca agregada (RF-071)`).
- Commits pequenos e frequentes — nenhum PR com mais de ~400 linhas de diff sem justificativa (dificulta revisão de qualidade real).

## Versionamento

- **Trunk-based development** com branches curtas de feature (`feat/nome-curto`), sempre a partir de `main`.
- **SemVer** para a API (`/api/v1`, `/api/v2` conforme já definido em `04-API/00-Principios-da-API.md`) — nunca breaking change dentro da mesma versão major.
- Tags de release seguem `v0.X.0` até o primeiro cliente pagante; `v1.0.0` marca o primeiro cliente real em produção.

## Testes — requisito mínimo por tipo de código

| Camada | Requisito |
|---|---|
| `domain/` (M2) | 100% de cobertura de linha, sem exceção — é a camada mais barata de testar exaustivamente e a mais cara de errar |
| `use-cases/` | Teste unitário do comportamento de decisão para todo Caso de Uso |
| `api/` | Teste de integração cobrindo caminho feliz + ao menos um caminho de erro de negócio por endpoint |
| `test/critical/` | Os 16 Testes Críticos (`09-Testes/01-Testes-Criticos.md`) — bloqueiam merge se falharem, sem exceção, sem "skip temporário" |

## Qualidade — Definition of Done

Uma funcionalidade só é considerada concluída quando:

- [ ] Código implementado seguindo a Arquitetura Física (Entregável 3) e a Linguagem Ubíqua
- [ ] Testes unitários e de integração escritos e passando (conforme tabela acima)
- [ ] Nenhum Teste Crítico relevante quebrado
- [ ] Documentação técnica (`docs/`) atualizada, se a implementação divergiu ou refinou o que estava documentado
- [ ] Code review aprovado por outra pessoa (mesmo em equipe de 2 — Frederico e Pedro revisam mutuamente; nenhum merge auto-aprovado)
- [ ] Nenhuma regra de negócio fora da camada de domínio (verificação manual no review, além do lint estrutural)
- [ ] Se envolve dado de Tenant: teste de isolamento multi-tenant validado, não assumido

## Revisão de código — critério de aprovação

Todo PR revisado contra estas perguntas, não apenas "o código funciona":

1. Essa mudança respeita a Linguagem Ubíqua já definida, ou introduz um termo novo sem atualizar `01-Domain/05-Linguagem-Ubiqua.md`?
2. Essa mudança adiciona regra de negócio fora da camada de domínio?
3. Essa mudança toca dado multi-tenant sem teste de isolamento?
4. Essa mudança em automação (n8n) passa no teste de aceite do ADR-0021?
5. Essa mudança em mensagem ao paciente segue os 11 padrões de tom de voz (`05-IA/01`)?

## O que nunca é aceito em um PR, mesmo funcionando

- Regra de negócio dentro de Controller, rota de API ou workflow n8n.
- Query sem filtro de `tenant_id` explícito, mesmo com RLS como rede de segurança (defesa em profundidade não é desculpa para descuido na camada de aplicação).
- Mensagem automática ao paciente que mencione suspensão, ameaça ou tom de cobrança agressiva.
- Commit com teste crítico comentado/pulado "temporariamente".
