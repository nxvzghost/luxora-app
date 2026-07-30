import { Module } from '@nestjs/common';
import { INBOX_REPOSITORY } from '@domain-services/platform/inbox.repository';
import { PrismaInboxRepository } from '@infrastructure/database/repositories/prisma-inbox.repository';
import { PrismaService } from '@infrastructure/database/prisma.service';
import { PrismaClientProvider } from '@infrastructure/database/prisma-client.provider';

/**
 * InboxModule — ADR-0054 (AD-036). Módulo pequeno e dedicado, sem
 * controller — só existe para que `InboxRepository` seja registrado uma
 * única vez e reaproveitado por import, nunca redeclarado (lição
 * aplicada da revisão do commit AD-007/AD-010, que encontrou AuditService
 * duplicado entre CommunicationModule e AIModule). Qualquer módulo de
 * canal futuro (email/SMS) que precise de idempotência de consumo importa
 * este módulo, sem repetir providers.
 */
@Module({
  providers: [
    { provide: INBOX_REPOSITORY, useClass: PrismaInboxRepository },
    PrismaService,
    PrismaClientProvider,
  ],
  exports: [INBOX_REPOSITORY],
})
export class InboxModule {}
