# PD-007 — Identificação do Tenant via WhatsApp: Análise Arquitetural

> Nota de numeração (2026-07-18): este documento foi originalmente criado
> como PD-005. Renumerado para PD-007 para se alinhar à sequência oficial
> de Product Decisions da Luxora (PD-005 – Multi Unidade, PD-006 – IA
> Clínica, PD-007 – Identificação do Tenant via WhatsApp, PD-008 – Domínio
> Conversacional). Conteúdo inalterado, só a numeração.

## Pergunta única

**Como a Luxora identifica, de forma segura, qual Tenant recebeu uma
mensagem do WhatsApp?**

Não implementa nada. Não cria migration, schema, controller. Só decide a
arquitetura, para desbloquear a Fase C/D do plano de validação do fluxo
principal (`docs/10-Sprint-0/08-Plano-de-Validacao-do-Fluxo-Principal.md`).

## Método

Investiguei o código real — não a documentação de intenção. Toda
afirmação abaixo foi verificada por leitura direta do repositório.

---

## 1. Estado atual

### Como funciona hoje

`WhatsAppIntegration` (`schema.prisma`) é **1:1 com Tenant**
(`tenantId String @unique`), guardando `phoneNumberId` e `accessToken`.
`ConectarWhatsAppUseCase` (`POST /whatsapp/connect`, autenticado, admin)
faz um `upsert` por `tenantId` — ou seja, hoje o sistema só sabe responder
**"qual número esta clínica usa"** (Tenant → número). Confirmado por
leitura direta de `conectar-whatsapp.use-case.ts` e do schema.

### Onde o fluxo quebra

**O sentido contrário não existe.** Não há nenhum método, índice ou
consulta que responda "dado este `phoneNumberId` (o que a Meta envia no
payload do webhook), qual é o `tenantId`?". Confirmado por dois achados
concretos do `schema.prisma`:

- `phoneNumberId` **não tem `@unique` nem `@@index`** — mesmo se um
  lookup fosse escrito hoje, seria um full table scan, sem nada impedindo
  ambiguidade.
- Nada no schema ou no Use Case impede que dois Tenants diferentes sejam
  salvos com o mesmo `phoneNumberId` — um erro operacional (copiar/colar
  a credencial errada, por exemplo) criaria uma ambiguidade real e
  silenciosa.

### Componentes que dependem desta identificação

- O futuro Controller de webhook (Fase D de `08-Plano-de-Validacao...md`) — não pode ser implementado sem isso, é o primeiro passo de qualquer requisição recebida.
- `ProcessarMensagemUseCase`/`IntentActionRouter` — recebem `tenantId` como input obrigatório; sem o lookup, não há como preenchê-lo a partir de uma mensagem real.
- `TenantContext` — precisaria ser inicializado a partir deste lookup, o mesmo papel que hoje só `JwtAuthGuard` e `TenantApiKeyGuard` (PD-003) desempenham.
- RLS (`prisma/rls/enable-rls.sql`) — toda tabela multi-tenant depende de `app.tenant_id` estar setado corretamente; um lookup errado aqui tem o mesmo peso de uma falha de RLS.

### Riscos já existentes no código, hoje

1. **Nenhuma garantia de unicidade de `phoneNumberId` entre Tenants.** Sem constraint, é fisicamente possível (por erro humano) dois Tenants "reivindicarem" o mesmo número.
2. **Nenhum índice de performance para o único acesso que este dado precisará suportar em produção real** — cada mensagem recebida via webhook exigiria essa consulta, no caminho mais quente do sistema.
3. **Nenhum precedente de auditoria para mudança de vínculo número↔Tenant** — `ClinicUpdatedEvent` audita mudança de nome/política da clínica, mas `ConectarWhatsAppUseCase` não emite nenhum evento de domínio hoje (achado adicional, fora do escopo direto da pergunta, mas relevante para "auditoria" no requisito abaixo).

---

## 2. Requisitos do domínio

