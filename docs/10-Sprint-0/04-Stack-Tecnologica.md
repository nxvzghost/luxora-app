# Sprint 0 — Entregável 4: Stack Tecnológica Definitiva

Toda escolha abaixo já estava decidida ao longo da documentação técnica (ADRs 0001-0021); este documento consolida em um único lugar, com justificativa, para consulta rápida durante a implementação.

| Categoria | Escolha | Justificativa | Referência |
|---|---|---|---|
| Linguagem | TypeScript (Backend e Frontend) | Um único idioma entre as duas camadas reduz custo de contexto para equipe pequena; tipagem forte reduz classe inteira de bugs antes de produção | ADR-0008 |
| Framework Backend | NestJS | Arquitetura modular nativa, alinhada a Clean Architecture/DDD sem lutar contra o framework; ecossistema maduro para REST + filas + auth | ADR-0008 |
| Framework Frontend | Next.js (App Router) | SSR quando necessário, DX madura, ecossistema React já dominante para o time; Vercel como opção de deploy gratuita para o Frontend na Fase 1 | `02-Arquitetura/04-Frontend.md` |
| ORM | Prisma | Type-safety ponta a ponta com TypeScript, migrations declarativas, boa DX para equipe pequena | ADR-0010 |
| Banco de Dados | PostgreSQL | Suporte nativo a Row-Level Security (crítico para isolamento multi-tenant), maturidade, JSON nativo para payloads de auditoria | ADR-0009 |
| Cache | Redis | Padrão de mercado, integração nativa com BullMQ, suficiente para o volume esperado nos primeiros 2 anos | ADR-0009 |
| Filas | BullMQ | Sobre Redis (sem infra adicional), suporta idempotência e retry nativamente — crítico para envio de WhatsApp e cobrança | ADR-0009 |
| Autenticação | JWT (access + refresh) | Stateless, padrão para API consumida por Frontend e futuros integradores externos; RBAC simples no MVP (Admin/Terapeuta) | `02-Arquitetura/06-Autenticacao.md` |
| Armazenamento de arquivos | S3-compatible (Object Storage) | Comprovantes de pagamento, exports; compatível com múltiplos provedores sem lock-in (Princípio 13) | ADR-0013 |
| Mensageria com paciente | WhatsApp Business API (oficial) | Canal primário já validado pelo ICP; API oficial evita bloqueio/banimento que soluções não-oficiais sofrem | `02-Arquitetura/08-Comunicacao.md` |
| Provedor de IA | Claude Haiku 4.5 (Anthropic API) | Menor custo da geração atual, latência baixa adequada a chat, margem de ~10x sobre o teto orçado (RNF-021) | `05-IA/00-Provedor-e-Interface.md` |
| Automação/Orquestração | n8n | Open-source, auto-hospedável, fronteira de responsabilidade já formalizada (ADR-0021) | ADR-0021 |
| Infraestrutura/Deploy | Railway (Fases 1-2), com checkpoint de reavaliação na Fase 3 | Cobrança por uso real, zero custo de capacidade ociosa, tudo gerenciado numa única plataforma para equipe pequena | `07-Infra/00-Provedor-e-Custos.md` |
| CI/CD | GitHub Actions | Integração nativa com o host de código, sem infraestrutura própria a manter | `02-Arquitetura/13-Deploy.md` |
| Observabilidade | 4 pilares: logs estruturados, métricas, eventos de domínio, traces | Já formalizado; ferramenta específica (ex: OpenTelemetry) a definir na implementação do M15, não bloqueante antes disso | `02-Arquitetura/11-Monitoramento.md` |
| Testes | Vitest | Unificado com o ecossistema TypeScript/Vite, mais rápido que Jest para o volume esperado | `02-Arquitetura/03-Backend.md` |
| Documentação de API | OpenAPI/Swagger, gerado a partir do código NestJS | Fonte única de verdade entre contrato e implementação, evita documentação manual desatualizada | ADR-0011 |

## Princípio geral que rege toda a stack

Independência Tecnológica (Princípio 13, ADR): nenhuma dessas escolhas é definitiva de forma irreversível. Toda integração externa (provedor de IA, infraestrutura, storage) passa por uma interface própria do domínio — trocar de provedor nunca exige reescrever regra de negócio. Esta stack é a melhor escolha **para o estágio atual da empresa**, não um compromisso permanente.
