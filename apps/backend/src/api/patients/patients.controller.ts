import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { CreatePatientDto, UpdatePatientDto } from './dto/patient.dto';
import { CadastrarPacienteUseCase } from '@use-cases/patient/cadastrar-paciente.use-case';
import { ConsultarPacienteUseCase } from '@use-cases/patient/consultar-paciente.use-case';
import { ListarPacientesUseCase } from '@use-cases/patient/listar-pacientes.use-case';
import { AtualizarPacienteUseCase } from '@use-cases/patient/atualizar-paciente.use-case';
import {
  InativarPacienteUseCase,
  ReativarPacienteUseCase,
  DarAltaPacienteUseCase,
} from '@use-cases/patient/gerenciar-status-paciente.use-case';

/**
 * PatientsController — ver 02 - CTO/clinicos/docs/04-API/01-Contratos-REST.md,
 * seção Pacientes.
 *
 * Todo endpoint protegido por JwtAuthGuard — nenhum aqui aceita tenant_id
 * como parâmetro (Princípio já reforçado desde o Módulo 01).
 */
@ApiTags('patients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SubscriptionAccessGuard)
@Controller('patients')
export class PatientsController {
  constructor(
    private readonly cadastrarPaciente: CadastrarPacienteUseCase,
    private readonly consultarPaciente: ConsultarPacienteUseCase,
    private readonly listarPacientes: ListarPacientesUseCase,
    private readonly atualizarPaciente: AtualizarPacienteUseCase,
    private readonly inativarPaciente: InativarPacienteUseCase,
    private readonly reativarPaciente: ReativarPacienteUseCase,
    private readonly darAltaPaciente: DarAltaPacienteUseCase,
  ) {}

  @Get()
  async list(@Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const effectiveLimit = limit ? Number(limit) : 20;
    const patients = await this.listarPacientes.execute({ cursor, limit: effectiveLimit });
    // Módulo 08: next_cursor estava fixo em `null` desde o Módulo 05 —
    // nunca de fato paginava além da primeira página. Corrigido: se
    // devolveu exatamente `limit` itens, pode haver mais — o cursor da
    // próxima página é o id do último item desta.
    const nextCursor = patients.length === effectiveLimit ? patients[patients.length - 1].id : null;
    return { data: patients.map(this.toResponse), next_cursor: nextCursor };
  }

  @Post()
  async create(@Body() dto: CreatePatientDto) {
    const patient = await this.cadastrarPaciente.execute(dto);
    return this.toResponse(patient);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const patient = await this.consultarPaciente.execute(id);
    return this.toResponse(patient);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdatePatientDto) {
    const patient = await this.atualizarPaciente.execute({ id, ...dto });
    return this.toResponse(patient);
  }

  @Post(':id/deactivate')
  async deactivate(@Param('id') id: string) {
    const patient = await this.inativarPaciente.execute(id);
    return this.toResponse(patient);
  }

  @Post(':id/reactivate')
  async reactivate(@Param('id') id: string) {
    const patient = await this.reativarPaciente.execute(id);
    return this.toResponse(patient);
  }

  @Post(':id/discharge')
  async discharge(@Param('id') id: string) {
    const patient = await this.darAltaPaciente.execute(id);
    return this.toResponse(patient);
  }

  private toResponse(patient: {
    id: string;
    name: string;
    phone: string;
    state: string;
    billingPolicyOverride?: string;
  }) {
    return {
      id: patient.id,
      name: patient.name,
      phone: patient.phone,
      state: patient.state,
      billingPolicyOverride: patient.billingPolicyOverride ?? null,
    };
  }
}
