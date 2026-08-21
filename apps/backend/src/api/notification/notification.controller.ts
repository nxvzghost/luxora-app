import { Controller, Get, Post, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import {
  ListarNotificacoesUseCase,
  ContarNotificacoesNaoLidasUseCase,
  MarcarNotificacaoComoLidaUseCase,
} from '@use-cases/notification/notification.use-cases';
import { Notification } from '@domain/notification/notification.entity';

/**
 * NotificationController — Epic 12 (AD-021).
 *
 * Política de papel por rota: mesmo padrão da maioria dos endpoints
 * operacionais (Patients/Billing/Dashboard) — não admin-only como Audit.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionAccessGuard)
@Controller('notifications')
export class NotificationController {
  constructor(
    private readonly listarNotificacoes: ListarNotificacoesUseCase,
    private readonly contarNaoLidas: ContarNotificacoesNaoLidasUseCase,
    private readonly marcarComoLida: MarcarNotificacaoComoLidaUseCase,
  ) {}

  @Get()
  @Roles('admin', 'therapist')
  async list(@Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const effectiveLimit = limit ? Number(limit) : 20;
    const notifications = await this.listarNotificacoes.execute({ cursor, limit: effectiveLimit });
    const nextCursor = notifications.length === effectiveLimit ? notifications[notifications.length - 1].id : null;
    return { data: notifications.map(this.toResponse), next_cursor: nextCursor };
  }

  @Get('unread-count')
  @Roles('admin', 'therapist')
  async unreadCount(): Promise<{ count: number }> {
    const count = await this.contarNaoLidas.execute();
    return { count };
  }

  @Post(':id/read')
  @Roles('admin', 'therapist')
  async markAsRead(@Param('id') id: string) {
    const notification = await this.marcarComoLida.execute(id);
    return this.toResponse(notification);
  }

  private toResponse(notification: Notification) {
    return {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      entityType: notification.entityType,
      entityId: notification.entityId,
      readAt: notification.readAt,
      createdAt: notification.createdAt,
    };
  }
}
