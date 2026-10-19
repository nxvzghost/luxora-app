import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SubscriptionAccessGuard } from '../subscription/subscription-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { LinkContactDto } from './dto/contact.dto';
import { ListarContatosPendentesUseCase } from '@use-cases/contact/listar-contatos-pendentes.use-case';
import { VincularContatoAPacienteUseCase } from '@use-cases/contact/vincular-contato-a-paciente.use-case';
import { ListarVinculosAprovadosUseCase } from '@use-cases/contact/listar-vinculos-aprovados.use-case';
import { DesfazerVinculoDoContatoUseCase } from '@use-cases/contact/desfazer-vinculo-do-contato.use-case';

/**
 * ContactsController — ADR-0063, decisão 3 (AD-038). O mínimo para a
 * clínica aprovar o vínculo de um número novo a um paciente que já existe.
 *
 * As duas rotas são só do administrador: a lista mostra números de quem
 * escreveu para a clínica, e a aprovação muda quem um número identifica.
 * O isolamento entre clínicas é o de todo o resto — as leituras passam pela
 * RLS, e um contato ou paciente de outra clínica responde 404.
 *
 * A-10 (19/10/2026) — mais duas rotas, também só do administrador: a lista
 * dos vínculos aprovados e o desfazer.
 */
@ApiTags('contacts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionAccessGuard)
@Controller('contacts')
export class ContactsController {
  constructor(
    private readonly listarPendentes: ListarContatosPendentesUseCase,
    private readonly vincularContato: VincularContatoAPacienteUseCase,
    private readonly listarVinculos: ListarVinculosAprovadosUseCase,
    private readonly desfazerVinculo: DesfazerVinculoDoContatoUseCase,
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

  /** Números que identificam um paciente porque a clínica aprovou o vínculo (os do cadastro ficam de fora). */
  @Get('linked')
  @Roles('admin')
  async linked() {
    return { data: await this.listarVinculos.execute() };
  }

  /** Desfaz um vínculo aprovado: o número deixa de identificar o paciente. Fica gravado quem desfez e quando. */
  @Post(':id/unlink')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async unlink(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: LinkContactDto) {
    const { contact, patientId, undoneByUserId, undoneAt } = await this.desfazerVinculo.execute({
      contactId: id,
      patientId: dto.patientId,
    });
    return { contactId: contact.id, patientId, state: contact.state, undoneByUserId, undoneAt };
  }
}
