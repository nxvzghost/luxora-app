import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Appointment } from '@domain/appointment/appointment.entity';
import { Session } from '@domain/session/session.entity';
import {
  AppointmentRepository,
  APPOINTMENT_REPOSITORY,
} from '@domain-services/patient-ops/appointment.repository';
import { SessionRepository, SESSION_REPOSITORY } from '@domain-services/patient-ops/session.repository';
import { AuditService } from '@domain-services/platform/audit.service';

async function findOrThrow(repo: AppointmentRepository, id: string): Promise<Appointment> {
  const appointment = await repo.findById(id);
  if (!appointment) {
    throw new NotFoundException('Agendamento não encontrado.');
  }
  return appointment;
}

/**
 * RemarcarConsultaUseCase — RF-052.
 */
@Injectable()
export class RemarcarConsultaUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository,
    private readonly auditService: AuditService,
  ) {}

  async execute(id: string, newScheduledAt: Date): Promise<Appointment> {
    const appointment = await findOrThrow(this.repo, id);
    appointment.transitionTo('ReagendamentoSolicitado');
    appointment.reschedule(newScheduledAt);
    await this.repo.save(appointment);
    await this.auditService.recordAll(appointment.pullDomainEvents());
    return appointment;
  }
}

/** CancelarConsultaUseCase — RF-053. */
@Injectable()
export class CancelarConsultaUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository,
    private readonly auditService: AuditService,
  ) {}

  async execute(id: string): Promise<Appointment> {
    const appointment = await findOrThrow(this.repo, id);
    appointment.transitionTo('Cancelada');
    await this.repo.save(appointment);
    await this.auditService.recordAll(appointment.pullDomainEvents());
    return appointment;
  }
}

/**
 * ConfirmarConsultaUseCase — RF-054, RN e JP-004.
 *
 * GAP REAL ENCONTRADO E FECHADO: Session.createFromConfirmedAppointment já
 * existia na entidade de Domain (com a regra "só nasce de um Appointment
 * Confirmada" já validada ali dentro), mas nenhum Use Case jamais chamava
 * isso — não havia SessionRepository, nem Prisma implementation, nem
 * nenhum controller tocando em Session. Na prática, nenhuma Sessão nunca
 * era criada por nenhum caminho da aplicação real, o que tornava todo o
 * fluxo de Cobrança Agregada (Módulo 09 — GerarCobrancaUseCase depende de
 * sessionIds existentes de verdade, FK de billing_session) inalcançável
 * fora de teste. Confirmar a consulta agora cria a Sessão real.
 */
@Injectable()
export class ConfirmarConsultaUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessionRepo: SessionRepository,
    private readonly auditService: AuditService,
  ) {}

  async execute(id: string): Promise<Appointment> {
    const appointment = await findOrThrow(this.repo, id);
    appointment.transitionTo('Confirmada');
    await this.repo.save(appointment);

    const session = Session.createFromConfirmedAppointment({
      id: randomUUID(),
      tenantId: appointment.tenantId,
      appointmentId: appointment.id,
      appointmentState: appointment.state,
      patientId: appointment.patientId,
      therapistId: appointment.therapistId,
    });
    await this.sessionRepo.save(session);

    await this.auditService.recordAll([...appointment.pullDomainEvents(), ...session.pullDomainEvents()]);
    return appointment;
  }
}
