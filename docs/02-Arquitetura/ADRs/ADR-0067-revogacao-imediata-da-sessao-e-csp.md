# ADR-0067 — Revogação imediata da sessão e Content-Security-Policy no painel

**Status:** ADOTADA — decidida pelo responsável pelo produto em 20 de outubro de 2026 ("opção B, revogação imediata pela versão de sessão no Redis, com CSP no painel") e implementada no mesmo dia, em commits locais, sem push.
**Origem:** achado **A-17** da auditoria (sessão), reavaliado na auditoria dos bloqueadores do piloto de 20/10/2026 (Painel do Projeto, seção "Auditoria 20 out").
**Antecedentes:** [ADR-0056](./ADR-0056-sessao-revogavel-token-version.md) (versão de sessão no refresh token), [ADR-0061](./ADR-0061-painel-operavel.md) (tokens no `localStorage`, sem `middleware.ts`).

## Contexto

Lido no código antes desta ADR:

- O `JwtAuthGuard` conferia só a assinatura, a validade e o tipo `access`, sem consultar nada. O access token durava 15 minutos (`JWT_EXPIRES_IN`).
- "Sair" e desativar incrementavam `User.tokenVersion` (ADR-0056): revogavam os refresh tokens, não o access token já emitido.
- A troca de papel só valia no próximo refresh: um administrador rebaixado a terapeuta continuava administrador por até 15 minutos.
- No painel, os dois tokens ficam no `localStorage` (ADR-0061), e o painel não enviava Content-Security-Policy. O Helmet protegia só a API.

Consequência: pessoa desligada, ou com papel reduzido, agia por até 15 minutos; um access token copiado valia até 15 minutos depois de "Sair"; uma falha de XSS lia os dois tokens.

## Decisão

### 1. O access token carrega a versão de sessão e é conferido a cada requisição

- O access token passa a levar `tv` (o `tokenVersion` do usuário na emissão), como o refresh token já levava.
- O `JwtAuthGuard` recusa, com 401, o access token cuja versão ou cujo papel não sejam os vigentes do usuário, ou cujo usuário esteja desativado ou não exista na clínica do token. A mensagem é "Sessão encerrada ou alterada. Faça login novamente."
- Access token sem `tv` (emitido antes desta ADR) é recusado. O painel já trata o 401: renova uma vez e segue, de modo que a troca é transparente para quem estiver com o painel aberto no momento do deploy.

### 2. O estado vigente fica no Redis, com o banco como reserva

- `SessionStateCache` (`src/infrastructure/auth/session-state.cache.ts`) guarda, por clínica e usuário, `versão:papel` ou, para o usuário desativado, `versão:inactive` (usuário que não existe na clínica: `-1:inactive`), na chave `luxora:session-state:<clínica>:<usuário>`, com prazo de 60 segundos.
- Leitura: Redis; sem a entrada, com uma entrada ilegível ou com o Redis fora do ar, o banco, numa transação escopada à clínica do token (a RLS garante que o usuário é dessa clínica). O valor lido do banco é gravado só se a chave não existir (`NX`), para nunca apagar um valor mais novo.
- Escrita: depois de cada gravação que pode mudar o estado (sair, desativar, reativar, trocar o papel), o estado é relido do banco e sobrescreve a entrada, **de forma monotônica**: um script Lua no Redis só grava se a entrada não existir, não for legível ou tiver versão de sessão menor ou igual à nova. Sair e desativar incrementam a versão; por isso uma releitura que leu o banco antes de uma revogação e grava depois dela (duas gravações do mesmo usuário ao mesmo tempo, por exemplo um administrador alterando o usuário enquanto ele sai) não devolve ao cache o estado revogado. Versão igual sobrescreve: é como a troca de papel e a reativação, que não mudam a versão, chegam ao cache. Se o banco não puder ser relido, a entrada é apagada.
- A sobrescrita acontece antes da resposta: o `204` de `logout` e o `200` de desativar, reativar e alterar usuário só saem depois dela.
- O Redis fora do ar não abre nada: o guard passa a ler do banco a cada requisição. O banco fora do ar recusa a requisição.
- Global (`SessionStateModule`), porque o `JwtAuthGuard` é declarado nos providers de doze módulos: um só cache e uma só conexão com o Redis.

### 3. A troca de papel não encerra a sessão

O token com o papel antigo é recusado na hora, mas o refresh token continua válido: o painel renova e recebe um token com o papel novo, que já vale. Desativar e sair, ao contrário, encerram a sessão (o refresh também é recusado, como na ADR-0056).

### 4. Content-Security-Policy no painel

- `apps/frontend/middleware.ts` gera um nonce de 128 bits por requisição e aplica `apps/frontend/lib/content-security-policy.ts`:
  - `script-src 'self' 'nonce-…' 'strict-dynamic'`: script inline injetado, atributo de evento (`onerror`, `onclick`) e script de outro site não rodam;
  - `connect-src 'self'` e a origem da API (`NEXT_PUBLIC_API_URL`): os tokens não saem por `fetch` para outro endereço;
  - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, `img-src 'self' data: blob:`, `font-src 'self'`;
  - `style-src 'self' 'unsafe-inline'`, porque o painel usa o atributo `style` e nonce não cobre atributo;
  - em desenvolvimento, `'unsafe-eval'` e `ws:`, que o Next exige lá.
