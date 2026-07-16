import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ConsultarAuditLogUseCase } from '@use-cases/audit/consultar-audit-log.use-case';

/**
 * AuditLogController — 02 - CTO/clinicos/docs/04-API/01-Contratos-REST.md,
 * seção "Auditoria — acesso restrito a Administrador".
 */
@ApiTags('audit-log')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionAccessGuard)
@Controller('audit-log')
export class AuditLogController {
  constructor(private readonly consultarAuditLog: ConsultarAuditLogUseCase) {}

  @Get()
  @Roles('admin')
  async list(@Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const entries = await this.consultarAuditLog.execute({ cursor, limit: limit ? Number(limit) : undefined });
    return { data: entries };
  }
}
