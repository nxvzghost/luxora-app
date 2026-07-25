# ADR-0048 — Repositório de trabalho migrado para ext4 nativo do WSL2

**Status:** ADOTADO
**Origem:** investigação de performance conduzida durante a AD-003 (RBAC), quando timeouts de hook intermitentes na Suíte Crítica (`test/critical`) bloquearam a validação da Etapa 1.
**Data:** 25 de julho de 2026
**Referência:** estende [`ADR-0047`](./ADR-0047-docker-engine-nativo-wsl2.md), que resolveu apenas o Docker e validou explicitamente, na época, que o dev loop continuava no Windows.

## Contexto

O ambiente de desenvolvimento do backend Luxora, no Windows, roda sobre WSL2 desde a ADR-0047 — mas só o Docker Engine foi movido para dentro da distro; o código-fonte, `node_modules` e a execução de `pnpm`/`node`/testes continuavam no filesystem Windows (`C:\Users\...\luxora-app`), acessado de dentro do WSL2 via `/mnt/c` (DrvFs).

Durante a implementação da AD-003 (matriz de RBAC), a Suíte Crítica (`apps/backend/test/critical`, 18 arquivos, `maxWorkers=6`) passou a falhar de forma intermitente com `Error: Hook timed out in 10000ms` em 2 arquivos (`recurring-blocks-api.test.ts`, `tenant-api-key.test.ts`) — nenhum dos dois relacionado à mudança de RBAC em si.

## Problema identificado

Investigação incremental, com instrumentação temporária e evidências objetivas em cada etapa, isolou a causa: `bootstrapTestApp()` (helper que sobe uma instância real do `AppModule` via `Test.createTestingModule().compile()` + `createNestApplication()` + `app.init()`, usado por praticamente todo arquivo de Teste Crítico que faz requisição HTTP real) consumia consistentemente **~5,1–6,1 segundos** por arquivo — próximo o bastante do timeout de 10s que, sob concorrência real de até 6 workers simultâneos, uma fração dos arquivos ultrapassava o limite.

Leitura direta do código-fonte de `@nestjs/testing` (`testing-module.js`, v10.4.22) mostrou que `createNestApplication()` não faz nada além de:
```js
createHttpAdapter(httpServer) {
    const { ExpressAdapter } = loadPackage('@nestjs/platform-express', 'NestFactory',
        () => require('@nestjs/platform-express'));
    return new ExpressAdapter(httpServer);
}
```
— ou seja, um único `require('@nestjs/platform-express')` (que carrega `express` e sua árvore transitiva) seguido de uma instanciação trivial (`new ExpressAdapter()`, medida em 1–2ms). Nenhuma chamada a Postgres, Redis ou rede ocorre dentro desta função.

## Metodologia

Cada etapa da investigação seguiu o mesmo padrão: instrumentação temporária (timestamps via `Date.now()`) inserida apenas em código de teste/suporte (nunca em `src/`), medição, remoção da instrumentação logo após a coleta, e nenhuma alteração de comportamento proposta até a causa raiz estar comprovada com evidência direta — não hipótese. Quando uma medição era surpreendente (ex.: `createNestApplication()` levando segundos numa chamada estruturalmente trivial), a investigação foi repetida antes de aceitar o número como fato.

## Experimentos executados

1. **Decomposição de `bootstrapTestApp()`** (isolado, 2 execuções): `Test.createTestingModule()` (~0ms) → `builder.compile()` (~55ms) → `createNestApplication()` (**~4,7–5,7s**) → `setGlobalPrefix`/pipes/filters (~50ms) → `app.init()` (~300–355ms).
2. **Reprodução isolada do `require('@nestjs/platform-express')`**, fora de qualquer contexto Nest/Vitest, em processo Node limpo, lendo o pacote real do pnpm store em `/mnt/c`: **16,02–16,13s**, reproduzido em 3 execuções independentes (variação < 1% entre elas — descarta efeito de cache frio).
3. **Experimento de controle (decisivo):** mesma versão exata do mesmo pacote (`@nestjs/platform-express@10.4.22`, `express@4.22.1`), instalada via `pnpm add --ignore-scripts` num diretório limpo em `tmpfs` (RAM, sem DrvFs) — o mesmo `require()`: **165–173ms**. Única variável alterada: o filesystem de origem.
4. **Auditoria de unidades e recálculo**, após uma inconsistência de notação identificada (period-as-thousands vs. decimal na prosa do relatório, não nos dados brutos) — valores brutos do Node reauditados e confirmados: milissegundos sem ambiguidade, sem erro de transcrição.
5. **Validação no ambiente real do projeto** (não um experimento isolado de `require()`): cópia integral do repositório (947MB, 43.657 arquivos, incluindo `.git`, histórico e alterações não commitadas) para `/root/luxora-app` (ext4 nativo), com a mesma instrumentação de `bootstrapTestApp()` reaplicada e depois revertida.
6. **`/usr/bin/time -v`** na execução isolada em `/mnt/c`: 14% de CPU, 86% do tempo em espera (User 4,89s + System 5,42s de CPU real, sobre 71,78s de relógio) — assinatura de processo bloqueado em I/O, não CPU-bound.
7. **Confirmação de ausência de Redis/BullMQ como causa concorrente**: `CommunicationModule` (importado por `AppModule`) registra `MessageQueueProducer`/`MessageQueueWorker`, ambos com `new IORedis(...)` no construtor — mas isso ocorre durante `compile()` (~55ms medidos), não durante `createNestApplication()`; não bloqueia a chamada em investigação.

