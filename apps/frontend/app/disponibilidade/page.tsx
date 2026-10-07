'use client';

import { useEffect, useMemo, useState } from 'react';
import { PageShell, cardStyle, hintStyle, inputStyle, labelStyle, rowStyle, sectionTitleStyle } from '@/components/ui/page-shell';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, EmptyState, ErrorMessage, Loading, SuccessMessage } from '@/components/ui/feedback';
import { describeApiError } from '@/lib/api-client/errors';
import { useRole } from '@/lib/session';
import { useTherapists } from '@/lib/api-client/therapists.hooks';
import { usePatients } from '@/lib/api-client/dashboard.hooks';
import { useClinic } from '@/lib/api-client/clinic.hooks';
import { useAvailableSlots, type Modality } from '@/lib/api-client/appointments.hooks';
import {
  type AvailabilityException,
  type AvailabilityWindow,
  useAvailabilityCalendar,
  useCreateRecurringBlock,
  useRecurringBlocks,
  useSetAvailabilityExceptions,
  useSetAvailabilityWindows,
} from '@/lib/api-client/availability.hooks';

const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const DAY_MS = 24 * 60 * 60 * 1000;

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Problema de uma janela, ou null. Mesmas regras que a API valida — conferidas antes para a mensagem ser clara. */
function windowProblem(window: AvailabilityWindow): string | null {
  if (!/^\d{2}:\d{2}$/.test(window.startTime) || !/^\d{2}:\d{2}$/.test(window.endTime)) return 'Informe início e fim no formato HH:MM.';
  if (window.startTime >= window.endTime) return 'O fim precisa ser depois do início.';
  if (!Number.isInteger(window.sessionDurationMinutes) || window.sessionDurationMinutes <= 0) return 'A duração da sessão precisa ser um número de minutos maior que zero.';
  return null;
}

/**
 * DisponibilidadePage — Tarefa 05 da auditoria. Antes só era possível
 * definir a disponibilidade chamando a API direto.
 *
 * Ver e alterar os horários de atendimento de cada terapeuta, as exceções
 * (folgas, férias) e os horários fixos de pacientes. Alterar janelas e
 * exceções é só para admin, como na API; o terapeuta vê e pode criar
 * horários fixos. Feriados da clínica são respeitados na agenda, mas a API
 * ainda não tem rota para cadastrá-los.
 */
export default function DisponibilidadePage() {
  const { data: therapistsData, isLoading: loadingTherapists, isError: therapistsFailed, error: therapistsError } = useTherapists();
  const therapists = useMemo(() => therapistsData?.data ?? [], [therapistsData]);
  const [therapistId, setTherapistId] = useState('');

  useEffect(() => {
    if (!therapistId && therapists.length > 0) setTherapistId(therapists[0].id);
  }, [therapistId, therapists]);

  return (
    <PageShell title="Disponibilidade" maxWidth="860px">
      {loadingTherapists && <Loading />}
      {therapistsFailed && <ErrorMessage>{describeApiError(therapistsError, 'Não foi possível carregar os terapeutas.')}</ErrorMessage>}
      {!loadingTherapists && !therapistsFailed && therapists.length === 0 && (
        <EmptyState>Cadastre um terapeuta em Terapeutas para definir a disponibilidade dele.</EmptyState>
      )}

      {therapists.length > 0 && (
        <>
          <label style={{ ...labelStyle, marginTop: 0 }} htmlFor="availability-therapist">
            Terapeuta
          </label>
          <select
            id="availability-therapist"
            value={therapistId}
            onChange={(event) => setTherapistId(event.target.value)}
            style={{ ...inputStyle, maxWidth: '360px', marginBottom: '1.5rem' }}
          >
            {therapists.map((therapist) => (
              <option key={therapist.id} value={therapist.id}>
                {therapist.name}
              </option>
            ))}
          </select>
          {/* key: trocar de terapeuta descarta qualquer edição não salva do anterior. */}
          {therapistId && <TherapistAvailability key={therapistId} therapistId={therapistId} />}
        </>
      )}
    </PageShell>
  );
}

