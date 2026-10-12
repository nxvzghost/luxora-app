'use client';

import { hintStyle } from '@/components/ui/page-shell';
import { useClinicTimeZone } from '@/lib/api-client/clinic.hooks';
import { browserTimeZone } from '@/lib/clinic-time';

/**
 * AD-039 (ADR-0064) — diz em que fuso estão os horários da tela, quando isso
 * não é óbvio: a pessoa acessa de um fuso diferente do da clínica, ou o
 * painel não conseguiu ler o fuso da clínica e está usando o do computador.
 * Quando os dois fusos coincidem, não mostra nada.
 */
export function ClinicTimeZoneNote() {
  const { timeZone, unavailable } = useClinicTimeZone();

  if (unavailable) {
    return (
      <p role="note" style={{ ...hintStyle, color: 'var(--danger)', marginBottom: '0.75rem' }}>
        Não foi possível ler o fuso horário da clínica. Os horários desta tela estão no fuso deste computador e podem não ser os da clínica.
      </p>
    );
  }
  if (!timeZone || timeZone === browserTimeZone()) return null;
  return (
    <p role="note" style={{ ...hintStyle, marginBottom: '0.75rem' }}>
      Horários no fuso da clínica ({timeZone}), que é diferente do fuso deste computador.
    </p>
  );
}
