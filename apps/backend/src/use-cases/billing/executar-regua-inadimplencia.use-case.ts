import { Injectable, Inject, Logger } from '@nestjs/common';
import { PATIENT_REPOSITORY, PatientRepository } from '@domain-services/patient-ops/patient.repository';
import { ConsultarSegmentacaoFinanceiraUseCase } from './consultar-segmentacao-financeira.use-case';
import { MessageQueueProducer } from '@infrastructure/messaging/message-queue.producer';
import { buildD1ReminderMessage, buildD7ReminderMessage } from '@use-cases/communication/templates/overdue-reminder.template';

/**
 * ExecutarReguaInadimplenciaUseCase — Módulo 13.
 * Fonte: 05-IA/03-Gestao-de-Inadimplencia.md, "Fluxo da régua".
 *
 * Regra central: D+1 e D+7 enviam lembrete gentil ao PACIENTE. Entre D+8 e
 * D+39, NENHUMA mensagem nova. D+40 NUNCA envia mensagem ao paciente —
 * apenas sinaliza ao terapeuta, decisão de como conduzir é sempre humana.
 *
 * LIMITAÇÃO CONHECIDA, documentada: o gatilho é por igualdade exata
 * (daysOverdue === 1/7/40). Se a régua não rodar em algum dia específico
 * (ex: job de cron falhar), aquele paciente nunca recebe o lembrete
 * daquele estágio retroativamente — a checagem por igualdade não
 * "recupera" um dia perdido. Idempotência (não duplicar) está garantida;
 * garantia de "sempre disparar" depende de a régua rodar todo dia sem
 * falha, o que é responsabilidade do agendador (Módulo 14, n8n/cron).
 */
@Injectable()
export class ExecutarReguaInadimplenciaUseCase {
  private readonly logger = new Logger(ExecutarReguaInadimplenciaUseCase.name);

  constructor(
    private readonly segmentacao: ConsultarSegmentacaoFinanceiraUseCase,
    @Inject(PATIENT_REPOSITORY) private readonly patientRepo: PatientRepository,
    private readonly messageQueue: MessageQueueProducer,
  ) {}

  async execute(tenantId: string, correlationId?: string): Promise<{ d1: number; d7: number; d40Signaled: number }> {
    const segmented = await this.segmentacao.execute();
    let d1 = 0;
    let d7 = 0;
    let d40Signaled = 0;

    for (const item of segmented) {
      const patient = await this.patientRepo.findById(item.patientId);
      if (!patient) continue;

      if (item.daysOverdue === 1) {
        await this.messageQueue.enqueue({
          tenantId,
          toPhoneNumber: patient.phone,
          body: buildD1ReminderMessage(patient.name.split(' ')[0], 'ontem'),
          idempotencyKey: `billing-overdue-${item.billingId}-d1`,
          correlationId,
        });
        d1++;
      } else if (item.daysOverdue === 7) {
        await this.messageQueue.enqueue({
          tenantId,
          toPhoneNumber: patient.phone,
          body: buildD7ReminderMessage(patient.name.split(' ')[0]),
          idempotencyKey: `billing-overdue-${item.billingId}-d7`,
          correlationId,
        });
        d7++;
      } else if (item.daysOverdue === 40) {
        this.logger.warn(
          `Paciente ${item.patientId} cruzou 40 dias de atraso na cobrança ${item.billingId} — decisão de condução é do terapeuta, não automática.`,
        );
        d40Signaled++;
      }
      // Entre D+8 e D+39, e qualquer outro dia fora de 1/7/40: nenhuma ação — deliberado.
    }

    return { d1, d7, d40Signaled };
  }
}
