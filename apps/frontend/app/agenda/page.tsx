'use client';

import { useMemo, useState } from 'react';
import { PageShell, cardStyle, inputStyle, labelStyle, rowStyle, sectionTitleStyle } from '@/components/ui/page-shell';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, EmptyState, ErrorMessage, Loading, SuccessMessage } from '@/components/ui/feedback';
import { SlotPicker } from '@/components/slot-picker';
import { ClinicTimeZoneNote } from '@/components/clinic-time-zone-note';
import { describeApiError } from '@/lib/api-client/errors';
import { useClinicTimeZone } from '@/lib/api-client/clinic.hooks';
import { formatInZone, startOfDayIn, todayInputValue } from '@/lib/clinic-time';
import { usePatients } from '@/lib/api-client/dashboard.hooks';
import { useTherapists } from '@/lib/api-client/therapists.hooks';
import {
  type Appointment,
  type Modality,
  useAppointments,
  useCancelAppointment,
  useConfirmAppointment,
  useCreateAppointment,
  useRescheduleAppointment,
} from '@/lib/api-client/appointments.hooks';

const STATE_LABELS: Record<string, string> = {
  Criada: 'Criado',
  Reservada: 'Reservado',
  Confirmada: 'Confirmado',
  ReagendamentoSolicitado: 'Reagendamento solicitado',
  Reagendada: 'Reagendado',
  Cancelada: 'Cancelado',
};

/**
 * O que cada estado permite — espelho das transições que o backend aceita
 * (appointment.entity.ts). A tela só mostra a ação que vai funcionar; quem
 * valida de verdade continua sendo o backend.
 */
const CAN_CONFIRM = ['Reservada', 'Reagendada'];
const CAN_RESCHEDULE = ['Reservada', 'Confirmada', 'Reagendada'];
const CAN_CANCEL = ['Criada', 'Reservada', 'Confirmada', 'ReagendamentoSolicitado', 'Reagendada'];

/**
 * AgendaPage — Módulo 15; ciclo completo na Tarefa 05 da auditoria.
 * Fonte: 06-UX/03-Fluxo-Agendamento.md.
 *
 * Criar, ver, confirmar, remarcar e cancelar consultas, sete dias por vez.
 * DÍVIDA: continua sendo uma lista, não uma grade de calendário.
 *
 * AD-039: "hoje", os sete dias e todos os horários são os do fuso da
 * clínica, seja qual for o do computador.
 */