- O nonce vai no cabeçalho da requisição, de onde o Next o aplica aos próprios scripts, e no da resposta. Por isso o layout raiz é `dynamic = 'force-dynamic'`: uma página gerada no build teria scripts sem o nonce.
- Este `middleware.ts` só trata da CSP. Não lê token nem protege rota: a decisão da ADR-0061 sobre sessão (tokens no `localStorage`, `AuthGuard` no cliente, AD-028 parcial) continua a mesma.

## Alternativas consideradas

- **Manter os 15 minutos, com access token de 5 minutos e CSP** (opção A da auditoria). Rejeitada pelo responsável pelo produto: reduz a janela, não a fecha.
- **Conferir a versão no banco a cada requisição, sem Redis.** É o que acontece quando o Redis cai; como regra, uma consulta por requisição autenticada (motivo da rejeição na ADR-0056).
- **Lista de tokens revogados.** Cobre "sair", não desativação nem troca de papel sem guardar todos os tokens de cada usuário.
- **CSP com `'unsafe-inline'` nos scripts, sem nonce.** Não impediria o script injetado de rodar nem de mandar o token por navegação.
- **Tokens em cookie `httpOnly`** (AD-028). Mudança maior (CSRF, CORS, renovação), fora do escopo do piloto.

## Consequências

- Sair, desativar e trocar o papel valem na requisição seguinte.
- Cada requisição autenticada faz uma leitura no Redis; a cada 60 segundos por usuário ativo, ou com o Redis fora do ar, uma leitura no banco.
- O Redis passa a fazer parte do caminho de autenticação. Sem ele a API continua funcionando, lendo do banco.
- Mais um cliente Prisma (o do `SessionStateModule`), somando-se aos já registrados no achado de conexões (A-23).
- O painel deixa de ter páginas geradas no build: todas são renderizadas a cada requisição. Em um painel administrativo de uma clínica, o custo é pequeno; não foi medido em carga.

## Limitações

- Se o Redis estiver no ar mas a sobrescrita de uma revogação falhar (por exemplo, prazo de 500 ms estourado, ou um failover que deixe o Redis aceitando leitura e recusando escrita), a entrada antiga vale até o prazo de 60 segundos. A operação no banco já aconteceu e a resposta é de sucesso; a falha fica no log. Não há teste para esse caso.
- A escrita monotônica ordena pela versão de sessão. Duas alterações do mesmo usuário que não mudam a versão (duas trocas de papel opostas, ou troca de papel e reativação) feitas no mesmo instante por administradores diferentes podem deixar no cache o estado da que gravou por último no Redis, e não o do banco, por até 60 segundos. Não afeta sair nem desativar, que mudam a versão.
- Várias instâncias da API funcionam porque todas leem e gravam a mesma chave no mesmo Redis: não há cache em memória. Não há teste com duas instâncias.
- O refresh token continua sem rotação nem detecção de reuso (ADR-0056); "sair" encerra a sessão em todos os dispositivos.
- `style-src` aceita `'unsafe-inline'`.
- A CSP é do painel. A API mantém a CSP padrão do Helmet.
- A troca de papel pelo banco, por SQL direto, não relê o cache: vale em até 60 segundos. Os fluxos do sistema passam todos pelo repositório.

## Verificação

Registrada no CHANGELOG (entradas "Sessão — revogação imediata e CSP no painel" e "Sessão — escrita monotônica no cache").

**Revisão final de 20/10/2026, antes da publicação.** Feita a pedido do responsável pelo produto, só de leitura. Achou duas coisas, corrigidas no mesmo dia:

- uma releitura atrasada podia gravar no Redis um estado mais velho por cima de uma revogação, e o access token revogado voltaria a valer por até 60 segundos. Corrigido pela escrita monotônica acima. Dois testes críticos reproduzem a corrida, com a leitura do banco pausada entre ler e gravar, para sair e para desativar; sem a comparação de versão, os dois falham;
- o comentário de `auth.controller.ts` ainda dizia que o access token valia até expirar depois de sair.

A mesma revisão conferiu a CSP no HTML do build de produção (`next start`): em `/login`, `/agenda`, `/pacientes` e numa página 404, todos os `<script>` (12 a 16 por página) levam o nonce do cabeçalho da própria resposta; nenhum fica sem; cinco respostas, cinco nonces diferentes; o HTML sai com `Cache-Control: private, no-cache, no-store`.

## Documentos relacionados

- [ADR-0056](./ADR-0056-sessao-revogavel-token-version.md), [ADR-0061](./ADR-0061-painel-operavel.md) — atualizações datadas
- `docs/04-API/01-Contratos-REST.md` — seção Auth
- `docs/07-Infra/DEPLOY_RUNBOOK.md` — Redis no caminho de autenticação
