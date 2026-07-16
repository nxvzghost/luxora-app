import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { AuditLogRepository, AuditLogEntry } from '@domain-services/platform/audit-log.repository';
import { randomUUID } from 'node:crypto';

/**
 * PrismaAuditLogRepository — Módulo 10.
 * Fonte: 02 - CTO/clinicos/docs/03-Database/08-Auditoria.md.
 *
 * Nunca expõe update/delete — auditoria é imutável por definição
 * (mesma regra já aplicada a DomainEvent, Módulo 02, Princípio 10).
 */
@Injectable()
export class PrismaAuditLogRepository implements AuditLogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: Omit<AuditLogEntry, 'id'>): Promise<void> {
    await this.prisma.forTenant((tx) =>
      tx.auditLog.create({
        data: {
          id: randomUUID(),
          tenantId: entry.tenantId,
          userId: entry.userId,
          actorType: entry.actorType,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          payload: (entry.payload ?? undefined) as Prisma.InputJsonValue | undefined,
          result: entry.result,
        },
      }),
    );
  }

  async findByTenant(params?: { cursor?: string; limit?: number }): Promise<AuditLogEntry[]> {
    const limit = params?.limit ?? 50;
    const records = await this.prisma.forTenant((tx) =>
      tx.auditLog.findMany({
        take: limit,
        ...(params?.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
        orderBy: { createdAt: 'desc' },
      }),
    );
    return records.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      userId: r.userId,
      actorType: r.actorType,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      payload: r.payload as Record<string, unknown> | null,
      result: r.result,
    }));
  }
}
