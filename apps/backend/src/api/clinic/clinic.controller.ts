import { Body, Controller, Get, Patch, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UpdateClinicDto, UpdateClinicPoliciesDto, UpdatePaymentInfoDto } from './dto/clinic.dto';
import {
  ConsultarClinicaUseCase,
  AtualizarClinicaUseCase,
  AtualizarPoliticasClinicaUseCase,
  AtualizarDadosPagamentoUseCase,
} from '@use-cases/clinic/clinic.use-cases';
import { Clinic } from '@domain/clinic/clinic.entity';

/**
 * ClinicController — recurso singular por Tenant (sem :id na rota), ver
 * 02 - CTO/clinicos/docs/04-API/01-Contratos-REST.md, seção Clínica.
 *
 * AD-003 — política de papel por rota: docs/02-Arquitetura/16-Politica-RBAC.md.
 */
@ApiTags('clinic')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionAccessGuard)
@Controller('clinic')
export class ClinicController {
  constructor(
    private readonly consultarClinica: ConsultarClinicaUseCase,
    private readonly atualizarClinica: AtualizarClinicaUseCase,
    private readonly atualizarPoliticas: AtualizarPoliticasClinicaUseCase,
    private readonly atualizarDadosPagamento: AtualizarDadosPagamentoUseCase,
  ) {}

  @Get()
  async findOne() {
    return this.toResponse(await this.consultarClinica.execute());
  }

  @Patch()
  @Roles('admin')
  async update(@Body() dto: UpdateClinicDto) {
    return this.toResponse(await this.atualizarClinica.execute(dto));
  }

  @Put('policies')
  @Roles('admin')
  async updatePolicies(@Body() dto: UpdateClinicPoliciesDto) {
    return this.toResponse(await this.atualizarPoliticas.execute(dto));
  }

  @Put('payment-info')
  @Roles('admin')
  async updatePaymentInfo(@Body() dto: UpdatePaymentInfoDto) {
    return this.toResponse(await this.atualizarDadosPagamento.execute(dto));
  }

  private toResponse(clinic: Clinic) {
    return {
      name: clinic.name,
      defaultBillingPolicy: clinic.defaultBillingPolicy,
      cancellationHoursLimit: clinic.cancellationHoursLimit ?? null,
      defaultSessionDurationMinutes: clinic.defaultSessionDurationMinutes,
      pixKey: clinic.pixKey ?? null,
      payeeName: clinic.payeeName ?? null,
    };
  }
}
