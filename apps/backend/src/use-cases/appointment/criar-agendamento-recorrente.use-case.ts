import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Appointment } from '@domain/appointment/appointment.entity';
import {
  AppointmentRepository,
  APPOINTMENT_REPOSITORY,
} from '@domain-services/patient-ops/appointment.repository';
import { AuditService } from '@domain-services/platform/audit.service';
import { TenantContext } from '@shared/tenant-context';
import { VerificarDisponibilidadeUseCase } from '@use-cases/availability/verificar-disponibilidade.use-case';
import { SlotNotAvailableError } from '@domain-services/availability/slot-not-available.error';

export interface CriarAgendamentoRecorrenteInput {
  patientId: string;
  therapistId: string;
  firstScheduledAt: Date;
  modality: 'presencial' | 'online';
  occurrences: number; // nº de sessões a criar, incluindo a primeira
  intervalDays: number; // 7 = semanal, 14 = quinzenal
}

/**
 * CriarAgendamentoRecorrenteUseCase — RF-059, JP-010.
 *
 * Escopo deliberadamente reduzido neste módulo: cria N ocorrências em
 * intervalo fixo, sem ajuste automático para feriados/férias/bloqueios
 * (mencionado no PRD original) — essa parte fica registrada como dívida
 * explícita (ver README do módulo), não implementada silenciosamente pela
 * metade.
 *
 * ADR-0040 (PD-001): TODAS as N ocorrências são validadas contra o Motor de
 * Disponibilidade ANTES de qualquer uma ser criada — recusa o lote inteiro
 * (nenhuma linha criada) se qualquer ocorrência não estiver disponível, em
 * vez de intercalar validação e criação uma a uma. Decisão deliberada: uma
 * recorrência "pela metade" por recusa do Motor (uma decisão que a própria
 * aplicação já tinha todos os dados para saber de antemão) é um resultado
 * pior do que gastar N consultas extras de leitura antes de escrever.
 *
 * LIMITAÇÃO CONHECIDA remanescente (registrada, não escondida): a garantia
 * acima cobre a decisão do Motor, não a escrita em si — se, ENTRE a
 * validação e o `save()`, uma requisição concorrente ocupar um dos horários
 * (corrida real, rara), o índice único do banco ainda pode rejeitar uma
 * ocorrência no meio do laço de criação (SESSION_CONFLICT) com as
 * ocorrências anteriores já persistidas. Isso não é revertido
 * automaticamente — o Repository ainda não expõe uma transação abrangendo
 * múltiplas linhas de Appointment. Correção real (envolver o laço de
 * criação inteiro em uma única transação Prisma) fica para quando o
 * Repository ganhar um método `saveMany` transacional.
 */
@Injectable()
export class CriarAgendamentoRecorrenteUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY) private readonly repo: AppointmentRepository,
    private readonly verificarDisponibilidade: VerificarDisponibilidadeUseCase,
    private readonly tenantContext: TenantContext,
    private readonly auditService: AuditService,
  ) {}

  async execute(input: CriarAgendamentoRecorrenteInput): Promise<Appointment[]> {
    if (input.occurrences < 1) {
      throw new Error('occurrences deve ser ao menos 1.');
    }

    const occurrenceDates = Array.from({ length: input.occurrences }, (_, i) => new Date(
      input.firstScheduledAt.getTime() + i * input.intervalDays * 24 * 60 * 60 * 1000,
    ));

    for (const scheduledAt of occurrenceDates) {
      const disponivel = await this.verificarDisponibilidade.execute({
        therapistId: input.therapistId,
        scheduledAt,
      });
      if (!disponivel) {
        throw new SlotNotAvailableError();
      }
    }

    const created: Appointment[] = [];
    for (const scheduledAt of occurrenceDates) {
      const appointment = Appointment.create({
        id: randomUUID(),
        tenantId: this.tenantContext.tenantId,
        patientId: input.patientId,
        therapistId: input.therapistId,
        scheduledAt,
        modality: input.modality,
        recurring: true,
      });
      appointment.transitionTo('Reservada');
      await this.repo.save(appointment);
      await this.auditService.recordAll(appointment.pullDomainEvents()); // retrofit da revisão geral
      created.push(appointment);
    }
    return created;
  }
}