function TherapistAvailability({ therapistId }: { therapistId: string }) {
  const isAdmin = useRole() !== 'therapist';
  const { data: calendar, isLoading, isError, error } = useAvailabilityCalendar(therapistId);

  if (isLoading) return <Loading />;
  if (isError || !calendar) return <ErrorMessage>{describeApiError(error, 'Não foi possível carregar a disponibilidade.')}</ErrorMessage>;

  return (
    <>
      {!isAdmin && <p style={hintStyle}>Os horários de atendimento e as exceções só podem ser alterados por um administrador.</p>}
      <WindowsSection therapistId={therapistId} saved={calendar.windows} canEdit={isAdmin} />
      <ExceptionsSection therapistId={therapistId} saved={calendar.exceptions} canEdit={isAdmin} />
      <section style={cardStyle}>
        <h2 style={sectionTitleStyle}>Feriados da clínica</h2>
        <p style={{ ...hintStyle, marginTop: 0 }}>
          Os feriados cadastrados para a clínica já são descontados dos horários livres. Ainda não é possível cadastrá-los por esta tela: a API
          não tem essa rota.
        </p>
      </section>
      <RecurringBlocksSection therapistId={therapistId} />
      <FreeSlotsPreview therapistId={therapistId} />
    </>
  );
}

