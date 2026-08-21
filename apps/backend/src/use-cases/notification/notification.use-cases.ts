import { Injectable, Inject } from '@nestjs/common';
import { Notification } from '@domain/notification/notification.entity';
import { NotificationRepository, NOTIFICATION_REPOSITORY } from '@domain-services/platform/notification.repository';

export interface ListarNotificacoesInput {
  cursor?: string;
  limit?: number;
}

@Injectable()
export class ListarNotificacoesUseCase {
  constructor(@Inject(NOTIFICATION_REPOSITORY) private readonly repo: NotificationRepository) {}

  async execute(input?: ListarNotificacoesInput): Promise<Notification[]> {
    return this.repo.findByTenant(input);
  }
}

@Injectable()
export class ContarNotificacoesNaoLidasUseCase {
  constructor(@Inject(NOTIFICATION_REPOSITORY) private readonly repo: NotificationRepository) {}

  async execute(): Promise<number> {
    return this.repo.countUnreadByTenant();
  }
}

@Injectable()
export class MarcarNotificacaoComoLidaUseCase {
  constructor(@Inject(NOTIFICATION_REPOSITORY) private readonly repo: NotificationRepository) {}

  async execute(id: string): Promise<Notification> {
    return this.repo.markAsRead(id);
  }
}
