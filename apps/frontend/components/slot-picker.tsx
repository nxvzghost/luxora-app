'use client';

import Link from 'next/link';
import { useAvailableSlots } from '@/lib/api-client/appointments.hooks';
import { useClinicTimeZone } from '@/lib/api-client/clinic.hooks';
import { dayRange, formatInZone, todayInputValue } from '@/lib/clinic-time';
import { describeApiError } from '@/lib/api-client/errors';
import { ErrorMessage, Loading } from '@/components/ui/feedback';
import { hintStyle, inputStyle, labelStyle } from '@/components/ui/page-shell';

// O dia, "hoje" e a hora são os do fuso da clínica (AD-039) — as regras estão em lib/clinic-time.ts.
export { dayRange, todayInputValue };

export function formatTime(iso: string, timeZone?: string): string {
  return formatInZone(iso, { hour: '2-digit', minute: '2-digit' }, timeZone);
}

/**
 * SlotPicker — Tarefa 05 da auditoria. Escolha de dia e horário para criar
 * ou remarcar uma consulta. Só oferece os horários que a API diz estarem
 * livres para o terapeuta naquele dia: a tela não deixa pedir um horário
 * que o backend recusaria por indisponibilidade.
 *
 * O dia escolhido é um dia do calendário da clínica, e os horários aparecem
 * na hora de lá — seja qual for o fuso do computador (AD-039).
 */
export function SlotPicker(props: {
  therapistId: string;
  day: string;
  onDayChange: (day: string) => void;
  value: string;
  onChange: (startsAt: string) => void;
}) {
  const { timeZone } = useClinicTimeZone();
  const range = props.therapistId ? dayRange(props.day, timeZone) : null;
  const { data, isLoading, isError, error } = useAvailableSlots(props.therapistId, range?.from ?? null, range?.to ?? null);
  // A API devolve também horários que já passaram no dia de hoje.
  const slots = (data?.data ?? []).filter((slot) => new Date(slot.startsAt).getTime() > Date.now());

  return (
    <div>
      <label style={labelStyle} htmlFor="slot-day">
        Dia
      </label>
      <input
        id="slot-day"
        type="date"
        required
        min={todayInputValue(new Date(), timeZone)}
        value={props.day}
        onChange={(event) => {
          props.onDayChange(event.target.value);
          props.onChange('');
        }}
        style={inputStyle}
      />

      <label style={labelStyle} htmlFor="slot-time">
        Horário
      </label>
      {!props.therapistId && <p style={hintStyle}>Escolha o terapeuta para ver os horários livres.</p>}
      {props.therapistId && isLoading && <Loading>Buscando horários livres...</Loading>}
      {isError && <ErrorMessage>{describeApiError(error, 'Não foi possível buscar os horários livres.')}</ErrorMessage>}
      {props.therapistId && range && !isLoading && !isError && slots.length === 0 && (
        <p style={hintStyle}>
          Sem horário livre neste dia. Escolha outro dia ou confira a{' '}
          <Link href="/disponibilidade" style={{ textDecoration: 'underline' }}>
            disponibilidade do terapeuta
          </Link>
          .
        </p>
      )}
      {slots.length > 0 && (
        <select id="slot-time" required value={props.value} onChange={(event) => props.onChange(event.target.value)} style={inputStyle}>
          <option value="">Selecione...</option>
          {slots.map((slot) => (
            <option key={slot.startsAt} value={slot.startsAt}>
              {formatTime(slot.startsAt, timeZone)} – {formatTime(slot.endsAt, timeZone)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
