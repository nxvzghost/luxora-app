import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ObterResumoDashboardUseCase, ResumoDashboard } from '@use-cases/dashboard/obter-resumo-dashboard.use-case';

/**
 * DashboardController — Epic 11. Indicadores agregados diretamente no
 * banco, substituindo o cálculo client-side anterior sobre /patients e
 * /billings.
 */
@ApiTags('dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionAccessGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly obterResumoDashboard: ObterResumoDashboardUseCase) {}

  @Get('summary')
  @Roles('admin', 'therapist')
  async summary(): Promise<ResumoDashboard> {
    return this.obterResumoDashboard.execute();
  }
}
