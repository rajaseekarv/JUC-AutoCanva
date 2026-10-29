import ts from 'typescript';
import { defineConfig, type Plugin } from 'vitest/config';

// esbuild does not emit decorator metadata, so Nest cannot resolve
// constructor dependencies by type under Vitest. HTTP tests boot real Nest
// modules, so their sources are transpiled with TypeScript instead, emitting
// the same metadata as `nest build`.
function nestDecoratorMetadata(): Plugin {
  return {
    name: 'adflow-nest-decorator-metadata',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.ts') || id.includes('/node_modules/')) return null;
      const output = ts.transpileModule(code, {
        fileName: id,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          sourceMap: true,
        },
      });
      return { code: output.outputText, map: output.sourceMapText };
    },
  };
}

// Real-PostgreSQL tests run only when an isolated test database URL is
// supplied and ADFLOW_PG_GATES=run opts in explicitly, so a URL left in a
// shell never turns an ordinary `pnpm test` into a database run. The specs
// themselves refuse anything but the guarded 127.0.0.1:55432 *_test
// database. They never run in the default suite.
const runPostgres =
  !!process.env.ADFLOW_PG_TEST_URL && process.env.ADFLOW_PG_GATES === 'run';
const isolatedPostgresProject = runPostgres
  ? [
      {
        extends: true as const,
        plugins: [nestDecoratorMetadata()],
        test: {
          name: 'pg',
          include: ['src/**/*.pg.spec.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ]
  : [];

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
    // fileParallelism is honored only at the root. Real-PostgreSQL files
    // coordinate through pg_stat_activity lock counts on one shared database,
    // so they must not run concurrently; default runs stay parallel.
    fileParallelism: !runPostgres,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
          exclude: ['src/**/*.http.spec.ts', 'src/**/*.pg.spec.ts'],
        },
      },
      {
        extends: true,
        plugins: [nestDecoratorMetadata()],
        test: { name: 'http', include: ['src/**/*.http.spec.ts'] },
      },
      ...isolatedPostgresProject,
    ],
  },
});