## Métricas obtidas

| Medição | `/mnt/c` (DrvFs) | ext4 / tmpfs | Razão |
|---|---|---|---|
| `require('@nestjs/platform-express')`, isolado | 16.020–16.134ms (3 execuções) | 165–173ms (tmpfs, 2 execuções) | **~93–97x** (média ~94,4x) |
| `builder.compile()` | 54–57ms | 37ms | — |
| `createNestApplication()` (dentro do projeto real) | 4.665–5.689ms (média ~5.177ms) | 182ms | **~28,4x** (redução ~96,5%) |
| `app.init()` | 291–355ms | 298ms | equivalente (inclui conexão real com Postgres, independente do filesystem) |
| `bootstrapTestApp()` total | 5.067–6.148ms (média ~5.607ms) | 518ms | **~10,8x** (redução ~90,8%) |
| Suíte crítica completa (18 arquivos, `maxWorkers=6`) | ~206s (1 execução, com 2 falhas de timeout) | ~9–10s (4 execuções: 3 limpas, 1 com falha isolada não-reprodutível em arquivo não relacionado) | **~21–22x** |

## Comparação `/mnt/c` × ext4 — leitura

A migração para ext4 explica **a grande maioria, mas não a totalidade**, do tempo de bootstrap: `createNestApplication()` caiu ~96,5%, `bootstrapTestApp()` total caiu ~90,8%. Um piso real de ~518ms permanece mesmo em ext4 — consistente com trabalho genuíno (primeira carga do módulo `express` no processo, ~182ms; conexão real com Postgres via `PrismaClientProvider.onModuleInit()`, ~298ms), não atribuível a filesystem lento. A causa exata de por que o DrvFs é ~94x mais lento para este padrão de acesso (muitas chamadas pequenas de `stat`/`open` típicas de resolução de `require()` CJS) não foi comprovada a nível de syscall (sem `strace` disponível no ambiente) — o padrão observado é consistente com o mecanismo documentado do DrvFs (round-trip via protocolo 9P ao host Windows por operação de arquivo), mas isso permanece uma leitura do padrão, não uma medição direta de syscall.

## Decisão arquitetural

O repositório de trabalho oficial (código, `node_modules`, `.git`, execução de `pnpm`/`node`/testes) passa a residir em **`/root/luxora-app`, filesystem ext4 nativo do WSL2** — não mais em `/mnt/c/Users/.../luxora-app` (Windows, via DrvFs).

- `/mnt/c/Users/pichau/Desktop/luxora-app/luxora-app` **permanece intocado no disco**, como cópia de referência — não é mais o ambiente oficial de execução, e nenhum passo desta migração o alterou ou removeu.
- Migração feita via `cp -a` (preserva histórico Git completo, branches, e todas as alterações não commitadas — nunca `git clone`, que perderia o working tree não commitado) — verificada com `git status --short` byte-idêntico entre as duas cópias antes de qualquer commit adicional.
- `core.autocrlf` ajustado para `input`, localmente no repositório em `/root/luxora-app` (nunca alterado em `/mnt/c`), corrigindo um falso-positivo de ~25 arquivos "modificados" causado por diferença de configuração global de line-ending entre o Git do Windows (`autocrlf=true`) e o Git do WSL2 (sem essa configuração) — confirmado via `git diff` mostrando conteúdo textualmente idêntico, só variando `\r`.
- Toolchain: Node 20.20.2 e pnpm 9.0.0 instalados nativamente no WSL2 via NVM + Corepack (não os binários do Windows, não acessados via `/mnt/c`).

