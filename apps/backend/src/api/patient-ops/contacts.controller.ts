import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { LinkContactDto } from './dto/contact.dto';
import { ListarContatosPendentesUseCase } from '@use-cases/contact/listar-contatos-pendentes.use-case';
import { VincularContatoAPacienteUseCase } from '@use-cases/contact/vincular-contato-a-paciente.use-case';

/**
 * ContactsController — ADR-0063, decisão 3 (AD-038). O mínimo para a
 * clínica aprovar o vínculo de um número novo a um paciente que já existe.
 *
 * As duas rotas são só do administrador: a lista mostra números de quem
 * escreveu para a clínica, e a aprovação muda quem um número identifica.
 * O isolamento entre clínicas é o de todo o resto — as leituras passam pela
 * RLS, e um contato ou paciente de outra clínica responde 404.
 */
@ApiTags('contacts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionAccessGuard)
@Controller('contacts')
export class ContactsController {
  constructor(
    private readonly listarPendentes: ListarContatosPendentesUseCase,
    private readonly vincularContato: VincularContatoAPacienteUseCase,
  ) {}

  /** Números que escreveram para a clínica e ainda não identificam nenhum paciente. */
  @Get('pending')
  @Roles('admin')
  async pending() {
    return { data: await this.listarPendentes.execute() };
  }

  /** Aprova o vínculo: a partir daqui, este número identifica o paciente. Fica gravado quem aprovou e quando. */
  @Post(':id/link')
  @Roles('admin')
  async link(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: LinkContactDto) {
    const { contact, association, approvedByUserId, approvedAt } = await this.vincularContato.execute({
      contactId: id,
      patientId: dto.patientId,
    });
    return {
      contactId: contact.id,
      patientId: association.patientId,
      state: contact.state,
      approvedByUserId,
      approvedAt,
    };
  }
}
