'use client';

import Link from 'next/link';
import { useAvailableSlots } from '@/lib/api-client/appointments.hooks';
import { describeApiError } from '@/lib/api-client/errors';
import { ErrorMessage, Loading } from '@/components/ui/feedback';
import { hintStyle, inputStyle, labelStyle } from '@/components/ui/page-shell';

/** Início e fim (exclusivo) de um dia local, a partir do valor de um <input type="date">. */
export function dayRange(day: string): { from: Date; to: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const from = new Date(`${day}T00:00:00`);
  if (Number.isNaN(from.getTime())) return null;
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from, to };
}

export function todayInputValue(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * SlotPicker — Tarefa 05 da auditoria. Escolha de dia e horário para criar
 * ou remarcar uma consulta. Só oferece os horários que a API diz estarem
 * livres para o terapeuta naquele dia: a tela não deixa pedir um horário
 * que o backend recusaria por indisponibilidade.
 */
export function SlotPicker(props: {
  therapistId: string;
  day: string;
  onDayChange: (day: string) => void;
  value: string;
  onChange: (startsAt: string) => void;
}) {
  const range = props.therapistId ? dayRange(props.day) : null;
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
        min={todayInputValue()}
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
              {formatTime(slot.startsAt)} – {formatTime(slot.endsAt)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