- **Isolamento entre Tenants** — o requisito mais crítico: um lookup errado aqui equivale, em gravidade, a uma falha de RLS (dado de um Tenant vazando pra outro).
- **Performance** — usado em todo webhook recebido, no caminho mais quente e mais sensível a latência de todo o sistema (uma resposta de chat lenta é imediatamente perceptível).
- **Segurança** — o lookup precisa acontecer numa camada de acesso que hoje não tem `tenantId` nenhum — mesma classe de problema já resolvida 2 vezes (login por e-mail, API key por Tenant), nunca deveria virar uma 3ª solução inventada do zero.
- **Escalabilidade** — precisa continuar O(1)/indexado com 10 ou 10.000 clínicas.
- **Integridade/consistência** — um `phoneNumberId` nunca pode apontar para dois Tenants ao mesmo tempo.
- **Troca de número** — uma clínica pode trocar de número sem perder identidade/histórico.
- **Múltiplos números** — não é requisito confirmado hoje, mas a arquitetura não deveria impedir essa evolução sem redesenho completo (ver seção 4).
- **Desativação temporária sem perda de configuração** — já parcialmente atendido (`active: Boolean` já existe).
- **Auditoria** — toda alteração de vínculo (conectar, trocar número, desativar) precisa ficar registrada — hoje não fica (achado da seção 1).
- **Migração de provedor** — a identificação não deveria depender de detalhes específicos da Meta Cloud API a ponto de travar uma troca de fornecedor no futuro.
- **Least privilege / superfície mínima de bypass** — qualquer mecanismo que precise "ver antes de saber o Tenant" deve expor o mínimo de dado possível, princípio já aplicado nas duas exceções de RLS existentes (login por e-mail, API key).

---

## 3. Modelagem — o que representa um número de WhatsApp na Luxora?

**Pertence ao Tenant — e a evidência para isso já está no próprio código,
não é uma escolha nova.** `domain/clinic/clinic.entity.ts` documenta,
literalmente: *"Clínica — representa o Tenant do ponto de vista de
negócio (...) mesmo que ambos apontem para a mesma linha."* Ou seja, a
Luxora já decidiu, em código, que **"Clínica" e "Tenant" são a mesma
identidade**, vista por duas lentes (técnica vs. negócio) — não são dois
conceitos com ciclos de vida separados.

Isso elimina duas das quatro opções que a pergunta original propõe:

- **"Unidade"** não existe como conceito no sistema — e o PD-005 decidiu explicitamente não criar esse conceito sem um caso de uso real validado. Amarrar o número de WhatsApp a uma Unidade inexistente seria construir sobre uma fundação que a própria Luxora decidiu não construir ainda.
- **"Integração"**, no sentido de uma entidade desacoplada do Tenant, também não se sustenta — o que existe (`WhatsAppIntegration`) já É uma entidade de integração, e ela já é 1:1 com Tenant. Não há uma terceira camada aqui, só a entidade de credencial que já existe.

Restam, de fato, **Tenant** e **Clínica** — que a própria Luxora já
declarou serem a mesma coisa. **Conclusão: o número de WhatsApp pertence
ao Tenant**, exatamente como `WhatsAppIntegration` já modela hoje. Esta
análise não está propondo mudar a posse — está confirmando, com evidência,
que a modelagem de posse já está certa. **O que falta não é modelagem
nova — é o mecanismo de busca no sentido inverso.**

---

## 4. Casos futuros — a arquitetura recomendada suporta, sem decidir agora

- **Troca de número:** já suportado hoje (`upsert` por `tenantId`) — trocar o `phoneNumberId` de um Tenant já existente é a operação natural do Use Case atual.
- **Dois números para uma clínica:** **não suportado hoje** (`tenantId` é `@unique` — 1:1 estrito). Se isso vier a ser necessário, a evolução natural é remover essa unicidade (virar 1:N) — e a recomendação desta análise (índice único em `phoneNumberId`, não em `tenantId`) já é compatível com essa evolução sem redesenho: um Tenant poderia ter N linhas, cada uma com seu próprio `phoneNumberId` único globalmente. Não implementar agora — só confirmando que não há beco sem saída.
- **Número temporariamente desativado:** já suportado (`active: Boolean` já existe) — só precisa o lookup checar esse campo.
- **Migração entre provedores / WhatsApp Cloud API / provedores alternativos:** `phoneNumberId` hoje é uma string opaca, sem parsing especial no domínio — trocar de provedor é uma questão de quem preenche e lê esse campo, não uma mudança estrutural. Se um provedor futuro tiver um identificador de formato diferente, o campo comporta sem mudança de schema.
- **Crescimento futuro (volume):** a recomendação (índice único) mantém custo de busca praticamente constante independente do número de clínicas.

