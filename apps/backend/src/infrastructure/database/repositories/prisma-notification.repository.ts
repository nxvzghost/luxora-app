import { Injectable, NotFoundException } from '@nestjs/common';
import { Notification as PrismaNotification } from '@prisma/client';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { Notification } from '@domain/notification/notification.entity';
import { NotificationRepository } from '@domain-services/platform/notification.repository';

/**
 * PrismaNotificationRepository — Epic 12 (AD-021).
 *
 * Toda operação passa por PrismaService.forTenant() — mesmo padrão de todos
 * os demais repositórios; a RLS (`tenant_isolation`, migration
 * 20260813171216_add_notification) é a defesa real contra leitura
 * cross-tenant, não uma checagem em código.
 */
@Injectable()
export class PrismaNotificationRepository implements NotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(notification: Notification): Promise<void> {
    await this.prisma.forTenant((tx) =>
      tx.notification.create({
        data: {
          id: notification.id,
          tenantId: notification.tenantId,
          type: notification.type,
          title: notification.title,
          message: notification.message,
          entityType: notification.entityType,
          entityId: notification.entityId,
          readAt: notification.readAt,
          createdAt: notification.createdAt,
        },
      }),
    );
  }

  async findById(id: string): Promise<Notification | null> {
    const record = await this.prisma.forTenant((tx) => tx.notification.findUnique({ where: { id } }));
    return record ? this.toDomain(record) : null;
  }

  async findByTenant(params?: { cursor?: string; limit?: number }): Promise<Notification[]> {
    const limit = params?.limit ?? 20;
    const records = await this.prisma.forTenant((tx) =>
      tx.notification.findMany({
        take: limit,
        ...(params?.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
        orderBy: { createdAt: 'desc' },
      }),
    );
    return records.map((r) => this.toDomain(r));
  }

  async countUnreadByTenant(): Promise<number> {
    return this.prisma.forTenant((tx) => tx.notification.count({ where: { readAt: null } }));
  }

  /**
   * updateMany com `readAt: null` na cláusula where garante idempotência
   * (segunda chamada não encontra linhas a atualizar, não sobrescreve o
   * readAt original). Em seguida busca o registro atual para devolver a
   * Notification atualizada — se o id não existir no tenant (RLS já filtrou
   * ou id inválido), lança NotFoundException, mesmo padrão de recurso
   * singular usado em todo o projeto.
   */
  async markAsRead(id: string): Promise<Notification> {
    await this.prisma.forTenant((tx) =>
      tx.notification.updateMany({
        where: { id, readAt: null },
        data: { readAt: new Date() },
      }),
    );
    const record = await this.prisma.forTenant((tx) => tx.notification.findUnique({ where: { id } }));
    if (!record) {
      throw new NotFoundException('Notificação não encontrada.');
    }
    return this.toDomain(record);
  }

  private toDomain(record: PrismaNotification): Notification {
    return Notification.reconstitute({
      id: record.id,
      tenantId: record.tenantId,
      type: record.type,
      title: record.title,
      message: record.message,
      entityType: record.entityType,
      entityId: record.entityId,
      readAt: record.readAt,
      createdAt: record.createdAt,
    });
  }
}
