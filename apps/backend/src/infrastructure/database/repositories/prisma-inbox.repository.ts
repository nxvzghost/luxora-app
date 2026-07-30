import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import {
  InboxRepository,
  InboxClaimOutcome,
  InboxClaimParams,
  InboxResultPayload,
} from '@domain-services/platform/inbox.repository';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

/**
 * Janela de staleness — acima disso, um claim em 'processing' é tratado
 * como órfão (worker morreu no meio) e pode ser reclamado por uma
 * execução seguinte. Configurável via env, com um default conservador
 * (ADR-0054 §Arquitetura — folga generosa acima da latência plausível de
 * IA+DB).
 */
const STALE_CLAIM_MINUTES = Number(process.env.INBOX_STALE_CLAIM_MINUTES ?? 5);

@Injectable()
export class PrismaInboxRepository implements InboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  async tryClaim(params: InboxClaimParams): Promise<InboxClaimOutcome> {
    const { channel, externalId, tenantId, conversationId, correlationId } = params;

    try {
      await this.prisma.forTenant((tx) =>
        tx.inboxEntry.create({
          data: {
            tenantId,
            channel,
            externalId,
            conversationId,
            correlationId,
            status: 'processing',
          },
        }),
      );
      return { outcome: 'claimed' };
    } catch (err) {
      if ((err as Prisma.PrismaClientKnownRequestError)?.code !== UNIQUE_CONSTRAINT_VIOLATION) {
        throw err;
      }
    }

    // Já existe uma entrada para este (channel, externalId) — decide o
    // que fazer a partir do estado atual dela.
    const existing = await this.prisma.forTenant((tx) =>
      tx.inboxEntry.findUnique({ where: { channel_externalId: { channel, externalId } } }),
    );
    if (!existing) {
      // Corrida extremamente improvável: o insert falhou por violação de
      // unicidade, mas a linha já não existe mais no momento da leitura
      // (só possível se algo fora deste código apagou a linha). Trata
      // como um claim novo — mais seguro que travar o evento para sempre.
      return this.tryClaim(params);
    }

    if (existing.status === 'generated' || existing.status === 'dispatched') {
      return { outcome: 'resume_dispatch', resultPayload: existing.resultPayload as unknown as InboxResultPayload };
    }

    if (existing.status === 'failed') {
      const reclaimed = await this.prisma.forTenant((tx) =>
        tx.inboxEntry.updateMany({
          where: { channel, externalId, status: 'failed' },
          data: { status: 'processing', attempts: { increment: 1 }, claimedAt: new Date(), lastError: null },
        }),
      );
      return reclaimed.count === 1 ? { outcome: 'claimed' } : { outcome: 'in_progress' };
    }

    // status === 'processing' — só reclama se o claim atual estiver obsoleto.
    const staleThreshold = new Date(Date.now() - STALE_CLAIM_MINUTES * 60_000);
    if (existing.claimedAt >= staleThreshold) {
      return { outcome: 'in_progress' };
    }

    const reclaimed = await this.prisma.forTenant((tx) =>
      tx.inboxEntry.updateMany({
        where: { channel, externalId, status: 'processing', claimedAt: { lt: staleThreshold } },
        data: {
          attempts: { increment: 1 },
          claimedAt: new Date(),
          lastError: 'reclaim: claim anterior expirado (worker possivelmente interrompido)',
        },
      }),
    );
    return reclaimed.count === 1 ? { outcome: 'claimed' } : { outcome: 'in_progress' };
  }

  async markGenerated(channel: string, externalId: string, resultPayload: InboxResultPayload): Promise<void> {
    await this.prisma.forTenant((tx) =>
      tx.inboxEntry.updateMany({
        where: { channel, externalId },
        data: {
          status: 'generated',
          resultPayload: resultPayload as unknown as Prisma.InputJsonValue,
          processedAt: new Date(),
        },
      }),
    );
  }

  async markDispatched(channel: string, externalId: string): Promise<void> {
    await this.prisma.forTenant((tx) =>
      tx.inboxEntry.updateMany({
        where: { channel, externalId },
        data: { status: 'dispatched', dispatchedAt: new Date() },
      }),
    );
  }

  async markFailed(channel: string, externalId: string, error: string): Promise<void> {
    await this.prisma.forTenant((tx) =>
      tx.inboxEntry.updateMany({
        where: { channel, externalId },
        data: { status: 'failed', lastError: error },
      }),
    );
  }
}
