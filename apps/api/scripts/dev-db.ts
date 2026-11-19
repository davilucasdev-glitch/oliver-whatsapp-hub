/**
 * Postgres de DESENVOLVIMENTO sem Docker: PGlite (Postgres em WASM) com pg_trgm,
 * exposto na porta 5433 pelo protocolo do Postgres. Dados em apps/api/.pglite/.
 *
 *   npm run dev:db          (deixe rodando)
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres?sslmode=disable&connection_limit=1&pgbouncer=true
 *
 * "pgbouncer=true" é obrigatório aqui: o PGlite é um único backend compartilhado entre
 * conexões, e sem isso os prepared statements de processos diferentes colidem.
 *
 * Em produção use o Postgres do docker-compose.
 */
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.env.DEV_DB_PORT ?? 5433);
const dataDir = process.env.DEV_DB_DIR ?? './.pglite';

const db = await PGlite.create({ dataDir, extensions: { pg_trgm } });
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 10 });
await server.start();
console.log(`PGlite rodando em postgresql://postgres:postgres@localhost:${port}/postgres (dados: ${dataDir})`);

const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
