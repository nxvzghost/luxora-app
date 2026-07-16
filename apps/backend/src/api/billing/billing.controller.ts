import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
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
} from '@use-cases/payment/payment.use-cases';
import { Billing } from '@domain/billing/billing.entity';
import { Payment } from '@domain/payment/payment.entity';

@ApiTags('billings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SubscriptionAccessGuard)
@Controller('billings')
export class BillingController {
  constructor(
    private readonly gerarCobranca: GerarCobrancaUseCase,
    private readonly consultarCobranca: ConsultarCobrancaUseCase,
    private readonly listarCobrancas: ListarCobrancasUseCase,
    private readonly enviarCobranca: EnviarCobrancaUseCase,
  ) {}

  @Get()
  async list(@Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const billings = await this.listarCobrancas.execute({ cursor, limit: limit ? Number(limit) : undefined });
    return { data: billings.map(this.toResponse) };
  }

  @Post()
  async create(@Body() dto: CreateBillingDto) {
    const billing = await this.gerarCobranca.execute({ ...dto, dueDate: new Date(dto.dueDate) });
    return this.toResponse(billing);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.toResponse(await this.consultarCobranca.execute(id));
  }

  @Post(':id/send')
  async send(@Param('id') id: string) {
    return this.toResponse(await this.enviarCobranca.execute(id));
  }

  private toResponse(billing: Billing) {
    return { id: billing.id, patientId: billing.patientId, amount: billing.amount, dueDate: billing.dueDate, state: billing.state };
  }
}

/**
 * PaymentController — POST / exige header Idempotency-Key
 * (04-API/00-Principios-da-API.md) — sem ele, a requisição é rejeitada
 * antes mesmo de chegar ao Use Case.
 */
@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SubscriptionAccessGuard)
@Controller('payments')
export class PaymentController {
  constructor(
    private readonly registrarPagamento: RegistrarPagamentoUseCase,
    private readonly consultarPagamento: ConsultarPagamentoUseCase,
    private readonly estornarPagamento: EstornarPagamentoUseCase,
  ) {}

  @Post()
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
  async refund(@Param('id') id: string) {
    return this.toResponse(await this.estornarPagamento.execute(id));
  }

  private toResponse(payment: Payment) {
    return { id: payment.id, billingId: payment.billingId, amount: payment.amount, state: payment.state };
  }
}