## Consequências

**Positivas:**
- Suíte Crítica completa: de ~206s (com falhas intermitentes de timeout) para ~9–10s, consistentemente estável.
- `createNestApplication()`/`bootstrapTestApp()` deixam de estar na margem do timeout de hook (10s) — a folga passou de "quase estourando" para ~20x de margem.
- Ciclo de desenvolvimento (`pnpm dev`, `pnpm test:unit`, `pnpm lint`) mais rápido para qualquer operação que envolva leitura de `node_modules`.

**Negativas / trade-offs:**
- O projeto deixa de estar diretamente acessível em `C:\Users\...\luxora-app` pelo Explorer do Windows ou por um editor apontando direto para esse caminho — acesso passa a ser via `\\wsl.localhost\Ubuntu\root\luxora-app` (Explorer) ou, preferencialmente, abrindo o VS Code de dentro do WSL2 (ver "Plano de adoção").
- Ferramentas desta própria sessão de investigação (que validam `file_path` contra uma lista de diretórios de trabalho permitidos) não reconhecem `\\wsl.localhost\...` — achado registrado, sem solução aplicada nesta ADR (ver "Limitações").
- `/mnt/c/Users/.../luxora-app` como cópia de referência inerte é uma duplicação de ~947MB em disco — decisão sobre removê-la ou mantê-la fica em aberto, não decidida nesta ADR.

## Limitações

- A causa exata (nível de syscall) da lentidão do DrvFs não foi confirmada — só o padrão e a magnitude foram medidos e reproduzidos.
- Nenhuma ferramenta de profiling de sistema (`strace`) estava disponível no ambiente, e não foi instalada (fora do escopo autorizado da investigação) — a evidência é toda baseada em medição controlada por experimento (tmpfs vs. DrvFs com pacote idêntico), não em rastreamento de syscall.
- Um flaky pré-existente (`recurring-block-materialization.test.ts`, corrida de concorrência entre arquivos de teste, provavelmente exposta pela suíte agora rodar muito mais rápido) foi descoberto durante a validação desta ADR — registrado como investigação separada, não é uma regressão desta migração e não bloqueou a adoção.

## Plano de adoção pela equipe

1. Abrir o projeto **sempre de dentro do WSL2**: `cd /root/luxora-app && code .` (VS Code Remote-WSL) — nunca via caminho `\\wsl.localhost\...`/`\\wsl$\...` no Explorer ou num VS Code aberto do lado Windows.
2. Todo comando (`pnpm`, `git`, `docker`, `docker compose`, `prisma`, `vitest`) roda de dentro de uma shell WSL2 (terminal integrado do VS Code em modo Remote-WSL, ou `wsl -d Ubuntu` direto) — nunca PowerShell, CMD ou Git Bash do lado Windows apontando para o caminho antigo.
3. Node/pnpm: usar exclusivamente os binários instalados via NVM/Corepack dentro do WSL2 — não os do Windows.
4. `/mnt/c/Users/.../luxora-app` deixa de receber commits ou alterações — é referência histórica até decisão futura sobre removê-la.
5. Onboarding de novos desenvolvedores (`README.md`, `COMECE_AQUI.md`) atualizado para partir do pressuposto WSL2/ext4 desde o primeiro passo — ver commits desta mesma mudança.

## Critérios de sucesso

- Suíte Crítica completa roda em menos de ~15s (folga sobre os ~9–10s medidos), sem timeout de hook, em pelo menos 3 execuções consecutivas — atingido (3 de 4 execuções limpas; a única falha foi isolada, não-reprodutível, em arquivo não relacionado).
- `git status` idêntico entre a cópia migrada e a origem antes de qualquer commit novo — atingido.
- Postgres e Redis acessíveis e saudáveis a partir do novo ambiente, sem alteração de `.env`/`docker-compose.yml` — atingido (verificado com consulta real via Prisma e `PING` real via `ioredis`).
- Nenhuma perda de histórico Git, branch ou alteração não commitada — atingido.

## Referências

- [`ADR-0047`](./ADR-0047-docker-engine-nativo-wsl2.md) — Docker Engine nativo no WSL2 (decisão anterior, escopo restrito ao Docker; esta ADR estende o mesmo racional de "mover a peça problemática para dentro do WSL2" ao repositório inteiro).
- `docs/09-Testes/02-Dedicated-Fixtures.md` — infraestrutura de testes afetada positivamente (mesma suíte, mesmo código, ambiente mais rápido).
