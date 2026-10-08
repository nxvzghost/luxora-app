import { countTestClinics, disconnect } from './database';

/**
 * Ao fim da suíte, nenhuma clínica de teste pode ter ficado no banco: cada
 * teste remove a sua, passe ou falhe. Se sobrar alguma, a limpeza de algum
 * teste não rodou — e isso é uma falha da suíte, não um detalhe.
 */
export default async function globalTeardown(): Promise<void> {
  try {
    const leftovers = await countTestClinics();
    if (leftovers > 0) {
      throw new Error(`${leftovers} clínica(s) de teste ficaram no banco depois da suíte — alguma limpeza não rodou.`);
    }
  } finally {
    await disconnect();
  }
}
