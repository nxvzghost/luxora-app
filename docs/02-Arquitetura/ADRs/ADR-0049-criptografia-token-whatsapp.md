# ADR-0049 — Criptografia em repouso do `accessToken` de `WhatsAppIntegration`

**Status:** ADOTADO
**Origem:** AD-005 (`docs/PLANO_DE_EXECUCAO.md`, Epic 3 — Segurança Fundamental), auditoria técnica aprovada em 25/07/2026, implementação aprovada na mesma data.
**Data:** 25 de julho de 2026

## Objetivo

`WhatsAppIntegration.accessToken` (credencial da API do WhatsApp Business de cada clínica) era gravado em texto plano no banco — dívida de segurança registrada explicitamente no schema desde a correção de isolamento multi-tenant do Módulo 11 (*"Precisa de endurecimento antes de produção real com clientes pagantes"*). Esta ADR fecha essa dívida: o token passa a ser cifrado em repouso, de forma transparente para o restante do sistema.

## Auditoria prévia (resumo)

Mapeamento completo do ciclo de vida do campo, feito antes de qualquer código: **3 arquivos de produção** tocam o valor —
- Criado/atualizado: `ConectarWhatsAppUseCase` (`use-cases/communication/conectar-whatsapp.use-case.ts`), via `upsert`.
- Lido/usado: `WhatsAppMessageProvider` (`infrastructure/messaging/whatsapp-message.provider.ts`), para montar o header `Authorization` da Graph API do Meta.
- Nunca serializado por nenhuma API (`WhatsAppController` só retorna `{ status: 'connected' }`), nunca logado (nenhum middleware/interceptor de logging existe no backend; `LuxoraExceptionFilter` só loga stack de exceção 5xx, nunca corpo de requisição).
- Achado correlato, fora do escopo desta ADR: `whatsapp_integration` não está entre as 15 tabelas cobertas por RLS (`migration 20260723190000_enable_rls`) — registrado como candidato a item de backlog próprio, não corrigido aqui.

## Arquitetura adotada

**Algoritmo:** AES-256-GCM via `node:crypto` nativo (`createCipheriv`/`createDecipheriv`) — zero dependência de pacote nova. GCM é autenticado: detecta adulteração do ciphertext, não só garante confidencialidade.

**Abstração:** `TokenCipherService` (`apps/backend/src/shared/token-cipher.service.ts`), único ponto do sistema que conhece o formato de cifragem. Dois métodos: `encrypt(plaintext): string` e `decrypt(value): string`. Nenhum chamador (`ConectarWhatsAppUseCase`, `WhatsAppMessageProvider`) sabe ou precisa saber qual é o algoritmo, a versão do formato, ou como um valor legado é reconhecido — toda essa responsabilidade é encapsulada dentro do serviço (refinamento explicitamente pedido antes da implementação: nenhuma lógica de reconhecimento de formato ficaria espalhada pelo código chamador).

**Formato armazenado (mesma coluna `access_token`, sem migration de schema):** `v1:<iv-base64>:<authTag-base64>:<ciphertext-base64>`. O prefixo de versão existe desde o primeiro dia para permitir rotação de chave futura sem reescrever o formato nem migrar o schema.

**Gerenciamento da chave:** variável de ambiente `WHATSAPP_TOKEN_ENCRYPTION_KEY`, mesma UX de `JWT_SECRET` (qualquer string aleatória longa — uma derivação via `scryptSync` produz os 32 bytes exigidos por AES-256 a partir de um segredo de qualquer tamanho, com um salt fixo e não-secreto só para esse propósito). Uma única chave, não uma por Tenant — mesmo modelo de ameaça (comprometimento do banco), sem benefício real de segregação por Tenant neste estágio. Sem KMS/Vault: o projeto está no Railway (Fases 1–2, `docs/07-Infra/00-Provedor-e-Custos.md`), sem infraestrutura de nuvem própria — introduzir KMS agora contradiria a diretriz já registrada no projeto de não adotar complexidade prematura. Documentado como evolução natural para quando/se a Fase 3 (migração para AWS/GCP) acontecer.

## Compatibilidade com tokens legados

