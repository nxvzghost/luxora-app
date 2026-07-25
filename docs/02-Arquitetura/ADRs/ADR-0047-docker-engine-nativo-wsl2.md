# ADR-0047 — Docker Engine nativo no WSL2 como ambiente oficial de desenvolvimento (Windows)

**Status:** ADOTADO
**Origem:** incidente AD-026 (bloqueio de ambiente Docker local), registrado em [`docs/AUDITORIA_TECNICA_DEFINITIVA.md`](../../AUDITORIA_TECNICA_DEFINITIVA.md) e conduzido em [`docs/PLANO_DE_EXECUCAO.md`](../../PLANO_DE_EXECUCAO.md), Epic 1.
**Data:** 23 de julho de 2026

## Contexto

O ambiente de desenvolvimento local do backend depende de Postgres 16 + Redis 7, historicamente providos via Docker Desktop (`docker-compose.yml`, raiz do repo). Em 22–23/07/2026, o Docker Desktop 4.82.0 (build 233772, Windows 10 Pro, backend WSL2) passou a falhar de forma reprodutível ao iniciar, bloqueando por completo a execução de containers locais e, com isso, os Testes Críticos e qualquer validação contra banco/Redis reais — bloqueio direto da Sprint 4.

## Problema

`com.docker.backend.exe` falha em `starting services`, sucessivamente em dois componentes internos (`Secrets Engine`, depois `Inference Manager`), sempre com a mesma assinatura de erro: tentativa de remover um socket AF_UNIX implementado como reparse point NTFS falha com `The file cannot be accessed by the system` (Win32 1920). Investigação extensa (ver histórico de incidente) esgotou as vias de correção disponíveis sem sucesso:
- Renomear os sockets órfãos individualmente falhou em toda API tentada (`mv`, `Rename-Item`, `Move-Item`, `Get-Acl`, `fsutil reparsepoint query`) — todas com o mesmo erro.
- Um reboot completo do Windows foi realizado; o erro se reproduziu de forma idêntica depois, invalidando a hipótese de que fosse um estado de kernel temporário.
- Não foi identificada correção oficial, versão estável confirmada, ou workaround documentado pela própria Docker que resolvesse o caso — apenas evidência pública de que o mesmo padrão de defeito já foi reportado em outras versões do Docker Desktop, sem resolução publicamente confirmada.

**A causa raiz exata permanece inconclusiva.** Esta decisão não depende de tê-la identificado.

## Alternativas avaliadas

| Alternativa | Sucesso estimado | Observação |
|---|---|---|
| Reparar Docker Desktop (Clean/Purge data, reinstalar) | ~35% | Já sobrevivemos a um reboot completo, mais profundo que um purge de app, com o mesmo erro |
| Outra versão do Docker Desktop (down/upgrade) | ~40% | Nenhuma versão "estável para este cenário" tem confirmação oficial — aposta sem lastro |
| Rancher Desktop | ~75% | Produto maduro, stack de inicialização própria — forte candidata |
| Podman (modo compatível Docker) | ~55% | Mais peças de configuração, maior chance de fricção com o `docker-compose.yml` existente |
| **Docker Engine nativo no WSL2** | **~75%** | Remove exatamente o componente com defeito (backend Windows do Docker Desktop); usa infraestrutura (WSL2) já confirmada saudável; zero dependência de um novo produto de terceiros |
| Postgres/Redis nativos no WSL2 (sem container) | ~90% | Maior certeza, mas tecnicamente deixa de usar containers — fora do objetivo declarado |
| Postgres/Redis remoto de dev | ~85% | Introduz dependência de rede/custo, foge do modelo local self-contained do projeto |

Matriz de decisão completa, com tempo/complexidade/risco/dependências/impacto/rollback por alternativa, está registrada no histórico de condução do incidente AD-026 (`docs/PLANO_DE_EXECUCAO.md`, seção 4).

## Decisão

Adotar **Docker Engine nativo (`docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-compose-plugin`) instalado diretamente na distro WSL2 (Ubuntu)** como ambiente oficial de desenvolvimento local no Windows, substituindo o Docker Desktop para esse fim.

Justificativa central: o Docker Desktop, mesmo hoje, já executa seus containers dentro de uma VM WSL2 por baixo dos panos (backend `wsl-2`, confirmado em `install-log.txt`). A mudança não introduz um ambiente de execução novo — remove apenas a camada de orquestração Windows do Docker Desktop, que é exatamente onde o defeito reside, mantendo o mesmo Docker Engine real por baixo.

**Validação arquitetural prévia** (antes de qualquer instalação) confirmou:
- O projeto depende apenas de um daemon compatível com a API Docker + Compose CLI — nunca de uma feature específica do Docker Desktop.
- `docker-compose.yml` não faz bind mount de código-fonte (só um volume nomeado do Postgres e um mount somente-leitura do script de init) — o dev loop (`pnpm dev`, hot reload, Prisma) roda inteiramente no Windows, nunca cruzando a fronteira `/mnt/c`.
- Não há uso de Testcontainers no projeto.