function WindowsSection(props: { therapistId: string; saved: AvailabilityWindow[]; canEdit: boolean }) {
  const { data: clinic } = useClinic();
  const save = useSetAvailabilityWindows(props.therapistId);
  const [windows, setWindows] = useState<AvailabilityWindow[]>(props.saved);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const dirty = JSON.stringify(windows) !== JSON.stringify(props.saved);

  function update(index: number, patch: Partial<AvailabilityWindow>) {
    setSuccess(null);
    setWindows((current) => current.map((window, i) => (i === index ? { ...window, ...patch } : window)));
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    setSuccess(null);
    const problemIndex = windows.findIndex((window) => windowProblem(window));
    if (problemIndex >= 0) {
      setError(`Horário ${problemIndex + 1} (${WEEKDAYS[windows[problemIndex].dayOfWeek]}): ${windowProblem(windows[problemIndex])}`);
      return;
    }
    setError(null);
    try {
      const calendar = await save.mutateAsync(windows);
      setWindows(calendar.windows);
      setSuccess('Horários de atendimento salvos.');
    } catch (err) {
      setError(describeApiError(err, 'Não foi possível salvar os horários de atendimento.'));
    }
  }

  return (
    <form onSubmit={handleSave} style={cardStyle} aria-label="Horários de atendimento">
      <h2 style={sectionTitleStyle}>Horários de atendimento</h2>
      {windows.length === 0 && <EmptyState>Nenhum horário definido: este terapeuta não aparece com horários livres na agenda.</EmptyState>}

      {windows.map((window, index) => (
        <div key={index} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr auto', gap: '0.5rem', alignItems: 'end', marginBottom: '0.5rem' }}>
          <div>
            <label style={labelStyle} htmlFor={`window-day-${index}`}>
              Dia
            </label>
            <select
              id={`window-day-${index}`}
              disabled={!props.canEdit}
              value={window.dayOfWeek}
              onChange={(event) => update(index, { dayOfWeek: Number(event.target.value) })}
              style={inputStyle}
            >
              {WEEKDAYS.map((name, day) => (
                <option key={name} value={day}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle} htmlFor={`window-start-${index}`}>
              Início
            </label>
            <input id={`window-start-${index}`} type="time" required disabled={!props.canEdit} value={window.startTime} onChange={(event) => update(index, { startTime: event.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle} htmlFor={`window-end-${index}`}>
              Fim
            </label>
            <input id={`window-end-${index}`} type="time" required disabled={!props.canEdit} value={window.endTime} onChange={(event) => update(index, { endTime: event.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle} htmlFor={`window-duration-${index}`}>
              Sessão (min)
            </label>
            <input
              id={`window-duration-${index}`}
              type="number"
              min={1}
              required
              disabled={!props.canEdit}
              value={window.sessionDurationMinutes}
              onChange={(event) => update(index, { sessionDurationMinutes: Number(event.target.value) })}
              style={inputStyle}
            />
          </div>
          {props.canEdit && (
            <Button
              type="button"
              variant="ghost"
              aria-label={`Remover horário ${index + 1}`}
              onClick={() => {
                setSuccess(null);
                setWindows((current) => current.filter((_, i) => i !== index));
              }}
            >
              Remover
            </Button>
          )}
        </div>
      ))}

      <ErrorMessage>{error}</ErrorMessage>
      <SuccessMessage>{success}</SuccessMessage>
      {props.canEdit && (
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setSuccess(null);
              setWindows((current) => [
                ...current,
                { dayOfWeek: 1, startTime: '08:00', endTime: '12:00', sessionDurationMinutes: clinic?.defaultSessionDurationMinutes ?? 50 },
              ]);
            }}
          >
            Adicionar horário
          </Button>
          <Button type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Salvando...' : 'Salvar horários'}
          </Button>
          {dirty && <span style={hintStyle}>Há alterações não salvas.</span>}
        </div>
      )}
    </form>
  );
}

function ExceptionsSection(props: { therapistId: string; saved: AvailabilityException[]; canEdit: boolean }) {
  const save = useSetAvailabilityExceptions(props.therapistId);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [toRemove, setToRemove] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // A rota substitui a lista inteira: toda gravação parte do que está salvo.
  const normalize = (exception: AvailabilityException): AvailabilityException => ({
    from: new Date(exception.from).toISOString(),
    to: new Date(exception.to).toISOString(),
    ...(exception.reason ? { reason: exception.reason } : {}),
  });

  async function handleAdd(event: React.FormEvent) {
    event.preventDefault();
    setSuccess(null);
    const start = new Date(from);
    const end = new Date(to);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      setError('Informe início e fim, com o fim depois do início.');
      return;
    }
    setError(null);
    try {
      await save.mutateAsync([...props.saved.map(normalize), normalize({ from, to, reason: reason.trim() || undefined })]);
      setFrom('');
      setTo('');
      setReason('');
      setSuccess('Exceção adicionada.');
    } catch (err) {
      setError(describeApiError(err, 'Não foi possível adicionar a exceção.'));
    }
  }

  async function handleRemove() {
    if (toRemove === null) return;
    setRemoveError(null);
    try {
      await save.mutateAsync(props.saved.filter((_, index) => index !== toRemove).map(normalize));
      setToRemove(null);
      setSuccess('Exceção removida.');
    } catch (err) {
      setRemoveError(describeApiError(err, 'Não foi possível remover a exceção.'));
    }
  }

  return (
    <section style={cardStyle} aria-label="Exceções">
      <h2 style={sectionTitleStyle}>Exceções (folgas, férias, compromissos)</h2>
      <p style={{ ...hintStyle, marginTop: 0, marginBottom: '0.75rem' }}>Períodos em que o terapeuta não atende, mesmo dentro dos horários acima.</p>
      {props.saved.length === 0 && <EmptyState>Nenhuma exceção cadastrada.</EmptyState>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {props.saved.map((exception, index) => (
          <li key={`${exception.from}-${exception.to}`} style={rowStyle}>
            <div>
              <p style={{ margin: 0, fontWeight: 600 }}>
                {formatDateTime(exception.from)} até {formatDateTime(exception.to)}
              </p>
              {exception.reason && <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--sage)' }}>{exception.reason}</p>}
            </div>
            {props.canEdit && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setSuccess(null);
                  setRemoveError(null);
                  setToRemove(index);
                }}
              >
                Remover
              </Button>
            )}
          </li>
        ))}
      </ul>
      <SuccessMessage>{success}</SuccessMessage>

      {props.canEdit && (
        <form onSubmit={handleAdd} aria-label="Nova exceção">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            <div>
              <label style={labelStyle} htmlFor="exception-from">
                De
              </label>
              <input id="exception-from" type="datetime-local" required value={from} onChange={(event) => setFrom(event.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle} htmlFor="exception-to">
                Até
              </label>
              <input id="exception-to" type="datetime-local" required value={to} onChange={(event) => setTo(event.target.value)} style={inputStyle} />
            </div>
          </div>
          <label style={labelStyle} htmlFor="exception-reason">
            Motivo (opcional)
          </label>
          <input id="exception-reason" value={reason} onChange={(event) => setReason(event.target.value)} style={inputStyle} />
          <ErrorMessage>{error}</ErrorMessage>
          <Button type="submit" disabled={save.isPending} style={{ marginTop: '1rem' }}>
            {save.isPending && toRemove === null ? 'Salvando...' : 'Adicionar exceção'}
          </Button>
        </form>
      )}

      {toRemove !== null && props.saved[toRemove] && (
        <ConfirmDialog
          title="Remover esta exceção?"
          description={
            <>
              {formatDateTime(props.saved[toRemove].from)} até {formatDateTime(props.saved[toRemove].to)}. O terapeuta volta a aparecer com
              horários livres nesse período.
            </>
          }
          confirmLabel="Remover exceção"
          busyLabel="Removendo..."
          busy={save.isPending}
          error={removeError}
          onConfirm={handleRemove}
          onCancel={() => setToRemove(null)}
        />
      )}
    </section>
  );
}

function RecurringBlocksSection({ therapistId }: { therapistId: string }) {
  const { data, isLoading, isError, error } = useRecurringBlocks(therapistId);
  const { data: patientsData } = usePatients();
  const create = useCreateRecurringBlock(therapistId);
  const patients = patientsData?.data ?? [];
  const [patientId, setPatientId] = useState('');
  const [firstOccurrence, setFirstOccurrence] = useState('');
  const [intervalDays, setIntervalDays] = useState('7');
  const [modality, setModality] = useState<Modality>('presencial');
  const [renewalMode, setRenewalMode] = useState<'automatic' | 'manual'>('automatic');
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const blocks = data?.data ?? [];

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSuccess(null);
    const first = new Date(firstOccurrence);
    if (Number.isNaN(first.getTime())) {
      setFormError('Informe a data e a hora da primeira ocorrência.');
      return;
    }
    setFormError(null);
    try {
      await create.mutateAsync({ patientId, firstOccurrence: first.toISOString(), intervalDays: Number(intervalDays), modality, renewalMode });
      setPatientId('');
      setFirstOccurrence('');
      setSuccess('Horário fixo criado.');
    } catch (err) {
      setFormError(describeApiError(err, 'Não foi possível criar o horário fixo.'));
    }
  }

  return (
    <section style={cardStyle} aria-label="Horários fixos">
      <h2 style={sectionTitleStyle}>Horários fixos de pacientes</h2>
      <p style={{ ...hintStyle, marginTop: 0, marginBottom: '0.75rem' }}>Um paciente que vem sempre no mesmo dia e horário (bloqueio recorrente).</p>
      {isLoading && <Loading />}
      {isError && <ErrorMessage>{describeApiError(error, 'Não foi possível carregar os horários fixos.')}</ErrorMessage>}
      {!isLoading && !isError && blocks.length === 0 && <EmptyState>Nenhum horário fixo para este terapeuta.</EmptyState>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {blocks.map((block) => (
          <li key={block.id} style={rowStyle}>
            <div>
              <p style={{ margin: 0, fontWeight: 600 }}>{patients.find((patient) => patient.id === block.patientId)?.name ?? 'Paciente'}</p>
              <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--sage)' }}>
                Desde {formatDateTime(block.firstOccurrence)} · a cada {block.intervalDays} dias · {block.modality} · renovação{' '}
                {block.renewalMode === 'automatic' ? 'automática' : 'manual'}
              </p>
            </div>
          </li>
        ))}
      </ul>
      <SuccessMessage>{success}</SuccessMessage>

      <form onSubmit={handleSubmit} aria-label="Novo horário fixo">
        <label style={labelStyle} htmlFor="block-patient">
          Paciente
        </label>
        <select id="block-patient" required value={patientId} onChange={(event) => setPatientId(event.target.value)} style={inputStyle}>
          <option value="">Selecione...</option>
          {patients
            .filter((patient) => patient.state !== 'Inativo' && patient.state !== 'Alta')
            .map((patient) => (
              <option key={patient.id} value={patient.id}>
                {patient.name}
              </option>
            ))}
        </select>
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr', gap: '0.5rem' }}>
          <div>
            <label style={labelStyle} htmlFor="block-first">
              Primeira ocorrência
            </label>
            <input id="block-first" type="datetime-local" required value={firstOccurrence} onChange={(event) => setFirstOccurrence(event.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle} htmlFor="block-interval">
              Repete a cada
            </label>
            <select id="block-interval" value={intervalDays} onChange={(event) => setIntervalDays(event.target.value)} style={inputStyle}>
              <option value="7">7 dias</option>
              <option value="14">14 dias</option>
              <option value="28">28 dias</option>
            </select>
          </div>
          <div>
            <label style={labelStyle} htmlFor="block-modality">
              Modalidade
            </label>
            <select id="block-modality" value={modality} onChange={(event) => setModality(event.target.value as Modality)} style={inputStyle}>
              <option value="presencial">Presencial</option>
              <option value="online">Online</option>
            </select>
          </div>
          <div>
            <label style={labelStyle} htmlFor="block-renewal">
              Renovação
            </label>
            <select id="block-renewal" value={renewalMode} onChange={(event) => setRenewalMode(event.target.value as 'automatic' | 'manual')} style={inputStyle}>
              <option value="automatic">Automática</option>
              <option value="manual">Manual</option>
            </select>
          </div>
        </div>
        <ErrorMessage>{formError}</ErrorMessage>
        <Button type="submit" disabled={create.isPending} style={{ marginTop: '1rem' }}>
          {create.isPending ? 'Criando...' : 'Criar horário fixo'}
        </Button>
      </form>
    </section>
  );
}

/** O efeito de tudo acima: quantos horários a agenda vai oferecer em cada um dos próximos sete dias. */
function FreeSlotsPreview({ therapistId }: { therapistId: string }) {
  const range = useMemo(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    return { from, to: new Date(from.getTime() + 7 * DAY_MS) };
  }, []);
  const { data, isLoading, isError, error } = useAvailableSlots(therapistId, range.from, range.to);
  const perDay = useMemo(() => {
    const counts = new Map<string, number>();
    for (const slot of data?.data ?? []) {
      if (new Date(slot.startsAt).getTime() <= Date.now()) continue;
      const day = new Date(slot.startsAt).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    return Array.from(counts.entries());
  }, [data]);

  return (
    <section style={cardStyle} aria-label="Horários livres">
      <h2 style={sectionTitleStyle}>Horários livres nos próximos 7 dias</h2>
      <p style={{ ...hintStyle, marginTop: 0, marginBottom: '0.75rem' }}>É o que a agenda oferece hoje, já descontadas as consultas marcadas, as exceções e os feriados.</p>
      {isLoading && <Loading />}
      {isError && <ErrorMessage>{describeApiError(error, 'Não foi possível calcular os horários livres.')}</ErrorMessage>}
      {!isLoading && !isError && perDay.length === 0 && <EmptyState>Nenhum horário livre nos próximos 7 dias.</EmptyState>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {perDay.map(([day, count]) => (
          <li key={day} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.75rem', fontSize: '0.875rem' }}>
            <strong>{day}</strong> · {count} {count === 1 ? 'horário' : 'horários'}
          </li>
        ))}
      </ul>
    </section>
  );
}
