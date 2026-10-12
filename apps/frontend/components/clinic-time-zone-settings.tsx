'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, SuccessMessage } from '@/components/ui/feedback';
import { cardStyle, hintStyle, inputStyle, labelStyle, sectionTitleStyle } from '@/components/ui/page-shell';
import { useUpdateClinicTimeZone } from '@/lib/api-client/clinic.hooks';
import { describeApiError } from '@/lib/api-client/errors';
import { BRAZIL_TIME_ZONES, formatInZone, isKnownTimeZone, otherTimeZones } from '@/lib/clinic-time';

function describeZone(timeZone: string): string {
  const brazilian = BRAZIL_TIME_ZONES.find((zone) => zone.value === timeZone);
  return brazilian ? `${brazilian.label} — ${timeZone}` : timeZone;
}

/**
 * Fuso horário da clínica — AD-039 (ADR-0064). Todos veem o fuso em vigor;
 * só o administrador o altera, e só depois de confirmar que entendeu o
 * efeito: a troca vale daqui em diante e não reescreve nada do que já está
 * gravado, então o que já está marcado passa a aparecer em outra hora do
 * relógio.
 *
 * A lista é uma conveniência; quem valida o nome é a API.
 */
export function ClinicTimeZoneSettings({ current, canEdit }: { current: string; canEdit: boolean }) {
  const update = useUpdateClinicTimeZone();
  const [selected, setSelected] = useState(current);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const others = useMemo(otherTimeZones, []);

  useEffect(() => setSelected(current), [current]);

  const listed = BRAZIL_TIME_ZONES.some((zone) => zone.value === current) || others.includes(current);

  async function handleConfirm() {
    setError(null);
    try {
      const clinic = await update.mutateAsync(selected);
      setConfirming(false);
      setSuccess(`Fuso da clínica alterado para ${describeZone(clinic.timeZone)}.`);
    } catch (err) {
      setError(describeApiError(err, 'Não foi possível alterar o fuso.'));
    }
  }

  return (
    <section style={cardStyle} aria-label="Fuso horário">
      <h2 style={sectionTitleStyle}>Fuso horário</h2>
      <p style={{ ...hintStyle, marginTop: 0 }}>
        É o fuso do lugar onde a clínica atende. Os horários de atendimento, a agenda e o dia de vencimento das cobranças valem nele — não no fuso
        do computador de quem usa o painel.
      </p>
      <p style={{ fontSize: '0.9375rem', margin: '0.75rem 0 0' }}>
        Fuso atual: <strong>{describeZone(current)}</strong>
        {isKnownTimeZone(current) && (
          <> · agora na clínica: {formatInZone(new Date(), { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }, current)}</>
        )}
      </p>
      <SuccessMessage>{success}</SuccessMessage>

      {!canEdit && <p style={hintStyle}>Só um administrador pode alterar o fuso da clínica.</p>}

      {canEdit && (
        <form
          aria-label="Alterar fuso horário"
          onSubmit={(event) => {
            event.preventDefault();
            setSuccess(null);
            setError(null);
            setConfirming(true);
          }}
        >
          <label style={labelStyle} htmlFor="clinic-time-zone">
            Novo fuso
          </label>
          <select id="clinic-time-zone" value={selected} onChange={(event) => setSelected(event.target.value)} style={inputStyle}>
            {!listed && <option value={current}>{current}</option>}
            <optgroup label="Brasil">
              {BRAZIL_TIME_ZONES.map((zone) => (
                <option key={zone.value} value={zone.value}>
                  {zone.label} — {zone.value}
                </option>
              ))}
            </optgroup>
            {others.length > 0 && (
              <optgroup label="Outros fusos">
                {others.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <p style={hintStyle}>
            Mudar o fuso vale daqui em diante e não reescreve o que já está gravado. Confira a agenda depois de alterar.
          </p>
          <Button type="submit" disabled={selected === current || update.isPending} style={{ marginTop: '0.75rem' }}>
            Alterar fuso
          </Button>
        </form>
      )}

      {confirming && (
        <ConfirmDialog
          title="Alterar o fuso da clínica?"
          description={
            <>
              <p style={{ margin: '0 0 0.5rem' }}>
                De <strong>{current}</strong> para <strong>{selected}</strong>. A mudança vale daqui em diante:
              </p>
              <ul style={{ margin: 0, paddingLeft: '1.125rem' }}>
                <li>Os horários de atendimento (por exemplo, 09:00–18:00) e o dia de vencimento das cobranças passam a valer no novo fuso.</li>
                <li>
                  Nada do que já foi gravado é reescrito. Consultas, exceções e horários fixos já marcados continuam no mesmo instante — e por isso
                  passam a aparecer na hora do novo fuso, que pode não ser a combinada com o paciente.
                </li>
                <li>
                  Valores, pagamentos e datas de vencimento não mudam. Uma cobrança pode passar a constar em atraso algumas horas antes ou depois,
                  porque o dia passa a virar em outro momento.
                </li>
              </ul>
            </>
          }
          confirmLabel="Alterar fuso"
          busyLabel="Alterando..."
          busy={update.isPending}
          error={error}
          onConfirm={handleConfirm}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  );
}