export default function AgendaPage() {
  const { timeZone } = useClinicTimeZone();
  // Quantas semanas à frente (ou atrás) de hoje a tela está mostrando.
  const [weekOffset, setWeekOffset] = useState(0);
  const { rangeStart, rangeEnd } = useMemo(
    () => ({ rangeStart: startOfDayIn(timeZone, 7 * weekOffset), rangeEnd: startOfDayIn(timeZone, 7 * weekOffset + 7) }),
    [timeZone, weekOffset],
  );
  const formatDateTime = (iso: string) =>
    formatInZone(iso, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }, timeZone);
  const formatDate = (instant: Date) => formatInZone(instant, { day: '2-digit', month: '2-digit', year: 'numeric' }, timeZone);
  const { data, isLoading, isError, error } = useAppointments(rangeStart, rangeEnd);
  const { data: patientsData } = usePatients();
  const { data: therapistsData } = useTherapists();
  const confirmAppointment = useConfirmAppointment();
  const cancelAppointment = useCancelAppointment();

  const [showCreate, setShowCreate] = useState(false);
  const [toReschedule, setToReschedule] = useState<Appointment | null>(null);
  const [toCancel, setToCancel] = useState<Appointment | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const patients = patientsData?.data ?? [];
  const therapists = therapistsData?.data ?? [];
  const patientName = (id: string) => patients.find((patient) => patient.id === id)?.name ?? 'Paciente';
  const therapistName = (id: string) => therapists.find((therapist) => therapist.id === id)?.name ?? 'Terapeuta';
  const appointments = data?.data ?? [];

  function clearMessages() {
    setActionError(null);
    setSuccess(null);
  }

  async function handleConfirm(appointment: Appointment) {
    clearMessages();
    try {
      await confirmAppointment.mutateAsync(appointment.id);
      setSuccess(`Consulta de ${patientName(appointment.patientId)} confirmada.`);
    } catch (err) {
      setActionError(describeApiError(err, 'Não foi possível confirmar a consulta.'));
    }
  }

  async function handleCancel() {
    if (!toCancel) return;
    setCancelError(null);
    try {
      await cancelAppointment.mutateAsync(toCancel.id);
      setSuccess(`Consulta de ${patientName(toCancel.patientId)} cancelada.`);
      setToCancel(null);
    } catch (err) {
      setCancelError(describeApiError(err, 'Não foi possível cancelar a consulta.'));
    }
  }

  // O último instante do sétimo dia: cai nele em qualquer fuso, inclusive em dia de mudança de horário de verão.
  const lastDay = new Date(rangeEnd.getTime() - 1);

  return (
    <PageShell
      title="Agenda"
      actions={
        <Button
          onClick={() => {
            clearMessages();
            setShowCreate((visible) => !visible);
          }}
        >
          {showCreate ? 'Fechar' : 'Nova consulta'}
        </Button>
      }
    >
      {showCreate && (
        <AppointmentForm
          patients={patients.filter((patient) => patient.state !== 'Inativo' && patient.state !== 'Alta')}
          therapists={therapists}
          onCreated={(appointment) => {
            setShowCreate(false);
            setSuccess(`Consulta de ${patientName(appointment.patientId)} marcada para ${formatDateTime(appointment.scheduledAt)}.`);
          }}
        />
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <Button type="button" variant="ghost" onClick={() => setWeekOffset((offset) => offset - 1)}>
          Semana anterior
        </Button>
        <Button type="button" variant="ghost" onClick={() => setWeekOffset(0)}>
          Hoje
        </Button>
        <Button type="button" variant="ghost" onClick={() => setWeekOffset((offset) => offset + 1)}>
          Próxima semana
        </Button>
        <span style={{ color: 'var(--sage)', fontSize: '0.9375rem' }}>
          {formatDate(rangeStart)} a {formatDate(lastDay)}
        </span>
      </div>
      <ClinicTimeZoneNote />

      {isLoading && <Loading />}
      {isError && <ErrorMessage>{describeApiError(error, 'Não foi possível carregar a agenda.')}</ErrorMessage>}
      {!isLoading && !isError && appointments.length === 0 && <EmptyState>Nenhuma consulta neste período.</EmptyState>}
      <ErrorMessage>{actionError}</ErrorMessage>
      <SuccessMessage>{success}</SuccessMessage>

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {appointments.map((appointment) => {
          const isConfirming = confirmAppointment.isPending && confirmAppointment.variables === appointment.id;
          return (
            <li key={appointment.id} style={rowStyle}>
              <div>
                <p style={{ margin: 0, fontWeight: 600 }}>{formatDateTime(appointment.scheduledAt)}</p>
                <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--sage)' }}>
                  {patientName(appointment.patientId)} · {therapistName(appointment.therapistId)}
                  {appointment.recurring && ' · recorrente'}
                </p>
              </div>
              <span
                style={{
                  fontSize: '0.8125rem',
                  fontWeight: 600,
                  padding: '0.25rem 0.625rem',
                  borderRadius: '999px',
                  background: appointment.state === 'Confirmada' ? 'var(--success)' : 'var(--gold-soft)',
                  color: appointment.state === 'Confirmada' ? '#fff' : 'var(--forest-ink)',
                }}
              >
                {STATE_LABELS[appointment.state] ?? appointment.state}
              </span>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {CAN_CONFIRM.includes(appointment.state) && (
                  <Button type="button" variant="ghost" disabled={isConfirming} onClick={() => handleConfirm(appointment)}>
                    {isConfirming ? 'Confirmando...' : 'Confirmar'}
                  </Button>
                )}
                {CAN_RESCHEDULE.includes(appointment.state) && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      clearMessages();
                      setToReschedule(appointment);
                    }}
                  >
                    Remarcar
                  </Button>
                )}
                {CAN_CANCEL.includes(appointment.state) && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      clearMessages();
                      setCancelError(null);
                      setToCancel(appointment);
                    }}
                  >
                    Cancelar
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {toCancel && (
        <ConfirmDialog
          title="Cancelar esta consulta?"
          description={
            <>
              {patientName(toCancel.patientId)}, {formatDateTime(toCancel.scheduledAt)}, com {therapistName(toCancel.therapistId)}. O horário volta a
              ficar livre e o cancelamento não pode ser desfeito.
            </>
          }
          confirmLabel="Cancelar consulta"
          busyLabel="Cancelando..."
          busy={cancelAppointment.isPending}
          error={cancelError}
          onConfirm={handleCancel}
          onCancel={() => setToCancel(null)}
        />
      )}

      {toReschedule && (
        <RescheduleDialog
          appointment={toReschedule}
          summary={`${patientName(toReschedule.patientId)}, atualmente em ${formatDateTime(toReschedule.scheduledAt)}, com ${therapistName(toReschedule.therapistId)}.`}
          onClose={() => setToReschedule(null)}
          onRescheduled={(appointment) => {
            setToReschedule(null);
            setSuccess(`Consulta de ${patientName(appointment.patientId)} remarcada para ${formatDateTime(appointment.scheduledAt)}.`);
          }}
        />
      )}
    </PageShell>
  );
}

