import { Appointment } from '@domain/appointment/appointment.entity';

export interface AppointmentRepository {
  findById(id: string): Promise<Appointment | null>;
  /**
   * K2-b (ADR-0069, seção 2.7) — a consulta com a linha travada até o fim da
   * unidade de trabalho (`SELECT … FOR UPDATE`): uma transição por vez. Só
   * dentro de uma unidade de trabalho. Devolve null também para a consulta
   * com desfecho, que a política restritiva do banco deixa fora de qualquer
   * escrita (e de qualquer trava) do papel da aplicação; quem chama distingue
   * os dois casos lendo a consulta e o desfecho sem trava.
   */
  findByIdForUpdate(id: string): Promise<Appointment | null>;
  /** K2-b — id da ocorrência criada pela remarcação desta, se houver. */
  findSuccessorId(id: string): Promise<string | null>;
  /** Busca agendamentos ativos (não cancelados) de um terapeuta num intervalo — base de ConsultarDisponibilidade. */
  findActiveByTherapistAndRange(therapistId: string, from: Date, to: Date): Promise<Appointment[]>;
  /** Módulo 15 — lista agendamentos do Tenant inteiro (todos os terapeutas) num intervalo, para a tela de Agenda. */
  findByTenantAndRange(from: Date, to: Date): Promise<Appointment[]>;
  save(appointment: Appointment): Promise<void>;
  /**
   * Salva N Appointments em uma única operação atômica — tudo ou nada. Base
   * para fluxos que criam mais de uma ocorrência de uma vez (ex: lote
   * recorrente, PD-001 Fase 2), evitando série "pela metade" quando uma
   * ocorrência no meio do lote falha.
   *
   * `tx` é um handle de transação opaco ao Domain — quem já está dentro de
   * uma transação da implementação concreta pode repassá-la aqui para
   * compor (ex: um Caso de Uso que precisa deste `saveMany` e mais alguma
   * outra escrita na mesma transação); quem não tem nenhuma, não passa
   * nada, e o Repository abre a própria transação internamente. Este
   * parâmetro não antecipa nenhuma Unit of Work — é só o ponto de extensão
   * mínimo para permitir composição futura sem reescrever a assinatura.
   */
  saveMany(appointments: Appointment[], tx?: unknown): Promise<void>;
  /**
   * PD-001 Fase 2, C3 — checagem de idempotência da materialização de
   * `RecurringBlock`. Retorna só `boolean` (não o `Appointment` inteiro):
   * o único uso é "já existe, pular?" — reidratar a entidade completa não
   * tem propósito para quem chama. Contrato deliberadamente estreito, não
   * generalizado — mesmo padrão de todo Repository deste projeto (ver
   * `ClinicHolidayRepository`/`RecurringBlockRepository`), sem
   * generalização especulativa até um segundo consumidor real aparecer.
   */
  existsForRecurringBlockOccurrence(recurringBlockId: string, scheduledAt: Date): Promise<boolean>;
}

export const APPOINTMENT_REPOSITORY = Symbol('APPOINTMENT_REPOSITORY');