**Passos de instalação e configuração (procedimento completo, reproduzível do zero):**

1. Instalar o Docker Engine na distro WSL2 via repositório apt oficial da Docker:
   ```bash
   wsl -d Ubuntu
   sudo install -m 0755 -d /etc/apt/keyrings
   curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
   sudo chmod a+r /etc/apt/keyrings/docker.asc
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME || echo noble) stable" | sudo tee /etc/apt/sources.list.d/docker.list
   sudo apt-get update
   sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
   ```
   **Nota:** se a distro rodar uma versão do Ubuntu mais nova do que o repositório oficial da Docker ainda publica (ex.: 26.04 no momento desta escrita), use o codename da última LTS suportada (`noble`, 24.04) — os pacotes são compatíveis.
2. Habilitar systemd (geralmente já ativo por padrão em distros WSL2 recentes — confirmar em `/etc/wsl.conf`: `[boot]` `systemd=true`; se precisar alterar, rodar `wsl --shutdown` depois).
3. `sudo systemctl enable --now docker` — inicia o daemon como serviço padrão.
4. Criar `C:\Users\<usuário>\.wslconfig` (lado Windows) com:
   ```ini
   [wsl2]
   vmIdleTimeout=-1
   localhostForwarding=true
   ```
   Sem isso, a VM do WSL2 se desliga por ociosidade quando nenhuma sessão está anexada, derrubando o `dockerd` e os containers junto — e, isoladamente, o encaminhamento de `localhost` pode não ativar corretamente até esse ajuste. Aplicar com `wsl --shutdown` seguido de reabrir a distro.
5. **Para uso contínuo de desenvolvimento**: manter um terminal WSL2 aberto durante a sessão de trabalho (Windows Terminal, ou terminal integrado do VS Code via extensão "WSL") — isso mantém a VM naturalmente ativa, além do ajuste de configuração acima.
6. A partir daqui, o restante do setup do projeto é **idêntico ao documentado no README** (`docker compose up -d`, migrations, RLS, seed) — só rodando os comandos `docker`/`docker compose` de dentro do shell WSL2 em vez do PowerShell/CMD (ou configurando um cliente Docker no Windows apontando para o daemon via `DOCKER_HOST`, se preferir digitar do lado Windows).

## Consequências positivas

- Sprint 4 destravada — Testes Críticos voltam a rodar contra Postgres/Redis reais.
- Zero mudança de código do projeto: `docker-compose.yml`, `.env`, scripts do README continuam válidos como estão.
- Docker Desktop permanece instalado, apenas inativo — nenhuma remoção, mudança 100% reversível.
- Efeito colateral positivo: a validação completa de ambiente (migrations + RLS + índice de concorrência aplicados manualmente) expôs dois bugs reais pré-existentes, nunca antes detectados porque nenhum ambiente local anterior tinha RLS de fato aplicada — registrados como AD-033 e AD-034.

## Limitações

- Comandos `docker`/`docker compose` precisam ser digitados de um shell WSL2 (ou exigem configuração extra de `DOCKER_HOST` no Windows) — mudança real de hábito, não coberta pelos scripts atuais do README.
- A causa raiz do defeito do Docker Desktop **não foi identificada nem corrigida** — está contornada. Se o Docker Desktop for necessário no futuro por outro motivo, o problema original provavelmente ainda estará presente.
- `vmIdleTimeout=-1` desabilita uma otimização de recursos do WSL2 (a VM nunca se desliga sozinha por ociosidade) — impacto de consumo de memória em segundo plano quando o WSL2 está instalado mas não em uso ativo; aceitável para uma máquina de desenvolvimento.

## Plano de rollback

Nenhuma etapa desta decisão desinstala o Docker Desktop nem altera `.env`, `docker-compose.yml`, schema ou qualquer arquivo do projeto. Para reverter: parar o `dockerd` do WSL2 (`sudo systemctl stop docker`) e voltar a usar o Docker Desktop normalmente (ou adotar a próxima alternativa da matriz — Rancher Desktop — sem retrabalho de configuração do projeto, já que ela é idêntica entre as alternativas avaliadas).

## Evolução posterior (25/07/2026)

Esta ADR resolveu **apenas** o Docker — a validação da época (seção "Decisão", acima) confirmou explicitamente que o dev loop (`pnpm dev`, hot reload, Prisma) continuava rodando inteiramente no Windows, nunca cruzando a fronteira `/mnt/c`. Essa afirmação era correta na data em que foi escrita e permanece registrada como estava, sem edição — mas deixou de refletir o ambiente oficial em 25/07/2026.

A **[ADR-0048](./ADR-0048-repositorio-ext4-wsl2.md)** estendeu esta decisão: não apenas o Docker, mas o repositório de trabalho inteiro (código, `node_modules`, Git, execução de `pnpm`/testes) passou a residir nativamente dentro do WSL2 (filesystem ext4), motivado por uma penalidade de performance de ~94x medida entre `/mnt/c` (DrvFs) e ext4/tmpfs para operações de `require()` de módulos Node. Ver ADR-0048 para o contexto completo, experimentos e decisão.
