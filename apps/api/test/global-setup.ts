import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { TestProject } from 'vitest/node';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** Sobe um Postgres (PGlite em memória) e aplica as migrations reais antes dos testes. */
export default async function setup(project: TestProject) {
  const db = await PGlite.create({ extensions: { pg_trgm } });
  const port = 55_000 + Math.floor(Math.random() * 5000);
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 10 });
  await server.start();
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable&connection_limit=1&pgbouncer=true`;

  // Assíncrono de propósito: o PGlite roda neste mesmo processo e precisa do event loop livre.
  const prismaCli = path.resolve(require.resolve('prisma/package.json'), '..', 'build', 'index.js');
  await execFileAsync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    cwd: path.resolve(import.meta.dirname, '..'),
  });

  project.provide('databaseUrl', url);

  return async () => {
    await server.stop();
    await db.close();
  };
}
