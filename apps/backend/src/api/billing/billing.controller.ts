import { BadRequestException, Body, Controller, Get, Headers, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { parsePageLimit } from '@shared/pagination';
import { CreateBillingDto, CreatePaymentDto } from './dto/billing.dto';
import {
  GerarCobrancaUseCase,
  ConsultarCobrancaUseCase,
  ListarCobrancasUseCase,
  EnviarCobrancaUseCase,
} from '@use-cases/billing/billing.use-cases';
import {
  RegistrarPagamentoUseCase,
  ConsultarPagamentoUseCase,
  EstornarPagamentoUseCase,
  ListarPagamentosDaCobrancaUseCase,
  ConsultarEstadosDePagamentoUseCase,
} from '@use-cases/payment/payment.use-cases';
import { Billing } from '@domain/billing/billing.entity';
import { Payment } from '@domain/payment/payment.entity';
import { CLINIC_TIME_ZONE_READER, ClinicTimeZoneReader } from '@domain-services/platform/clinic-time-zone.reader';

/**
 * BillingController — política de papel por rota: docs/02-Arquitetura/16-Politica-RBAC.md (AD-003).
 */
@ApiTags('billings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionAccessGuard)
@Controller('billings')
export class BillingController {
  constructor(
    private readonly gerarCobranca: GerarCobrancaUseCase,
    private readonly consultarCobranca: ConsultarCobrancaUseCase,
    private readonly listarCobrancas: ListarCobrancasUseCase,
    private readonly enviarCobranca: EnviarCobrancaUseCase,
    private readonly listarPagamentos: ListarPagamentosDaCobrancaUseCase,
    private readonly consultarEstadosDePagamento: ConsultarEstadosDePagamentoUseCase,
    @Inject(CLINIC_TIME_ZONE_READER) private readonly clinicTimeZone: ClinicTimeZoneReader,
  ) {}

  // Tarefa 05 — `paymentState` (aditivo): estado do pagamento da cobrança,
  // ou null quando não há pagamento. É o que permite ao painel mostrar uma
  // cobrança quitada cujo pagamento foi estornado.
  @Get()
  async list(@Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const billings = await this.listarCobrancas.execute({ cursor, limit: parsePageLimit(limit) });
    const paymentStates = await this.consultarEstadosDePagamento.execute(billings.map((billing) => billing.id));
    const timeZone = await this.clinicTimeZone.current();
    return {
      data: billings.map((billing) => ({ ...this.toResponse(billing, timeZone), paymentState: paymentStates.get(billing.id) ?? null })),
    };
  }

  @Post()
  @Roles('admin')
  async create(@Body() dto: CreateBillingDto) {
    const billing = await this.gerarCobranca.execute({ ...dto, dueDate: new Date(dto.dueDate) });
    return this.toResponse(billing, await this.clinicTimeZone.current());
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.toResponse(await this.consultarCobranca.execute(id), await this.clinicTimeZone.current());
  }

  @Post(':id/send')
  @Roles('admin')
  async send(@Param('id') id: string) {
    return this.toResponse(await this.enviarCobranca.execute(id), await this.clinicTimeZone.current());
  }

  // Tarefa 05 da auditoria — só leitura: é por aqui que o painel chega ao id
  // do pagamento para acompanhar o estado e oferecer o estorno.
  @Get(':id/payments')
  async payments(@Param('id') id: string) {
    const payments = await this.listarPagamentos.execute(id);
    return {
      data: payments.map((payment) => ({ id: payment.id, billingId: payment.billingId, amount: payment.amount, state: payment.state })),
    };
  }

  // Tarefa 05 — `overdue` (aditivo): a cobrança está em atraso pela regra de
  // Billing.isOverdue(), a mesma que GET /dashboard/summary conta. O painel
  // lê este campo em vez de refazer a conta, para as duas telas concordarem.
  // AD-039 — o dia do vencimento é o da clínica: `timeZone` é o fuso dela.
  private toResponse(billing: Billing, timeZone: string) {
    return {
      id: billing.id,
      patientId: billing.patientId,
      amount: billing.amount,
      dueDate: billing.dueDate,
      state: billing.state,
      overdue: billing.isOverdue(timeZone),
    };
  }
}

/**
 * PaymentController — POST / exige header Idempotency-Key
 * (04-API/00-Principios-da-API.md) — sem ele, a requisição é rejeitada
 * antes mesmo de chegar ao Use Case.
 */
@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionAccessGuard)
@Controller('payments')
export class PaymentController {
  constructor(
    private readonly registrarPagamento: RegistrarPagamentoUseCase,
    private readonly consultarPagamento: ConsultarPagamentoUseCase,
    private readonly estornarPagamento: EstornarPagamentoUseCase,
  ) {}

  @Post()
  @Roles('admin')
  async create(@Body() dto: CreatePaymentDto, @Headers('idempotency-key') idempotencyKey?: string) {
    if (!idempotencyKey) {
      throw new BadRequestException('Header Idempotency-Key é obrigatório (RNF-008).');
    }
    const payment = await this.registrarPagamento.execute({ ...dto, idempotencyKey });
    return this.toResponse(payment);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.toResponse(await this.consultarPagamento.execute(id));
  }

  @Post(':id/refund')
  @Roles('admin')
  async refund(@Param('id') id: string) {
    return this.toResponse(await this.estornarPagamento.execute(id));
  }

  private toResponse(payment: Payment) {
    return { id: payment.id, billingId: payment.billingId, amount: payment.amount, state: payment.state };
  }
}