function AppointmentForm(props: {
  patients: Array<{ id: string; name: string }>;
  therapists: Array<{ id: string; name: string }>;
  onCreated: (appointment: Appointment) => void;
}) {
  const createAppointment = useCreateAppointment();
  const { timeZone } = useClinicTimeZone();
  const [patientId, setPatientId] = useState('');
  const [therapistId, setTherapistId] = useState('');
  // Até a pessoa escolher um dia, vale "hoje" no calendário da clínica.
  const [chosenDay, setDay] = useState<string | null>(null);
  const day = chosenDay ?? todayInputValue(new Date(), timeZone);
  const [scheduledAt, setScheduledAt] = useState('');
  const [modality, setModality] = useState<Modality>('presencial');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      props.onCreated(await createAppointment.mutateAsync({ patientId, therapistId, scheduledAt, modality }));
    } catch (err) {
      // O horário pode ter sido ocupado entre a escolha e o envio: a lista é
      // recarregada pelo hook e a pessoa escolhe outro.
      setScheduledAt('');
      setError(describeApiError(err, 'Não foi possível marcar a consulta.'));
    }
  }

  const missingBasics = props.patients.length === 0 || props.therapists.length === 0;

  return (
    <form onSubmit={handleSubmit} style={cardStyle} aria-label="Nova consulta">
      <h2 style={sectionTitleStyle}>Nova consulta</h2>
      {missingBasics && (
        <EmptyState>Para marcar uma consulta é preciso ter ao menos um paciente ativo e um terapeuta cadastrados.</EmptyState>
      )}

      <label style={labelStyle} htmlFor="appointment-patient">
        Paciente
      </label>
      <select id="appointment-patient" required value={patientId} onChange={(event) => setPatientId(event.target.value)} style={inputStyle}>
        <option value="">Selecione...</option>
        {props.patients.map((patient) => (
          <option key={patient.id} value={patient.id}>
            {patient.name}
          </option>
        ))}
      </select>

      <label style={labelStyle} htmlFor="appointment-therapist">
        Terapeuta
      </label>
      <select
        id="appointment-therapist"
        required
        value={therapistId}
        onChange={(event) => {
          setTherapistId(event.target.value);
          setScheduledAt('');
        }}
        style={inputStyle}
      >
        <option value="">Selecione...</option>
        {props.therapists.map((therapist) => (
          <option key={therapist.id} value={therapist.id}>
            {therapist.name}
          </option>
        ))}
      </select>

      <SlotPicker therapistId={therapistId} day={day} onDayChange={setDay} value={scheduledAt} onChange={setScheduledAt} />

      <label style={labelStyle} htmlFor="appointment-modality">
        Modalidade
      </label>
      <select id="appointment-modality" value={modality} onChange={(event) => setModality(event.target.value as Modality)} style={inputStyle}>
        <option value="presencial">Presencial</option>
        <option value="online">Online</option>
      </select>

      <ErrorMessage>{error}</ErrorMessage>
      <Button type="submit" disabled={createAppointment.isPending || !scheduledAt} style={{ marginTop: '1rem' }}>
        {createAppointment.isPending ? 'Marcando...' : 'Marcar consulta'}
      </Button>
    </form>
  );
}

function RescheduleDialog(props: {
  appointment: Appointment;
  summary: string;
  onClose: () => void;
  onRescheduled: (appointment: Appointment) => void;
}) {
  const reschedule = useRescheduleAppointment();
  const { timeZone } = useClinicTimeZone();
  const [chosenDay, setDay] = useState<string | null>(null);
  const day = chosenDay ?? todayInputValue(new Date(), timeZone);
  const [newScheduledAt, setNewScheduledAt] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    if (!newScheduledAt) {
      setError('Escolha o novo dia e horário.');
      return;
    }
    setError(null);
    try {
      props.onRescheduled(await reschedule.mutateAsync({ appointmentId: props.appointment.id, newScheduledAt }));
    } catch (err) {
      setNewScheduledAt('');
      setError(describeApiError(err, 'Não foi possível remarcar a consulta.'));
    }
  }

  return (
    <ConfirmDialog
      title="Remarcar consulta"
      description={props.summary}
      confirmLabel="Remarcar"
      busyLabel="Remarcando..."
      busy={reschedule.isPending}
      error={error}
      onConfirm={handleConfirm}
      onCancel={props.onClose}
    >
      <SlotPicker therapistId={props.appointment.therapistId} day={day} onDayChange={setDay} value={newScheduledAt} onChange={setNewScheduledAt} />
    </ConfirmDialog>
  );
}
