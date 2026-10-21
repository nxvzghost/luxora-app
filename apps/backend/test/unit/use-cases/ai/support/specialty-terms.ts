/**
 * L16 do A-14 (docs/12-Privacidade-e-Dados/06): o Vertex atende clínicas e
 * consultórios em geral, então os textos fixos da IA não podem presumir uma
 * especialidade. Termos que denunciam essa presunção; "clínica", "consulta" e
 * "dado clínico" são genéricos e ficam de fora.
 */
export const SPECIALTY_TERMS =
  /saúde mental|psic|psiq|terap|vulnerabilidade|médic|odonto|dentist|dermat|fisioter|nutri|fonoaud|pediatr|ginec|cardio|ortop|oftalm/i;