---

## 5. Alternativas avaliadas

### Alternativa A — Índice único em `phoneNumberId` + política de bypass de RLS estreita (reaproveitando o padrão já existente)

Adicionar `@unique`/`@@index` em `WhatsAppIntegration.phoneNumberId`, e um
lookup via bypass de RLS restrito à mesma tabela — **exatamente o mesmo
mecanismo já aprovado duas vezes** (`auth_lookup_by_email` no login,
`api_key_lookup_by_hash` no PD-003): uma política de `SELECT` adicional,
ativada só quando a aplicação define explicitamente
`app.bypass_tenant_check = 'true'` dentro da transação, nunca por padrão.

- **Vantagens:** extensão direta de um padrão já em produção e já validado (Teste Crítico #17); zero conceito novo; lookup O(1) via índice; corrige de graça o risco de ambiguidade (2 Tenants com o mesmo número passa a ser fisicamente impossível, não só uma convenção).
- **Desvantagens:** nenhuma real — é a opção de menor superfície de mudança de todas.
- **Complexidade:** baixa.
- **Escalabilidade:** alta.
- **Risco:** baixo — mecanismo já testado em produção duas vezes.

### Alternativa B — Tabela de índice dedicada (`phoneNumberId → tenantId`), separada da tabela de credenciais

Uma tabela nova, minimalista, só para o lookup — nunca expõe
`accessToken` mesmo sob bypass.

- **Vantagens:** separa a superfície do bypass (o lookup nunca "vê" a linha inteira de credencial, só o par phoneNumberId/tenantId).
- **Desvantagens:** duplica dado (o mesmo `phoneNumberId` passa a existir em 2 lugares) — risco real de desincronia se o `upsert` de conexão não mantiver as duas tabelas atomicamente; mais uma tabela para manter sem ganho de segurança claro, já que a Alternativa A, sob o mesmo padrão de bypass já usado no login, também nunca expõe senha/token para além do necessário (o próprio `auth_lookup_by_email` já convive com uma tabela que tem `passwordHash` ao lado, sem que isso tenha se mostrado um problema).
- **Complexidade:** média.
- **Escalabilidade:** alta (mesma característica de índice).
- **Risco:** médio — introduz uma fonte de duplicação que pode divergir.

### Alternativa C — Cache (Redis) como índice rápido `phoneNumberId → tenantId`

- **Vantagens:** latência mínima teórica.
- **Desvantagens:** introduz uma fonte de verdade secundária que pode ficar desatualizada; Redis hoje só é usado para fila (BullMQ) — não existe nenhuma camada de cache de aplicação no sistema (o próprio Teste Crítico #3 documenta isso como gap real, deliberadamente não implementado); um cache desatualizado, justamente na etapa de identificar o Tenant, tem o mesmo risco que um bug de RLS. Otimização prematura: o volume atual não justifica a complexidade — um índice Postgres já atende com folga.
- **Complexidade:** média-alta (exige estratégia de invalidação/reconciliação, hoje inexistente).
- **Risco:** alto, justamente no ponto mais sensível do sistema.

### Alternativa D — Roteamento por URL própria da Luxora (path/subdomínio por Tenant), sem depender de `phoneNumberId`

- **Descartada por restrição técnica externa, não por preferência.** A Meta Cloud API não funciona por número — um mesmo "App"/WABA da Meta tem **uma única URL de callback de webhook**, compartilhada entre todos os números conectados a ele. Para a Luxora ter uma URL por Tenant, cada clínica precisaria criar seu próprio App na Meta — o que contradiz diretamente a promessa do PD-001 de implantação assistida pela IA, sem fricção técnica para o terapeuta. Esta alternativa não é tecnicamente viável dado como a Meta Cloud API é desenhada.

---

## 6. Recomendação oficial

**Alternativa A** — índice único em `phoneNumberId`, com uma terceira
política de bypass de RLS restrita, seguindo exatamente o padrão já
estabelecido e validado duas vezes (login por e-mail, API key do PD-003).

**Por que deve virar o padrão oficial:** é a única alternativa que atende
todos os requisitos do domínio (isolamento, performance, segurança,
auditoria futura) sem introduzir nenhum componente ou conceito novo — só
estende, pela terceira vez, um mecanismo que já é o padrão oficial de
"como resolver a busca que precisa acontecer antes de saber o `tenantId`"
na Luxora. Rejeitar as alternativas B e C não é conservadorismo — é o
mesmo princípio já aplicado em toda esta sessão: não introduzir
infraestrutura nova (uma tabela extra, uma camada de cache) quando a
existente já resolve, com evidência de que já resolveu duas vezes antes.

---

## 7. Impacto, se aprovada

- **Módulos afetados:** Módulo 04 (Multi-Tenant/RLS) ganha uma 3ª exceção documentada; Módulo 11 (Comunicação) ganha a peça que faltava para desbloquear a Fase D do plano de validação do fluxo principal; Módulo 12 (IA) depende indiretamente, como consumidor do `tenantId` resultante.
- **Documentos a atualizar quando implementado:** `prisma/rls/enable-rls.sql` (nova policy, mesmo padrão das duas anteriores); comentário do schema de `WhatsAppIntegration` (constraint nova); `docs/03-Database/09-Multi-Tenant.md` (documentar a 3ª exceção, ao lado das outras duas); `docs/10-Sprint-0/08-Plano-de-Validacao-do-Fluxo-Principal.md` (a Fase C deixa de estar em aberto).
- **Decisões futuras que dependem desta:** o desenho do Controller de webhook (Fase D) só pode começar depois desta decisão estar fechada; uma eventual decisão futura de "múltiplos números por clínica" parte desta arquitetura como base, sem precisar redesenhá-la.

---

## Relatório executivo

1. **Arquivos analisados:** `schema.prisma` (`WhatsAppIntegration`, `Tenant`), `conectar-whatsapp.use-case.ts`, `whatsapp-message.provider.ts`, `whatsapp.controller.ts`, `domain/clinic/clinic.entity.ts`, `clinic.repository.ts`, `prisma/rls/enable-rls.sql`, `prisma.service.ts` (`forAuthLookup`), ADR-0011, ADR-0006, `docs/03-Database/09-Multi-Tenant.md`.
2. **Evidências encontradas:** `phoneNumberId` sem `@unique`/índice; nenhum lookup reverso existe; `Clinic` é documentado no próprio código como "o Tenant do ponto de vista de negócio", mesma identidade; o padrão de bypass de RLS restrito já foi usado 2 vezes (login por e-mail, API key do PD-003) com sucesso comprovado em teste crítico real.
3. **Alternativas avaliadas:** índice único + bypass restrito (recomendada); tabela de índice separada; cache Redis; roteamento por URL própria (tecnicamente inviável pela forma como a Meta Cloud API funciona).
4. **Recomendação oficial:** Alternativa A — reaproveitar o mecanismo de bypass de RLS já validado, com índice único em `phoneNumberId`.
5. **Riscos:** nenhum risco novo introduzido; o risco que existe **hoje** (ausência de unicidade) é eliminado por esta recomendação, não criado por ela.
6. **Trade-offs:** nenhum trade-off real entre as alternativas líderes — a Alternativa A domina nos critérios de complexidade, risco e reaproveitamento; as demais foram descartadas por motivo concreto, não por preferência.
7. **Próximos passos:** com esta decisão aprovada, a Fase C do plano de validação do fluxo principal deixa de estar em aberto — o próximo documento natural seria o desenho técnico detalhado (ainda sem código) da migration e da policy de RLS, como sua própria etapa de aprovação, antes de qualquer implementação real do webhook.
