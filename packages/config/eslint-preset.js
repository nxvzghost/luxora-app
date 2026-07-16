/**
 * Preset ESLint compartilhado — Luxora.
 * Fonte: docs/10-Sprint-0/03-Arquitetura-Fisica-Repositorio.md,
 * docs/10-Sprint-0/05-Criterios-de-Engenharia.md.
 *
 * A regra mais importante deste preset não é estilo — é arquitetura:
 * src/domain/ nunca pode importar de src/infrastructure/, src/api/ ou
 * qualquer módulo de framework (Princípio 01, 14 — Clean Architecture).
 * Isso é verificado automaticamente aqui, não deixado apenas para o code
 * review humano perceber.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'boundaries'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    'boundaries/element-types': [
      'error',
      {
        default: 'disallow',
        rules: [
          { from: 'domain', allow: ['domain'] },
          { from: 'domain-services', allow: ['domain', 'domain-services', 'shared'] },
          { from: 'use-cases', allow: ['domain', 'domain-services', 'operational-engine', 'shared'] },
          { from: 'operational-engine', allow: ['domain', 'domain-services', 'use-cases', 'shared'] },
          // infrastructure importa domain-services para implementar as
          // interfaces de Repository (ex: PatientRepository) definidas lá —
          // é Dependency Inversion correta, não uma violação da regra de
          // que domain-services nunca pode importar infrastructure (essa
          // direção continua proibida acima). Corrigido no Módulo 05, ao
          // implementar o primeiro Repository real.
          { from: 'infrastructure', allow: ['domain', 'domain-services', 'infrastructure', 'shared'] },
          { from: 'api', allow: ['domain', 'use-cases', 'operational-engine', 'infrastructure', 'shared'] },
          { from: 'shared', allow: ['shared'] },
        ],
      },
    ],
  },
  settings: {
    'boundaries/elements': [
      { type: 'domain', pattern: 'src/domain/**' },
      { type: 'domain-services', pattern: 'src/domain-services/**' },
      { type: 'use-cases', pattern: 'src/use-cases/**' },
      { type: 'operational-engine', pattern: 'src/operational-engine/**' },
      { type: 'infrastructure', pattern: 'src/infrastructure/**' },
      { type: 'api', pattern: 'src/api/**' },
      { type: 'shared', pattern: 'src/shared/**' },
    ],
  },
};