`TokenCipherService.decrypt()` reconhece o formato pelo prefixo `v1:` (mais separadores `:` na contagem exata esperada). Um valor que não corresponde a esse formato — incluindo qualquer token gravado em texto puro antes desta ADR — é devolvido **exatamente como está**, sem erro: fallback deliberado de compatibilidade retroativa, não uma condição de erro. Um valor que TEM o formato `v1:` mas falha na decifração (chave incorreta, dado corrompido ou adulterado) **lança erro** — mascarar essa falha devolvendo o valor cru romperia silenciosamente a integração com uma credencial inutilizável, um risco maior que falhar de forma visível.

## Estratégia de migração / backfill

Nenhum ambiente conhecido deste projeto (dev local) tem hoje uma linha real em `whatsapp_integration` — `prisma/seed.ts` nunca populou essa tabela, e não havia nenhum Teste Crítico exercitando este fluxo contra Postgres real antes desta ADR. Ainda assim, o plano cobre o caso de já existir dado real em produção futura:
1. Deploy do código com `TokenCipherService` — **sem migration de banco**, a coluna continua `String`.
2. `TokenCipherService.decrypt()` já tolera valores sem prefixo (texto puro legado) — o sistema continua 100% funcional antes de qualquer backfill rodar, sem janela de indisponibilidade.
3. Um script de backfill único (não incluído nesta ADR — fica como próximo passo natural apenas se/quando houver dado real em produção): leria cada linha, cifraria as que ainda estão em texto puro, regravaria.

## Estratégia de rotação de chave

O prefixo de versão (`v1:`) é o mecanismo de agilidade criptográfica: uma rotação futura introduziria `v2` com uma chave nova, e `TokenCipherService.decrypt()` escolheria o algoritmo/chave pelo prefixo lido — linhas `v1` e `v2` coexistiriam até uma re-gravação (reconectar o WhatsApp já sobrescreve o valor por design, então a rotação completa acontece naturalmente conforme cada clínica reconecta). Nenhum mecanismo de rotação automática/batch foi implementado nesta ADR — over-engineering para 1 integração por Tenant, sem requisito de compliance conhecido que o exija agora.

## Evidências quantitativas

**Arquivos alterados (6):**
- `apps/backend/src/use-cases/communication/conectar-whatsapp.use-case.ts`
- `apps/backend/src/infrastructure/messaging/whatsapp-message.provider.ts`
- `apps/backend/src/api/communication/communication.module.ts`
- `apps/backend/prisma/schema.prisma` (comentário, sem mudança de coluna)
- `.env.example`, `CONFIGURACAO_AMBIENTE.md` (nova variável documentada)

**Arquivos novos (3 de produção/infra + 3 de teste):**
- `apps/backend/src/shared/token-cipher.service.ts`
- `.env` / `apps/backend/.env` (nova variável adicionada aos ambientes locais)
- `apps/backend/test/unit/shared/token-cipher.service.test.ts` (6 testes)
- `apps/backend/test/critical/whatsapp-token-encryption.test.ts` (2 testes, Postgres real)

**Testes:** 1 arquivo unitário existente ajustado (`conectar-whatsapp.use-case.test.ts`) + 8 testes novos (6 unitários + 2 críticos).

**Resultado da suíte unitária completa:** 52 arquivos, 429 testes, 0 falhas.

**Resultado da suíte crítica completa** (`/root/luxora-app`, 2 execuções consecutivas): ambas 18/19 arquivos, 135/136 testes, 0 falhas (1 skip documentado, não relacionado).

**Build:** `nest build` limpo, exit 0. **Lint:** 2 erros pré-existentes (`audit-immutability.test.ts`, `automations.test.ts`), confirmados via `git diff` como não introduzidos por esta ADR — não bloqueiam.

## Confirmações

- **Nenhuma regra de negócio foi alterada** — `ConectarWhatsAppUseCase`/`WhatsAppMessageProvider` continuam com exatamente o mesmo comportamento funcional; só o valor fisicamente armazenado/lido mudou de forma transparente às chamadas.
- **Nenhum endpoint público mudou** — `POST /whatsapp/connect` mantém a mesma assinatura de request/response (`{ status: 'connected' }`).
- **Nenhuma migration de banco foi necessária** — a coluna `access_token` continua `String`; o que muda é o conteúdo gravado nela, não o schema.

## Referências

- `docs/PLANO_DE_EXECUCAO.md` — AD-005, Epic 3.
- `docs/02-Arquitetura/12-Seguranca.md` — seção "Criptografia > Em repouso".
- `CONFIGURACAO_AMBIENTE.md` — `WHATSAPP_TOKEN_ENCRYPTION_KEY`.
