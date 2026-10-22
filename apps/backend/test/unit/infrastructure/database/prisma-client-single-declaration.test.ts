import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * PrismaClientProvider declarado num único lugar (DatabaseModule).
 *
 * O Nest cria uma instância do provider para cada módulo que o declara, e
 * cada instância é um PrismaClient com pool de conexões próprio. Com 17
 * declarações, a aplicação abria 17 pools (17 conexões logo após o boot, no
 * ensaio de deploy), e a Suíte Crítica esgotou as conexões do Postgres no CI
 * 39737046589. Este teste falha se algum módulo voltar a declarar, importar ou
 * citar o provider; a prova em execução (uma instância, um $connect, um
 * $disconnect) está em test/critical/prisma-client-shared-instance.test.ts.
 */

const SRC = join(__dirname, '../../../../src');
const DATABASE_MODULE = 'infrastructure/database/database.module.ts';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

// Todo arquivo com @Module(, e não só os *.module.ts: um módulo com outro
// nome também criaria a sua instância.
const moduleFiles = sourceFiles(SRC).filter((file) => readFileSync(file, 'utf8').includes('@Module('));

describe('PrismaClientProvider — declarado só no DatabaseModule', () => {
  it('a varredura encontra os módulos da aplicação', () => {
    expect(moduleFiles.length).toBeGreaterThan(15);
    expect(moduleFiles.map((file) => relative(SRC, file))).toContain(DATABASE_MODULE);
  });

  it('nenhum outro módulo declara, importa ou cita PrismaClientProvider', () => {
    const offenders = moduleFiles
      .map((file) => relative(SRC, file))
      .filter((file) => file !== DATABASE_MODULE)
      .filter((file) => /\bPrismaClientProvider\b/.test(readFileSync(join(SRC, file), 'utf8')));

    expect(offenders).toEqual([]);
  });

  it('o DatabaseModule é global e declara e exporta o provider', () => {
    const source = readFileSync(join(SRC, DATABASE_MODULE), 'utf8');

    expect(source).toMatch(/@Global\(\)\s*@Module\(/);
    expect(source).toMatch(/providers:\s*\[PrismaClientProvider\]/);
    expect(source).toMatch(/exports:\s*\[PrismaClientProvider\]/);
  });

  it('o AppModule importa o DatabaseModule', () => {
    const source = readFileSync(join(SRC, 'app.module.ts'), 'utf8');
    const imports = source.slice(source.indexOf('imports: ['), source.indexOf('controllers:'));

    expect(imports).toMatch(/^\s+DatabaseModule,$/m);
  });
});
