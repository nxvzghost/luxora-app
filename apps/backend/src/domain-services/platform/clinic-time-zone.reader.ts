/**
 * Fuso horário da clínica da requisição — AD-039 (ADR-0064).
 *
 * Quem pergunta "que dia é hoje?" ou "que horas são 09:00?" pergunta à
 * clínica, nunca à máquina. Os Casos de Uso que precisam da resposta
 * dependem desta porta; o valor vem de `clinic_settings.time_zone`.
 *
 * Clínica sem configuração gravada recebe o padrão
 * (`DEFAULT_CLINIC_TIME_ZONE`). Um valor gravado que não seja um fuso
 * conhecido é erro — nunca é trocado por outro em silêncio.
 */
export interface ClinicTimeZoneReader {
  current(): Promise<string>;
}

export const CLINIC_TIME_ZONE_READER = Symbol('CLINIC_TIME_ZONE_READER');
