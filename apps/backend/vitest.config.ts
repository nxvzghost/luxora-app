import { defineConfig } from 'vitest/config';
import path from 'node:path';
import swc from 'unplugin-swc';

/**
 * Resolve os mesmos path aliases definidos em tsconfig.json, necessário
 * porque o Vitest não lê "paths" do tsconfig automaticamente sem este plugin
 * explícito — sem isso, todo teste que importar de @domain/*, @shared/* etc.
 * falharia na resolução de módulo.
 *
 * plugins: [swc...] — BUG REAL ENCONTRADO ao escrever os primeiros Testes
 * Críticos com bootstrap de app completo (test/critical/support/bootstrap-app.ts):
 * o transform TS padrão do Vitest (esbuild) NÃO emite `design:paramtypes`
 * (metadata de decorator), que é exatamente do que a injeção de dependência
 * implícita do NestJS depende (`constructor(private readonly x: XService)`,
 * sem `@Inject()` explícito — o padrão usado em quase todo o código). Sem
 * isso, `Test.createTestingModule({ imports: [AppModule] }).compile()`
 * "funciona" sem erro nenhum no boot, mas injeta `undefined` silenciosamente
 * em todo controller/serviço com esse padrão — só quebra em runtime, na
 * primeira chamada. Nenhum teste anterior a este tinha bootstrapado o
 * container de DI real do Nest (todos usavam `new UseCase(mocks...)` direto,
 * contornando a injeção por completo) — por isso isso nunca tinha aparecido.
 * unplugin-swc é a solução padrão da própria comunidade NestJS para isso.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // test/integration/ ainda não tem nenhum arquivo — sem isso, `vitest run
    // test/integration` sai com código 1 ("No test files found") e quebra o
    // job test-integration do CI (e test-critical, que depende dele) mesmo
    // sem nenhum teste ter falhado de verdade. test/unit e test/critical têm
    // arquivos reais; se um dia ficarem vazios por engano, essa config não
    // detecta — risco aceito, mesmo padrão já usado em apps/frontend.
    passWithNoTests: true,
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
    }),
  ],
  resolve: {
    alias: {
      '@domain': path.resolve(__dirname, './src/domain'),
      '@operational-engine': path.resolve(__dirname, './src/operational-engine'),
      '@domain-services': path.resolve(__dirname, './src/domain-services'),
      '@use-cases': path.resolve(__dirname, './src/use-cases'),
      '@infrastructure': path.resolve(__dirname, './src/infrastructure'),
      '@api': path.resolve(__dirname, './src/api'),
      '@shared': path.resolve(__dirname, './src/shared'),
    },
  },
});
